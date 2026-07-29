// Гейт ручного подтверждения: фейковое "расширение" на native messaging +
// сырые клиенты сокета. Проверяем approve/session/deny/timeout/forever и то,
// что health-check ping не гейтится.
const { spawn } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");

const DIR = path.join(os.tmpdir(), "ffmcp-approval-" + process.pid);
fs.mkdirSync(DIR, { recursive: true });
const env = { ...process.env, FFMCP_DIR: DIR, FFMCP_APPROVAL_TIMEOUT_MS: "1000" };
const ROOT = path.join(__dirname, "..");
const SOCK = path.join(DIR, "firefox.sock");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let okN = 0;
let failN = 0;
const pass = (m) => { okN++; console.log("✅ " + m); };
const fail = (m) => { failN++; process.exitCode = 1; console.log("❌ " + m); };

const host = spawn("node", [ROOT + "/bin/ffmcp-host.js"], { env, stdio: ["pipe", "pipe", "inherit"] });

function sendNative(msg) {
  const b = Buffer.from(JSON.stringify(msg));
  const h = Buffer.alloc(4);
  h.writeUInt32LE(b.length, 0);
  host.stdin.write(Buffer.concat([h, b]));
}

const policy = new Map(); // token -> { decision, scope } | { decision: "none" }
const approvalRequests = [];
const expired = [];

let hbuf = Buffer.alloc(0);
host.stdout.on("data", (d) => {
  hbuf = Buffer.concat([hbuf, d]);
  for (;;) {
    if (hbuf.length < 4) return;
    const len = hbuf.readUInt32LE(0);
    if (hbuf.length < 4 + len) return;
    const msg = JSON.parse(hbuf.subarray(4, 4 + len).toString());
    hbuf = hbuf.subarray(4 + len);
    if (msg.type === "call") {
      sendNative({ type: "result", id: msg.id, ok: true, value: { echoed: msg.op } });
    } else if (msg.type === "approval-request") {
      approvalRequests.push(msg);
      const p = policy.get(msg.token);
      if (p && p.decision !== "none") {
        setTimeout(() => sendNative({ type: "approval-decision", reqId: msg.reqId, decision: p.decision, scope: p.scope }), 30);
      }
    } else if (msg.type === "approval-expired") {
      expired.push(msg.reqId);
    }
  }
});

// Один вызов сырым клиентом: ждём финального (не pending) ответа.
function clientCall(token, op = "tabs.list") {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    let buf = "";
    let sawPending = false;
    s.on("connect", () =>
      s.write(JSON.stringify({ id: 1, op, params: {}, token, client: { name: "test", pid: 111, argv: "approval.test" } }) + "\n")
    );
    s.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.pending) { sawPending = true; continue; }
        s.end();
        return resolve({ sawPending, final: m });
      }
    });
    s.on("error", reject);
  });
}

setTimeout(() => sendNative({ type: "hello", extension: "ffmcp@local", version: "1.0.0" }), 200);

(async () => {
  await sleep(400);
  for (let i = 0; i < 50 && !fs.existsSync(SOCK); i++) await sleep(50);

  // A — одобрение на подключение
  policy.set("tA", { decision: "approve", scope: "connection" });
  const a = await clientCall("tA");
  a.sawPending && a.final.ok && a.final.value.echoed === "tabs.list"
    ? pass("approve(connection): вызов проходит после подтверждения")
    : fail("connection approve: " + JSON.stringify(a));
  approvalRequests.some((r) => r.token === "tA" && r.client && r.client.pid === 111)
    ? pass("approval-request доносит client-инфо (имя/pid)")
    : fail("нет client-инфо в approval-request");

  // B — сессия: повторное подключение того же токена не переспрашивает
  policy.set("tB", { decision: "approve", scope: "session" });
  const b1 = await clientCall("tB");
  const b2 = await clientCall("tB");
  const bReqs = approvalRequests.filter((r) => r.token === "tB").length;
  b1.final.ok && b2.final.ok && bReqs === 1 && b2.sawPending === false
    ? pass("session: тот же токен переиспользуется без повторного запроса")
    : fail("session: " + JSON.stringify({ bReqs, b2 }));

  // C — отказ
  policy.set("tC", { decision: "deny", scope: null });
  const c = await clientCall("tC");
  !c.final.ok && /отклон/i.test(c.final.error)
    ? pass("deny: вызов возвращает ошибку отказа")
    : fail("deny: " + JSON.stringify(c));

  // D — таймаут (решение не приходит) → fail-closed
  policy.set("tD", { decision: "none" });
  const d = await clientCall("tD");
  !d.final.ok && /таймаут/i.test(d.final.error)
    ? pass("timeout: без ответа доступ отклоняется (fail-closed)")
    : fail("timeout: " + JSON.stringify(d));
  expired.length > 0 ? pass("approval-expired отправлен расширению по таймауту") : fail("нет approval-expired");

  // E — навсегда: токен сохраняется на диск
  policy.set("tE", { decision: "approve", scope: "forever" });
  const e = await clientCall("tE");
  await sleep(50);
  let persisted = false;
  try {
    persisted = (JSON.parse(fs.readFileSync(path.join(DIR, "allowed-firefox.json"), "utf8")).tokens || []).includes("tE");
  } catch {}
  e.final.ok && persisted
    ? pass("forever: токен записан в allowed-firefox.json")
    : fail("forever: " + JSON.stringify({ ok: e.final.ok, persisted }));

  // F — health-check ping не гейтится
  const before = approvalRequests.length;
  const f = await clientCall("tF", "ping");
  f.final.ok && !f.sawPending && approvalRequests.length === before
    ? pass("ping не требует подтверждения")
    : fail("ping зря гейтится: " + JSON.stringify(f));

  host.kill();
  await sleep(200);
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${failN ? "❌" : "✅"} approval: ${okN} проверок ок${failN ? ", " + failN + " упало" : ""}`);
})();
