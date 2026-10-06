// rig-hq: a pixel office for OpenRig rigs.
//
// Read-only bridge between the OpenRig daemon and the browser. It polls the
// daemon for rigs and seats, keeps one upstream connection to the daemon's
// event stream, and fans a small, normalised set of events out to every open
// page over SSE. It never writes to the daemon.
//
//   PORT         (default 7480)                    where the office is served
//   HOST         (default 127.0.0.1)               bind address
//   DAEMON       (default http://127.0.0.1:7433)   the OpenRig daemon
//   RIG_HQ_BOSS  (default "You")                   the name on the boss's door
//   RIG_HQ_SCREENS (default on)                    "off" hides seat screens (they show whatever the agent printed)
//   RIG_HQ_ALLOWED_HOSTS                           extra Host names to accept, comma-separated (e.g. a reverse-proxy name)
//   DEMO=1 or --demo                               invented rigs, no daemon needed

import http from "node:http";
import { execFile } from "node:child_process";
import { hostname, networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 7480);
const HOST = process.env.HOST ?? "127.0.0.1";
const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:7433";
const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const BOSS = process.env.RIG_HQ_BOSS || "You";
const DEMO = process.env.DEMO === "1" || process.argv.includes("--demo");
const SCREENS = process.env.RIG_HQ_SCREENS !== "off";
const POLL_MS = 4000;
const HISTORY = 60; // conversations kept for pages that open later
const HISTORY_WINDOW_MS = 6 * 3600 * 1000; // replayed conversations younger than this are kept

const state = { rigs: [], updatedAt: null, daemonOk: false, error: null, boss: BOSS, demo: DEMO, screens: SCREENS && !DEMO };
const history = []; // recent conversation events, oldest first
const seenOutbox = new Set(); // outboxIds already turned into conversations
let lastEventId = null; // last SSE id from the daemon, sent back as Last-Event-ID on reconnect
const clients = new Set();

// ---------------------------------------------------------------- daemon poll

async function getJson(path) {
  const res = await fetch(DAEMON + path, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// The daemon's reconciled activity (activityState.display: working | idle |
// needs-input | unknown) is what `rig ps` and the TUI render, so it is the
// source of truth here. Raw hook events are not: a prompt interrupted with Esc
// sends no closing hook, and a state built from them stays "needs input" forever.
// One addition: the daemon's on-screen prompt detection (agentActivity with
// evidenceSource "pane_heuristic", re-sampled every poll) also counts as needs-input.
const DISPLAY = { working: "running", idle: "idle", "needs-input": "needs_input", unknown: "idle" };
function seatState(node) {
  const as = node.activityState ?? {};
  const raw = node.agentActivity ?? {};
  let state = DISPLAY[as.display] ?? "idle";
  let reason = as.needsInput?.reason ?? null;
  if (state !== "needs_input" && raw.state === "needs_input" && raw.evidenceSource === "pane_heuristic" && !raw.stale) {
    state = "needs_input"; reason = raw.reason ?? "prompt on screen";
  }
  if (node.startupStatus === "attention_required") { state = "needs_input"; reason = reason ?? "attention_required"; }
  return { state, reason };
}

let markReady;
const ready = new Promise((r) => (markReady = r)); // settles after the first poll, success or not

async function poll() {
  try {
    const ps = await getJson("/api/ps");
    const rigs = [];
    for (const r of ps.filter((r) => !r.isArchived)) {
      const nodes = await getJson(`/api/rigs/${r.rigId}/nodes`);
      rigs.push({
        id: r.rigId,
        name: r.name,
        status: r.status,
        seats: nodes
          .filter((n) => n.nodeKind === "agent")
          .map((n) => ({
            session: n.canonicalSessionName,
            seat: n.canonicalSessionName.split("@")[0],
            logicalId: n.logicalId,
            pod: n.podNamespace,
            runtime: n.runtime,
            lifecycle: n.lifecycleState,
            ...seatState(n),
            pending: n.pendingWorkCount ?? 0,
            inProgress: n.inProgressWorkCount ?? 0,
            lastActivityAt: n.lastActivityAt ?? null,
            attach: n.tmuxAttachCommand ?? null,
          }))
          .sort((a, b) => a.logicalId.localeCompare(b.logicalId)),
      });
    }
    Object.assign(state, { rigs, updatedAt: new Date().toISOString(), daemonOk: true, error: null });
    markReady();
  } catch (e) {
    Object.assign(state, { daemonOk: false, error: String(e.message ?? e) });
    markReady();
  }
  broadcast({ kind: "state", state });
}

// An activity event means something changed: poll soon (coalesced), rather
// than waiting up to POLL_MS.
let nudgeTimer = null;
function nudge() {
  if (!nudgeTimer) nudgeTimer = setTimeout(() => { nudgeTimer = null; poll(); }, 700);
}

// ----------------------------------------------------------------- rig send

// `rig send` messages aren't in the event stream, but a send with a known
// sender session is recorded in that sender's outbox (OpenRig 0.6.5). Poll each
// seat's outbox and turn new entries into conversations.
function outboxSummary(body) {
  const parts = String(body ?? "").split(/\n---\n?/);
  const text = (parts[1] ?? parts[0]).replace(/^[\w.-]+:\s*/, "").replace(/\s+/g, " ").trim();
  return text.slice(0, 200);
}

let outboxPrimed = false;
async function pollOutboxes() {
  const sessions = state.rigs.flatMap((r) => r.seats.map((s) => s.session));
  const fresh = [];
  await Promise.all(sessions.map(async (session) => {
    try {
      const rows = await getJson(`/api/queue/outbox/list?senderSession=${encodeURIComponent(session)}&limit=5`);
      for (const row of rows) {
        if (!row.outboxId || seenOutbox.has(row.outboxId)) continue;
        seenOutbox.add(row.outboxId);
        const at = Date.parse(row.tsDispatched) || Date.now();
        if (at < Date.now() - HISTORY_WINDOW_MS) continue;
        fresh.push({ kind: "talk", verb: "says", from: row.senderSession, to: row.destinationSession, summary: outboxSummary(row.body), at });
      }
    } catch { /* a seat without an outbox, or a daemon hiccup: try again next round */ }
  }));
  fresh.sort((a, b) => a.at - b.at);
  for (const t of fresh) {
    history.push(t);
    if (outboxPrimed) broadcast(t); // the first round is history, not news
  }
  history.sort((a, b) => a.at - b.at);
  while (history.length > HISTORY) history.shift();
  outboxPrimed = true;
}

// ------------------------------------------------------- daemon event stream

// Daemon timestamps look like "2026-10-01 01:17:08" (UTC) or full ISO.
const ts = (s) => Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s ?? "") ? s : `${s}Z`.replace(" ", "T"));

function normalise(ev) {
  const at = ts(ev.createdAt) || Date.now();
  switch (ev.type) {
    case "queue.created":
      return { kind: "talk", verb: "asks", from: ev.sourceSession, to: ev.destinationSession, summary: ev.summary, qitem: ev.qitemId, at };
    case "queue.handed_off":
      return { kind: "talk", verb: "hands back", from: ev.fromSession, to: ev.toSession, summary: ev.summary, qitem: ev.qitemId, at };
    case "agent.activity":
    case "seat.attention_cleared":
      return { kind: "nudge" }; // re-poll now instead of trusting the raw event
    default:
      return null;
  }
}

async function follow() {
  const started = Date.now();
  for (;;) {
    try {
      // OpenRig 0.6.5 resumes from Last-Event-ID; only the very first connect replays history.
      const headers = { accept: "text/event-stream" };
      if (lastEventId) headers["last-event-id"] = lastEventId;
      const res = await fetch(DAEMON + "/api/events", { headers });
      if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trimEnd();
          buf = buf.slice(i + 1);
          if (line.startsWith("id: ")) { lastEventId = line.slice(4).trim(); continue; }
          if (!line.startsWith("data: ")) continue;
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          const n = normalise(ev);
          if (!n) continue;
          // The stream replays history from the first event on every connect.
          const replay = n.at < started - 5000;
          if (n.kind === "nudge") {
            if (!replay) nudge();
          } else if (n.kind === "talk") {
            if (replay && n.at < Date.now() - HISTORY_WINDOW_MS) continue;
            history.push(n);
            if (history.length > HISTORY) history.shift();
            if (!replay) broadcast(n);
          }
        }
      }
    } catch (e) {
      state.error = `event stream: ${e.message ?? e}`;
    }
    await new Promise((r) => setTimeout(r, 3000)); // reconnect; the replay is filtered as above
  }
}

// ------------------------------------------------------------- seat screen

// View-only: a seat's screen, read from its tmux pane with colours and sent to
// the page when it changes. Read-only by construction (capture-pane never
// types), and only for seats the daemon lists, so a request can't name an
// arbitrary tmux session. Needs Rig HQ on the same host as the rigs.
const PANE_MS = 500, PANE_GONE_MS = 3000, PANE_LINES = 400;
const knownSession = (name) => state.rigs.some((r) => r.seats.some((x) => x.session === name));
const tmux = (args) => new Promise((resolve, reject) =>
  execFile("tmux", args, { maxBuffer: 8 * 1024 * 1024, timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(out))));

function streamPane(req, res, session) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const target = `=${session}:`; // exact session name; its current window's active pane
  const send = (frame) => { if (frame !== last) { last = frame; res.write(`data: ${frame}\n\n`); } };
  let last = "", busy = false, closed = false, timer = null;
  const tick = async () => {
    if (busy || closed) return;
    busy = true;
    let gone = false;
    if (!knownSession(session)) { // the daemon stopped listing it: stop reading it
      send(JSON.stringify({ kind: "gone", error: "the daemon no longer lists this seat" }));
      res.end();
      closed = true;
      busy = false;
      return;
    }
    try {
      const [size, screen] = await Promise.all([
        tmux(["display-message", "-p", "-t", target, "#{pane_width} #{pane_height}"]),
        tmux(["capture-pane", "-p", "-e", "-t", target, "-S", `-${PANE_LINES}`]),
      ]);
      const [cols, rows] = size.trim().split(" ").map(Number);
      send(JSON.stringify({ kind: "screen", cols, rows, screen }));
    } catch (e) {
      gone = true; // sent once (send() skips repeats); a returning pane differs from it, so it is redrawn
      send(JSON.stringify({ kind: "gone", error: String(e.message ?? e).split("\n")[0] }));
    }
    busy = false;
    if (!closed) timer = setTimeout(tick, gone ? PANE_GONE_MS : PANE_MS); // back off while the pane is missing
  };
  tick();
  req.on("close", () => { closed = true; clearTimeout(timer); });
}

// ---------------------------------------------------------------- host check

// Only answer requests addressed to this machine by a name it actually has, so
// a web page on another domain can't reach the API through DNS rebinding (it
// would arrive with its own Host). Allowed: loopback, the OS hostname, every
// local interface address, and RIG_HQ_ALLOWED_HOSTS (for a reverse proxy name).
const allowedHosts = new Set([
  "localhost", "127.0.0.1", "::1", hostname().toLowerCase(), hostname().split(".")[0].toLowerCase(),
  ...Object.values(networkInterfaces()).flat().map((i) => i.address.toLowerCase()),
  ...(process.env.RIG_HQ_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
]);
function hostAllowed(req) {
  const h = String(req.headers.host ?? "").toLowerCase();
  const name = h.startsWith("[") ? h.slice(1, h.indexOf("]")) : h.replace(/:\d+$/, "");
  return allowedHosts.has(name);
}

// ------------------------------------------------------------------ browser

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (!hostAllowed(req)) {
    res.writeHead(421, { "content-type": "text/plain" });
    res.end(`rig-hq does not answer to Host "${req.headers.host ?? ""}"; add it to RIG_HQ_ALLOWED_HOSTS if it is yours\n`);
    return;
  }
  if (url.pathname === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ kind: "hello", state, history })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/api/pane") {
    const session = url.searchParams.get("session") ?? "";
    await ready; // a freshly started server knows no seats until its first poll
    if (!state.screens || !knownSession(session)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: !state.screens ? "seat screens are off" : "unknown seat" }));
      return;
    }
    streamPane(req, res, session);
    return;
  }
  if (url.pathname === "/api/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state, history }));
    return;
  }
  const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = await readFile(join(PUBLIC, rel));
    res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

setInterval(() => broadcast({ kind: "ping" }), 25000); // keeps proxies from closing idle streams
server.listen(PORT, HOST, () => console.log(`rig-hq on http://${HOST}:${PORT} (${DEMO ? "demo mode" : `daemon ${DAEMON}`})`));
if (DEMO) {
  const { startDemo } = await import("./demo.mjs");
  startDemo({ state, history, broadcast, HISTORY });
  markReady();
} else {
  poll().then(pollOutboxes);
  setInterval(poll, POLL_MS);
  setInterval(pollOutboxes, 5000);
  follow();
}
