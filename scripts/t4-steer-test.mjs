// T4: native steer through codex app-server v2 against the ACP bridge.
// Starts a long multi-tool turn, then steers mid-turn; verifies the steer
// text reaches the Cursor session and the turn completes with the steered
// output. Usage: node scripts/t4-steer-test.mjs
import { spawn } from "node:child_process";
import readline from "node:readline";

const child = spawn(
  "codex",
  [
    "app-server",
    "-c",
    'model_provider="cursor"',
    "-c",
    'model="cursor-composer-2-fast"',
  ],
  { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" },
);

const rl = readline.createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();
const notifications = [];
let agentDeltas = "";

function send(method, params) {
  const id = nextId++;
  const message = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(`${JSON.stringify(message)}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 120_000).unref();
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

const turnDone = { resolved: false, resolve: null };
const turnDonePromise = new Promise((resolve) => (turnDone.resolve = resolve));

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && (message.result !== undefined || message.error)) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error)
      entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
    return;
  }
  if (message.method) {
    notifications.push(message);
    if (message.method === "item/agentMessage/delta") {
      agentDeltas += message.params?.delta || "";
    }
    if (
      message.method === "item/completed" &&
      message.params?.item?.type === "agentMessage"
    ) {
      agentDeltas += `\n[item] ${message.params.item.text || ""}`;
    }
    if (message.method === "turn/completed" || message.method === "turn/failed") {
      turnDone.resolved = true;
      turnDone.resolve(message);
    }
  }
});

const initialized = await send("initialize", {
  clientInfo: { name: "auth2api-t4", version: "0.1.0" },
  capabilities: { experimentalApi: true },
});
notify("initialized", {});
console.log("[t4] initialized:", JSON.stringify(initialized).slice(0, 200));

const thread = await send("thread/start", {
  cwd: "P:\\tmp\\acp-workspace",
});
const threadId = thread.thread?.id || thread.threadId || thread.id;
console.log("[t4] thread:", threadId);

const turnStarted = await send("turn/start", {
  threadId,
  input: [
    {
      type: "text",
      text: "Long task: using ONE terminal command per step, slowly count from 1 to 8. For each number N run: powershell -c \"Start-Sleep 2; Write-Output N\". Report each result before the next step. Do all 8 steps.",
    },
  ],
});
const turnId = turnStarted.turn?.id;
console.log(`[t4] turn started id=${turnId}; waiting 15s before steer...`);
await new Promise((resolve) => setTimeout(resolve, 15_000));

console.log("[t4] sending turn/steer...");
try {
  const steer = await send("turn/steer", {
    threadId,
    expectedTurnId: turnId,
    input: [
      {
        type: "text",
        text: "STOP counting immediately. Reply exactly T4_STEER_OK and end the task.",
      },
    ],
  });
  console.log("[t4] steer accepted:", JSON.stringify(steer).slice(0, 200));
} catch (error) {
  console.log("[t4] steer REJECTED:", error.message);
}

const done = await Promise.race([
  turnDonePromise,
  new Promise((resolve) => setTimeout(() => resolve(null), 150_000)),
]);
console.log("[t4] turn terminal:", done ? done.method : "TIMEOUT");
console.log("[t4] agent text tail:", agentDeltas.slice(-500));
const methods = [...new Set(notifications.map((n) => n.method))];
console.log("[t4] notification methods seen:", methods.join(", "));
child.kill();
process.exit(0);
