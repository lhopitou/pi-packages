---
name: tmux
description: tmux CLI usage reference — controlling sessions, windows, and panes from inside or outside a session. Use when running commands in panes, spawning windows, sending input, capturing output, or managing sessions.
---

# tmux

tmux is server-driven: every command works from anywhere via targets. Run
`tmux <command>` inside a pane to act on the current session, or pass targets
(`-t`) to act on any session from anywhere.

## Environment detection

- `$TMUX` set → you are inside a tmux session
- `$TMUX_PANE` → the current pane's id (`%N`)
- Resolve names from the current pane:
  `tmux display-message -p '#{session_name}'` / `'#{window_id}'` / `'#{pane_id}'`
- Window ids look like `@N`, pane ids like `%N`

## tmux → zellij translation

| tmux | zellij |
| --- | --- |
| `tmux new-session -d -s name` | `zellij attach --create-background name` |
| `tmux ls` | `zellij list-sessions` |
| `tmux new-window -n name cmd` | `zellij action new-tab --name name -- cmd` |
| `tmux split-window -h cmd` | `zellij action new-pane -d right -- cmd` |
| `tmux send-keys -t id 'cmd' Enter` | `zellij action paste --pane-id id 'cmd' && zellij action send-keys --pane-id id 'Enter'` |
| `tmux capture-pane -p -t id` | `zellij action dump-screen --pane-id id` |
| `tmux list-panes -a` | `zellij action list-panes --json` |
| `tmux kill-pane -t id` | `zellij action close-pane --pane-id id` |
| `tmux attach -t name` | `zellij attach name` |
| `-t` targets | `--pane-id` / `--tab-id`, or `zellij --session name action ...` |

## Sessions

- `tmux new-session -d -s name` — create detached (headless)
- `tmux attach -t name` — attach
- `tmux ls` — list sessions
- `tmux has-session -t name` — exit-code check
- `tmux kill-session -t name` — stop it

## Windows and panes

- `tmux new-window -n NAME -c DIR [-d] [command]` — new window; `-c` sets the
  cwd, `-d` creates it without switching (background), a trailing command runs
  in the pane
- `tmux split-window -h|-v -c DIR [-t target] [command]` — split right/down
- `tmux list-windows [-a] [-F format]` / `tmux list-panes [-a] [-F format]` —
  inventory; `-a` covers all sessions. Useful format:
  `-a -F '#{session_name} #{window_name} #{pane_id} #{pane_current_path}'`
- `tmux kill-window -t target` / `tmux kill-pane -t target`
- Panes run `command` directly (no trailing shell wrapper needed); the pane
  stays open showing the exit status when the command exits

## Environment for spawned commands

- `tmux new-window -e VAR=value ...` sets env vars for the new window's
  process (tmux ≥ 3.2)
- Or prefix the command: `tmux new-window ... 'env VAR=x cmd'`

## Sending input

- `tmux send-keys -t %N 'text' Enter` — literal text, then keys (`Enter`,
  `C-c`, …). Fine for one-liners
- For multiline text, use a buffer:
  `tmux load-buffer -b NAME file && tmux paste-buffer -b NAME -t %N`
  then `tmux send-keys -t %N Enter` to submit
- `tmux send-keys -t %N -l 'text'` — `-l` forces literal mode (no key names)

## Capturing output

- `tmux capture-pane -p -t %N` — current viewport as plain text (ANSI stripped)
- `tmux capture-pane -p -S -300 -t %N` — include the last 300 scrollback lines
- Poll `capture-pane` in a loop, or use `tmux display-message -p -t %N
  '#{pane_dead} #{pane_dead_status}'` to check whether the pane's command
  exited

## Renaming

- `tmux rename-window -t @N 'name'` — window names always render in the
  status line
- `tmux select-pane -t %N -T 'title'` — pane titles only show with
  `pane-border-status` configured

## Targeting

- Session: name or `$id`. Window: `@id`, name, or index. Pane: `%id`
- Commands that take a window target also accept a pane target — it resolves
  to the pane's window (e.g. `kill-window -t %3`)
- Omitting `-t` acts on the current pane/window when invoked from inside a
  session; from outside, prefer explicit targets or `-a` listings

## Session management

- `tmux kill-server` — stop everything
- Detach inside a session: `Ctrl-b d` (prefix d); the session keeps running
- Sessions do not auto-resurrect after reboot; recreate with `new-session -d`