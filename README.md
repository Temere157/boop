# boop

A persistent, event-driven, single-user AI agent.

Boop runs continuously and reacts to events from pluggable providers. Each
event is handled by a short, transient session that loads what it needs from
long-lived memory, does its work, and writes back what it learned before
ending. The agent's continuity lives in memory, not in long-running
sessions.

## Goals

- **Minimal, understandable main loop.** The core loop should be small
  enough to read and follow in one sitting. Everything else hangs off it.
- **Pluggable event providers.** Events arrive from independent providers
  (timers, webhooks, messages, …) that the loop treats uniformly. Adding an
  event source means writing a provider, not touching the loop.
- **Transient sessions.** Work happens in short-lived sessions that spin up
  to handle an event and tear down when done — no kept-alive conversational
  state.
- **Out-of-session memory.** Knowledge that must survive a session is
  written to a memory store that later sessions read from. Continuity is
  explicit, not implicit in long-lived state.
- **Single-user.** One agent, one user, one memory. No multi-tenancy.

## Architecture

```
  providers ──▶ queue ──▶ main loop
   (plugins)               │
                           │ spawn per event
                           ▼
                       ┌──────────┐
              load     │ session  │     write
          ┌──────────▶ │ (LLM +   │ ──────────┐
          │            │  tools)  │           │
          │            └──────────┘           │
          ▼                                     ▼
   ┌───────────────────────────────────────────────┐
   │                 memory store                   │  (long-lived,
   └───────────────────────────────────────────────┘   out-of-session)
```

- **Providers** push events onto a queue.
- The **main loop** pulls the next event and spawns a transient **session**.
- The **session** loads relevant context from **memory**, runs the LLM with
  its **tools**, then writes anything worth remembering back to **memory**.
- **Memory** is the only thing that persists between sessions.

See [docs/architecture.md](docs/architecture.md) for the detailed design.

## Status

Boop is at the start of implementation. The repository currently holds a
base TypeScript + Nix setup; the event loop, sessions, memory store, and
provider plugin model are not yet built.

## Development

A Nix flake provides the devshell:

```sh
nix develop     # nodejs, npm, typescript-language-server
npm install     # install dependencies
npm run dev     # run with tsx watch
npm run typecheck
```
