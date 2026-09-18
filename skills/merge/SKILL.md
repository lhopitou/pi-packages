---
name: merge
description: Commit, rebase onto the base branch, merge the current worktree branch back into it, and clean up the worktree and tab.
disable-model-invocation: true
---

# Merge

Arguments appended below (as `User:` lines) may contain flags:
- `--keep`, `-k` → keep the worktree, branch, and tab after merging (skip Step 4)

Commit, rebase, and merge the current branch. This finishes work on a
worktree branch: all changes are committed, the branch is rebased onto its
base, merged back with fast-forward, and the worktree is cleaned up.

## Step 1: Commit

Check for staged, unstaged, and untracked changes with `git status --porcelain`.
If there are changes, stage all of them with `git add -A`, review the staged
diff, and commit. Lowercase, imperative mood, no conventional commit
prefixes. Skip if the working tree is clean.

## Step 2: Rebase onto the base branch

```
BRANCH=$(git branch --show-current)
BASE=$(git config --local --get "branch.$BRANCH.base")
BASE=${BASE:-main}
```

Rebase onto the local base branch (do NOT fetch first):

```
git rebase "$BASE"
```

IMPORTANT: Do NOT run `git fetch`. Do NOT rebase onto `origin/<branch>`. Only
the local branch name (e.g. `git rebase main`, not `git rebase origin/main`).

If conflicts occur:

- BEFORE resolving any conflict, understand what changes were made to each
  conflicting file in the base branch: `git log -p -n 3 "$BASE" -- <file>`
- The goal is to preserve BOTH the changes from the base branch AND this
  branch's changes
- After resolving each conflict, stage the file and continue with
  `git rebase --continue`
- If a conflict is too complex or unclear, ask for guidance before proceeding
- If resolution fails or the user says abort: run `git rebase --abort`, leave
  the worktree exactly as it was, and report — nothing is lost

## Step 3: Merge into the base branch (from the MAIN checkout)

This session runs inside a linked worktree, so the merge happens in the main
checkout — the base branch is checked out there:

```
WT=$(git rev-parse --show-toplevel)                     # this worktree
HANDLE=$(basename "$WT")
MAIN_ROOT=$(dirname "$(git rev-parse --git-common-dir)")
WTROOT=$(dirname "$WT")
MAIN_BRANCH=$(git -C "$MAIN_ROOT" branch --show-current)
```

Checks before merging:
- If `$MAIN_BRANCH` is empty (detached HEAD) or not equal to `$BASE` — the
  main checkout has moved to another branch. STOP and report; ask the user
  whether to merge into `$MAIN_BRANCH` instead.
- If the main checkout has uncommitted changes
  (`git -C "$MAIN_ROOT" status --porcelain`) — STOP and report. Do not touch
  it without asking.

Merge (fast-forward only — we just rebased, so this cannot create conflicts):

```
git -C "$MAIN_ROOT" merge --ff-only "$BRANCH"
```

If it fails, report the error and ask. Do not force anything.

## Step 4: Cleanup

Skip this entire step if `--keep` was requested. Run ALL of it as a SINGLE
bash call — pi cannot run further bash commands once this worktree directory
is removed (it becomes the deleted cwd), and `git branch -d` fails while the
branch is still checked out in this worktree, so the worktree must go first:

```bash
rm -f "$WTROOT/.status/$HANDLE.prompt.md"

# Remove the worktree BEFORE deleting the branch (git refuses branches
# checked out in a worktree). We are standing in it — fall back if git refuses.
git -C "$MAIN_ROOT" worktree remove "$WT" 2>/dev/null || {
  rm -rf "$WT"
  git -C "$MAIN_ROOT" worktree prune
}
git -C "$MAIN_ROOT" branch -d "$BRANCH"

# Post-mortem, detached in a new session so it survives this shell and runs
# AFTER this pi has stopped (its reporter rewrites the status file on settle):
# delete the status file, then close this tab (this pane's process dies with it —
# expected).
export WT_DELAY_RM="$WTROOT/.status/$HANDLE.json" \
       WT_ZELLIJ_PANE="${ZELLIJ_PANE_ID:-}" \
       WT_TMUX_PANE="${TMUX_PANE:-}"
setsid sh -c 'sleep 2; rm -f "$WT_DELAY_RM"; \
  [ -n "$WT_ZELLIJ_PANE" ] && zellij action close-pane --pane-id "$WT_ZELLIJ_PANE"; \
  [ -n "$WT_TMUX_PANE" ] && tmux kill-window -t "$WT_TMUX_PANE"' </dev/null >/dev/null 2>&1 &
```

Then tell the user: merged `$BRANCH` into `$BASE`; this tab closes itself in a
couple of seconds. Do not attempt to run any further bash commands — your cwd
is gone.