import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
let promptRequest;
let promptTimer;
let sessionCounter = 0;
const loadedSessions = new Set();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function update(sessionId, value) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: value },
  });
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    setTimeout(
      () =>
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: process.env.FAKE_ACP_LOAD_SESSION === "true",
            },
          },
        }),
      Number(process.env.FAKE_ACP_INIT_DELAY_MS || 0),
    );
    return;
  }
  if (message.method === "session/new") {
    sessionCounter += 1;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: `fake-session-${process.pid}-${sessionCounter}` },
    });
    return;
  }
  if (message.method === "session/load") {
    loadedSessions.add(message.params.sessionId);
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt") {
    promptRequest = message;
    const sessionId = message.params.sessionId;
    update(sessionId, {
      sessionUpdate: "plan",
      entries: [
        {
          content: "Inspect workspace",
          status: "in_progress",
          priority: "high",
        },
      ],
    });
    update(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Inspecting first." },
    });
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read README.md",
      kind: "read",
      status: "pending",
      rawInput: { path: "README.md" },
    });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: { bytes: 42 },
    });
    promptTimer = setTimeout(() => {
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `Done. session=${sessionId} loaded=${loadedSessions.has(sessionId)} prompt=${message.params.prompt?.[0]?.text || ""}`,
        },
      });
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "end_turn" },
      });
    }, 30);
    return;
  }
  if (message.method === "session/cancel") {
    clearTimeout(promptTimer);
    if (promptRequest) {
      send({
        jsonrpc: "2.0",
        id: promptRequest.id,
        result: { stopReason: "cancelled" },
      });
      promptRequest = undefined;
    }
  }
});
