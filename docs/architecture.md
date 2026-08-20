# Architecture

Boop is a persistent, event-driven, single-user AI agent. This document
describes the intended design. Implementation is in progress.

## Design principle: minimal understandable main loop

The agent's core is a single loop small enough to read and hold in your
head. Complexity is pushed to the edges — into providers, tools, and
memory — so the loop itself stays a thin spine:

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

Event providers are the sources of work. Each provider is an independent
module that knows how to produce events and push them onto the queue.
Examples: a timer/cron provider, a webhook/HTTP provider, a message
provider (chat, email), a file watcher.

Providers are plugins: they implement a small interface and register with
the agent. The main loop does not know or care where events come from — it
only consumes the queue.

### Event queue

A FIFO of pending events. Providers push; the loop pulls. The queue is the
single handoff point between the asynchronous outside world and the loop's
one-thing-at-a-time processing.

### Transient sessions

A session is a short-lived context created to handle a single event (or a
small batch). It is spun up when the loop dequeues an event and torn down
when the work is done. Sessions hold no state between events by design —
if something must persist, it is written to memory and read back next
time.

This makes each event's processing inspectable and isolated: a session is
just "given this event and this remembered context, decide and act."

### Memory store

Memory is the only thing that outlives a session. Before running, a session
loads whatever context is relevant to the event; after running, it writes
back anything worth remembering. This is how the agent maintains
cross-event knowledge without keeping sessions alive.

Memory *is* the agent's continuity. Its shape (key-value, documents, a
graph, a database) is an implementation detail; what matters is the
contract: sessions read in, write out, and the store persists between them.

### Tools

Tools are the actions a session can take on behalf of the agent — call an
API, read a file, send a message. They are the "other tooling" that hangs
off sessions. Tools are pluggable like providers: a session is given the
set of tools available to it, and the LLM decides which to use.

## Single-user

Boop assumes one user. There is no multi-tenancy, no per-user isolation,
no auth between users. This is a deliberate scope choice that keeps both
the loop and the memory model simple.
