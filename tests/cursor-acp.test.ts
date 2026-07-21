import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  __disposeCursorAcpPools,
  cancelCursorAcpResponse,
  callCursorAcpResponses,
  getCursorAcpResponse,
} from "../src/upstream/cursor-acp";
import { Config } from "../src/config";

function config(): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": "/tmp/auth2api-test",
    "api-keys": new Set(["test-key"]),
    "body-limit": "200mb",
    cloaking: {
      cursor: {
        transport: "acp",
        workspace: process.cwd(),
        "heartbeat-ms": 10,
      },
    },
    timeouts: {
      "messages-ms": 120000,
      "stream-messages-ms": 1000,
      "count-tokens-ms": 30000,
    },
    stats: { enabled: false },
    debug: "off",
  };
}

async function waitForTerminalResponse(responseId: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const stored = getCursorAcpResponse(responseId);
    if (stored?.status !== "in_progress") return stored;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return getCursorAcpResponse(responseId);
}

test("Responses stream exposes ACP reasoning, plan, tool progress, text, and completion", async () => {
  const oldKey = process.env.CURSOR_API_KEY;
  const oldNode = process.env.CURSOR_AGENT_NODE;
  const oldScript = process.env.CURSOR_AGENT_SCRIPT;
  const oldInitDelay = process.env.FAKE_ACP_INIT_DELAY_MS;
  process.env.CURSOR_API_KEY = "test-cursor-key";
  process.env.CURSOR_AGENT_NODE = process.execPath;
  process.env.CURSOR_AGENT_SCRIPT = path.resolve(
    "tests/fixtures/fake-cursor-acp.mjs",
  );
  process.env.FAKE_ACP_INIT_DELAY_MS = "200";

  try {
    const startedAt = Date.now();
    const response = await callCursorAcpResponses({
      body: { model: "cursor-composer-2-fast", input: "Say hello" },
      request: { body: {}, path: "/v1/responses" } as any,
      account: {} as any,
      config: config(),
      responseFormat: "openai-responses",
    });
    assert.ok(
      Date.now() - startedAt < 150,
      "Responses SSE should start before cursor-agent initializes",
    );
    assert.equal(response.status, 200);
    const stream = await response.text();

    assert.match(stream, /event: response\.created/);
    assert.match(stream, /event: response\.reasoning_summary_text\.delta/);
    assert.match(stream, /Inspecting first\./);
    assert.match(stream, /event: response\.cursor\.plan/);
    assert.match(stream, /event: response\.cursor\.tool_call\n/);
    assert.match(stream, /"toolCallId":"tool-1"/);
    assert.match(stream, /event: response\.cursor\.tool_call_update/);
    assert.match(stream, /: ping/);
    assert.match(stream, /event: response\.output_text\.delta/);
    assert.match(stream, /Done\./);
    assert.match(stream, /event: response\.completed/);
  } finally {
    await __disposeCursorAcpPools();
    if (oldKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = oldKey;
    if (oldNode === undefined) delete process.env.CURSOR_AGENT_NODE;
    else process.env.CURSOR_AGENT_NODE = oldNode;
    if (oldScript === undefined) delete process.env.CURSOR_AGENT_SCRIPT;
    else process.env.CURSOR_AGENT_SCRIPT = oldScript;
    if (oldInitDelay === undefined) delete process.env.FAKE_ACP_INIT_DELAY_MS;
    else process.env.FAKE_ACP_INIT_DELAY_MS = oldInitDelay;
  }
});

test("ACP turn can be cancelled and remains retrievable", async () => {
  const oldKey = process.env.CURSOR_API_KEY;
  const oldNode = process.env.CURSOR_AGENT_NODE;
  const oldScript = process.env.CURSOR_AGENT_SCRIPT;
  process.env.CURSOR_API_KEY = "test-cursor-key";
  process.env.CURSOR_AGENT_NODE = process.execPath;
  process.env.CURSOR_AGENT_SCRIPT = path.resolve(
    "tests/fixtures/fake-cursor-acp.mjs",
  );

  try {
    const response = await callCursorAcpResponses({
      body: { model: "cursor-composer-2-fast", input: "Long task" },
      request: { body: {}, path: "/v1/responses" } as any,
      account: {} as any,
      config: config(),
      responseFormat: "openai-responses",
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    const responseId = text.match(/"id":"([^"]+)"/)?.[1];
    assert.ok(responseId);
    assert.equal(cancelCursorAcpResponse(responseId), true);
    const rest = await new Response(
      new ReadableStream({
        async start(controller) {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            controller.enqueue(chunk.value);
          }
          controller.close();
        },
      }),
    ).text();
    assert.match(rest, /event: response\.cancelled/);
    assert.equal(getCursorAcpResponse(responseId)?.status, "cancelled");
  } finally {
    await __disposeCursorAcpPools();
    if (oldKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = oldKey;
    if (oldNode === undefined) delete process.env.CURSOR_AGENT_NODE;
    else process.env.CURSOR_AGENT_NODE = oldNode;
    if (oldScript === undefined) delete process.env.CURSOR_AGENT_SCRIPT;
    else process.env.CURSOR_AGENT_SCRIPT = oldScript;
  }
});

test("ACP turn survives client disconnect and stores its completed response", async () => {
  const oldKey = process.env.CURSOR_API_KEY;
  const oldNode = process.env.CURSOR_AGENT_NODE;
  const oldScript = process.env.CURSOR_AGENT_SCRIPT;
  process.env.CURSOR_API_KEY = "test-cursor-key";
  process.env.CURSOR_AGENT_NODE = process.execPath;
  process.env.CURSOR_AGENT_SCRIPT = path.resolve(
    "tests/fixtures/fake-cursor-acp.mjs",
  );

  try {
    const response = await callCursorAcpResponses({
      body: { model: "cursor-composer-2-fast", input: "Keep working" },
      request: { body: {}, path: "/v1/responses" } as any,
      account: {} as any,
      config: config(),
      responseFormat: "openai-responses",
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    const responseId = text.match(/"id":"([^"]+)"/)?.[1];
    assert.ok(responseId);
    await reader.cancel("simulated disconnect");
    const stored = await waitForTerminalResponse(responseId);
    assert.equal(stored?.status, "completed");
    assert.match(JSON.stringify(stored), /Done\./);
  } finally {
    await __disposeCursorAcpPools();
    if (oldKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = oldKey;
    if (oldNode === undefined) delete process.env.CURSOR_AGENT_NODE;
    else process.env.CURSOR_AGENT_NODE = oldNode;
    if (oldScript === undefined) delete process.env.CURSOR_AGENT_SCRIPT;
    else process.env.CURSOR_AGENT_SCRIPT = oldScript;
  }
});
