import fs from "node:fs";
import path from "node:path";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";

import { CallCursorResponsesOptions } from "./cursor-api";
import { __resolveCursorModel } from "./cursor-api";
import { randomQuip } from "./cursor-acp-quips";

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
  private agentCapabilities: JsonObject = {};

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
      const initialized = await connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "auth2api", version: "1.0.0" },
      });
      connection.agentCapabilities = initialized?.agentCapabilities || {};
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
    return () => {
      // A newer turn may have replaced the handler for this session already
      // (steer = cancel -> prompt on the same session); never remove it.
      if (this.sessions.get(sessionId) === handler) {
        this.sessions.delete(sessionId);
      }
    };
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

  get canLoadSession(): boolean {
    return this.agentCapabilities.loadSession === true;
  }

  get canResumeSession(): boolean {
    return this.agentCapabilities.sessionCapabilities?.resume === true;
  }
}

// ---------------------------------------------------------------------------
// TurnRun: one live ACP session/prompt turn, decoupled from HTTP responses.
// The turn accumulates segments; each HTTP response streams a chunk of them,
// cutting at tool-call boundaries so Codex can persist the tool call in its
// history and deliver steer input between chunks.
// ---------------------------------------------------------------------------

type Segment =
  | { kind: "reasoning"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; callId: string; name: string; args: string }
  | { kind: "end"; error?: Error; cancelled?: boolean };

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);
}

function excerpt(value: unknown, max = 600): string {
  if (value === undefined || value === null) return "";
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 0);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

class TurnRun {
  readonly id = randomUUID();
  segments: Segment[] = [];
  cursor = 0;
  running = true;
  /** function_call call_ids emitted at chunk boundaries, awaiting follow-up. */
  boundaryCallIds = new Set<string>();
  /** ACP toolCallId -> emitted function name (for tool_call_update notes). */
  toolNames = new Map<string, string>();
  consumerAttached = false;
  updatedAt = Date.now();
  /** Resolves when the underlying session/prompt settles (end segment). */
  readonly finished: Promise<void>;
  private finishResolve!: () => void;
  private waiters: Array<() => void> = [];
  private abandonTimer?: NodeJS.Timeout;

  constructor(
    readonly conversation: CursorAcpConversation,
    readonly connection: CursorAcpConnection,
    readonly sessionId: string,
  ) {
    this.finished = new Promise((resolve) => {
      this.finishResolve = resolve;
    });
  }

  push(segment: Segment): void {
    this.updatedAt = Date.now();
    if (segment.kind === "end") {
      this.running = false;
      this.finishResolve();
    }
    this.segments.push(segment);
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** Resolves when a new segment arrives or timeoutMs elapses. */
  waitForSegment(timeoutMs: number): Promise<"segment" | "timeout"> {
    if (this.cursor < this.segments.length || !this.running) {
      return Promise.resolve("segment");
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref();
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve("segment");
      });
    });
  }

  get drained(): boolean {
    return this.cursor >= this.segments.length;
  }

  cancel(): void {
    if (!this.running) return;
    try {
      this.connection.notify("session/cancel", { sessionId: this.sessionId });
    } catch {
      // Connection loss will surface through the prompt promise.
    }
  }

  /** Arm/disarm the abandonment TTL (Codex never came back for a follow-up). */
  armAbandonTimer(ttlMs: number, onAbandon: () => void): void {
    this.clearAbandonTimer();
    this.abandonTimer = setTimeout(() => {
      if (!this.consumerAttached) onAbandon();
    }, ttlMs);
    this.abandonTimer.unref();
  }

  clearAbandonTimer(): void {
    if (this.abandonTimer) clearTimeout(this.abandonTimer);
    this.abandonTimer = undefined;
  }
}

const ABANDONED_TURN_TTL_MS = 5 * 60 * 1000;
const QUIP_INTERVAL_MS = 20_000;

const pools = new Map<string, Promise<CursorAcpConnection>>();

type CursorAcpConversation = {
  model: string;
  workspace: string;
  persistentKey?: string;
  statePath?: string;
  connection?: CursorAcpConnection;
  sessionId?: string;
  activeTurn?: TurnRun;
  tail: Promise<void>;
  updatedAt: number;
};

const conversations = new Map<string, CursorAcpConversation>();
const responseConversations = new Map<string, CursorAcpConversation>();

export type StoredCursorAcpResponse = {
  id: string;
  status: "in_progress" | "completed" | "failed" | "cancelled";
  response?: JsonObject;
  updated_at: number;
};

const responseStore = new Map<string, StoredCursorAcpResponse>();
const activeResponses = new Map<string, () => void>();
const STORE_TTL_MS = 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
type PersistedSession = { sessionId: string; updatedAt: number };
const persistedSessions = new Map<string, Map<string, PersistedSession>>();

function loadPersistedSessions(
  statePath: string,
): Map<string, PersistedSession> {
  const cached = persistedSessions.get(statePath);
  if (cached) return cached;
  const sessions = new Map<string, PersistedSession>();
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    for (const [key, value] of Object.entries(parsed?.sessions || {})) {
      const session = value as Partial<PersistedSession>;
      if (
        typeof session.sessionId === "string" &&
        typeof session.updatedAt === "number" &&
        Date.now() - session.updatedAt <= SESSION_TTL_MS
      ) {
        sessions.set(key, {
          sessionId: session.sessionId,
          updatedAt: session.updatedAt,
        });
      }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.error(
        `[cursor-acp] Failed to read session state: ${error.message}`,
      );
    }
  }
  persistedSessions.set(statePath, sessions);
  return sessions;
}

function persistConversation(conversation: CursorAcpConversation): void {
  if (
    !conversation.persistentKey ||
    !conversation.statePath ||
    !conversation.sessionId
  ) {
    return;
  }
  const sessions = loadPersistedSessions(conversation.statePath);
  sessions.set(conversation.persistentKey, {
    sessionId: conversation.sessionId,
    updatedAt: conversation.updatedAt,
  });
  for (const [key, session] of sessions) {
    if (Date.now() - session.updatedAt > SESSION_TTL_MS) sessions.delete(key);
  }
  const state = { version: 1, sessions: Object.fromEntries(sessions) };
  const directory = path.dirname(conversation.statePath);
  const temporary = `${conversation.statePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, conversation.statePath);
  } catch (error: any) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve original persistence error.
    }
    console.error(
      `[cursor-acp] Failed to persist session state: ${error.message}`,
    );
  }
}

function firstHeader(
  request: CallCursorResponsesOptions["request"],
  name: string,
): string {
  const value = request.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return typeof value === "string" ? value.trim() : "";
}

function stableConversationId(
  request: CallCursorResponsesOptions["request"],
): string {
  return (
    firstHeader(request, "thread-id") ||
    firstHeader(request, "session-id") ||
    firstHeader(request, "x-client-request-id") ||
    firstHeader(request, "thread_id") ||
    firstHeader(request, "session_id") ||
    firstHeader(request, "conversation_id")
  );
}

function conversationKey(model: string, workspace: string, id: string): string {
  return `${model}\u0000${workspace}\u0000${id}`;
}

function pruneConversations(now = Date.now()): void {
  for (const [key, conversation] of conversations) {
    if (now - conversation.updatedAt > SESSION_TTL_MS)
      conversations.delete(key);
  }
  for (const [responseId, conversation] of responseConversations) {
    if (now - conversation.updatedAt > STORE_TTL_MS) {
      responseConversations.delete(responseId);
    }
  }
}

function getConversation(
  options: CallCursorResponsesOptions,
  model: string,
  workspace: string,
  responseId: string,
): CursorAcpConversation {
  pruneConversations();
  const body = options.body ?? options.request.body;
  const stableId = stableConversationId(options.request);
  const statePath = path.join(
    options.config["auth-dir"],
    "cursor-acp-sessions.json",
  );
  const previousResponseId =
    typeof body?.previous_response_id === "string"
      ? body.previous_response_id.trim()
      : "";
  let conversation = previousResponseId
    ? responseConversations.get(previousResponseId)
    : undefined;
  if (
    conversation &&
    (conversation.model !== model || conversation.workspace !== workspace)
  ) {
    conversation = undefined;
  }

  if (stableId) {
    const key = conversationKey(model, workspace, stableId);
    const stableConversation = conversations.get(key);
    if (stableConversation) conversation = stableConversation;
    else if (conversation) {
      conversation.persistentKey = key;
      conversation.statePath = statePath;
      conversations.set(key, conversation);
    } else {
      const persisted = loadPersistedSessions(statePath).get(key);
      conversation = {
        model,
        workspace,
        persistentKey: key,
        statePath,
        sessionId: persisted?.sessionId,
        updatedAt: persisted?.updatedAt || Date.now(),
        tail: Promise.resolve(),
      };
      conversations.set(key, conversation);
    }
  }

  conversation ||= {
    model,
    workspace,
    tail: Promise.resolve(),
    updatedAt: Date.now(),
  };
  conversation.updatedAt = Date.now();
  responseConversations.set(responseId, conversation);
  return conversation;
}

function continuationPrompt(body: any): string {
  const input = body?.input ?? body?.messages;
  if (typeof input === "string") return input || "Continue.";
  if (Array.isArray(input)) {
    for (let index = input.length - 1; index >= 0; index--) {
      const item = input[index];
      if (typeof item === "string") return item;
      const role = String(item?.role || "").toLowerCase();
      const type = String(item?.type || "").toLowerCase();
      // Only user text starts a new Cursor turn. Synthetic boundary outputs
      // ("unsupported call: cursor_*") must never become a prompt.
      if (role === "user" && type !== "function_call_output") {
        const text = contentText(item?.content) || contentText(item?.text);
        if (text) return text;
      }
    }
  }
  return promptFromBody(body);
}

async function ensureConversationSession(
  conversation: CursorAcpConversation,
  connection: CursorAcpConnection,
): Promise<{ sessionId: string; continued: boolean }> {
  if (
    conversation.connection === connection &&
    conversation.sessionId &&
    !connection.isClosed
  ) {
    return { sessionId: conversation.sessionId, continued: true };
  }

  const previousSessionId = conversation.sessionId;
  if (previousSessionId) {
    try {
      if (connection.canResumeSession) {
        await connection.request("session/resume", {
          sessionId: previousSessionId,
          cwd: conversation.workspace,
          mcpServers: [],
        });
        conversation.connection = connection;
        return { sessionId: previousSessionId, continued: true };
      }
      if (connection.canLoadSession) {
        await connection.request("session/load", {
          sessionId: previousSessionId,
          cwd: conversation.workspace,
          mcpServers: [],
        });
        conversation.connection = connection;
        return { sessionId: previousSessionId, continued: true };
      }
    } catch {
      // Fall through to a fresh session and replay the request context.
    }
  }

  const session = await connection.request("session/new", {
    cwd: conversation.workspace,
    mcpServers: [],
  });
  conversation.connection = connection;
  conversation.sessionId = String(session.sessionId);
  return { sessionId: conversation.sessionId, continued: false };
}

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
  conversations.clear();
  responseConversations.clear();
  persistedSessions.clear();
  await Promise.allSettled(
    connections.map(async (value) => (await value).dispose()),
  );
}

// ---------------------------------------------------------------------------
// Request classification: new turn vs continuation vs steer.
// Codex resends full history each request. A follow-up after one of our
// synthetic tool-call boundaries contains function_call_output items with our
// call_ids ("unsupported call: ..."). Any user message AFTER the last such
// item is steer input delivered by Codex between sampling requests.
// ---------------------------------------------------------------------------

type RequestClass =
  | { kind: "new" }
  | { kind: "continuation"; turn: TurnRun }
  | { kind: "steer"; turn: TurnRun; steerText: string };

function classifyRequest(body: any, turn: TurnRun | undefined): RequestClass {
  if (!turn) return { kind: "new" };
  const input = body?.input ?? body?.messages;
  if (!Array.isArray(input)) return { kind: "new" };
  let lastBoundaryIndex = -1;
  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index];
    if (
      item?.type === "function_call_output" &&
      turn.boundaryCallIds.has(String(item?.call_id || ""))
    ) {
      lastBoundaryIndex = index;
      break;
    }
  }
  if (lastBoundaryIndex < 0) return { kind: "new" };
  const steerParts: string[] = [];
  for (let index = lastBoundaryIndex + 1; index < input.length; index++) {
    const item = input[index];
    const role = String(item?.role || "").toLowerCase();
    if (item?.type === "function_call_output") continue;
    if (role === "user" || item?.type === "message") {
      const text = contentText(item?.content);
      if (text) steerParts.push(text);
    }
  }
  if (steerParts.length > 0) {
    return { kind: "steer", turn, steerText: steerParts.join("\n\n") };
  }
  return { kind: "continuation", turn };
}

function segmentFromUpdate(
  turn: TurnRun,
  update: SessionNotification["update"],
): Segment | undefined {
  const type = (update as any).sessionUpdate;
  const u = update as any;
  if (type === "agent_message_chunk" && u.content?.type === "text") {
    return { kind: "text", text: String(u.content.text || "") };
  }
  if (type === "agent_thought_chunk" && u.content?.type === "text") {
    return { kind: "reasoning", text: String(u.content.text || "") };
  }
  if (type === "plan") {
    return {
      kind: "reasoning",
      text: `\n[plan] ${excerpt(u.entries || [], 400)}\n`,
    };
  }
  if (type === "tool_call") {
    const name = `cursor_${sanitizeId(String(u.kind || "other"))}`;
    const callId = `call_cursor_${sanitizeId(String(u.toolCallId || randomUUID()))}`;
    turn.toolNames.set(String(u.toolCallId || ""), name);
    return {
      kind: "tool_call",
      callId,
      name,
      args: JSON.stringify({
        title: u.title || undefined,
        input: u.rawInput ?? undefined,
        locations: u.locations?.length ? u.locations : undefined,
      }),
    };
  }
  if (type === "tool_call_update") {
    const name =
      turn.toolNames.get(String(u.toolCallId || "")) || "cursor_tool";
    const status = String(u.status || "updated");
    const output = excerpt(u.rawOutput ?? contentText(u.content));
    return {
      kind: "reasoning",
      text: `\n[${name} ${status}]${output ? ` ${output}` : ""}\n`,
    };
  }
  if (type === "permission_request") {
    return {
      kind: "reasoning",
      text: `\n[permission auto-allowed] ${excerpt(u.request?.toolCall?.title || "", 200)}\n`,
    };
  }
  return undefined;
}

function abandonTurn(conversation: CursorAcpConversation, turn: TurnRun) {
  turn.cancel();
  if (conversation.activeTurn === turn) conversation.activeTurn = undefined;
}

async function startTurn(
  conversation: CursorAcpConversation,
  model: string,
  prompt: string,
): Promise<TurnRun> {
  const connection = await getConnection(model);
  const session = await ensureConversationSession(conversation, connection);
  const turn = new TurnRun(conversation, connection, session.sessionId);
  conversation.activeTurn = turn;
  const stopSession = connection.onSession(session.sessionId, (update) => {
    const segment = segmentFromUpdate(turn, update);
    if (segment) turn.push(segment);
  });
  connection
    .request(
      "session/prompt",
      {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: prompt }],
      },
      0,
    )
    .then((result: any) => {
      turn.push({
        kind: "end",
        cancelled: result?.stopReason === "cancelled",
      });
    })
    .catch((error: unknown) => {
      turn.push({
        kind: "end",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    })
    .finally(() => {
      stopSession();
      conversation.updatedAt = Date.now();
      persistConversation(conversation);
      if (conversation.activeTurn === turn && !turn.running && turn.drained) {
        conversation.activeTurn = undefined;
      }
    });
  return turn;
}

// ---------------------------------------------------------------------------
// Chunk writer: streams segments from a TurnRun into one Responses SSE
// response, ending the response at a tool_call boundary or at turn end.
// ---------------------------------------------------------------------------

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
  const createdAt = Math.floor(Date.now() / 1000);
  const conversation = getConversation(options, model, workspace, responseId);
  responseStore.set(responseId, {
    id: responseId,
    status: "in_progress",
    updated_at: Date.now(),
  });
  let consumerClosed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let sequence = 0;
      let completed = false;
      let turn: TurnRun | undefined;
      const output: any[] = [];
      let nextOutputIndex = 0;
      // Open item state: at most one reasoning and one message item open at a
      // time; a new one opens (with a fresh id/index) after the other kind
      // interleaves.
      let openReasoning:
        | { id: string; index: number; text: string }
        | undefined;
      let openMessage: { id: string; index: number; text: string } | undefined;

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

      const closeReasoning = () => {
        if (!openReasoning) return;
        emit("response.reasoning_summary_text.done", {
          item_id: openReasoning.id,
          output_index: openReasoning.index,
          summary_index: 0,
          text: openReasoning.text,
        });
        emit("response.reasoning_summary_part.done", {
          item_id: openReasoning.id,
          output_index: openReasoning.index,
          summary_index: 0,
          part: { type: "summary_text", text: openReasoning.text },
        });
        const item = {
          id: openReasoning.id,
          type: "reasoning",
          status: "completed",
          summary: [{ type: "summary_text", text: openReasoning.text }],
        };
        emit("response.output_item.done", {
          output_index: openReasoning.index,
          item,
        });
        output[openReasoning.index] = item;
        openReasoning = undefined;
      };
      const closeMessage = () => {
        if (!openMessage) return;
        const item = {
          id: openMessage.id,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: openMessage.text, annotations: [] },
          ],
        };
        emit("response.output_text.done", {
          item_id: openMessage.id,
          output_index: openMessage.index,
          content_index: 0,
          text: openMessage.text,
        });
        emit("response.output_item.done", {
          output_index: openMessage.index,
          item,
        });
        output[openMessage.index] = item;
        openMessage = undefined;
      };
      const emitReasoning = (delta: string) => {
        if (!delta) return;
        if (!openReasoning) {
          closeMessage();
          openReasoning = {
            id: `rs_cursor_${randomUUID()}`,
            index: nextOutputIndex++,
            text: "",
          };
          emit("response.output_item.added", {
            output_index: openReasoning.index,
            item: {
              id: openReasoning.id,
              type: "reasoning",
              status: "in_progress",
              summary: [],
            },
          });
          emit("response.reasoning_summary_part.added", {
            item_id: openReasoning.id,
            output_index: openReasoning.index,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          });
        }
        openReasoning.text += delta;
        emit("response.reasoning_summary_text.delta", {
          item_id: openReasoning.id,
          output_index: openReasoning.index,
          summary_index: 0,
          delta,
        });
      };
      const emitText = (delta: string) => {
        if (!delta) return;
        if (!openMessage) {
          closeReasoning();
          openMessage = {
            id: `msg_cursor_${randomUUID()}`,
            index: nextOutputIndex++,
            text: "",
          };
          emit("response.output_item.added", {
            output_index: openMessage.index,
            item: {
              id: openMessage.id,
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: [],
            },
          });
          emit("response.content_part.added", {
            item_id: openMessage.id,
            output_index: openMessage.index,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
        }
        openMessage.text += delta;
        emit("response.output_text.delta", {
          item_id: openMessage.id,
          output_index: openMessage.index,
          content_index: 0,
          delta,
        });
      };

      const heartbeat = setInterval(() => write(": ping\n\n"), heartbeatMs);
      heartbeat.unref();

      const cleanup = () => {
        clearInterval(heartbeat);
        activeResponses.delete(responseId);
        if (turn) {
          turn.consumerAttached = false;
          if (turn.running || !turn.drained) {
            const current = turn;
            turn.armAbandonTimer(ABANDONED_TURN_TTL_MS, () =>
              abandonTurn(conversation, current),
            );
          }
        }
      };

      const finalize = (
        status: "completed" | "failed" | "cancelled",
        error?: Error,
        extraMetadata?: JsonObject,
      ) => {
        if (completed) return;
        completed = true;
        closeReasoning();
        closeMessage();
        cleanup();
        const response: JsonObject = {
          id: responseId,
          object: "response",
          created_at: createdAt,
          status,
          model,
          output,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          metadata: {
            ...(turn?.sessionId ? { cursor_session_id: turn.sessionId } : {}),
            ...(extraMetadata || {}),
          },
        };
        if (status === "failed") {
          response.error = {
            code: "cursor_acp_error",
            message: error?.message || "Cursor ACP turn failed",
          };
        }
        responseStore.set(responseId, {
          id: responseId,
          status,
          response,
          updated_at: Date.now(),
        });
        emit(
          status === "completed"
            ? "response.completed"
            : status === "cancelled"
              ? "response.cancelled"
              : "response.failed",
          { response },
        );
        if (!consumerClosed) {
          try {
            controller.close();
          } catch {
            consumerClosed = true;
          }
        }
      };

      /** Ends this chunk at a tool boundary: function_call item + completed. */
      const finalizeAtToolCall = (segment: {
        callId: string;
        name: string;
        args: string;
      }) => {
        closeReasoning();
        closeMessage();
        const index = nextOutputIndex++;
        const item = {
          id: `fc_${segment.callId}`,
          type: "function_call",
          call_id: segment.callId,
          name: segment.name,
          arguments: segment.args,
          status: "completed",
        };
        emit("response.output_item.added", {
          output_index: index,
          item: { ...item, status: "in_progress" },
        });
        emit("response.output_item.done", { output_index: index, item });
        output[index] = item;
        turn?.boundaryCallIds.add(segment.callId);
        finalize("completed");
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
        const current = turn;
        if (current) {
          current.cancel();
          if (conversation.activeTurn === current) {
            conversation.activeTurn = undefined;
          }
        }
        finalize("cancelled");
      });

      void (async () => {
        try {
          const existing = conversation.activeTurn;
          const classified = classifyRequest(body, existing);
          console.log(
            `[cursor-acp] request classified=${classified.kind} activeTurn=${Boolean(existing)} inputItems=${Array.isArray(body?.input) ? body.input.length : typeof body?.input}`,
          );

          if (classified.kind === "continuation") {
            turn = classified.turn;
          } else {
            if (existing) {
              // New prompt or steer while a turn is live: cancel -> send on
              // the same ACP session (approved steer semantics). Wait for the
              // old session/prompt to actually settle before prompting again,
              // otherwise cursor-agent drops or serializes the new prompt
              // unpredictably.
              existing.cancel();
              existing.clearAbandonTimer();
              conversation.activeTurn = undefined;
              const settled = await Promise.race([
                existing.finished.then(() => true),
                new Promise<false>((resolve) => {
                  const timer = setTimeout(() => resolve(false), 15_000);
                  timer.unref();
                }),
              ]);
              if (!settled) {
                console.warn(
                  "[cursor-acp] previous turn did not settle after cancel; prompting anyway",
                );
              }
            }
            const isNewSession = !conversation.sessionId;
            const prompt =
              classified.kind === "steer"
                ? classified.steerText
                : isNewSession
                  ? promptFromBody(body)
                  : continuationPrompt(body);
            turn = await startTurn(conversation, model, prompt);
          }
          if (completed) return;
          turn.consumerAttached = true;
          turn.clearAbandonTimer();

          let idleElapsed = 0;
          for (;;) {
            if (completed) return;
            if (turn.cursor < turn.segments.length) {
              const segment = turn.segments[turn.cursor++];
              idleElapsed = 0;
              if (segment.kind === "reasoning") emitReasoning(segment.text);
              else if (segment.kind === "text") emitText(segment.text);
              else if (segment.kind === "tool_call") {
                finalizeAtToolCall(segment);
                return;
              } else {
                // end
                if (conversation.activeTurn === turn) {
                  conversation.activeTurn = undefined;
                }
                if (segment.error) finalize("failed", segment.error);
                else {
                  finalize("completed", undefined, {
                    cursor_stop_reason: segment.cancelled
                      ? "cancelled"
                      : "end_turn",
                  });
                }
                return;
              }
              continue;
            }
            if (!turn.running) {
              // Drained and ended without an explicit end segment (should not
              // happen, but never hang).
              if (conversation.activeTurn === turn) {
                conversation.activeTurn = undefined;
              }
              finalize("completed");
              return;
            }
            const waitMs = Math.min(
              QUIP_INTERVAL_MS,
              Math.max(idleTimeoutMs - idleElapsed, 50),
            );
            const waited = await turn.waitForSegment(waitMs);
            if (waited === "timeout") {
              idleElapsed += waitMs;
              if (idleElapsed >= idleTimeoutMs) {
                finalize(
                  "failed",
                  new Error(
                    `cursor-agent ACP idle timeout after ${idleTimeoutMs}ms`,
                  ),
                );
                return;
              }
              emitReasoning(`\n${randomQuip()}...\n`);
            }
          }
        } catch (error) {
          finalize(
            "failed",
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      })();
    },
    cancel() {
      // HTTP client disappeared. Keep the ACP turn alive; Codex retries or the
      // abandonment TTL reaps it.
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
