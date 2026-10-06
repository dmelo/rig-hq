// Rig HQ: draws the OpenRig rigs as an office floor. Every rig is a room
// of desks along a hallway, every seat is a pixel person, the boss (you) has
// a corner office, and idle seats hang out in the coffee room. Seats that need
// you walk to your office and queue; queue handoffs fly between people as envelopes.
"use strict";

const P = 3; // css pixels per pixel-art unit
const WALL = 11, SIDE = 2, CORR = 18, SPINE = 18; // wall depth, wall thickness, hallway widths
const DW = 28, AISLE = 12, PAIR_H = 44, PAIR_GAP = 16; // desk grid
const BOSS_W = 184, BOSS_H = 124, SLOT = 16;
const TABLE_DX = 42, TABLE_DY = 36;
const WALK = 55; // units per second
const COFFEE_GRACE_MS = 15e3; // idle this long before heading for coffee, so quick wake-ups don't bounce
const TALK_MS = 2400, BUBBLE_MS = 7000;

const canvas = document.getElementById("office");
const ctx = canvas.getContext("2d");
const tip = document.getElementById("tip");
const banner = document.getElementById("banner");

let world = { rigs: [], daemonOk: true, error: null, updatedAt: null, boss: "You" };
// ?boss=Name in the URL overrides the server's RIG_HQ_BOSS for this page.
const bossName = () => new URLSearchParams(location.search).get("boss") || world.boss || "You";
let history = [];
const chars = new Map(); // session -> character
const needSince = new Map(); // session -> ms when it started needing the boss
const idleSince = new Map(); // session -> ms when it went idle (0 = already idle when the page opened)
const talks = []; // flying envelopes and speech bubbles
let rooms = [], bands = [], boss = null, coffee = null, worldW = 0, worldH = 0, flash = null;

// ------------------------------------------------------------------ colours

const POD = { pm: "#e0a63b", orch: "#9b6bd6", dev: "#4f8fe0", review: "#3fb37a", cs: "#2bb3b3", mobile: "#e06aa0" };
const HAIR = ["#2b1d14", "#5a3a22", "#a8652f", "#d9b25f", "#1c1c22", "#7a7f86", "#b3473a"];
const SKIN = ["#f2c79b", "#e0ac7e", "#c98e5f", "#a46a43", "#7b4b2c"];
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const podColor = (pod) => POD[pod] ?? `hsl(${hash(pod ?? "x") % 360} 55% 55%)`;
const shade = (col, f) => {
  const n = parseInt(col.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
};

// ------------------------------------------------------------------- layout

function rigRoom(rig) {
  const n = Math.max(1, rig.seats.length);
  const cols = Math.min(4, Math.max(1, Math.ceil(n / 2)));
  const pairs = Math.ceil(n / (cols * 2));
  return { kind: "rig", rig, cols, pairs, w: SIDE * 2 + AISLE + cols * DW + 12, h: WALL + 4 + pairs * PAIR_H + (pairs - 1) * PAIR_GAP + 10 + SIDE };
}

function coffeeRoom(seatCount) {
  const tables = Math.max(2, Math.ceil(seatCount / 4));
  const tcols = 4, trows = Math.ceil(tables / tcols);
  return { kind: "coffee", tcols, trows, tables, w: SIDE * 2 + AISLE + tcols * TABLE_DX + 8, h: WALL + 20 + trows * TABLE_DY + 8 + SIDE };
}

function layout() {
  const avail = Math.max(260, Math.floor(canvas.parentElement.clientWidth / P) - 4);
  const seatCount = world.rigs.reduce((n, r) => n + r.seats.length, 0);
  const list = [
    { kind: "boss", w: BOSS_W, h: BOSS_H },
    coffeeRoom(seatCount),
    ...[...world.rigs].sort((a, b) => a.name.localeCompare(b.name)).map(rigRoom),
  ];
  // Pack rooms into bands: a row above a hallway, a row below it.
  bands = [];
  let band = null;
  for (const r of list) {
    if (!band) bands.push((band = { top: [], bottom: [], topW: SPINE, botW: SPINE }));
    if (band.topW + r.w <= avail || !band.top.length) { band.top.push(r); band.topW += r.w; }
    else if (band.botW + r.w <= avail || !band.bottom.length) { band.bottom.push(r); band.botW += r.w; }
    else { bands.push((band = { top: [r], bottom: [], topW: SPINE + r.w, botW: SPINE })); }
  }
  let y = 4;
  worldW = 0;
  bands.forEach((b, bi) => {
    const topH = Math.max(0, ...b.top.map((r) => r.h));
    const botH = Math.max(0, ...b.bottom.map((r) => r.h));
    b.y = y; b.corrY = y + topH; b.cy = b.corrY + CORR / 2;
    b.right = Math.max(b.topW, b.botW);
    let x = SPINE;
    for (const r of b.top) { Object.assign(r, { x, y: b.corrY - r.h, band: bi, doorSide: "bottom" }); x += r.w; }
    x = SPINE;
    for (const r of b.bottom) { Object.assign(r, { x, y: b.corrY + CORR, band: bi, doorSide: "top" }); x += r.w; }
    y = b.corrY + CORR + botH + 6;
    worldW = Math.max(worldW, b.right + 4);
  });
  worldH = y;
  rooms = list;
  for (const r of rooms) {
    const ix = r.x + SIDE, iy = r.y + WALL;
    r.ix = ix; r.iy = iy;
    r.doorX = ix + 6;
    if (r.doorSide === "bottom") {
      r.door = { x: r.doorX, y: r.y + r.h - 1 };
      r.inside = { x: r.doorX, y: r.y + r.h - SIDE - 5 };
      r.out = { x: r.doorX, y: bands[r.band].cy };
    } else {
      r.door = { x: r.doorX, y: r.y + 4 };
      r.inside = { x: r.doorX, y: iy + 4 };
      r.out = { x: r.doorX, y: bands[r.band].cy };
    }
    if (r.kind === "boss") boss = r;
    if (r.kind === "coffee") coffee = r;
  }
  boss.desk = { x: boss.x + boss.w / 2 + 10, y: boss.iy + 30 };
  coffee.spots = [];
  for (let t = 0; t < coffee.tables; t++) {
    const tx = coffee.ix + AISLE + 10 + (t % coffee.tcols) * TABLE_DX + 8;
    const ty = coffee.iy + 26 + Math.floor(t / coffee.tcols) * TABLE_DY;
    coffee.spots.push({ x: tx, y: ty - 3, dir: "down", t }, { x: tx - 10, y: ty + 4, dir: "right", t }, { x: tx + 10, y: ty + 4, dir: "left", t }, { x: tx, y: ty + 13, dir: "up", t });
  }
  coffee.tableXY = Array.from({ length: coffee.tables }, (_, t) => ({ x: coffee.ix + AISLE + 18 + (t % coffee.tcols) * TABLE_DX, y: coffee.iy + 26 + Math.floor(t / coffee.tcols) * TABLE_DY }));

  for (const r of rooms) if (r.kind === "rig") r.rig.seats.forEach((s, i) => ensureChar(s, r, seatGeom(r, i)));
  const live = new Set(world.rigs.flatMap((r) => r.seats.map((s) => s.session)));
  for (const [k, c] of chars) if (!live.has(k)) { releaseSpot(c); chars.delete(k); }

  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${worldW * P}px`;
  canvas.style.height = `${worldH * P}px`;
  canvas.width = Math.ceil(worldW * P * dpr);
  canvas.height = Math.ceil(worldH * P * dpr);
}

function seatGeom(r, i) {
  const per = r.cols * 2, p = Math.floor(i / per), j = i % per;
  const row = j < r.cols ? 0 : 1, k = j % r.cols;
  const pairY = r.iy + 4 + p * (PAIR_H + PAIR_GAP);
  const cx = r.ix + AISLE + k * DW + DW / 2;
  return row === 0
    ? { row, cx, deskY: pairY + 16, x: cx, y: pairY + 18, dir: "down", aisleY: pairY + 2 }
    : { row, cx, deskY: pairY + 23, x: cx - 2, y: pairY + 42, dir: "up", aisleY: pairY + PAIR_H + 3 };
}

function ensureChar(seat, room, g) {
  let c = chars.get(seat.session);
  if (!c) {
    const h = hash(seat.session);
    c = { path: [], loc: null, dir: "down", hair: HAIR[h % HAIR.length], skin: SKIN[(h >> 3) % SKIN.length], phase: (h % 100) / 100 };
    chars.set(seat.session, c);
  }
  const moved = c.g && (c.g.x !== g.x || c.g.y !== g.y);
  Object.assign(c, { seat, room, g });
  if (moved && c.loc === "desk" && !c.path.length) { c.x = g.x; c.y = g.y; }
}

// ------------------------------------------------------------------ movement

// Where a seat is shows its state: at the desk = working, in the coffee room =
// idle, in the boss's office = needs you. (lastActivityAt is no idle clock: Claude
// re-sends idle_prompt notifications while idle, and each one refreshes it.)
function wanted(c) {
  const s = c.seat;
  if (s.state === "needs_input") return "queue";
  if (s.state === "running") return "desk";
  return Date.now() - (idleSince.get(s.session) ?? 0) > COFFEE_GRACE_MS ? "coffee" : "desk";
}

function queueOrder() {
  return [...chars.values()]
    .filter((c) => c.seat.state === "needs_input")
    .sort((a, b) => (needSince.get(a.seat.session) ?? 0) - (needSince.get(b.seat.session) ?? 0));
}

function slotPos(i) {
  const perRow = Math.max(2, Math.floor((boss.w - 40) / SLOT));
  const row = Math.floor(i / perRow), k = i % perRow;
  return { x: boss.desk.x - ((perRow - 1) * SLOT) / 2 + k * SLOT, y: boss.desk.y + 32 + row * 20, dir: "up" };
}

function releaseSpot(c) { if (c.spot != null) { coffee.taken?.delete(c.spot); c.spot = null; } }
function takeSpot(c) {
  coffee.taken ??= new Set();
  if (c.spot != null && coffee.spots[c.spot]) return coffee.spots[c.spot];
  // A stable-ish choice, so the same seat tends to sit at the same table.
  const n = coffee.spots.length;
  for (let k = 0; k < n; k++) {
    const i = (hash(c.seat.session) + k * 7) % n;
    if (!coffee.taken.has(i)) { coffee.taken.add(i); c.spot = i; return coffee.spots[i]; }
  }
  return coffee.spots[0];
}

function target(c, loc, qi) {
  if (loc === "desk") return c.g;
  if (loc === "queue") return slotPos(qi);
  return takeSpot(c);
}
function roomOf(c, loc) { return loc === "desk" ? c.room : loc === "queue" ? boss : coffee; }
function inner(c, loc, t) {
  // from the spot towards the door, staying inside the room
  if (loc === "desk") return [{ x: c.g.cx, y: c.g.aisleY }, { x: c.room.doorX, y: c.g.aisleY }];
  return [{ x: roomOf(c, loc).doorX, y: t.y }];
}

function route(c, from, to, tFrom, tTo) {
  const A = roomOf(c, from), B = roomOf(c, to);
  const hall = A.band === B.band ? [] : [{ x: SPINE / 2, y: A.out.y }, { x: SPINE / 2, y: B.out.y }];
  return [...inner(c, from, tFrom), A.inside, A.door, A.out, ...hall, B.out, B.door, B.inside, ...inner(c, to, tTo).reverse(), tTo];
}

function plan() {
  const q = queueOrder();
  const qi = new Map(q.map((c, i) => [c, i]));
  for (const c of chars.values()) {
    const want = wanted(c);
    if (!c.loc) { // first sight: put them where they belong, no parade
      const t = target(c, want, qi.get(c) ?? 0);
      Object.assign(c, { x: t.x, y: t.y, dir: t.dir, loc: want, at: t });
      continue;
    }
    if (c.path.length) continue; // finish the current walk first
    if (want !== c.loc) {
      const tTo = target(c, want, qi.get(c) ?? 0);
      c.path = route(c, c.loc, want, c.at, tTo);
      if (c.loc === "coffee") releaseSpot(c);
      c.loc = want; c.at = tTo;
    } else if (want === "queue") {
      const t = slotPos(qi.get(c));
      if (t.x !== c.at.x || t.y !== c.at.y) { c.path = [t]; c.at = t; }
    }
  }
}

function step(dt) {
  for (const c of chars.values()) {
    let budget = WALK * dt;
    while (budget > 0 && c.path.length) {
      const t = c.path[0];
      const dx = t.x - c.x, dy = t.y - c.y, d = Math.hypot(dx, dy);
      if (d > 0.01) c.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
      if (d <= budget) { c.x = t.x; c.y = t.y; c.path.shift(); budget -= d; }
      else { c.x += (dx / d) * budget; c.y += (dy / d) * budget; budget = 0; }
    }
    c.walking = c.path.length > 0;
    if (!c.walking && c.at) c.dir = c.at.dir ?? c.dir;
  }
}

// ------------------------------------------------------------------ drawing

const R = (x, y, w, h, col) => { ctx.fillStyle = col; ctx.fillRect(Math.round(x), Math.round(y), w, h); };

function drawPerson(x, y, dir, o) {
  // (x, y) = feet, bottom centre; about 8 wide and 15 tall.
  const t = performance.now() / 1000 + (o.phase ?? 0) * 3;
  const stride = o.walking ? Math.floor(t * 8) % 2 : 0;
  const top = y - 15 - (o.walking ? stride : 0);
  const side = dir === "left" || dir === "right", flip = dir === "left" ? -1 : 1;
  if (!o.seated) R(x - 4, y - 1, 8, 1, "#0003");
  // legs
  if (!o.seated) {
    if (side) { R(x - 2 + stride * flip, y - 5, 2, 4, o.pants); R(x - (stride ? 1 : 0) * flip, y - 5, 2, 4, shade(o.pants, 0.8)); }
    else { R(x - 3, y - 5 + (stride ? -1 : 0), 2, 4 + stride, o.pants); R(x + 1, y - 5 - (stride ? 0 : 1) * (o.walking ? 1 : 0), 2, 4 + (o.walking ? 1 - stride : 0), o.pants); }
  }
  // body
  const bw = side ? 6 : 8;
  R(x - bw / 2, top + 7, bw, 5, o.shirt);
  R(x - bw / 2, top + 7, bw, 1, shade(o.shirt, 1.15));
  if (o.tie && dir === "down") R(x, top + 7, 1, 4, o.tie);
  // arms and hands
  const ty = o.typing ? Math.floor(t * 9) % 2 : 0;
  if (side) {
    const swing = o.walking ? (stride ? 1 : -1) : 0;
    R(x - 1 + swing, top + 8, 2, 3, shade(o.shirt, 0.8));
    R(x - 1 + swing + (o.mug ? flip * 2 : 0), top + 11, 1, 1, o.skin);
  } else {
    R(x - 5, top + 8, 1, 3, shade(o.shirt, 0.8));
    R(x + 4, top + 8, 1, 3, shade(o.shirt, 0.8));
    if (dir === "down") { R(x - 5, top + 11 - ty, 1, 1, o.skin); R(x + 4, top + 11 - (o.typing ? 1 - ty : 0), 1, 1, o.skin); }
  }
  if (o.mug) {
    const sip = Math.floor(t / 3) % 4 === 0 && dir === "down";
    const mx = side ? x + flip * 3 : x + 4, my = sip ? top + 6 : top + 10;
    R(mx, my, 2, 2, "#f4f1ea"); R(mx + (side && flip < 0 ? -1 : 2), my, 1, 1, "#d6d0c4");
  }
  // head
  if (dir === "up") {
    R(x - 3, top + 1, 6, 6, o.hair);
    R(x - 4, top + 3, 1, 2, o.skin); R(x + 3, top + 3, 1, 2, o.skin); // ears
    R(x - 3, top + 6, 6, 1, shade(o.hair, 0.8));
  } else if (side) {
    R(x - 2, top + 1, 5, 6, o.skin);
    R(x - 2, top, 5, 2, o.hair);
    R(x - 2 * flip - (flip < 0 ? 0 : 1) + (flip < 0 ? 1 : 0), top + 2, 2, 3, o.hair); // back of the head
    R(x + flip * 1 + (flip > 0 ? 0 : 0), top + 4, 1, 1, "#222"); // eye
    if (o.visor) R(x - 1 + (flip > 0 ? 1 : -1), top + 3, 3, 2, o.visor);
  } else {
    R(x - 3, top + 1, 6, 6, o.skin);
    R(x - 3, top, 6, 2, o.hair);
    R(x - 3, top + 2, 1, 2, o.hair);
    R(x + 2, top + 2, 1, 2, o.hair);
    const blink = Math.floor(t * 0.7 + (o.phase ?? 0) * 5) % 6 === 0 && (t * 10) % 10 < 1.5;
    if (!blink) { R(x - 2, top + 4, 1, 1, "#222"); R(x + 1, top + 4, 1, 1, "#222"); }
    if (o.visor) R(x - 3, top + 3, 6, 2, o.visor);
  }
  if (o.crown) { R(x - 3, top - 2, 6, 1, "#f2c94c"); R(x - 3, top - 3, 1, 1, "#f2c94c"); R(x, top - 3, 1, 1, "#f2c94c"); R(x + 2, top - 3, 1, 1, "#f2c94c"); }
}

function screen(x, y, w, h, state, now, phase) {
  R(x - 1, y - 1, w + 2, h + 2, "#23252c");
  const bg = state === "running" ? "#123326" : state === "needs_input" ? ((now / 400) % 2 < 1 ? "#5a1616" : "#2a0d0d") : "#1a1d26";
  R(x, y, w, h, bg);
  if (state === "running") {
    const off = Math.floor(now / 220 + phase * 10);
    for (let l = 0; l < h - 1; l++) R(x + 1, y + 1 + l, 1 + ((off + l * 3) % (w - 2)), 1, l % 2 ? "#5fd38d" : "#9fe8bb");
  } else if (state === "needs_input") R(x + w / 2 - 0.5, y + 1, 1, h - 2, "#ff8a8a");
}

function bubble(x, y, text, col, fg = "#1b1b1b") {
  ctx.font = "4px ui-monospace, monospace";
  const w = Math.ceil(ctx.measureText(text).width) + 4;
  const bx = Math.max(w / 2 + 1, Math.min(worldW - w / 2 - 1, x)); // keep it on the canvas
  R(bx - w / 2, y - 7, w, 6, col);
  R(x - 1, y - 1, 2, 1, col);
  ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, Math.round(bx), Math.round(y - 4));
}

function label(x, y, text, col, size = 3, align = "center") {
  ctx.font = `${size}px ui-monospace, monospace`;
  ctx.fillStyle = col; ctx.textAlign = align; ctx.textBaseline = "top";
  ctx.fillText(text, Math.round(x), Math.round(y));
}

function plant(x, y) { R(x - 2, y - 3, 5, 3, "#8a5a35"); R(x - 4, y - 9, 9, 6, "#2f7a45"); R(x - 2, y - 12, 5, 4, "#3d9a57"); }

function drawRoomShell(r, floorA, floorB, wallFace, sign, sub) {
  // floor
  R(r.x, r.y, r.w, r.h, floorA);
  for (let yy = r.iy; yy < r.y + r.h; yy += 8)
    for (let xx = r.x + SIDE + ((yy / 8) % 2) * 4; xx < r.x + r.w - SIDE; xx += 8) R(xx, yy, Math.min(4, r.x + r.w - SIDE - xx), 1, floorB);
  // top wall: cap, face with windows, baseboard
  R(r.x, r.y, r.w, 2, "#2b2d33");
  R(r.x, r.y + 2, r.w, WALL - 3, wallFace);
  R(r.x, r.y + WALL - 1, r.w, 1, shade(wallFace, 0.7));
  for (let wx = r.x + 10; wx + 12 < r.x + r.w - 52; wx += 26) {
    R(wx, r.y + 3, 12, 5, "#6f8fa8"); R(wx, r.y + 3, 12, 1, "#a9c6db"); R(wx + 6, r.y + 3, 1, 5, "#55697a");
  }
  // side and bottom walls
  R(r.x, r.y, SIDE, r.h, "#2b2d33");
  R(r.x + r.w - SIDE, r.y, SIDE, r.h, "#2b2d33");
  R(r.x, r.y + r.h - SIDE, r.w, SIDE, "#2b2d33");
  // doorway
  if (r.doorSide === "bottom") { R(r.doorX - 5, r.y + r.h - SIDE, 10, SIDE, "#8d8f96"); }
  else { R(r.doorX - 5, r.y, 10, WALL, floorA); R(r.doorX - 6, r.y, 1, WALL, "#2b2d33"); R(r.doorX + 5, r.y, 1, WALL, "#2b2d33"); }
  // name plaque
  // name plaque by the door, with the room's status on a second line
  ctx.font = "4px ui-monospace, monospace";
  const tw = Math.ceil(Math.max(ctx.measureText(sign).width, sub ? ctx.measureText(sub).width * 0.75 : 0)) + 6;
  const px = r.x + r.w - tw - 5;
  R(px, r.y + 1, tw, 9, "#2a2016"); R(px + 1, r.y + 2, tw - 2, 7, "#e9dcc0");
  label(px + tw / 2, r.y + 2, sign, "#3a2a18", 4);
  if (sub) label(px + tw / 2, r.y + 6, sub, "#6b5a44", 3);
}

function personStyle(c) {
  const s = c.seat;
  return { shirt: s.runtime === "codex" ? "#e07b39" : podColor(s.pod), pants: "#39404f", hair: c.hair, skin: c.skin, phase: c.phase, visor: s.runtime === "codex" ? "#2a2f38" : null };
}

function drawHallways() {
  const floor = "#9a9ca3", line = "#8a8c93", runner = "#7b5a4a";
  const first = bands[0], lastB = bands[bands.length - 1];
  R(0, first.corrY, SPINE, lastB.corrY + CORR - first.corrY, floor);
  R(SPINE / 2 - 3, first.corrY, 6, lastB.corrY + CORR - first.corrY, runner);
  for (const b of bands) {
    R(0, b.corrY, b.right, CORR, floor);
    for (let xx = 0; xx < b.right; xx += 10) R(xx, b.corrY, 1, CORR, line);
    R(0, b.cy - 3, b.right, 6, runner);
    R(0, b.cy - 3, b.right, 1, shade(runner, 1.2));
    for (let xx = SPINE + 60; xx < b.right - 10; xx += 120) plant(xx, b.corrY + 5);
    // water cooler at the end of each hallway
    R(b.right - 8, b.corrY + 1, 5, 6, "#d9e2ea"); R(b.right - 7, b.corrY - 3, 3, 4, "#7fb6e0");
  }
}

function drawBoss(now) {
  const r = boss;
  drawRoomShell(r, "#6b4f3a", "#5f4533", "#cdbb9c", `BOSS · ${bossName()}`, queueOrder().length ? `${queueOrder().length} waiting` : "all clear");
  R(r.desk.x - 34, r.desk.y + 10, 68, 44, "#7a3b3b"); R(r.desk.x - 32, r.desk.y + 12, 64, 40, "#8f4a46"); // rug
  R(r.ix + 22, r.iy + 2, 16, 20, "#5a3d27"); for (let k = 0; k < 3; k++) R(r.ix + 24, r.iy + 4 + k * 6, 12, 3, ["#c9a46a", "#8fb3c9", "#b36a5e"][k]); // bookshelf
  plant(r.x + r.w - 10, r.iy + 14);
  R(r.x + r.w - 32, r.y + r.h - 16, 22, 9, "#3d4a6b"); R(r.x + r.w - 32, r.y + r.h - 18, 22, 3, "#4f5f88"); // sofa
  const anyNeed = queueOrder().length > 0;
  R(r.desk.x - 6, r.desk.y - 14, 12, 5, "#3b2b1f"); // chair back
  drawPerson(r.desk.x, r.desk.y + 2, "down", { shirt: "#22262e", tie: "#f2b84b", pants: "#22262e", hair: "#2b1d14", skin: "#e0ac7e", crown: true, seated: true, typing: !anyNeed, phase: 0.3 });
  R(r.desk.x - 20, r.desk.y, 40, 2, "#b07a4a");
  R(r.desk.x - 20, r.desk.y + 2, 40, 8, "#8a5a35");
  R(r.desk.x - 7, r.desk.y + 4, 14, 3, "#e8d7a8");
  label(r.desk.x, r.desk.y + 4.2, bossName().toUpperCase().slice(0, 9), "#5a3a22", 3);
  R(r.desk.x + 10, r.desk.y - 5, 8, 5, "#23252c"); // monitor back
  if (anyNeed) bubble(r.desk.x, r.desk.y - 15, "next!", "#ffe7a3");
}

function drawCoffee(now, sitters) {
  const r = coffee;
  drawRoomShell(r, "#b9a27c", "#a99270", "#d8cfbf", "Coffee", sitters.length ? `${sitters.length} hanging out` : "empty");
  // counter, coffee machine with steam, fridge
  R(r.ix + AISLE, r.iy, r.w - AISLE - 18, 7, "#6b4a33"); R(r.ix + AISLE, r.iy, r.w - AISLE - 18, 2, "#8a6446");
  const mx = r.ix + AISLE + 8;
  R(mx, r.iy - 6, 8, 9, "#2a2b30"); R(mx + 2, r.iy - 4, 4, 2, "#c0392b"); R(mx + 3, r.iy, 2, 2, "#e8e2d6");
  const s = Math.floor(now / 300) % 3;
  R(mx + 3 + (s === 1 ? 1 : 0), r.iy - 9 - s, 1, 2, "#ffffff88");
  for (let k = 0; k < 3; k++) R(mx + 14 + k * 4, r.iy + 2, 2, 2, ["#f4f1ea", "#e07b39", "#4f8fe0"][k]);
  R(r.x + r.w - 16, r.iy - 4, 10, 18, "#e7ecef"); R(r.x + r.w - 15, r.iy + 4, 1, 3, "#9aa3aa");
  plant(r.ix + 6, r.iy + 14);
  // tables and the people around them, back to front
  const items = [];
  for (const t of r.tableXY) items.push({ y: t.y + 4, draw: () => { R(t.x - 6, t.y, 12, 6, "#7a5233"); R(t.x - 6, t.y, 12, 2, "#9a6b43"); R(t.x - 1, t.y + 6, 2, 3, "#5d3e27"); R(t.x - 2, t.y + 1, 2, 1, "#f4f1ea"); } });
  for (const c of sitters) items.push({ y: c.y, draw: () => drawPerson(c.x, c.y, c.dir, { ...personStyle(c), mug: true }) });
  items.sort((a, b) => a.y - b.y).forEach((i) => i.draw());
  for (const c of sitters) if (flash?.has(c.seat.session)) label(c.x, c.y + 1, c.seat.seat, "#ffe066", 3);
}

function drawRig(r, now, here) {
  const h = hash(r.rig.name) % 360;
  const working = r.rig.seats.filter((s) => s.state === "running").length;
  drawRoomShell(r, `hsl(${h} 16% 42%)`, `hsl(${h} 16% 38%)`, `hsl(${h} 18% 74%)`, r.rig.name, `${working}/${r.rig.seats.length} working`);
  plant(r.x + r.w - 8, r.iy + 12);
  r.rig.seats.forEach((s, i) => {
    const c = chars.get(s.session); if (!c) return;
    const g = c.g, atDesk = here.has(c), st = { ...personStyle(c), seated: true, typing: s.state === "running" };
    const hl = flash?.has(s.session) && (now / 250) % 2 < 1 ? "#ffe066" : "#f5f1e6";
    if (g.row === 0) {
      R(g.cx - 4, g.y - 13, 8, 4, "#30333b"); // chair back
      if (atDesk) drawPerson(g.cx, g.y, "down", st);
      R(g.cx - 12, g.deskY, 24, 7, "#9a6b43"); R(g.cx - 12, g.deskY, 24, 2, "#b5845a");
      R(g.cx - 9, g.deskY - 3, 7, 4, "#30333b"); // monitor seen from behind
      if (s.state === "running") R(g.cx - 9, g.deskY - 4, 7, 1, "#5fd38d"); else if (s.state === "needs_input") R(g.cx - 9, g.deskY - 4, 7, 1, "#ff5c5c");
      label(g.cx, g.y - 21, s.seat, hl);
      if (atDesk && s.state === "running") bubble(g.cx + 7, g.y - 15, ["·  ", "·· ", "···"][Math.floor(now / 350) % 3], "#e9f7ee");
    } else {
      R(g.cx - 12, g.deskY, 24, 7, "#9a6b43"); R(g.cx - 12, g.deskY + 5, 24, 2, "#7a5233");
      screen(g.cx + 1, g.deskY - 4, 8, 5, s.state, now, c.phase);
      if (atDesk) drawPerson(g.x, g.y, "up", st);
      R(g.cx - 5, g.y - 3, 8, 3, "#30333b"); // chair seat
      label(g.cx, g.y + 1, s.seat, hl);
      if (atDesk && s.state === "running") bubble(g.cx + 8, g.y - 15, ["·  ", "·· ", "···"][Math.floor(now / 350) % 3], "#e9f7ee");
    }
  });
}

function draw(now) {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(P * dpr, 0, 0, P * dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  R(0, 0, worldW, worldH, "#2c3a2f"); // grounds
  if (!boss) return;
  drawHallways();
  const all = [...chars.values()];
  const atDesk = new Set(all.filter((c) => c.loc === "desk" && !c.walking));
  const sitters = all.filter((c) => c.loc === "coffee" && !c.walking);
  const queued = all.filter((c) => c.loc === "queue" && !c.walking);
  const walkers = all.filter((c) => c.walking);
  drawBoss(now);
  drawCoffee(now, sitters);
  for (const r of rooms) if (r.kind === "rig") drawRig(r, now, atDesk);
  for (const c of [...queued, ...walkers].sort((a, b) => a.y - b.y)) {
    drawPerson(c.x, c.y, c.dir, { ...personStyle(c), walking: c.walking });
    if (!c.walking) { bubble(c.x, c.y - 17, "!", "#ff5c5c", "#fff"); label(c.x, c.y + 1, c.seat.seat, "#f5f1e6"); label(c.x, c.y + 4.5, c.room.rig.name, "#f2b84b"); }
  }

  // Conversations: an envelope flies from sender to recipient, the sender says what it is.
  for (let i = talks.length - 1; i >= 0; i--) {
    const t = talks[i], age = now - t.t0;
    if (age > BUBBLE_MS) { talks.splice(i, 1); continue; }
    const a = chars.get(t.from), b = chars.get(t.to);
    const pa = a && headPos(a), pb = b && headPos(b);
    if (pa && pb && age < TALK_MS + 600) {
      ctx.globalAlpha = Math.max(0, 1 - age / (TALK_MS + 600)) * 0.7;
      ctx.strokeStyle = "#f2b84b"; ctx.lineWidth = 0.6; ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    if (pa && pb && age < TALK_MS) {
      const k = age / TALK_MS, e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const x = pa.x + (pb.x - pa.x) * e, y = pa.y + (pb.y - pa.y) * e - Math.sin(Math.PI * k) * 18;
      if (t.verb === "says") { // rig send: a blue note
        R(x - 3, y - 4, 7, 7, "#d6e6ff"); R(x - 3, y - 4, 7, 1, "#8fb0e0");
        R(x - 2, y - 2, 5, 1, "#6d8fc4"); R(x - 2, y, 4, 1, "#6d8fc4");
      } else { // queue handoff: an envelope
        R(x - 4, y - 3, 8, 6, "#f4efe2"); R(x - 4, y - 3, 8, 1, "#b9a98f");
        R(x - 3, y - 2, 1, 1, "#b9a98f"); R(x + 2, y - 2, 1, 1, "#b9a98f"); R(x - 1, y - 1, 2, 1, "#c0392b");
      }
    }
    if (pa && age < BUBBLE_MS) {
      ctx.globalAlpha = age > BUBBLE_MS - 800 ? (BUBBLE_MS - age) / 800 : 1;
      const text = `→ ${t.to.split("@")[0]}: ${t.summary ?? ""}`;
      bubble(pa.x, pa.y - 6, text.length > 46 ? text.slice(0, 45) + "…" : text, "#fff6dc");
      ctx.globalAlpha = 1;
    }
  }
}

function headPos(c) { return { x: c.x, y: c.y - 14 }; }

// ------------------------------------------------------------------ panel

const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function renderPanel() {
  const status = document.getElementById("status");
  const seats = world.rigs.reduce((n, r) => n + r.seats.length, 0);
  status.textContent = world.daemonOk ? `${world.demo ? "demo · " : ""}${world.rigs.length} rigs · ${seats} seats · updated ${world.updatedAt ? new Date(world.updatedAt).toLocaleTimeString() : "—"}` : "daemon unreachable";
  banner.hidden = world.daemonOk && !world.error?.startsWith("event");
  banner.textContent = world.error ? `OpenRig: ${world.error}` : "";

  const q = queueOrder();
  document.getElementById("need-count").textContent = q.length;
  document.getElementById("needs").innerHTML = q.map((c) =>
    `<li data-s="${esc(c.seat.session)}"><span class="when">${ago(needSince.get(c.seat.session) ?? Date.now())}</span><span class="who">${esc(c.seat.session)}</span><span class="what">${esc(c.seat.reason ?? "needs input")}${c.seat.attach ? ` · ${esc(c.seat.attach)}` : ""}</span></li>`).join("");
  document.getElementById("log").innerHTML = [...history].reverse().map((t, i) =>
    `<li data-i="${history.length - 1 - i}"><span class="when">${ago(t.at)}</span><span class="who">${esc(t.from?.split("@")[0])} ${esc(t.verb)} ${esc(t.to?.split("@")[0])}</span><span class="what">${esc(t.from?.split("@")[1] ?? "")} · ${esc(t.summary)}</span></li>`).join("");
}

document.getElementById("needs").addEventListener("click", (e) => {
  const li = e.target.closest("li"); if (!li) return;
  highlight([li.dataset.s]);
  const c = chars.get(li.dataset.s); if (c) openPane(c.seat);
});
document.getElementById("log").addEventListener("click", (e) => {
  const li = e.target.closest("li"); if (!li) return;
  const t = history[Number(li.dataset.i)];
  if (t) { talks.push({ ...t, t0: performance.now() }); highlight([t.from, t.to]); }
});

function highlight(sessions) {
  flash = new Set(sessions);
  clearTimeout(highlight.timer);
  highlight.timer = setTimeout(() => (flash = null), 3000);
  const c = chars.get(sessions[0]);
  if (c) canvas.parentElement.scrollTo({ top: Math.max(0, (c.y - 60) * P), behavior: "smooth" });
}

// What's under the pointer: a person wherever they are, or a desk (with its
// chair and name label), so a seat stays clickable while its person is away.
function personAt(e) {
  const rect = canvas.getBoundingClientRect();
  const ux = (e.clientX - rect.left) / P, uy = (e.clientY - rect.top) / P;
  let hit = null;
  for (const c of chars.values()) if (Math.abs(ux - c.x) < 7 && uy > c.y - 17 && uy < c.y + 12) hit = c;
  if (hit) return hit;
  for (const c of chars.values()) {
    const g = c.g; if (!g) continue;
    // Facing desks touch, and the back-row seat's monitor sits on the front desk's
    // lower half, so the front seat ends where that monitor begins (deskY + 3).
    const top = g.row === 0 ? g.y - 22 : g.deskY - 4, bottom = g.row === 0 ? g.deskY + 3 : g.y + 5;
    if (Math.abs(ux - g.cx) <= DW / 2 - 1 && uy >= top && uy < bottom) return c;
  }
  return null;
}

canvas.addEventListener("click", (e) => { const c = personAt(e); if (c) openPane(c.seat); });

canvas.addEventListener("mousemove", (e) => {
  const hit = personAt(e);
  canvas.style.cursor = hit ? "pointer" : "default";
  if (!hit) { tip.hidden = true; return; }
  const s = hit.seat;
  tip.innerHTML = `<b>${esc(s.session)}</b>${esc(s.runtime)} · pod ${esc(s.pod)}<br><i>click to watch their screen</i><br>state: ${esc(s.state)}${s.reason ? ` (${esc(s.reason)})` : ""}<br>work: ${s.inProgress} in progress, ${s.pending} pending${s.lastActivityAt ? `<br>last event ${ago(Date.parse(s.lastActivityAt))} ago` : ""}${s.attach ? `<br><code>${esc(s.attach)}</code>` : ""}`;
  tip.hidden = false;
  const fr = canvas.parentElement.getBoundingClientRect();
  tip.style.left = `${Math.min(e.clientX - fr.left + canvas.parentElement.scrollLeft + 14, canvas.parentElement.scrollLeft + fr.width - 330)}px`;
  tip.style.top = `${e.clientY - fr.top + canvas.parentElement.scrollTop + 14}px`;
});
canvas.addEventListener("mouseleave", () => (tip.hidden = true));

// ------------------------------------------------------------- seat screen

// View-only terminal for one seat: the server streams its tmux pane (with
// colours) whenever it changes. Scroll up to read back and updates pause;
// scroll to the bottom and they resume.
const pane = document.getElementById("pane");
const paneTitle = document.getElementById("pane-title");
const paneNote = document.getElementById("pane-note");
let term = null, paneSource = null, paneCols = 0, pending = null, lastNote = "";
const scrolledBack = () => { const b = term.buffer.active; return b.viewportY < b.baseY; };

function openPane(seat) {
  closePane();
  paneTitle.textContent = `${seat.session} · ${seat.state}`;
  pane.hidden = false;
  tip.hidden = true;
  if (world.demo) { paneNote.textContent = "demo mode has no real screens"; return; }
  if (world.screens === false) { paneNote.textContent = "seat screens are turned off (RIG_HQ_SCREENS=off)"; return; }
  if (typeof Terminal === "undefined") { paneNote.textContent = "terminal library failed to load (needs cdn.jsdelivr.net)"; return; }
  paneNote.textContent = "view only · connecting…";
  if (!term) {
    term = new Terminal({ disableStdin: true, cursorBlink: false, scrollback: 2000, fontSize: 12,
      fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace', theme: { background: "#101217" } });
    term.open(document.getElementById("term"));
    term.onScroll(() => {
      if (scrolledBack()) paneNote.textContent = "view only · paused while you scroll back";
      else if (pending) { const f = pending; pending = null; drawFrame(f); }
      else paneNote.textContent = lastNote;
    });
  }
  term.reset();
  paneCols = 0; pending = null;
  listen(`api/pane?session=${encodeURIComponent(seat.session)}`);
}

function listen(url) {
  const es = (paneSource = new EventSource(url));
  es.onmessage = (m) => {
    const f = JSON.parse(m.data);
    if (f.kind === "gone") { paneNote.textContent = `screen unavailable: ${f.error}`; return; }
    if (scrolledBack()) { pending = f; return; } // drawn when you scroll back down
    drawFrame(f);
  };
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED) { paneNote.textContent = "view only · reconnecting…"; return; }
    // The browser gave up after an error status: ask the server why, and retry
    // unless the answer is final (screens off, unknown seat).
    const retry = (ms) => setTimeout(() => { if (paneSource === es) listen(url); }, ms);
    fetch(url).then(async (r) => {
      if (paneSource !== es) { r.body?.cancel(); return; } // closed or switched meanwhile
      if (r.status === 404) { paneNote.textContent = `view only · ${(await r.json().catch(() => ({}))).error ?? "unavailable"}`; return; }
      r.body?.cancel();
      paneNote.textContent = "view only · reconnecting…";
      retry(2000);
    }).catch(() => retry(3000));
  };
}

function drawFrame(f) {
    if (f.cols !== paneCols) fitPane(f.cols);
    term.reset();
    term.write(f.screen.replace(/\n$/, "").replace(/\n/g, "\r\n"), () => term.scrollToBottom());
    paneNote.textContent = lastNote = `view only · ${f.cols}×${f.rows} · live`;
}

// Match the seat's width exactly (rewrapping would scramble a TUI's layout), so
// pick the largest font at which all its columns fit the panel, then as many
// rows as the panel holds.
// xterm's own measured cell size (what its renderer uses); falls back to an
// estimate before the first render. Line height differs by font, so guessing
// it clips the bottom rows, where the agent's prompt is.
const cellSize = (fontSize) => term._core?._renderService?.dimensions?.css?.cell ?? { width: fontSize * 0.6, height: fontSize * 1.3 };
function fitPane(cols) {
  paneCols = cols;
  const box = document.getElementById("term");
  const availW = box.clientWidth - 16, availH = box.clientHeight - 12;
  let fontSize = term.options.fontSize;
  for (let i = 0; i < 3; i++) { // cell width scales with font size; two passes settle it
    const next = Math.max(6, Math.min(14, Math.floor(fontSize * (availW / cols / cellSize(fontSize).width) * 10) / 10));
    if (next === fontSize) break;
    term.options.fontSize = fontSize = next;
  }
  term.resize(cols, Math.max(10, Math.floor(availH / cellSize(fontSize).height)));
}

function closePane() {
  if (paneSource) { paneSource.close(); paneSource = null; }
  pane.hidden = true;
}

document.getElementById("pane-close").addEventListener("click", closePane);
window.addEventListener("resize", () => { if (!pane.hidden && term && paneCols) fitPane(paneCols); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pane.hidden) closePane(); });

// ------------------------------------------------------------------ data

function applyState(s) {
  world = s;
  for (const r of world.rigs) for (const seat of r.seats) {
    if (seat.state === "running" || seat.state === "needs_input") idleSince.delete(seat.session);
    else if (!idleSince.has(seat.session)) idleSince.set(seat.session, chars.size ? Date.now() : 0);
    if (seat.state === "needs_input") { if (!needSince.has(seat.session)) needSince.set(seat.session, Date.now()); }
    else needSince.delete(seat.session);
  }
  layout();
  renderPanel();
}

function applyActivity(ev) {
  for (const r of world.rigs) for (const seat of r.seats) if (seat.session === ev.session) {
    seat.state = ev.state === "unknown" ? "idle" : ev.state;
    seat.reason = ev.reason;
    seat.lastActivityAt = new Date(ev.at).toISOString();
  }
  applyState(world);
}

function connect() {
  const es = new EventSource("api/stream");
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.kind === "hello") { history = ev.history ?? []; applyState(ev.state); }
    else if (ev.kind === "state") applyState(ev.state);
    else if (ev.kind === "activity") applyActivity(ev);
    else if (ev.kind === "talk") {
      history.push(ev); if (history.length > 60) history.shift();
      talks.push({ ...ev, t0: performance.now() });
      renderPanel();
    }
  };
  es.onerror = () => { world.daemonOk = false; world.error = "lost connection to the rig-hq server"; renderPanel(); };
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (boss) { plan(); step(dt); }
  draw(now);
  requestAnimationFrame(frame);
}

window.addEventListener("resize", () => layout());
setInterval(renderPanel, 15000); // refresh the "ago" labels
connect();
requestAnimationFrame(frame);
