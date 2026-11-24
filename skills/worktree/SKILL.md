---
name: worktree
description: Launch one or more tasks in new git worktrees, each running an isolated pi agent in its own multiplexer tab. Use when delegating tasks to parallel worktree agents.
disable-model-invocation: true
---

# Worktree dispatch

Launch one or more tasks in new git worktrees, each agent spawned via
`mux_spawn` into its own tab.

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
- Agent spawned via `mux_spawn` with handle `wt-<handle>`, in a tab of its own
- Base branch recorded at spawn: `git config branch.<handle>.base`
- Prompt files live at `<worktrees>/.status/<handle>.prompt.md`

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

Then spawn the agent into a tab:

```
mux_spawn {placement: "tab", handle: "wt-$HANDLE", cwd: "$WT",
          task_file: "$PROMPT_FILE"}
```

If the mux tools are missing, stop and tell the user to run this from inside a
multiplexer session.

Notes:
- The prompt file is passed as an `@file` message, so the agent starts working
  immediately
- `focus` stays false: you stay in your own tab (background dispatch)

### Step 3 — Report

After creating the worktrees, inform the user which handles/branches were
created. Your task is COMPLETE once the worktrees are spawned. Do NOT
implement anything yourself. Do NOT wait for the agents — if the user asked
for coordination, that is the coordinator skill's job, over mux.