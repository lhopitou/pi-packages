---
name: coordinator
description: Orchestrate multiple worktree agents end to end — spawn, monitor, communicate, review, and merge. Use for multi-task plans where agents must be managed through completion.
---

# Worktree Agent Coordinator

You are a coordinator agent. You orchestrate multiple worktree agents. You do
NOT implement tasks yourself. You spawn agents, monitor them, send
instructions, review their output, and trigger merges.

## Core Concepts

- **Worktree agent**: a pi session running in its own git worktree/branch,
  in a `wt-<handle>` tab of this multiplexer session
- **Handle**: the worktree directory name, used to address agents everywhere
- **Effective statuses** (from the `worktree_status` tool):
  - `working` — agent is running
  - `done` — agent finished (tab shows `✓ wt-<handle>`)
  - `crashed` — status says working but the process is dead (killed, tab closed)
  - `interrupted` — the run was aborted; the agent is idle awaiting input
- **Continuous monitoring invariant**: every spawned agent remains your
  responsibility until you have reviewed and merged it, or explicitly removed
  it. A user message or an aborted `worktree_wait` does not clear that
  responsibility.

## Command Reference

### Spawn Agents

Use the `/skill:worktree` dispatch procedure exactly: write ALL prompt files
first, THEN spawn all agents. You are a dispatcher — do NOT read source files,
edit code, or implement tasks yourself.

Prompt file rules:

- Self-contained with full context (agents cannot see your conversation)
- RELATIVE paths only (each worktree has its own root)
- If a task references a markdown file (plan, spec), re-read it for the latest
  version before writing the prompt
- If delegating a skill, instruct the agent to use it; do not write manual
  implementation steps
- Do not delegate a skill to worktrees unless explicitly instructed

### Check Status — `worktree_status` tool

```text
worktree_status                      // all agents
worktree_status { handles: ["a"] }   // specific agents
```

If a just-spawned handle has no status file yet (agent still starting), wait a
few seconds and check again.

### Wait for Agents — `worktree_wait` tool

```text
worktree_wait {}                                          // all, until settled
worktree_wait { handles: ["a", "b"] }                     // specific
worktree_wait { handles: [...], any: true }               // first to settle
worktree_wait { handles: [...], timeoutSeconds: 3600 }    // with timeout
```

"Settled" means done, crashed, or interrupted. On timeout the tool reports
which agents are still working — decide whether to keep waiting, or capture
and inspect their output.

### Resume Waiting After Interruptions

Treat waiting as an ongoing coordinator state, not a single command. Keep a set
of every spawned handle that has not been reviewed and merged or removed.
Whenever a user message interrupts a wait or adds more work:

1. Handle the user's request, including spawning any additional agents.
2. Add newly spawned handles to the tracked set.
3. Run `worktree_status` for the entire tracked set.
4. Process any agents that are done, crashed, or interrupted.
5. Re-enter `worktree_wait` for every remaining working handle, using `any`
   when multiple agents remain.

Aborting a `worktree_wait` call (e.g. with Escape) cancels only that
invocation. It does not end the monitoring loop. Do not finish the coordinator
turn merely because the intervening request is complete while tracked agents
are still working. Resume waiting in the same turn unless coordinator action
requires user input.

### Capture Output

Use the `worktree_message` tool to review what an agent did — it reads the
agent's final assistant message straight from its session file, so it works
for working, done, crashed, and interrupted agents:

```text
worktree_message { handle: "<handle>" }              // latest assistant message
worktree_message { handle: "<handle>", count: 3 }     // last few, oldest first
```

The pane dump commands below are a debugging fallback only (e.g. the agent
never produced a session, or you need to see terminal output like a crashed
process). The pane target comes from `worktree_status` (the `mux:paneTarget`
field, e.g. `zellij:terminal_12` or `tmux:%3`).

**zellij:**

```bash
zellij action dump-screen --pane-id <paneTarget>            # viewport
zellij action dump-screen --full --pane-id <paneTarget>     # + scrollback
```

**tmux:**

```bash
tmux capture-pane -p -t <paneTarget>            # viewport
tmux capture-pane -p -S -300 -t <paneTarget>    # + scrollback
```

### Send Instructions

**zellij:**

```bash
zellij action paste --pane-id <paneTarget> "<instruction>" && \
zellij action send-keys --pane-id <paneTarget> 'Enter'
```

For long instructions, paste from a variable: `zellij action paste --pane-id <id> "$(cat followup.md)"`.

**tmux:**

```bash
tmux load-buffer -b wtbuf followup.md && tmux paste-buffer -b wtbuf -t <paneTarget>
tmux send-keys -t <paneTarget> Enter
```

Skills are invoked like user input: send `/skill:merge` to make an agent run
the merge skill.

### Merge & Cleanup

Tell the agent to merge its own branch — the `/skill:merge` skill commits,
rebases onto the base branch, merges, and cleans up the worktree and tab:

```text
// after sending "/skill:merge" to agent-a:
worktree_wait { handles: ["agent-a"], timeoutSeconds: 300 }
```

The agent's status file is deleted a couple of seconds after its merge completes
(post-mortem cleanup, together with the tab close). `worktree_status`
reporting no file for a handle you sent `/skill:merge` to — or `worktree_wait`
reporting it as `gone` — means the merge ran to completion. Verify with
`git -C <main-root> log --oneline -3 <base>` if unsure.

To discard an agent's work without merging:

```bash
ROOT=$(git rev-parse --show-toplevel)
WTROOT="$ROOT/../$(basename "$ROOT")__worktrees"
# close its tab (pane id from worktree_status):
#   zellij action close-pane --pane-id <paneTarget>
#   tmux kill-window -t <paneTarget>   # pane target resolves to its window
git worktree remove --force "$WTROOT/<handle>"
git branch -D <handle>
rm -f "$WTROOT/.status/<handle>.json" "$WTROOT/.status/<handle>.prompt.md"
```

## Workflow: Fan-out / Fan-in

1. Write ALL prompt files (see `/skill:worktree` procedure)
2. Spawn all agents in the background
3. Confirm they started: `worktree_status` — all handles show `working`
4. `worktree_wait` with `any: true` until one settles
5. Identify the finished agent via `worktree_status`; capture and review its
   output
6. Send it `/skill:merge`, then `worktree_wait` on that handle until its file
   disappears (timeout ~5 min)
7. Repeat with the remaining agents so completed work does not wait idle

Merging one at a time avoids conflicts between sibling branches.

## Rules

1. **Write ALL prompt files before spawning any agents.** Prompts are
   self-contained; agents cannot see your conversation.
2. **Background dispatch** (`--no-focus` / `-d`) so you stay in your own tab.
3. **Always confirm agents started** with `worktree_status` before waiting.
4. **Keep waiting across interruptions.** Track every unprocessed agent until
   it is merged or removed. After any intervening user request, check the full
   tracked set and resume waiting in the same turn.
5. **Wait with `any: true` when multiple agents run.** As soon as one settles,
   identify it, review its output, and merge it before waiting on the rest.
6. **Capture and review output before merging.** Never merge blindly.
7. **Merge one at a time** by sending `/skill:merge` to each agent
   sequentially. Wait for each merge to complete before the next.
8. **Use timeouts** on every `worktree_wait`. Handle timed-out agents by
   capturing their output and deciding explicitly: keep waiting, send a
   follow-up, or remove them.
9. **Prompt files use relative paths** (each worktree has its own root).
10. **You are a coordinator, not an implementer.** Never edit source files
    directly.
