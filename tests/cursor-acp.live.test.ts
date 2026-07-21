import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  __disposeCursorAcpPools,
  callCursorAcpResponses,
} from "../src/upstream/cursor-acp";
import { Config } from "../src/config";

test(
  "live Composer ACP streams a real tool call and completes",
  { skip: process.env.AUTH2API_LIVE_CURSOR !== "1", timeout: 300_000 },
  async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "auth2api-acp-live-"),
    );
    await fs.writeFile(path.join(workspace, "hello.txt"), "HELLO_FROM_ACP\n");
    const config: Config = {
      host: "127.0.0.1",
      port: 0,
      "auth-dir": workspace,
      "api-keys": new Set(["test-key"]),
      "body-limit": "200mb",
      cloaking: {
        cursor: { transport: "acp", workspace, "heartbeat-ms": 1_000 },
      },
      timeouts: {
        "messages-ms": 120_000,
        "stream-messages-ms": 180_000,
        "count-tokens-ms": 30_000,
      },
      stats: { enabled: false },
      debug: "off",
    };

    try {
      const request = {
        body: {},
        path: "/v1/responses",
        headers: { "thread-id": "live-composer-continuation" },
      } as any;
      const response = await callCursorAcpResponses({
        body: {
          model: "cursor-composer-2-fast",
          input:
            "Read hello.txt with your file tool. Reply with only its exact content.",
        },
        request,
        account: {} as any,
        config,
        responseFormat: "openai-responses",
      });
      const stream = await response.text();
      assert.match(stream, /event: response\.cursor\.tool_call/);
      assert.match(stream, /HELLO_FROM_ACP/);
      assert.match(stream, /event: response\.completed/);
      assert.doesNotMatch(stream, /event: response\.failed/);

      const firstSessionId = stream.match(/"cursor_session_id":"([^"]+)"/)?.[1];
      assert.ok(firstSessionId);
      const continued = await callCursorAcpResponses({
        body: {
          model: "cursor-composer-2-fast",
          input:
            "Without reading the file again, reply with only the exact content you returned in the previous turn.",
        },
        request,
        account: {} as any,
        config,
        responseFormat: "openai-responses",
      });
      const continuedStream = await continued.text();
      assert.match(continuedStream, /HELLO_FROM_ACP/);
      assert.match(
        continuedStream,
        new RegExp(`"cursor_session_id":"${firstSessionId}"`),
      );
      assert.doesNotMatch(continuedStream, /event: response\.failed/);
    } finally {
      await __disposeCursorAcpPools();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  },
);
