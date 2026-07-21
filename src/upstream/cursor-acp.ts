import fs from "node:fs";
import path from "node:path";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";

import { CallCursorResponsesOptions } from "./cursor-api";
import { __resolveCursorModel } from "./cursor-api";

const encoder = new TextEncoder();

type JsonRpcId = number;
type JsonObject = Record<string, any>;
type UpdateHandler = (update: SessionNotification["update"]) => void;

function sse(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part: any) =>
      typeof part === "string"
        ? part
        : part?.text || part?.input_text || part?.output_text || "",
    )
    .filter(Boolean)
    .join("\n");
}

function promptFromBody(body: any): string {
  const sections: string[] = [];
  const instructions =
    contentText(body?.instructions) || contentText(body?.system);
  if (instructions) sections.push(`SYSTEM INSTRUCTIONS:\n${instructions}`);
  const input = body?.input ?? body?.messages;
  if (typeof input === "string") sections.push(input);
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") sections.push(item);
      else {
        const text = contentText(item?.content) || contentText(item?.output);
        if (text)
          sections.push(
            `${String(item?.role || "user").toUpperCase()}:\n${text}`,
          );
      }
    }
  }
  return sections.join("\n\n") || "Continue.";
}

function spawnAcp(model: string): ChildProcessWithoutNullStreams {
  const overrideNode = process.env.CURSOR_AGENT_NODE;
  const overrideScript = process.env.CURSOR_AGENT_SCRIPT;
  const args = ["--yolo", "--model", model, "acp"];
  if (overrideNode && overrideScript) {
    return spawn(overrideNode, [overrideScript, ...args], {
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  const configured = process.env.CURSOR_AGENT_COMMAND;
  if (process.platform === "win32" && !configured) {
    const script = path.join(
      process.env.LOCALAPPDATA || "",
      "cursor-agent",
      "cursor-agent.ps1",
    );
    if (!fs.existsSync(script)) {
      throw new Error("Cursor Agent CLI not found; set CURSOR_AGENT_COMMAND");
    }
    return spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
  }
  return spawn(configured || "cursor-agent", args, {
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

class CursorAcpConnection {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdout = "";
  private stderr = "";
  private closed = false;
  private pending = new Map<
    JsonRpcId,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer?: NodeJS.Timeout;
    }
  >();
  private sessions = new Map<string, UpdateHandler>();

  private constructor(private readonly model: string) {
    this.child = spawnAcp(model);
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", (code) =>
      this.fail(
        new Error(
          this.stderr.trim() || `cursor-agent ACP exited with code ${code}`,
        ),
      ),
    );
  }

  static async create(model: string): Promise<CursorAcpConnection> {
    const connection = new CursorAcpConnection(model);
    try {
      await connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "auth2api", version: "1.0.0" },
      });
      return connection;
    } catch (error) {
      await connection.dispose();
      throw error;
    }
  }

  private consume(chunk: string): void {
    this.stdout += chunk;
    for (;;) {
      const newline = this.stdout.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      let message: JsonObject;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        message.id !== undefined &&
        (message.result !== undefined || message.error)
      ) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (message.error)
          pending.reject(new Error(message.error.message || "ACP error"));
        else pending.resolve(message.result);
        continue;
      }
      if (message.method === "session/update") {
        this.sessions.get(message.params?.sessionId)?.(
          message.params.update as SessionNotification["update"],
        );
        continue;
      }
      if (message.id !== undefined) this.answerClientRequest(message);
    }
  }

  private answerClientRequest(message: JsonObject): void {
    if (message.method === "session/request_permission") {
      this.sessions.get(message.params?.sessionId)?.({
        sessionUpdate: "permission_request",
        request: message.params,
      } as any);
      const allow = message.params?.options?.find((option: any) =>
        ["allow_once", "allow_always"].includes(option.kind),
      );
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          outcome: allow
            ? { outcome: "selected", optionId: allow.optionId }
            : { outcome: "cancelled" },
        },
      });
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32601,
        message: `Unsupported ACP client method: ${message.method}`,
      },
    });
  }

  private write(message: JsonObject): void {
    if (this.closed) throw new Error("Cursor ACP connection is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(
    method: string,
    params: JsonObject,
    timeoutMs = 60_000,
  ): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                new Error(
                  `Cursor ACP ${method} timed out after ${timeoutMs}ms`,
                ),
              );
            }, timeoutMs)
          : undefined;
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: JsonObject): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  onSession(sessionId: string, handler: UpdateHandler): () => void {
    this.sessions.set(sessionId, handler);
    return () => this.sessions.delete(sessionId);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.kill();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

const pools = new Map<string, Promise<CursorAcpConnection>>();

export type StoredCursorAcpResponse = {
  id: string;
  status: "in_progress" | "completed" | "failed" | "cancelled";
  response?: JsonObject;
  updated_at: number;
};

const responseStore = new Map<string, StoredCursorAcpResponse>();
const activeResponses = new Map<string, () => void>();
const STORE_TTL_MS = 60 * 60 * 1000;

export function getCursorAcpResponse(
  responseId: string,
): StoredCursorAcpResponse | undefined {
  const stored = responseStore.get(responseId);
  if (!stored) return undefined;
  if (Date.now() - stored.updated_at > STORE_TTL_MS) {
    responseStore.delete(responseId);
    return undefined;
  }
  return stored;
}

export function cancelCursorAcpResponse(responseId: string): boolean {
  const cancel = activeResponses.get(responseId);
  if (!cancel) return false;
  cancel();
  return true;
}

async function getConnection(model: string): Promise<CursorAcpConnection> {
  let connection = pools.get(model);
  if (!connection) {
    connection = CursorAcpConnection.create(model).catch((error) => {
      pools.delete(model);
      throw error;
    });
    pools.set(model, connection);
  }
  const resolved = await connection;
  if (resolved.isClosed) {
    if (pools.get(model) === connection) pools.delete(model);
    return getConnection(model);
  }
  return resolved;
}

export async function __disposeCursorAcpPools(): Promise<void> {
  const connections = [...pools.values()];
  pools.clear();
  await Promise.allSettled(
    connections.map(async (value) => (await value).dispose()),
  );
}

export async function callCursorAcpResponses(
  options: CallCursorResponsesOptions,
): Promise<Response> {
  if (!process.env.CURSOR_API_KEY) {
    return Response.json(
      {
        error: {
          message: "CURSOR_API_KEY is not set",
          type: "authentication_error",
        },
      },
      { status: 401 },
    );
  }
  if ((options.responseFormat || "openai-responses") !== "openai-responses") {
    return Response.json(
      { error: { message: "ACP transport currently requires /v1/responses" } },
      { status: 501 },
    );
  }

  const body = options.body ?? options.request.body;
  const model = __resolveCursorModel(String(body?.model || "cursor-default"));
  const workspace = path.resolve(
    options.config.cloaking.cursor?.workspace || process.cwd(),
  );
  const heartbeatMs =
    options.config.cloaking.cursor?.["heartbeat-ms"] ?? 15_000;
  const idleTimeoutMs = options.config.timeouts["stream-messages-ms"];
  const responseId = `resp_cursor_${randomUUID()}`;
  const messageId = `msg_cursor_${randomUUID()}`;
  const reasoningId = `rs_cursor_${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  responseStore.set(responseId, {
    id: responseId,
    status: "in_progress",
    updated_at: Date.now(),
  });
  let consumerClosed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let connection: CursorAcpConnection | undefined;
      let sessionId: string | undefined;
      let sequence = 0;
      let fullText = "";
      let fullReasoning = "";
      let reasoningStarted = false;
      let reasoningOutputIndex = 0;
      let messageStarted = false;
      let messageOutputIndex = 0;
      let completed = false;
      let idleTimer: NodeJS.Timeout;
      let stopSession = () => {};
      const output: any[] = [];
      const write = (value: string) => {
        if (consumerClosed) return;
        try {
          controller.enqueue(encoder.encode(value));
        } catch {
          consumerClosed = true;
        }
      };
      const emit = (name: string, data: JsonObject) =>
        write(sse(name, { type: name, sequence_number: sequence++, ...data }));
      const ensureReasoning = () => {
        if (reasoningStarted) return;
        reasoningStarted = true;
        reasoningOutputIndex = messageStarted ? 1 : 0;
        emit("response.output_item.added", {
          output_index: reasoningOutputIndex,
          item: {
            id: reasoningId,
            type: "reasoning",
            status: "in_progress",
            summary: [],
          },
        });
        emit("response.reasoning_summary_part.added", {
          item_id: reasoningId,
          output_index: reasoningOutputIndex,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        });
      };
      const emitReasoning = (delta: string) => {
        if (!delta) return;
        ensureReasoning();
        fullReasoning += delta;
        emit("response.reasoning_summary_text.delta", {
          item_id: reasoningId,
          output_index: reasoningOutputIndex,
          summary_index: 0,
          delta,
        });
      };
      const ensureMessage = () => {
        if (messageStarted) return;
        messageStarted = true;
        messageOutputIndex = reasoningStarted ? 1 : 0;
        emit("response.output_item.added", {
          output_index: messageOutputIndex,
          item: {
            id: messageId,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        });
        emit("response.content_part.added", {
          item_id: messageId,
          output_index: messageOutputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      };
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () =>
            finish(
              new Error(
                `cursor-agent ACP idle timeout after ${idleTimeoutMs}ms`,
              ),
            ),
          idleTimeoutMs,
        );
        idleTimer.unref();
      };
      const handleUpdate: UpdateHandler = (update) => {
        resetIdle();
        const stored = responseStore.get(responseId);
        if (stored) stored.updated_at = Date.now();
        const type = update.sessionUpdate;
        if (type === "agent_message_chunk" && update.content?.type === "text") {
          ensureMessage();
          const delta = String(update.content.text || "");
          fullText += delta;
          emit("response.output_text.delta", {
            item_id: messageId,
            output_index: messageOutputIndex,
            content_index: 0,
            delta,
          });
        } else if (
          type === "agent_thought_chunk" &&
          update.content?.type === "text"
        ) {
          emitReasoning(String(update.content.text || ""));
        } else if (type === "plan") {
          emit("response.cursor.plan", { session_id: sessionId, ...update });
          emitReasoning(`[plan] ${JSON.stringify(update.entries || [])}\n`);
        } else if (type === "tool_call") {
          emit("response.cursor.tool_call", {
            session_id: sessionId,
            ...update,
          });
          emitReasoning(
            `[tool:${update.kind || "other"}] ${update.title || update.toolCallId} (${update.status || "pending"})\n`,
          );
        } else if (type === "tool_call_update") {
          emit("response.cursor.tool_call_update", {
            session_id: sessionId,
            ...update,
          });
          emitReasoning(
            `[tool:${update.toolCallId}] ${update.status || "updated"}\n`,
          );
        } else {
          emit("response.cursor.session_update", {
            session_id: sessionId,
            ...update,
          });
        }
      };
      const heartbeat = setInterval(() => write(": ping\n\n"), heartbeatMs);
      heartbeat.unref();

      const cleanup = () => {
        clearInterval(heartbeat);
        clearTimeout(idleTimer);
        stopSession();
        activeResponses.delete(responseId);
      };
      const finish = (error?: Error) => {
        if (completed) return;
        completed = true;
        cleanup();
        if (error) {
          const cancelled = error.name === "CursorAcpCancelledError";
          if (!cancelled && connection && sessionId) {
            try {
              connection.notify("session/cancel", { sessionId });
            } catch {
              // Connection failure already explains the terminal response.
            }
          }
          const failedResponse = {
            id: responseId,
            object: "response",
            created_at: createdAt,
            status: cancelled ? "cancelled" : "failed",
            model,
            output,
            error: cancelled
              ? null
              : { code: "cursor_acp_error", message: error.message },
          };
          responseStore.set(responseId, {
            id: responseId,
            status: cancelled ? "cancelled" : "failed",
            response: failedResponse,
            updated_at: Date.now(),
          });
          emit(cancelled ? "response.cancelled" : "response.failed", {
            response: failedResponse,
          });
          if (!consumerClosed) controller.close();
          return;
        }
        if (reasoningStarted) {
          emit("response.reasoning_summary_text.done", {
            item_id: reasoningId,
            output_index: reasoningOutputIndex,
            summary_index: 0,
            text: fullReasoning,
          });
          emit("response.reasoning_summary_part.done", {
            item_id: reasoningId,
            output_index: reasoningOutputIndex,
            summary_index: 0,
            part: { type: "summary_text", text: fullReasoning },
          });
          const reasoning = {
            id: reasoningId,
            type: "reasoning",
            status: "completed",
            summary: [{ type: "summary_text", text: fullReasoning }],
          };
          emit("response.output_item.done", {
            output_index: reasoningOutputIndex,
            item: reasoning,
          });
          output[reasoningOutputIndex] = reasoning;
        }
        ensureMessage();
        const message = {
          id: messageId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: fullText, annotations: [] }],
        };
        emit("response.output_text.done", {
          item_id: messageId,
          output_index: messageOutputIndex,
          content_index: 0,
          text: fullText,
        });
        emit("response.output_item.done", {
          output_index: messageOutputIndex,
          item: message,
        });
        output[messageOutputIndex] = message;
        const completedResponse = {
          id: responseId,
          object: "response",
          created_at: createdAt,
          status: "completed",
          model,
          output,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          metadata: sessionId ? { cursor_session_id: sessionId } : {},
        };
        responseStore.set(responseId, {
          id: responseId,
          status: "completed",
          response: completedResponse,
          updated_at: Date.now(),
        });
        emit("response.completed", { response: completedResponse });
        if (!consumerClosed) controller.close();
      };

      emit("response.created", {
        response: {
          id: responseId,
          object: "response",
          created_at: createdAt,
          status: "in_progress",
          model,
          output: [],
          metadata: {},
        },
      });
      activeResponses.set(responseId, () => {
        if (connection && sessionId) {
          try {
            connection.notify("session/cancel", { sessionId });
          } catch {
            // Cancellation still transitions local response state.
          }
        }
        const error = new Error("Cursor ACP response cancelled");
        error.name = "CursorAcpCancelledError";
        finish(error);
      });
      void (async () => {
        try {
          connection = await getConnection(model);
          if (completed) return;
          const session = await connection.request("session/new", {
            cwd: workspace,
            mcpServers: [],
          });
          if (completed) return;
          sessionId = String(session.sessionId);
          stopSession = connection.onSession(sessionId, handleUpdate);
          resetIdle();
          await connection.request(
            "session/prompt",
            {
              sessionId,
              prompt: [{ type: "text", text: promptFromBody(body) }],
            },
            0,
          );
          finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    },
    cancel() {
      // HTTP client disappeared. Keep ACP turn alive; caller can retrieve the
      // completed response through GET /v1/responses/:id.
      consumerClosed = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
