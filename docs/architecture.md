# Architecture

Boop is a persistent, event-driven, single-user AI agent.
This document describes the intended design.
Implementation is in progress.

## Design principle: minimal understandable main loop

The agent's core is a single loop small enough to read and hold in your head.
Complexity is pushed to the edges — into providers, tools, and memory — so the loop itself stays a thin spine:

```
loop:
  event   = queue.pull()
  session = new session(event)
  session.load(memory)      # pull in relevant context
  session.run()            # LLM + tools act on the event
  session.flush(memory)    # write back what to remember
  session.end()
```

Everything outside that loop is a replaceable, swappable component.

## Components

### Event providers (plugins)

Event providers are the sources of work.
Each provider is an independent module that knows how to produce events and push them onto the queue.
Examples: a timer/cron provider, a webhook/HTTP provider, a message provider (chat, email), a file watcher.

Providers are plugins: they implement a small interface and register with the agent.
The main loop does not know or care where events come from — it only consumes the queue.

Plugins live in a top-level `plugins/` directory and are discovered at startup by scanning one or more plugin directories in order.
Each plugin is either a single `.ts`/`.js` file or a package directory whose entry is resolved from its `package.json` (`exports["."]` → `main` → `module`, or an `index.{ts,js}` fallback); Node resolves a package's dependencies from the entry's location, so a package with its own deps — or one nix-symlinked into place with its deps alongside — loads the same way as a dependency-less directory.
Source `.ts` plugins stay within erasable syntax (no enums, namespaces, parameter properties) so Node's type stripping loads them without a build step, and import boop's contract only as types (`import type`) so the boop specifier is erased at runtime and never has to resolve.
A plugin name found in an earlier directory wins; a later directory can't shadow it.
The same mechanism backs every pluggable piece below — executors, tools, memory, response channels are all just plugins registering on the host.

### Event queue

A FIFO of pending events.
Providers push; the loop pulls.
The queue is the single handoff point between the asynchronous outside world and the loop's one-thing-at-a-time processing.

### Transient sessions

A session is a short-lived context created to handle a single event (or a small batch).
It is spun up when the loop dequeues an event and torn down when the work is done.
Sessions hold no state between events by design — if something must persist, it is written to memory and read back next time.

This makes each event's processing inspectable and isolated: a session is just "given this event and this remembered context, decide and act."

### Session executors

The session executor is the low-level piece that owns a prepared session's agentic loop (LLM ↔ tool calls) and returns the transcript.
It is supplied by a plugin at init time, registered under a stable id, so several executors may be registered and the core selects which one to run (from the config file); the selection is made once at startup and an unknown id fails loudly.
Exactly one executor runs a session; choosing a different id is how the LLM/runtime is swapped without touching the loop.

A prepared session carries the event, a separate system prompt string, and an ordered, mutable list of user/assistant messages (the system prompt is kept separate so executors that take it as a distinct argument — e.g. claude's `--system-prompt` — pass it through unchanged).
Plugins may register a *session preparer*: a hook that mutates that message list before the executor runs.
Memory/context injection is the expected first user — loading relevant memory into the session is a builtin preparer, not baked into the loop.
There is no ordering or priority among preparers; every registered one runs for every session.

### Memory store

Memory is the only thing that outlives a session.
Before running, a session loads whatever context is relevant to the event; after running, it writes back anything worth remembering.
This is how the agent maintains cross-event knowledge without keeping sessions alive.

Memory *is* the agent's continuity.
Its shape (key-value, documents, a graph, a database) is an implementation detail; what matters is the contract: sessions read in, write out, and the store persists between them.

### Tools

Tools are the actions a session can take on behalf of the agent — call an API, read a file, send a message.
They are the "other tooling" that hangs off sessions.
Tools are pluggable like providers: a session is given the set of tools available to it, and the LLM decides which to use.

### Response channels

Response channels are the reply-side mirror of event providers: where a provider pushes an event in, a channel carries a reply out.
A provider that can deliver a message back to a user — an HTTP ingest request held open for a reply, an SMS gateway, a live webui connection — registers a `ResponseChannel` for as long as it is willing to deliver and unregisters it when it stops.
The registry is simply the set of reply paths open right now; it has no knowledge of events.

Channel lifetimes are deliberately independent of events.
An HTTP ingest channel is transient — it lives only while one request is held open — but an SMS channel could be eternal (registered at startup, never unregistered) and a webui channel is transient on its own clock (the life of a connection).
A single event may carry a channel id in its payload so the session handling it knows where to reply, but the registry does not tie a channel's lifetime to any event.

The plugin boundary for replies sits on the channels, not the tool.
The core owns a single `respond` tool that takes a channel id and a message; which channels are available is whatever the providers have opened.
The session message lists the currently-open channels as a snapshot taken when the session is prepared, but the tool queries the registry live at call time — so a channel that closed between preparation and a `respond` call surfaces as a semantic error to the agent rather than a silent drop.

## Configuration

Boop reads a single JSON file, `$XDG_CONFIG_HOME/boop/config.json` (default `~/.config/boop/config.json`); a missing file is fine (all defaults), a malformed one fails startup.
Today the only setting is `executor`, the id of the session executor to run each event's session; `BOOP_EXECUTOR` overrides the file.
With no selection, the core runs the sole registered executor and refuses to guess when several are registered.

## Single-user

Boop assumes one user.
There is no multi-tenancy, no per-user isolation, no auth between users.
This is a deliberate scope choice that keeps both the loop and the memory model simple.
