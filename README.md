# Rig HQ

A pixel-art office for your [OpenRig](https://openrig.dev) agent teams. Every rig is a room off a hallway, every seat is a little person at a desk, and you have the corner office.

![Rig HQ in demo mode: a boss office with two seats queued at the door, a coffee room of idle seats, and three rig rooms with people working at their desks](docs/screenshot.png)

**Where someone is tells you their state:**

- **At their desk:** working. They type, their screen scrolls green, and a "…" bubble floats over them.
- **In the coffee room:** idle, mug in hand. A seat heads there 15 seconds after going idle, so quick hand-offs don't send people back and forth.
- **Queued at your door:** they need you (a permission or selection prompt, or OpenRig flagged the seat for attention). They line up in the order they started waiting, with a red "!", and the side panel lists each one with its `tmux attach` command. Answer the prompt and they walk back.

**Conversations:** when a seat creates or hands off a queue item, an envelope flies from sender to recipient and the sender says what it's about. The side panel keeps the last few hours; click one to replay it.

Hover anyone for their runtime, pod, state and work counts. Claude seats wear their pod's colour; Codex seats wear orange with a visor.

## Run it

Needs Node 22 or later and a running OpenRig daemon. No dependencies to install.

```sh
git clone https://github.com/dmelo/rig-hq && cd rig-hq
node server.mjs               # http://127.0.0.1:7480
```

No OpenRig yet, or just curious? Start it with invented rigs:

```sh
node server.mjs --demo
```

| Variable | Default | |
|---|---|---|
| `PORT` | `7480` | where the office is served |
| `HOST` | `127.0.0.1` | bind address; the page and its event stream have no auth, so keep it on loopback unless you trust the network |
| `DAEMON` | `http://127.0.0.1:7433` | the OpenRig daemon |
| `RIG_HQ_BOSS` | `You` | the name on your office door (`?boss=Name` in the URL overrides it for one page) |
| `DEMO` | | `1` for demo mode, same as `--demo` |

If the rigs run on another machine, tunnel the port: `ssh -N -L 7480:127.0.0.1:7480 <host>`, then open `http://localhost:7480`.

## How it works

`server.mjs` is a small read-only bridge; it never writes to the daemon.

- Every 4 seconds it reads the rigs (`/api/ps`) and each rig's seats (`/api/rigs/:id/nodes`). A seat's state is the daemon's reconciled activity (`activityState.display`, what `rig ps` and the OpenRig TUI show), plus the daemon's on-screen prompt detection, which also catches seats waiting at a prompt.
- It follows the daemon's event stream (`/api/events`) for queue traffic (`queue.created`, `queue.handed_off`). Activity events only trigger an early re-read, never a state change by themselves.
- It serves `public/` and pushes state and conversations to every open page over server-sent events (`/api/stream`).

The page is plain JavaScript on a `<canvas>`. All the art is drawn in code, so there are no image assets.

## Limits

- Only queue traffic shows as conversation. Plain `rig send` messages aren't recorded by the daemon, so they can't be shown.
- Tested against OpenRig 0.6.x. The daemon's HTTP API isn't documented as stable, so a future version may need changes here.

## Inspiration

The idea of watching coding agents as pixel people in an office comes from [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents), which does this for Claude Code sessions. Rig HQ is a separate implementation built around OpenRig's model instead (rigs, pods, seats and their queue), so it can give every rig its own room and show Codex seats too. [claude-office](https://github.com/paulrobello/claude-office) and [Agent Virtual Office](https://github.com/KbWen/agent-virtual-office) explore the same idea. No code or art is taken from any of them.

## License

[MIT](LICENSE)
