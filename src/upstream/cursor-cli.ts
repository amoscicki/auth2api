import fs from "node:fs";
import path from "node:path";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { CallCursorResponsesOptions, CursorSseFormat } from "./cursor-api";
import { __resolveCursorModel } from "./cursor-api";

type CursorAgentMode = "ask" | "plan" | "agent";

const encoder = new TextEncoder();

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => {
      if (typeof part === "string") return part;
      return part?.text || part?.input_text || part?.output_text || "";
    })
    .filter(Boolean)
    .join("\n");
}

function promptFromBody(body: any): string {
  const sections: string[] = [];
  const instructions =
    textFromContent(body?.instructions) || textFromContent(body?.system);
  if (instructions) sections.push(`SYSTEM INSTRUCTIONS:\n${instructions}`);

  const input = body?.input ?? body?.messages;
  if (typeof input === "string") {
    sections.push(`USER:\n${input}`);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        sections.push(`USER:\n${item}`);
        continue;
      }
      const role = String(item?.role || "user").toUpperCase();
      const text = textFromContent(item?.content);
      if (text) {
        sections.push(`${role}:\n${text}`);
        continue;
      }
      if (item?.type === "function_call_output") {
        sections.push(
          `TOOL RESULT ${item.call_id || ""}:\n${textFromContent(item.output)}`,
        );
        continue;
      }
      if (item?.type === "function_call") {
        sections.push(
          `ASSISTANT TOOL CALL ${item.name || ""}:\n${String(item.arguments || "{}")}`,
        );
      }
    }
  }

  if (Array.isArray(body?.tools) && body.tools.length > 0) {
    sections.push(
      "Use Cursor CLI built-in tools when needed. Return their final result as assistant text; do not emit Codex function_call JSON.",
    );
  }

  return sections.join("\n\n") || "Continue.";
}

function forceMaxModel(model: string): string {
  const resolved = __resolveCursorModel(model);
  if (/\[[^\]]*\]$/.test(resolved)) {
    const base = resolved.replace(/\[[^\]]*\]$/, "");
    return `${base}[effort=max]`;
  }
  if (/-(?:low|medium|high|xhigh|max)$/i.test(resolved)) {
    return resolved.replace(/-(?:low|medium|high|xhigh|max)$/i, "-max");
  }
  return `${resolved}[effort=max]`;
}

function cursorAgentMode(options: CallCursorResponsesOptions): CursorAgentMode {
  const configured = options.config.cloaking.cursor?.["agent-mode"];
  if (configured === "plan" || configured === "agent") return configured;
  return "ask";
}

function cursorWorkspace(options: CallCursorResponsesOptions): string {
  const configured = options.config.cloaking.cursor?.workspace;
  return configured ? path.resolve(configured) : process.cwd();
}

function spawnCursorAgent(
  args: string[],
  workspace: string,
): ChildProcessWithoutNullStreams {
  const configured =
    process.env.CURSOR_AGENT_COMMAND ||
    (process.platform === "win32" ? undefined : "cursor-agent");

  if (process.platform === "win32" && !configured) {
    const localAppData = process.env.LOCALAPPDATA;
    const script = localAppData
      ? path.join(localAppData, "cursor-agent", "cursor-agent.ps1")
      : "";
    if (!script || !fs.existsSync(script)) {
      throw new Error(
        "Cursor Agent CLI not found; install it or set CURSOR_AGENT_COMMAND",
      );
    }
    return spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      {
        cwd: workspace,
        env: process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  }

  return spawn(configured || "cursor-agent", args, {
    cwd: workspace,
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function assistantDelta(parsed: any): string {
  if (parsed?.type !== "assistant") return "";
  return textFromContent(parsed?.message?.content);
}

function responseStream(
  child: ChildProcessWithoutNullStreams,
  model: string,
  format: CursorSseFormat,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): ReadableStream<Uint8Array> {
  const responseId = `resp_cursor_${Date.now().toString(36)}`;
  const messageId = `msg_cursor_${Date.now().toString(36)}`;
  const createdAt = Math.floor(Date.now() / 1000);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let stdoutBuffer = "";
      let stderr = "";
      let fullText = "";
      let completed = false;
      let sequence = 0;

      const write = (chunk: string): void => {
        controller.enqueue(encoder.encode(chunk));
      };
      const emitText = (delta: string): void => {
        if (!delta) return;
        fullText += delta;
        if (format === "openai-responses") {
          write(
            event("response.output_text.delta", {
              type: "response.output_text.delta",
              sequence_number: sequence++,
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              delta,
            }),
          );
        } else if (format === "openai-chat-completions") {
          write(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created: createdAt,
              model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            })}\n\n`,
          );
        } else {
          write(
            event("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: delta },
            }),
          );
        }
      };

      if (format === "openai-responses") {
        const response = {
          id: responseId,
          object: "response",
          created_at: createdAt,
          status: "in_progress",
          model,
          output: [],
        };
        write(
          event("response.created", {
            type: "response.created",
            sequence_number: sequence++,
            response,
          }),
        );
        write(
          event("response.in_progress", {
            type: "response.in_progress",
            sequence_number: sequence++,
            response,
          }),
        );
        write(
          event("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: sequence++,
            output_index: 0,
            item: {
              id: messageId,
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: [],
            },
          }),
        );
        write(
          event("response.content_part.added", {
            type: "response.content_part.added",
            sequence_number: sequence++,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }),
        );
      } else if (format === "openai-chat-completions") {
        write(
          `data: ${JSON.stringify({
            id: responseId,
            object: "chat.completion.chunk",
            created: createdAt,
            model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "" },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
      } else {
        write(
          event("message_start", {
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }),
        );
        write(
          event("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
        );
      }

      const finish = (error?: string): void => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);

        if (error) {
          if (format === "openai-responses") {
            write(
              event("response.failed", {
                type: "response.failed",
                sequence_number: sequence++,
                response: {
                  id: responseId,
                  object: "response",
                  created_at: createdAt,
                  status: "failed",
                  model,
                  output: [],
                  error: { code: "cursor_cli_error", message: error },
                },
              }),
            );
          } else {
            write(
              event("error", {
                type: "error",
                error: { type: "cursor_cli_error", message: error },
              }),
            );
          }
          controller.close();
          return;
        }

        if (format === "openai-responses") {
          const item = {
            id: messageId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: fullText,
                annotations: [],
              },
            ],
          };
          write(
            event("response.output_text.done", {
              type: "response.output_text.done",
              sequence_number: sequence++,
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              text: fullText,
            }),
          );
          write(
            event("response.content_part.done", {
              type: "response.content_part.done",
              sequence_number: sequence++,
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              part: item.content[0],
            }),
          );
          write(
            event("response.output_item.done", {
              type: "response.output_item.done",
              sequence_number: sequence++,
              output_index: 0,
              item,
            }),
          );
          write(
            event("response.completed", {
              type: "response.completed",
              sequence_number: sequence++,
              response: {
                id: responseId,
                object: "response",
                created_at: createdAt,
                status: "completed",
                model,
                output: [item],
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  total_tokens: 0,
                },
              },
            }),
          );
        } else if (format === "openai-chat-completions") {
          write(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created: createdAt,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\ndata: [DONE]\n\n`,
          );
        } else {
          write(
            event("content_block_stop", {
              type: "content_block_stop",
              index: 0,
            }),
          );
          write(
            event("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 0 },
            }),
          );
          write(event("message_stop", { type: "message_stop" }));
        }
        controller.close();
      };

      const consumeLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        const delta = assistantDelta(parsed);
        if (delta) emitText(delta);
        if (parsed?.type === "result" && parsed?.subtype === "success") {
          const result = typeof parsed.result === "string" ? parsed.result : "";
          if (!fullText && result) emitText(result);
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        let newline = stdoutBuffer.indexOf("\n");
        while (newline >= 0) {
          consumeLine(stdoutBuffer.slice(0, newline));
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          newline = stdoutBuffer.indexOf("\n");
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      child.on("error", (error) => finish(error.message));
      child.on("close", (code) => {
        if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
        if (code === 0) finish();
        else finish(stderr.trim() || `cursor-agent exited with code ${code}`);
      });

      const abort = (): void => {
        child.kill();
        finish("request aborted");
      };
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        child.kill();
        finish(`cursor-agent timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      timer.unref();
    },
    cancel() {
      child.kill();
    },
  });
}

export async function callCursorCliResponses(
  options: CallCursorResponsesOptions,
): Promise<Response> {
  if (!process.env.CURSOR_API_KEY) {
    return new Response(
      JSON.stringify({
        error: {
          message:
            "CURSOR_API_KEY is not set in the auth2api server environment",
          type: "authentication_error",
          provider: "cursor",
        },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const body = options.body ?? options.request.body;
  const model = forceMaxModel(String(body?.model || "cursor-default"));
  const workspace = cursorWorkspace(options);
  const mode = cursorAgentMode(options);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--trust",
    "--workspace",
    workspace,
    "--model",
    model,
  ];
  if (mode !== "agent") args.push("--mode", mode);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnCursorAgent(args, workspace);
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: {
          message: error?.message || String(error),
          type: "cursor_cli_error",
          provider: "cursor",
        },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  child.stdin.on("error", () => {
    // Process startup/exit errors are reported by the child handlers.
  });
  child.stdin.end(promptFromBody(body));
  const stream = responseStream(
    child,
    model,
    options.responseFormat || "openai-responses",
    options.signal,
    options.config.timeouts["stream-messages-ms"],
  );
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
