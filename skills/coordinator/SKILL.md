---
name: coordinator
description: Drive subagent panes with the mux tool — spawn agents into panes or tabs, have them report in, steer them mid-run, inspect their state, and stop them when done. Use when delegating tasks to subagents, fanning out parallel work, or coordinating several agents in the multiplexer session.
---

# Agent pane coordination

You coordinate subagents as mux pane peers: pi sessions in panes or tabs of
this multiplexer session, addressed by pane number.

## Guard

The mux tool registers only when the agent runs inside a multiplexer
session. If it is missing from your tools, the task cannot proceed: report
to the user that coordinator work needs a multiplexer session, and stop
there.

## Pre-flight

Run `mux list` before spawning. It confirms the session state and gives you
your own pane number — agents report back to that number, and you embed it in
every task prompt.

## Spawning

`mux spawn` is fire-and-forget: give it a `handle`, `cwd`, and a
self-contained `task` (inline text or `@file` for bulk). Spawned agents see
none of your conversation, so each prompt carries all the context the task
needs; bulk content travels by file path, never inline.

**File ownership:** partition tasks so each agent edits its own files —
concurrent writes to a shared file clobber each other. Check the task set
for shared-file conflicts before spawning. When the work can't be split
cleanly, isolate it: follow the dispatch procedure in
`skills/worktree/SKILL.md` (worktree at the conventional path, base branch
recorded, setup script run, agent spawned via mux with `cwd` inside it).
The spawned agents are ordinary pane peers — steer, inspect, and stop them
like any other. Their branches land only when you send them `/skill:merge`
after reviewing their report — one at a time.

**Placement:**
- `right` — short-lived agents, few of them (≤2): they sit beside you, in
  view while they work, a glance away from inspection.
- `tab` — long-lived agents or many of them: each gets its own tab, keeping
  your tab uncluttered and your layout usable.

## Reporting vs inspecting

Two ways to learn what a subagent did. Choose by situation:

**Push — the agent reports in.** Embed in the task prompt: "When finished,
`mux send pane <N>` a brief report, ending the last line with
`DONE <handle>`." The report arrives as a user message (`[mux] from pane N`)
that wakes you, so you act on completion the moment it happens — update your
records, stop the pane, spawn the next queued task. Reach for push when:
- agents are many — watching panes does not scale
- runs are long — you are free to do other work; the report wakes you
- completion must trigger follow-up (wave replacement, cleanup)

**Pull — you inspect the pane.** `mux read` with `view: "state"` shows the
live tool call and recent messages; `view: "screen"` dumps the raw terminal;
`wait_for` blocks until the pane says something matching. Reach for pull
when:
- agents are few and short-lived beside you — checking is cheaper than
  wiring the report protocol into the prompt
- you want mid-run progress without disturbing the agent
- an agent goes quiet, a report is late or missing, or a report smells wrong
  — verify against the pane itself
- the agent crashed or hung and you need to see terminal output

Push for completion, pull for verification: even with report-in agents, read
the pane when a report is overdue or a claim needs checking.

## Steering

`mux send` delivered to a busy agent steers it mid-run — steer, don't
restart: a correction in flight saves re-running the whole task.
`broadcast` reaches every live agent at once — use it to fan a shared
discovery (a blocker, a superseded decision) to all in-flight siblings so
they converge instead of each rediscovering it. A finished-but-still-live
agent that got something wrong is fixed in place the same way: send the
correction, it re-runs, and reports `DONE` again.

Keep messages brief; bulk data travels by file path.

## Lifecycle

`mux stop` closes a pane. Stop an agent after its `DONE` report — close one
before spawning its replacement — and stop a misbehaving agent to abort it.
At the end of a run, `mux list` is the audit: every agent you spawned is stopped.
Panes you did not create are none of your concern.

## Recovery

A failed mux call (schema typo, pane already gone) is retryable. Re-check
`mux list` for the current pane layout, adjust, and retry.
