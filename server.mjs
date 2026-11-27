// rig-hq: a pixel office for OpenRig rigs.
//
// Bridge between the OpenRig daemon and the browser. It keeps one upstream
// connection to the daemon's event stream, reads rigs and seats when that
// stream says they changed (and only while a page is open), and fans a small, normalised set of events out to every open page over SSE.
// It is read-only unless RIG_HQ_INPUT=on, which lets the page send a seat a
// message (through the daemon) or a key (straight to its tmux pane).
//
//   PORT         (default 7480)                    where the office is served
//   HOST         (default 127.0.0.1)               bind address
//   DAEMON       (default http://127.0.0.1:7433)   the OpenRig daemon
//   RIG_HQ_BOSS  (default "You")                   the name on the boss's door
//   RIG_HQ_SCREENS (default on)                    "off" hides seat screens (they show whatever the agent printed)
//   RIG_HQ_INPUT (default off)                     "on" lets the page type into seats (needs screens on)
//   RIG_HQ_ALLOWED_HOSTS                           extra Host names to accept, comma-separated (e.g. a reverse-proxy name)
//   DEMO=1 or --demo                               invented rigs, no daemon needed

import http from "node:http";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
const INPUT = process.env.RIG_HQ_INPUT === "on";
const INPUT_TOKEN = randomBytes(24).toString("hex"); // handed only to pages this server serves (see /api/input)
const REPLAY = 200; // events replayed on the first connect to the daemon's stream
const HISTORY = 60; // conversations kept for pages that open later
const HISTORY_WINDOW_MS = 6 * 3600 * 1000; // replayed conversations younger than this are kept

const state = { rigs: [], updatedAt: null, daemonOk: false, error: null, boss: BOSS, demo: DEMO, screens: SCREENS && !DEMO, input: INPUT && SCREENS && !DEMO };
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

// Working vs idle comes from the daemon's reconciled activity
// (activityState.display), what `rig ps` and the TUI render.
//
// "Needs you" mirrors the daemon's own attention rule (seatNeedsAttention in
// OpenRig 0.6.5's ps-projection), so the line at the boss's door matches
// `rig ps`'s attention count:
//   - a positive needsInput count from the reconciled state;
//   - otherwise, the raw hook state (agentActivity), unless the seat's runtime
//     has a trusted needs-input source that already says "no". Claude seats do
//     (so an Esc-interrupted prompt doesn't stick); Codex seats don't yet (their
//     hooks are on trial), and the daemon then counts a live PermissionRequest.
//     The seat list doesn't expose that trust, so it's mirrored by runtime;
//   - or the seat is held, errored, failed to start or flagged for attention.
const DISPLAY = { working: "running", idle: "idle", "needs-input": "needs_input", unknown: "idle" };
const TRUSTED_NEEDS_INPUT = new Set(["claude-code"]);
function seatState(node) {
  const as = node.activityState ?? {};
  const raw = node.agentActivity ?? {};
  let state = DISPLAY[as.display] ?? "idle";
  let reason = as.needsInput?.reason ?? null;
  const count = as.needsInput?.count ?? 0;
  const rawNeeds = raw.state === "needs_input" && !raw.stale;
  if (count > 0) state = "needs_input";
  // With no reconciled state at all (a seat outside the daemon's tracking), the
  // daemon has no trusted "no" either, and falls back to the raw hook for every runtime.
  const trustedNo = node.activityState != null && TRUSTED_NEEDS_INPUT.has(node.runtime);
  if (count === 0 && rawNeeds && !trustedNo) { state = "needs_input"; reason = raw.reason ?? "prompt"; }
  const flag = node.lifecycleState === "attention_required" || node.startupStatus === "attention_required" ? "attention required"
    : node.startupStatus === "failed" ? "startup failed"
    : node.heldReason ? `held: ${node.heldReason}`
    : node.latestError ? `error: ${String(node.latestError).slice(0, 80)}`
    : null;
  if (flag) { state = "needs_input"; reason = reason ?? flag; }
  return { state, reason };
}

let markReady;
const ready = new Promise((r) => (markReady = r)); // settles after the first read, success or not

// Reads are driven by the daemon's event stream, not a timer. Its events are
// change notifications only (a seat name, not its new state), so an event
// marks that seat's rig stale and the rig's seat list is read again. A busy
// rig emits many events a second; each rig is read at most once per
// RIG_MIN_MS, and every event in between is covered by that one read.
//   - rig.* events (created, deleted, archived…) and events naming a seat we
//     don't know yet ask for a full read (/api/ps plus every rig);
//   - a full read also runs every FULL_MS while a page is open, in case an
//     event was missed or a change emitted none;
//   - nothing is read while no page is open: the state is refreshed when one
//     connects. The daemon is shared with the rigs themselves, and a polling
//     viewer nobody looks at competes with them for it.
// One read at a time, so an older read finishing last can't overwrite a newer one.
const RIG_MIN_MS = 5000, FULL_MS = 60000;
const watching = () => clients.size > 0;
const dirty = new Set(); // rig ids to read again
const lastRigRead = new Map(); // rig id -> when it was last read
let fullDue = true, lastFull = 0, reading = false, readTimer = null;
// A failed read (usually the daemon timing out under load) doubles the gap
// before the next one, up to FULL_MS, so a struggling daemon gets less traffic.
let gapMs = RIG_MIN_MS;
const readOk = () => { gapMs = RIG_MIN_MS; };
const readFailed = () => { gapMs = Math.min(FULL_MS, gapMs * 2); };

const rigOf = (session) => state.rigs.find((r) => r.seats.some((s) => s.session === session))?.id ?? null;

function markRig(rigId) {
  if (rigId && state.rigs.some((r) => r.id === rigId)) dirty.add(rigId);
  else fullDue = true;
  schedule();
}
function markSessions(sessions) {
  for (const s of sessions) if (s) markRig(rigOf(s));
}
function markFull() { fullDue = true; schedule(); }

function nextReadIn(now) {
  let wait = Infinity;
  if (fullDue) wait = Math.max(0, lastFull + gapMs - now);
  for (const id of dirty) wait = Math.min(wait, Math.max(0, (lastRigRead.get(id) ?? 0) + gapMs - now));
  return wait;
}

function schedule() {
  if (readTimer || reading || !watching()) return;
  const wait = nextReadIn(Date.now());
  if (wait === Infinity) return;
  readTimer = setTimeout(() => { readTimer = null; pump(); }, wait);
}

async function pump() {
  if (reading) return;
  reading = true;
  try {
    const now = Date.now();
    if (fullDue && now - lastFull >= gapMs) await readAll();
    else {
      const due = [...dirty].filter((id) => now - (lastRigRead.get(id) ?? 0) >= gapMs);
      for (const id of due) { dirty.delete(id); await readRig(id); }
      if (due.length) broadcast({ kind: "state", state });
    }
  } finally {
    reading = false;
    schedule();
  }
}

function seatsOf(nodes) {
  return nodes
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
    .sort((a, b) => a.logicalId.localeCompare(b.logicalId));
}

async function readAll() {
  fullDue = false;
  lastFull = Date.now();
  try {
    const ps = await getJson("/api/ps");
    const rigs = [];
    for (const r of ps.filter((r) => !r.isArchived)) {
      lastRigRead.set(r.rigId, Date.now());
      dirty.delete(r.rigId);
      rigs.push({ id: r.rigId, name: r.name, status: r.status, seats: seatsOf(await getJson(`/api/rigs/${r.rigId}/nodes`)) });
    }
    Object.assign(state, { rigs, updatedAt: new Date().toISOString(), daemonOk: true, error: null });
    readOk();
  } catch (e) {
    Object.assign(state, { daemonOk: false, error: String(e.message ?? e) });
    readFailed();
    fullDue = true; // try again after the backoff gap
  }
  markReady();
  broadcast({ kind: "state", state });
}

async function readRig(id) {
  lastRigRead.set(id, Date.now());
  try {
    const seats = seatsOf(await getJson(`/api/rigs/${id}/nodes`));
    const rig = state.rigs.find((r) => r.id === id);
    if (rig) rig.seats = seats;
    Object.assign(state, { updatedAt: new Date().toISOString(), daemonOk: true, error: null });
    readOk();
  } catch (e) {
    Object.assign(state, { daemonOk: false, error: String(e.message ?? e) });
    readFailed();
    dirty.add(id); // read it again after the backoff gap
  }
}

// ----------------------------------------------------------------- rig send

// `rig send` messages aren't in the event stream, but a send with a known
// sender session is recorded in that sender's outbox (OpenRig 0.6.5). Read the
// outboxes of seats that showed activity in the last ACTIVE_MS (a seat that
// sends is a seat that is working), every OUTBOX_MS while a page is open, and
// every seat's once when a page connects; turn new entries into conversations.
const OUTBOX_MS = 5000, ACTIVE_MS = 60000;
const activeAt = new Map(); // session -> last event naming it
function touch(sessions) {
  const now = Date.now();
  for (const s of sessions) if (s) activeAt.set(s, now);
}
function outboxSummary(body) {
  const parts = String(body ?? "").split(/\n---\n?/);
  const text = (parts[1] ?? parts[0]).replace(/^[\w.-]+:\s*/, "").replace(/\s+/g, " ").trim();
  return text.slice(0, 200);
}

let outboxPrimed = false, outboxBusy = false;
async function pollOutboxes({ all = false } = {}) {
  if (outboxBusy) return;
  outboxBusy = true;
  try { await readOutboxes(all); } finally { outboxBusy = false; }
}
async function readOutboxes(all) {
  const now = Date.now();
  const sessions = state.rigs.flatMap((r) => r.seats.map((s) => s.session))
    .filter((s) => all || now - (activeAt.get(s) ?? 0) < ACTIVE_MS);
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
    case "transport.prompt_override": // one seat answered another seat's prompt
      return { kind: "talk", verb: "answers a prompt for", override: true, from: ev.actorSession, to: ev.sessionName, summary: ev.overrideReason, at };
    case "queue.updated":
      if (ev.toState !== "done" || ev.fromState === "done") return null;
      return { kind: "done", session: ev.actorSession, qitem: ev.qitemId, at };
    case "queue.claimed":
      return { kind: "claimed", session: ev.destinationSession, summary: ev.summary, qitem: ev.qitemId, at };
    default:
      return null;
  }
}

// What an event makes stale. The display isn't built from the event itself:
// "needs you" comes from the daemon's reconciled state, which only a read has.
const SESSION_FIELDS = ["sessionName", "canonicalSessionName", "sourceSession", "destinationSession",
  "fromSession", "toSession", "actorSession"];
function route(ev) {
  const type = String(ev.type ?? "");
  if (type.startsWith("rig.")) return markFull(); // a rig appeared, went or changed shape
  if (type === "seat.rung_health") return; // periodic health, not a change
  const sessions = SESSION_FIELDS.map((f) => ev[f]).filter((s) => typeof s === "string" && s);
  if (type === "agent.activity" || type.startsWith("seat.") || type.startsWith("node.")
      || type.startsWith("session.") || type.startsWith("queue.")) {
    touch(sessions);
    if (ev.rigId && state.rigs.some((r) => r.id === ev.rigId)) markRig(ev.rigId);
    else if (sessions.length) markSessions(sessions); // an unknown seat asks for a full read
    else markFull();
  }
}

async function follow() {
  const started = Date.now();
  for (;;) {
    try {
      // A reconnect resumes from Last-Event-ID. The first connect asks for the newest
      // REPLAY events only: without `replay` the daemon sends its whole log, which
      // on a long-lived daemon is hundreds of thousands of events and stalls it.
      // (Last-Event-ID wins over `replay` when both are sent.)
      const headers = { accept: "text/event-stream" };
      if (lastEventId) headers["last-event-id"] = lastEventId;
      const res = await fetch(`${DAEMON}/api/events?replay=${REPLAY}`, { headers });
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
          // The first connect replays the newest REPLAY events.
          const replay = (ts(ev.createdAt) || Date.now()) < started - 5000;
          if (!replay) route(ev);
          const n = normalise(ev);
          if (!n) continue;
          if (n.kind === "done" || n.kind === "claimed") {
            if (!replay) broadcast(n); // a moment's bubble, not history
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

// ------------------------------------------------------------- seat input

// Off unless RIG_HQ_INPUT=on. Two ways in, for seats the daemon lists only:
//   - a message goes through the daemon's own send route, exactly like
//     `rig send --raw`: pasted, then Enter, and refused while the seat is at a
//     prompt, so a message can never pick an option by accident;
//   - a key from a fixed list, or typed characters, go straight to the pane
//     with tmux send-keys (what the page sends while its screen has focus).
//     Keys are how you answer a prompt (or Esc a busy seat). They don't go
//     through the daemon: its prompt override only applies while it sees a
//     prompt, and otherwise it would paste the key as text and press Enter.
const KEYS = new Set(["Up", "Down", "Left", "Right", "Enter", "Escape", "Tab", "BTab", "BSpace", "DC",
  "Home", "End", "PPage", "NPage", ..."123456789"]);
const MAX_MESSAGE = 8000;
const MAX_TYPED = 500;
// Typed characters are printable only: a control character (a newline, Ctrl-C,
// an escape sequence) can only arrive as a named key from the list above.
const printable = (t) => !/[\u0000-\u001f\u007f-\u009f]/.test(t);

async function sendMessage(session, text) {
  const res = await fetch(DAEMON + "/api/transport/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, text, deliveryId: randomUUID() }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) return { ok: false, error: data.error ?? `daemon answered HTTP ${res.status}` };
  if (data.outcome === "retained") return { ok: false, error: `retained, not delivered. ${data.warning ?? ""}`.trim() };
  return { ok: true, warning: data.warning ?? null };
}

// A cross-site page can POST here (its request would carry Host 127.0.0.1), so
// a write must also come from one of our own pages: an Origin we answer to, a
// JSON body (which a cross-site form can't send without a preflight we never
// grant), and the token that only our pages receive.
function inputAllowed(req) {
  let origin;
  try { origin = new URL(req.headers.origin ?? ""); } catch { return false; }
  const name = origin.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return allowedHosts.has(name)
    && String(req.headers["content-type"] ?? "").startsWith("application/json")
    && req.headers["x-rig-hq-token"] === INPUT_TOKEN;
}

async function readJson(req, limit) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("request too large");
  }
  return JSON.parse(body);
}

async function handleInput(req, res) {
  const reply = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method !== "POST") return reply(405, { ok: false, error: "POST only" });
  if (!state.input) return reply(403, { ok: false, error: "input is off (start Rig HQ with RIG_HQ_INPUT=on)" });
  if (!inputAllowed(req)) return reply(403, { ok: false, error: "not from a Rig HQ page; reload it" });
  let body;
  try { body = await readJson(req, 4 * MAX_MESSAGE); } catch (e) { return reply(400, { ok: false, error: String(e.message ?? e) }); }
  const { session, text, key, typed } = body ?? {};
  await ready;
  if (typeof session !== "string" || !knownSession(session)) return reply(404, { ok: false, error: "unknown seat" });
  try {
    if (typeof key === "string") {
      if (!KEYS.has(key)) return reply(400, { ok: false, error: `key ${key} isn't one Rig HQ sends` });
      await tmux(["send-keys", "-t", `=${session}:`, key]);
      console.log(`input: ${key} → ${session}`);
      return reply(200, { ok: true });
    }
    if (typeof typed === "string" && typed) {
      if (typed.length > MAX_TYPED || !printable(typed)) return reply(400, { ok: false, error: "typed text must be printable and short; use the message box" });
      await tmux(["send-keys", "-t", `=${session}:`, "-l", typed]);
      console.log(`input: typed ${typed.length} chars → ${session}`);
      return reply(200, { ok: true });
    }
    if (typeof text === "string" && text.trim()) {
      if (text.length > MAX_MESSAGE) return reply(400, { ok: false, error: `messages are capped at ${MAX_MESSAGE} characters` });
      const result = await sendMessage(session, text);
      console.log(`input: message (${text.length} chars) → ${session}: ${result.ok ? "sent" : result.error}`);
      return reply(result.ok ? 200 : 409, result);
    }
    return reply(400, { ok: false, error: "nothing to send" });
  } catch (e) {
    return reply(502, { ok: false, error: String(e.message ?? e).split("\n")[0] });
  }
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
    res.write(`data: ${JSON.stringify({ kind: "hello", state, history, token: state.input ? INPUT_TOKEN : null })}\n\n`);
    const first = !watching();
    clients.add(res);
    req.on("close", () => clients.delete(res));
    if (first && !DEMO) { // nothing was read while nobody watched: catch up
      if (Date.now() - lastFull >= RIG_MIN_MS) fullDue = true;
      schedule();
      pollOutboxes({ all: true });
    }
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
  if (url.pathname === "/api/input") {
    await handleInput(req, res);
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
  // One read at start, watched or not, so seat screens and input know the seats.
  pump().then(() => pollOutboxes({ all: true }));
  setInterval(() => { if (watching()) markFull(); }, FULL_MS);
  setInterval(() => { if (watching()) pollOutboxes(); }, OUTBOX_MS);
  follow();
}
