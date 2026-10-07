// Demo mode: invented rigs whose seats wander between working, idle and
// needing the boss, and hand each other work. For screenshots, for trying the
// office without an OpenRig daemon, and for working on the page itself.

const RIGS = {
  "acme-web": ["pm.lead", "orch.lead", "dev.api", "dev.web", "dev.db", "review.rev", "review.codex"],
  "data-pipeline": ["orch.lead", "dev.etl", "dev.ml", "review.rev"],
  "mobile": ["pm.lead", "orch.lead", "dev.ios", "dev.android", "review.rev", "review.codex"],
};

const ASKS = [
  "Implement the export endpoint; brief in work/briefs/export.md",
  "Review PR #42: pagination on /orders",
  "Fix the flaky login test on CI",
  "Add retry with backoff to the webhook sender",
  "Migrate the settings page to the new form library",
  "Spike: can we stream the report instead of buffering it?",
];
const BACKS = [
  "PR #42 ready: CI green, both findings fixed",
  "Fix first: the cursor skips rows when two share a timestamp",
  "Done: retries capped at 5, jitter added, tests cover the cap",
  "Blocked: need a decision on the CSV column order",
  "Ready: screenshots of every changed page in the review",
];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function startDemo({ state, history, broadcast, HISTORY }) {
  const seats = [];
  state.rigs = Object.entries(RIGS).map(([name, ids], ri) => ({
    id: `demo-${ri}`,
    name,
    status: "running",
    seats: ids.map((logicalId) => {
      const [pod, member] = logicalId.split(".");
      const seat = {
        session: `${pod}-${member}@${name}`,
        seat: `${pod}-${member}`,
        logicalId,
        pod,
        runtime: member === "codex" ? "codex" : "claude-code",
        lifecycle: "running",
        state: Math.random() < 0.35 ? "running" : "idle",
        reason: null,
        pending: 0,
        inProgress: 0,
        lastActivityAt: new Date().toISOString(),
        attach: `tmux attach -t ${pod}-${member}@${name}`,
      };
      seats.push(seat);
      return seat;
    }),
  }));
  Object.assign(state, { daemonOk: true, error: null, updatedAt: new Date().toISOString() });

  // Seats change state now and then; a few need the boss.
  setInterval(() => {
    const s = pick(seats);
    const r = Math.random();
    s.state = r < 0.45 ? "running" : r < 0.9 ? "idle" : "needs_input";
    s.reason = s.state === "needs_input" ? pick(["permission_prompt", "selection_prompt"]) : null;
    s.lastActivityAt = new Date().toISOString();
    state.updatedAt = s.lastActivityAt;
    broadcast({ kind: "state", state });
  }, 2500);

  // Work flows down from orch-lead and comes back up.
  const talk = () => {
    const rig = pick(state.rigs);
    const orch = rig.seats.find((x) => x.pod === "orch");
    const other = pick(rig.seats.filter((x) => x !== orch));
    const down = Math.random() < 0.55;
    const ev = {
      kind: "talk",
      verb: Math.random() < 0.3 ? "says" : down ? "asks" : "hands back",
      from: down ? orch.session : other.session,
      to: down ? other.session : orch.session,
      summary: down ? pick(ASKS) : pick(BACKS),
      at: Date.now(),
    };
    if (Math.random() < 0.1) Object.assign(ev, { verb: "answers a prompt for", override: true, summary: "decline the rm -rf approval prompt so the seat is unblocked" });
    history.push(ev);
    if (history.length > HISTORY) history.shift();
    broadcast(ev);
    // The recipient picks the work up; now and then a seat finishes something.
    if (ev.verb === "asks") setTimeout(() => broadcast({ kind: "claimed", session: ev.to, at: Date.now() }), 1500);
    if (Math.random() < 0.4) broadcast({ kind: "done", session: pick(seats).session, at: Date.now() });
    setTimeout(talk, 4000 + Math.random() * 6000);
  };
  setTimeout(talk, 3000);
}
