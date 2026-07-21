import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  __disposeCursorAcpPools,
  cancelCursorAcpResponse,
  callCursorAcpResponses,
  getCursorAcpResponse,
  steerCursorAcpResponse,
} from "../src/upstream/cursor-acp";
import { Config } from "../src/config";

function config(authDir = "/tmp/auth2api-test"): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
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

function completedResponse(stream: string): any {
  for (const line of stream.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = JSON.parse(line.slice(6));
    if (data.type === "response.completed") return data.response;
  }
  assert.fail("response.completed event missing");
}

function request(headers: Record<string, string> = {}): any {
  return { body: {}, path: "/v1/responses", headers };
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

test("steer cancels active turn and continues same ACP session", async () => {
  const oldKey = process.env.CURSOR_API_KEY;
  const oldNode = process.env.CURSOR_AGENT_NODE;
  const oldScript = process.env.CURSOR_AGENT_SCRIPT;
  process.env.CURSOR_API_KEY = "test-cursor-key";
  process.env.CURSOR_AGENT_NODE = process.execPath;
  process.env.CURSOR_AGENT_SCRIPT = path.resolve(
    "tests/fixtures/fake-cursor-acp.mjs",
  );

  try {
    const first = await callCursorAcpResponses({
      body: { model: "cursor-composer-2-fast", input: "Original task" },
      request: request({ "thread-id": "codex-thread-steer" }),
      account: {} as any,
      config: config(),
      responseFormat: "openai-responses",
    });
    const reader = first.body!.getReader();
    const decoder = new TextDecoder();
    let firstEvents = "";
    while (!firstEvents.includes("response.cursor.tool_call")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      firstEvents += decoder.decode(chunk.value, { stream: true });
    }
    const responseId = firstEvents.match(/"id":"([^"]+)"/)?.[1];
    const firstSessionId = firstEvents.match(/"session_id":"([^"]+)"/)?.[1];
    assert.ok(responseId);
    assert.ok(firstSessionId);
    assert.deepEqual(steerCursorAcpResponse(responseId), {
      model: "cursor-composer-2-fast",
    });

    const steered = await callCursorAcpResponses({
      body: {
        model: "cursor-composer-2-fast",
        input: "Changed direction",
        previous_response_id: responseId,
      },
      request: request({ "thread-id": "codex-thread-steer" }),
      account: {} as any,
      config: config(),
      responseFormat: "openai-responses",
    });
    const steeredCompleted = completedResponse(await steered.text());

    assert.match(
      steeredCompleted.output.at(-1).content[0].text,
      /prompt=Changed direction$/,
    );
    assert.equal(steeredCompleted.metadata.cursor_session_id, firstSessionId);
    assert.equal(getCursorAcpResponse(responseId)?.status, "cancelled");
    await reader.cancel();
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

test("Codex thread header reuses one ACP session and sends only new user turn", async () => {
  const oldKey = process.env.CURSOR_API_KEY;
  const oldNode = process.env.CURSOR_AGENT_NODE;
  const oldScript = process.env.CURSOR_AGENT_SCRIPT;
  process.env.CURSOR_API_KEY = "test-cursor-key";
  process.env.CURSOR_AGENT_NODE = process.execPath;
  process.env.CURSOR_AGENT_SCRIPT = path.resolve(
    "tests/fixtures/fake-cursor-acp.mjs",
  );

  try {
    const first = await callCursorAcpResponses({
      body: { model: "cursor-composer-2-fast", input: "First turn" },
      request: request({ "thread-id": "codex-thread-1" }),
      account: {} as any,
      config: config(),
      responseFormat: "openai-responses",
    });
    const firstCompleted = completedResponse(await first.text());

    const second = await callCursorAcpResponses({
      body: {
        model: "cursor-composer-2-fast",
        input: [
          { role: "user", content: "First turn" },
          { role: "assistant", content: "First answer" },
          { role: "user", content: "Second turn" },
        ],
      },
      request: request({ "thread-id": "codex-thread-1" }),
      account: {} as any,
      config: config(),
      responseFormat: "openai-responses",
    });
    const secondCompleted = completedResponse(await second.text());

    assert.equal(
      secondCompleted.metadata.cursor_session_id,
      firstCompleted.metadata.cursor_session_id,
    );
    const secondText = secondCompleted.output.at(-1).content[0].text;
    assert.match(secondText, /prompt=Second turn$/);
    assert.doesNotMatch(secondText, /First answer/);
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

test("previous_response_id continues ACP session without Codex headers", async () => {
  const oldKey = process.env.CURSOR_API_KEY;
  const oldNode = process.env.CURSOR_AGENT_NODE;
  const oldScript = process.env.CURSOR_AGENT_SCRIPT;
  process.env.CURSOR_API_KEY = "test-cursor-key";
  process.env.CURSOR_AGENT_NODE = process.execPath;
  process.env.CURSOR_AGENT_SCRIPT = path.resolve(
    "tests/fixtures/fake-cursor-acp.mjs",
  );

  try {
    const first = await callCursorAcpResponses({
      body: { model: "cursor-composer-2-fast", input: "First generic turn" },
      request: request(),
      account: {} as any,
      config: config(),
      responseFormat: "openai-responses",
    });
    const firstCompleted = completedResponse(await first.text());

    const second = await callCursorAcpResponses({
      body: {
        model: "cursor-composer-2-fast",
        input: "Second generic turn",
        previous_response_id: firstCompleted.id,
      },
      request: request(),
      account: {} as any,
      config: config(),
      responseFormat: "openai-responses",
    });
    const secondCompleted = completedResponse(await second.text());

    assert.equal(
      secondCompleted.metadata.cursor_session_id,
      firstCompleted.metadata.cursor_session_id,
    );
    assert.match(
      secondCompleted.output.at(-1).content[0].text,
      /prompt=Second generic turn$/,
    );
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

test("overlapping turns for one Codex thread are serialized", async () => {
  const oldKey = process.env.CURSOR_API_KEY;
  const oldNode = process.env.CURSOR_AGENT_NODE;
  const oldScript = process.env.CURSOR_AGENT_SCRIPT;
  process.env.CURSOR_API_KEY = "test-cursor-key";
  process.env.CURSOR_AGENT_NODE = process.execPath;
  process.env.CURSOR_AGENT_SCRIPT = path.resolve(
    "tests/fixtures/fake-cursor-acp.mjs",
  );

  try {
    const makeTurn = async (input: string) => {
      const response = await callCursorAcpResponses({
        body: { model: "cursor-composer-2-fast", input },
        request: request({ "thread-id": "codex-thread-serialized" }),
        account: {} as any,
        config: config(),
        responseFormat: "openai-responses",
      });
      return completedResponse(await response.text());
    };
    const [first, second] = await Promise.all([
      makeTurn("Concurrent one"),
      makeTurn("Concurrent two"),
    ]);

    assert.equal(
      second.metadata.cursor_session_id,
      first.metadata.cursor_session_id,
    );
    assert.match(first.output.at(-1).content[0].text, /prompt=Concurrent one$/);
    assert.match(
      second.output.at(-1).content[0].text,
      /prompt=Concurrent two$/,
    );
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

test("persisted Codex thread loads its Cursor ACP session after process restart", async () => {
  const oldKey = process.env.CURSOR_API_KEY;
  const oldNode = process.env.CURSOR_AGENT_NODE;
  const oldScript = process.env.CURSOR_AGENT_SCRIPT;
  const oldLoadSession = process.env.FAKE_ACP_LOAD_SESSION;
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-acp-"));
  process.env.CURSOR_API_KEY = "test-cursor-key";
  process.env.CURSOR_AGENT_NODE = process.execPath;
  process.env.CURSOR_AGENT_SCRIPT = path.resolve(
    "tests/fixtures/fake-cursor-acp.mjs",
  );
  process.env.FAKE_ACP_LOAD_SESSION = "true";

  try {
    const first = await callCursorAcpResponses({
      body: { model: "cursor-composer-2-fast", input: "Before restart" },
      request: request({ "thread-id": "codex-thread-persisted" }),
      account: {} as any,
      config: config(authDir),
      responseFormat: "openai-responses",
    });
    const firstCompleted = completedResponse(await first.text());
    await __disposeCursorAcpPools();

    const second = await callCursorAcpResponses({
      body: { model: "cursor-composer-2-fast", input: "After restart" },
      request: request({ "thread-id": "codex-thread-persisted" }),
      account: {} as any,
      config: config(authDir),
      responseFormat: "openai-responses",
    });
    const secondCompleted = completedResponse(await second.text());
    const secondText = secondCompleted.output.at(-1).content[0].text;

    assert.equal(
      secondCompleted.metadata.cursor_session_id,
      firstCompleted.metadata.cursor_session_id,
    );
    assert.match(secondText, /loaded=true/);
    assert.match(secondText, /prompt=After restart$/);
  } finally {
    await __disposeCursorAcpPools();
    fs.rmSync(authDir, { recursive: true, force: true });
    if (oldKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = oldKey;
    if (oldNode === undefined) delete process.env.CURSOR_AGENT_NODE;
    else process.env.CURSOR_AGENT_NODE = oldNode;
    if (oldScript === undefined) delete process.env.CURSOR_AGENT_SCRIPT;
    else process.env.CURSOR_AGENT_SCRIPT = oldScript;
    if (oldLoadSession === undefined) delete process.env.FAKE_ACP_LOAD_SESSION;
    else process.env.FAKE_ACP_LOAD_SESSION = oldLoadSession;
  }
});
