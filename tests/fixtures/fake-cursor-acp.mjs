import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
let promptRequest;
let promptTimer;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function update(value) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "fake-session", update: value },
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
            agentCapabilities: { loadSession: false },
          },
        }),
      Number(process.env.FAKE_ACP_INIT_DELAY_MS || 0),
    );
    return;
  }
  if (message.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "fake-session" },
    });
    return;
  }
  if (message.method === "session/prompt") {
    promptRequest = message;
    update({
      sessionUpdate: "plan",
      entries: [
        {
          content: "Inspect workspace",
          status: "in_progress",
          priority: "high",
        },
      ],
    });
    update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Inspecting first." },
    });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read README.md",
      kind: "read",
      status: "pending",
      rawInput: { path: "README.md" },
    });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: { bytes: 42 },
    });
    promptTimer = setTimeout(() => {
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done." },
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
