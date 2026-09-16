---
name: zellij
description: Zellij CLI usage reference for this machine's multiplexer. Use when running commands in panes, interactive or background testing, watching command output, sending input to terminals, or managing sessions — includes the tmux→zellij translation.
---

# Zellij

Zellij is driven from the CLI: `zellij run`/`zellij action` control it whether inside or outside a session. Target any session from anywhere with the global `--session NAME` flag (e.g. `zellij --session my-session action ...`).

## tmux → zellij translation

| tmux | zellij |
| --- | --- |
| `tmux new -s name` | `zellij attach --create name` (attaches immediately) or `zellij attach --create-background name` (headless) |
| `tmux ls` | `zellij list-sessions` |
| `tmux new-window -n name cmd` | `zellij action new-tab --name name -- cmd` |
| `tmux split-window -h cmd` | `zellij action new-pane -d right -- cmd` (or `zellij run -d right -- cmd`) |
| `tmux send-keys -t id 'cmd' Enter` | `zellij action paste --pane-id id 'cmd' && zellij action send-keys --pane-id id 'Enter'` |
| `tmux capture-pane -t id -p` | `zellij action dump-screen --pane-id id` (add `--full` for scrollback) |
| `tmux list-panes` | `zellij action list-panes` |
| `tmux kill-pane -t id` | `zellij action close-pane --pane-id id` |
| `tmux attach -t name` | `zellij attach name` (or `zellij watch name` for read-only) |
| targeting `-t` (target) | targeting `--pane-id` / `--tab-id`, or `zellij --session name action ...` for another session |

## Running commands in panes

`zellij run -- <cmd>` and `zellij action new-pane -- <cmd>` both launch a command in a new pane. Useful flags:

- `--name NAME` — title the pane
- `-d right|down` — split direction; `-f` / `--floating` — floating pane
- `-c` / `--close-on-exit` — close pane when the command exits (default: pane stays open showing the exit status; the user presses `Enter` to re-run or `Ctrl-c` to close)
- `--cwd DIR` — working directory
- `--no-focus` — open in background without stealing focus
- `--block-until-exit` / `--block-until-exit-success` / `--block-until-exit-failure` / `--blocking` — suspend the caller until the command exits (see below)

Both `new-pane` and `new-tab` print the created pane/tab ID to stdout — capture it: `PANE_ID=$(zellij action new-pane --name build -- cargo build)`.

## Interactive testing workflow

The blocking flags turn zellij into a test harness with human-in-the-loop retry:

- `--block-until-exit-success` blocks until the command exits 0. On failure the pane stays open with the error; the user fixes things, presses `Enter` in the pane to re-run, and the caller stays blocked until it passes.
- `--block-until-exit-failure` blocks until a non-zero exit — useful for "wait until the dev server crashes".
- A retry can be triggered remotely: `zellij action send-keys --pane-id <id> 'Enter'`.

Typical sequence for interactive testing:

```
zellij attach --create-background test options --default-layout compact   # headless session (if none exists)
PANE_ID=$(zellij --session test action new-pane --name app -- ./app.sh)  # run the thing under test
zellij --session test action dump-screen --pane-id $PANE_ID               # inspect output
zellij --session test action paste --pane-id $PANE_ID 'some input' && \
zellij --session test action send-keys --pane-id $PANE_ID 'Enter'         # drive it
```

## Sending input and reading output

- **Prefer `paste` over `write-chars`**: it uses bracketed paste — faster and correct for multi-line input (e.g. `paste 'printf "a\nb\n"'`). `paste` sends text; `send-keys 'Enter'` / `'ctrl c'` presses keys. Both accept `--pane-id`.
- `dump-screen [--full] [--pane-id ID] [--path FILE]` — snapshot the viewport (default; `--full` adds scrollback). ANSI codes stripped by default; `--ansi` preserves them.
- `zellij subscribe --pane-id ID --format json` — stream pane output as NDJSON in real time; `dump-screen` in a loop is the polling alternative.
- `list-panes` / `list-tabs` / `current-tab-info` / `list-clients` all take `--json` for structured state.
- A pane run with `-- cmd` reflects completion in its metadata: poll `zellij action list-panes --json` for `.exited` / `.exit_status`.

## Pane IDs

Terminal panes are addressed as `terminal_N`, plugin panes `plugin_N`, bare `N` = `terminal_N`. The pane you run a command from knows itself via `$ZELLIJ_PANE_ID`. Many actions accept `--pane-id` so you never need to change focus first. Chain dependent actions with `&&` — ordering across concurrent invocations is not guaranteed.

## Session management

- `zellij attach --create-background name` — create a headless session; control it with `zellij --session name action ...` from outside.
- `zellij attach name` — attach; `zellij watch name` — read-only attach.
- `zellij action detach` — leave the session running.
- `zellij kill-session name` / `zellij delete-session name` — stop / clean up.
- Sessions auto-resurrect by default; if a stale session interferes, `delete-session` rather than reusing it.
