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

function withFakeAcp(extraEnv: Record<string, string> = {}) {
  const saved = new Map<string, string | undefined>();
  const entries: Record<string, string> = {
    CURSOR_API_KEY: "test-cursor-key",
    CURSOR_AGENT_NODE: process.execPath,
    CURSOR_AGENT_SCRIPT: path.resolve("tests/fixtures/fake-cursor-acp.mjs"),
    ...extraEnv,
  };
  for (const [key, value] of Object.entries(entries)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  return async () => {
    await __disposeCursorAcpPools();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

function lastFunctionCall(response: any): any | undefined {
  const items = (response.output || []).filter(
    (item: any) => item?.type === "function_call",
  );
  return items.at(-1);
}

async function callOnce(body: any, headers: Record<string, string> = {}) {
  const response = await callCursorAcpResponses({
    body,
    request: request(headers),
    account: {} as any,
    config: config(),
    responseFormat: "openai-responses",
  });
  assert.equal(response.status, 200);
  const stream = await response.text();
  return { stream, response: completedResponse(stream) };
}

/**
 * Mimics Codex: keep sending follow-up requests with function_call_output
 * ("unsupported call") for each tool-call boundary until the turn finishes
 * without one. Returns every chunk plus accumulated history input.
 */
async function runTurn(
  input: any,
  headers: Record<string, string> = {},
  model = "cursor-composer-2-fast",
) {
  const history: any[] = Array.isArray(input)
    ? [...input]
    : [{ role: "user", content: input }];
  const chunks: { stream: string; response: any }[] = [];
  let previousResponseId: string | undefined;
  for (let hop = 0; hop < 10; hop++) {
    const { stream, response } = await callOnce(
      {
        model,
        input: history,
        ...(previousResponseId
          ? { previous_response_id: previousResponseId }
          : {}),
      },
      headers,
    );
    previousResponseId = response.id;
    chunks.push({ stream, response });
    for (const item of response.output || []) {
      if (item) history.push(item);
    }
    const boundary = lastFunctionCall(response);
    if (!boundary) return { chunks, history, final: response };
    history.push({
      type: "function_call_output",
      call_id: boundary.call_id,
      output: `unsupported call: ${boundary.name}`,
    });
  }
  assert.fail("turn did not finish within 10 chunks");
}

function allText(chunks: { response: any }[]): string {
  return chunks
    .flatMap((chunk) => chunk.response.output || [])
    .filter((item: any) => item?.type === "message")
    .flatMap((item: any) => item.content || [])
    .map((part: any) => part?.text || "")
    .join("");
}

test("turn chunks at tool boundary: function_call persists, continuation finishes turn", async () => {
  const restore = withFakeAcp({ FAKE_ACP_INIT_DELAY_MS: "1500" });
  try {
    const startedAt = Date.now();
    const first = await callCursorAcpResponses({
      body: { model: "cursor-composer-2-fast", input: "Say hello" },
      request: request({ "thread-id": "codex-thread-chunks" }),
      account: {} as any,
      config: config(),
      responseFormat: "openai-responses",
    });
    assert.ok(
      Date.now() - startedAt < 1000,
      "Responses SSE should start before cursor-agent initializes",
    );
    assert.equal(first.status, 200);
    const firstStream = await first.text();

    // Chunk 1: reasoning (plan + thought) then a real function_call item.
    assert.match(firstStream, /event: response\.created/);
    assert.match(firstStream, /event: response\.reasoning_summary_text\.delta/);
    assert.match(firstStream, /Inspecting first\./);
    assert.match(firstStream, /\[plan\]/);
    assert.match(firstStream, /event: response\.output_item\.added/);
    assert.match(firstStream, /"type":"function_call"/);
    assert.match(firstStream, /"name":"cursor_read"/);
    assert.match(firstStream, /README\.md/);
    assert.match(firstStream, /event: response\.completed/);
    const firstCompleted = completedResponse(firstStream);
    const boundary = lastFunctionCall(firstCompleted);
    assert.ok(boundary);
    assert.equal(boundary.name, "cursor_read");
    assert.match(boundary.call_id, /^call_cursor_tool-1$/);

    // Chunk 2 (continuation with function_call_output): tool result note as
    // reasoning, final text, completed without another function_call.
    const { stream: secondStream, response: second } = await callOnce(
      {
        model: "cursor-composer-2-fast",
        input: [
          { role: "user", content: "Say hello" },
          boundary,
          {
            type: "function_call_output",
            call_id: boundary.call_id,
            output: `unsupported call: ${boundary.name}`,
          },
        ],
      },
      { "thread-id": "codex-thread-chunks" },
    );
    assert.match(secondStream, /\[cursor_read completed\]/);
    assert.match(secondStream, /event: response\.output_text\.delta/);
    assert.match(secondStream, /Done\./);
    assert.equal(lastFunctionCall(second), undefined);
    assert.equal(
      second.metadata.cursor_session_id,
      firstCompleted.metadata.cursor_session_id,
    );
  } finally {
    await restore();
  }
});

test("ACP turn can be cancelled and remains retrievable", async () => {
  const restore = withFakeAcp();
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
    await restore();
  }
});

test("steer text in continuation cancels turn and prompts same ACP session", async () => {
  const restore = withFakeAcp();
  try {
    const { stream } = await callOnce(
      { model: "cursor-composer-2-fast", input: "Original task" },
      { "thread-id": "codex-thread-steer" },
    );
    const firstCompleted = completedResponse(stream);
    const boundary = lastFunctionCall(firstCompleted);
    assert.ok(boundary, "first chunk should end at a tool boundary");

    // Codex delivers steer input in the follow-up request: history includes
    // the function_call_output AND a fresh user message after it.
    const { response: steered } = await callOnce(
      {
        model: "cursor-composer-2-fast",
        input: [
          { role: "user", content: "Original task" },
          boundary,
          {
            type: "function_call_output",
            call_id: boundary.call_id,
            output: `unsupported call: ${boundary.name}`,
          },
          { role: "user", content: "Changed direction" },
        ],
      },
      { "thread-id": "codex-thread-steer" },
    );

    const chunks = [{ response: steered }];
    // Steer starts a fresh Cursor prompt, which may chunk at its own tool
    // boundary; follow it to the end like Codex would.
    let current = steered;
    let history: any[] = [];
    while (lastFunctionCall(current)) {
      const next = lastFunctionCall(current);
      history = [
        { role: "user", content: "Changed direction" },
        next,
        {
          type: "function_call_output",
          call_id: next.call_id,
          output: `unsupported call: ${next.name}`,
        },
      ];
      const { response } = await callOnce(
        { model: "cursor-composer-2-fast", input: history },
        { "thread-id": "codex-thread-steer" },
      );
      current = response;
      chunks.push({ response });
    }

    assert.match(allText(chunks), /prompt=Changed direction$/);
    assert.equal(
      current.metadata.cursor_session_id,
      firstCompleted.metadata.cursor_session_id,
    );
  } finally {
    await restore();
  }
});

test("ACP turn survives client disconnect and stores a terminal response", async () => {
  const restore = withFakeAcp();
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
    // The chunk ends at the fixture's tool boundary even with no consumer.
    assert.match(JSON.stringify(stored), /cursor_read/);
  } finally {
    await restore();
  }
});

test("Codex thread header reuses one ACP session and sends only new user turn", async () => {
  const restore = withFakeAcp();
  try {
    const firstTurn = await runTurn("First turn", {
      "thread-id": "codex-thread-1",
    });
    assert.match(allText(firstTurn.chunks), /prompt=First turn$/);

    const secondTurn = await runTurn(
      [
        { role: "user", content: "First turn" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Second turn" },
      ],
      { "thread-id": "codex-thread-1" },
    );
    const secondText = allText(secondTurn.chunks);
    assert.match(secondText, /prompt=Second turn$/);
    assert.doesNotMatch(secondText, /First answer/);
    assert.equal(
      secondTurn.final.metadata.cursor_session_id,
      firstTurn.final.metadata.cursor_session_id,
    );
  } finally {
    await restore();
  }
});

test("previous_response_id continues ACP session without Codex headers", async () => {
  const restore = withFakeAcp();
  try {
    const first = await runTurn("First generic turn");
    const second = await callOnce({
      model: "cursor-composer-2-fast",
      input: "Second generic turn",
      previous_response_id: first.final.id,
    });
    // Second turn may chunk; just verify the session carried over.
    assert.equal(
      second.response.metadata.cursor_session_id,
      first.final.metadata.cursor_session_id,
    );
  } finally {
    await restore();
  }
});

test("new prompt while turn is live cancels it and reuses the session", async () => {
  const restore = withFakeAcp();
  try {
    // Chunk 1 ends at the tool boundary while the fixture turn keeps running.
    const { response: firstChunk } = await callOnce(
      { model: "cursor-composer-2-fast", input: "Concurrent one" },
      { "thread-id": "codex-thread-replace" },
    );
    assert.ok(lastFunctionCall(firstChunk));

    // A brand-new prompt (no boundary output) replaces the live turn.
    const replacement = await runTurn("Concurrent two", {
      "thread-id": "codex-thread-replace",
    });
    assert.match(allText(replacement.chunks), /prompt=Concurrent two$/);
    assert.equal(
      replacement.final.metadata.cursor_session_id,
      firstChunk.metadata.cursor_session_id,
    );
  } finally {
    await restore();
  }
});

test("persisted Codex thread loads its Cursor ACP session after process restart", async () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-acp-"));
  const restore = withFakeAcp({ FAKE_ACP_LOAD_SESSION: "true" });
  const callWithDir = async (input: any, headers: Record<string, string>) => {
    const history: any[] = [{ role: "user", content: input }];
    let final: any;
    for (let hop = 0; hop < 10; hop++) {
      const response = await callCursorAcpResponses({
        body: { model: "cursor-composer-2-fast", input: history },
        request: request(headers),
        account: {} as any,
        config: config(authDir),
        responseFormat: "openai-responses",
      });
      const completed = completedResponse(await response.text());
      final = completed;
      for (const item of completed.output || []) history.push(item);
      const boundary = lastFunctionCall(completed);
      if (!boundary) break;
      history.push({
        type: "function_call_output",
        call_id: boundary.call_id,
        output: `unsupported call: ${boundary.name}`,
      });
    }
    const text = (final.output || [])
      .filter((item: any) => item?.type === "message")
      .flatMap((item: any) => item.content || [])
      .map((part: any) => part?.text || "")
      .join("");
    return { final, text };
  };
  try {
    const first = await callWithDir("Before restart", {
      "thread-id": "codex-thread-persisted",
    });
    await __disposeCursorAcpPools();

    const second = await callWithDir("After restart", {
      "thread-id": "codex-thread-persisted",
    });
    assert.equal(
      second.final.metadata.cursor_session_id,
      first.final.metadata.cursor_session_id,
    );
    assert.match(second.text, /loaded=true/);
    assert.match(second.text, /prompt=After restart$/);
  } finally {
    await restore();
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});
