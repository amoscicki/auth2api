// Probe: what thread/turn notifications does codex app-server emit to clients
// (i.e. what the mobile app sees) while the ACP bridge runs a tool-using turn.
import { spawn } from "node:child_process";
import readline from "node:readline";

const child = spawn(
  "codex",
  [
    "app-server",
    "-c", 'model_provider="cursor"',
    "-c", 'model="cursor-composer-2-fast"',
  ],
  { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" },
);

const rl = readline.createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();
const seen = new Map(); // method -> count
let log = [];

function send(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
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

const turnDone = new Promise((resolve) => {
  rl.on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && (m.result !== undefined || m.error)) {
      const e = pending.get(m.id);
      if (e) {
        pending.delete(m.id);
        m.error ? e.reject(new Error(JSON.stringify(m.error))) : e.resolve(m.result);
      }
      return;
    }
    if (!m.method) return;
    seen.set(m.method, (seen.get(m.method) || 0) + 1);
    const p = m.params || {};
    if (m.method === "item/started" || m.method === "item/completed") {
      log.push(`${m.method}: type=${p.item?.type} ${JSON.stringify(p.item).slice(0, 160)}`);
    } else if (m.method.includes("delta")) {
      if ((seen.get(m.method) || 0) <= 3)
        log.push(`${m.method}: ${JSON.stringify(p).slice(0, 140)}`);
    } else if (m.method.startsWith("turn/")) {
      log.push(`${m.method}`);
      if (m.method === "turn/completed" || m.method === "turn/failed") resolve(m);
    } else {
      log.push(`${m.method}: ${JSON.stringify(p).slice(0, 120)}`);
    }
  });
});

await send("initialize", {
  clientInfo: { name: "event-probe", version: "0.1.0" },
  capabilities: { experimentalApi: true },
});
notify("initialized", {});
const thread = await send("thread/start", { cwd: "P:\\tmp\\acp-workspace" });
const threadId = thread.thread?.id || thread.threadId || thread.id;
console.log("[probe] thread:", threadId);

await send("turn/start", {
  threadId,
  input: [{
    type: "text",
    text: "Using one terminal command per step: (1) create file probe1.txt with content PROBE_ONE, (2) run powershell -c \"Start-Sleep 3\", (3) create probe2.txt with content PROBE_TWO. Then reply exactly PROBE_DONE.",
  }],
});

const done = await Promise.race([
  turnDone,
  new Promise((r) => setTimeout(() => r(null), 180_000)),
]);
console.log("[probe] terminal:", done ? done.method : "TIMEOUT");
console.log("\n[probe] notification counts:");
for (const [k, v] of [...seen.entries()].sort()) console.log(`  ${k}: ${v}`);
console.log("\n[probe] event log:");
for (const l of log) console.log("  " + l);
child.kill();
process.exit(0);
