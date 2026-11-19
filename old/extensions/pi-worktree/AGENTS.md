# pi-worktree

Status tracking for parallel git-worktree pi agents. Replaces workmux's status
tracking and agent-interaction CLI. One extension, two modes, switched by env
vars — nothing to configure.

## Modes

| Mode | When | What it does |
|---|---|---|
| **Reporter** | `PI_WORKTREE_STATUS_DIR` **and** `PI_WORKTREE_HANDLE` env vars set | Writes the agent's status file on session/agent events; renames its own window (tmux) `● wt-<handle>` (working) / `✓ wt-<handle>` (done). In zellij the rename markers are hidden: zellij ≥0.46 draws its own working/needs-you/done markers from pi's OSC 7501 program status |
| **Coordinator** | env vars absent | Registers `worktree_status` and `worktree_wait` tools |

The worktree skill's spawn command sets the env vars when launching pi in a
new worktree tab. Worktree agents therefore run in reporter mode
automatically; your main sessions run in coordinator mode.

## Conventions

- Worktrees live at `<project>__worktrees/<handle>`, sibling of the main checkout.
- Status files: `<project>__worktrees/.status/<handle>.json` (deleted by the
  merge/remove workflow, not by this extension).
- Base branch tracking: `git config branch.<handle>.base` (set at spawn).
- The multiplexer is auto-detected from the environment: `$ZELLIJ_PANE_ID`
  (zellij) or `$TMUX_PANE` (tmux). No configuration.
- Must run inside zellij or tmux for rename display; without a multiplexer the
  reporter still writes status files but cannot rename anything.
- Renaming is skipped while `terminal.showTerminalProgress` is enabled: the
  OSC 9;4 progress spinner already marks the tab, and a rename would fight it.
  Status files are still written.
- Zellij pane names are only drawn in pane frames (multi-pane tabs), so the
  reporter also renames the tab — resolved via `list-panes --tab --json` →
  `rename-tab --tab-id` — making the marker visible in the tab bar.
- Rename markers are hidden in zellij (redundant with zellij ≥0.46's own
  OSC 7501-driven markers) and while `terminal.showTerminalProgress` is
  enabled (the OSC 9;4 spinner would fight the rename). Status files are
  always written.

## Status file schema

```json
{
  "handle": "feature-x",
  "state": "working | done",
  "stopReason": "aborted | null",
  "pid": 12345,
  "mux": "zellij | tmux | null",
  "paneTarget": "terminal_12 | %3 | null",
  "session": "myproject | null",
  "sessionFile": "/home/.../sessions/--...--/....jsonl | null",
  "startedAt": 1710000000000,
  "updatedAt": 1710000123000
}
```

## Semantics

- `agent_start` → `state: working`, `stopReason: null`, rename `●`.
- `agent_settled` with a normal stop → `state: done`, rename `✓`.
- `agent_settled` after an abort → `state` stays `working`, `stopReason:
  "aborted"`, display stays `●`. The user interrupted deliberately and may
  send more input; the next `agent_start` clears the flag.
- `worktree_wait` treats an agent as settled when its **effective** status is:
  - `done` — finished normally
  - `crashed` — `state: working` but the pid is dead (killed, tab closed,
    machine rebooted)

  An `interrupted` agent (`state: working` + `stopReason: aborted` + alive) is a
  display state only: `worktree_wait` keeps treating it as working — the wait
  continues until it finishes, dies, or times out. `worktree_status` still
  reports it as `interrupted`.

## Tools (coordinator mode)

- `worktree_status(handles?)` — lists agents with effective status, pid
  liveness, pane target, session, age. Unknown handles are reported with the
  known-handle list.
- `worktree_wait(handles?, any?, timeoutSeconds?)` — blocks until the target
  agents settle (done/crashed; interrupted agents keep waiting), then reports
  per-handle outcomes.
  `any: true` returns on the first settled agent (review-and-merge-one-at-a-time
  pattern). Default timeout 3600s. Aborting the tool call returns a summary.
- `worktree_message(handle, count?)` — reads the latest assistant message(s)
  from the agent's session JSONL (path recorded in the status file's
  `sessionFile` field, set at `session_start`). Works for working, done,
  crashed, and interrupted agents — the file survives the process. Falls back
  to the most recent session for the worktree cwd when `sessionFile` is
  missing (agents spawned before the field existed).

Sending input to an agent stays bash + multiplexer (`zellij action paste` /
`tmux send-keys`), targeting the `paneTarget` recorded in the status file.
Capturing output should use `worktree_message` — pane dumps
(`dump-screen` / `capture-pane`) are a debugging fallback only. See the
`zellij`, `tmux`, and `coordinator` skills.

## Related skills

- `worktree` — dispatcher: creates worktrees, spawns agent tabs, runs
  `scripts/setup-worktree.sh` for file ops + post-create hooks
- `coordinator` — fan-out/fan-in lifecycle orchestration
- `merge` / `rebase` — finishing workflows