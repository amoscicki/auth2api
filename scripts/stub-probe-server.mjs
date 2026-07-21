// F0 recon stub: serves /v1/responses, first request returns a synthetic
// function_call (unknown tool), follow-up request gets logged verbatim so we
// can see exactly how Codex ships function_call_output + steer input back.
// Usage: node scripts/stub-probe-server.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.argv[2] || 8399);
const logPath = path.resolve("scripts", "stub-probe-requests.jsonl");

function sse(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

let counter = 0;

const server = http.createServer((req, res) => {
  if (!req.url?.includes("/responses") || req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {}
    fs.appendFileSync(
      logPath,
      JSON.stringify({ at: new Date().toISOString(), headers: req.headers, body }) + "\n",
    );
    const input = Array.isArray(body.input) ? body.input : [];
    const hasProbeOutput = input.some(
      (item) =>
        item?.type === "function_call_output" &&
        String(item?.call_id || "").startsWith("call_cursor_probe"),
    );
    const responseId = `resp_stub_${++counter}`;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sse(res, "response.created", {
      response: { id: responseId, object: "response", status: "in_progress", output: [] },
    });
    if (!hasProbeOutput) {
      const item = {
        id: "fc_stub_1",
        type: "function_call",
        call_id: "call_cursor_probe_1",
        name: "cursor_execute",
        arguments: JSON.stringify({
          title: "Run `whoami` in terminal",
          rawInput: { command: "whoami" },
        }),
        status: "completed",
      };
      sse(res, "response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
      sse(res, "response.output_item.done", { output_index: 0, item });
      sse(res, "response.completed", {
        response: {
          id: responseId,
          object: "response",
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      console.log("[stub] phase1: sent function_call cursor_execute");
    } else {
      const msg = {
        id: "msg_stub_1",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "PROBE_DONE", annotations: [] }],
      };
      sse(res, "response.output_item.added", { output_index: 0, item: { ...msg, status: "in_progress", content: [] } });
      sse(res, "response.output_text.delta", {
        item_id: "msg_stub_1",
        output_index: 0,
        content_index: 0,
        delta: "PROBE_DONE",
      });
      sse(res, "response.output_item.done", { output_index: 0, item: msg });
      sse(res, "response.completed", {
        response: {
          id: responseId,
          object: "response",
          status: "completed",
          output: [msg],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      console.log("[stub] phase2: got function_call_output, sent PROBE_DONE");
    }
    res.end();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[stub] listening on 127.0.0.1:${port}, log: ${logPath}`);
});
