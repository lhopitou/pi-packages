---
name: worktree
description: Launch one or more tasks in new git worktrees, each running an isolated pi agent in its own multiplexer tab. Use when delegating tasks to parallel worktree agents.
disable-model-invocation: true
---

# Worktree dispatch

Launch one or more tasks in new git worktrees using zellij or tmux tabs.

## You are a dispatcher, not an implementer

**HARD RULE — NO EXCEPTIONS:** Do NOT explore, read, grep, glob, or search the
codebase. Do NOT investigate the problem. You are a thin dispatcher — your ONLY
job is to write prompt files and spawn worktrees. The worktree agent does all
the exploration and implementation.

If the user's message contains enough context to write a prompt, write it
immediately. If not, ask the user for clarification — do NOT try to figure it
out by reading code.

If tasks reference earlier conversation (e.g., "do option 2"), include all
relevant context in each prompt you write.

If tasks reference a markdown file (e.g., a plan or spec), re-read the file to
ensure you have the latest version before writing prompts.

## Conventions

- Worktrees live at `<project>__worktrees/<handle>`, a sibling of the main checkout
- Handles: 2-4 words, kebab-case (e.g. `add-search-endpoint`)
- Tab/window named `wt-<handle>`; its pane shows `● wt-<handle>` while working,
  `✓ wt-<handle>` when done (status tracking via the pi-worktree extension)
- Base branch recorded at spawn: `git config branch.<handle>.base`
- Status files: `<worktrees>/.status/<handle>.json` — the coordinator reads
  these via `worktree_status` / `worktree_wait` tools

## Workflow

**Write ALL prompt files first, THEN spawn all worktrees.**

### Step 1 — Resolve paths and write prompt files

```bash
ROOT=$(git rev-parse --show-toplevel)
WTROOT="$ROOT/../$(basename "$ROOT")__worktrees"
mkdir -p "$WTROOT/.status"
```

For each task, generate a handle, then write a detailed implementation prompt
to `"$WTROOT/.status/<handle>.prompt.md"`. The prompt must be:

- Self-contained with full context (the worktree agent cannot see your conversation)
- Using RELATIVE paths only (each worktree has its own root)
- Specific about what the agent should accomplish

If the user passes a skill reference (e.g. `/skill:auto`), instruct the agent
to use that skill instead of writing manual implementation steps, passing any
flags through. If the user asks for `--merge`, append to the prompt:

```
Then use the /skill:merge skill to commit, rebase, and merge the branch.
```

### Step 2 — Spawn worktrees

For each task, run all of the following from the CURRENT directory:

```bash
HANDLE=<handle>
PROMPT_FILE="$WTROOT/.status/$HANDLE.prompt.md"
BASE=$(git branch --show-current); BASE=${BASE:-main}
WT="$WTROOT/$HANDLE"

# Create the worktree branched from the current HEAD
git worktree add "$WT" -b "$HANDLE"
git config "branch.$HANDLE.base" "$BASE"

# Deterministic file ops (copy/symlink) + post_create hooks
# setup-worktree.sh lives in this skill's scripts/ directory — resolve the
# path relative to the directory containing this SKILL.md
bash <this skill's directory>/scripts/setup-worktree.sh "$ROOT" "$WT"
```

Then create the tab and launch the agent. Detect the multiplexer from the
environment and error out if neither is running:

**zellij:**

```bash
zellij action new-tab --name "wt-$HANDLE" --cwd "$WT" --no-focus -- \
  env PI_WORKTREE_STATUS_DIR="$WTROOT/.status" PI_WORKTREE_HANDLE="$HANDLE" \
  pi -a -n "wt-$HANDLE" "@$PROMPT_FILE"
```

**tmux:**

```bash
tmux new-window -n "wt-$HANDLE" -c "$WT" -d \
  "env PI_WORKTREE_STATUS_DIR='$WTROOT/.status' PI_WORKTREE_HANDLE='$HANDLE' pi -a -n 'wt-$HANDLE' '@$PROMPT_FILE'"
```

**Neither (`$ZELLIJ` and `$TMUX` unset):** stop and tell the user to run this
from inside a zellij or tmux session.

Notes:
- `-a` trusts project-local files for the run (avoids the interactive trust prompt blocking the agent)
- The prompt file is passed as an `@file` message, so the agent starts working immediately
- `--no-focus` / `-d` keep you in your own tab (background dispatch)

### Step 3 — Report

After creating the worktrees, inform the user which handles/branches were
created. Your task is COMPLETE once the worktrees are spawned. Do NOT
implement anything yourself. Do NOT wait for the agents unless the user asked
you to coordinate (that is the `/skill:coordinator` job).