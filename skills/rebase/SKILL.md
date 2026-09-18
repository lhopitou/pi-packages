---
name: rebase
description: Rebase the current worktree branch onto its base branch (or a given target) with smart conflict resolution.
disable-model-invocation: true
---

# Rebase

Arguments appended below (as `User:` lines) select the target:

- No arguments: rebase onto this branch's base branch
  (`git config branch.<current>.base`), falling back to local `main` when none
  is configured
- `origin`: fetch origin, rebase on `origin/main`
- `origin/branch`: fetch that remote, rebase on `origin/branch`
- `branch`: rebase on that local branch, no fetch

## Steps

1. Check for local changes with `git status --porcelain`:
   - If the working tree has staged, unstaged, or untracked changes, stash
     them: `git stash push --include-untracked -m "worktree rebase"`
   - Remember whether this created a stash. Existing stash entries remain
     untouched. If stashing fails, stop before fetching or rebasing.
2. Parse the arguments to pick the target (see above). Resolve the default
   target with `git config --get "branch.$(git branch --show-current).base"`;
   if empty, use `main`.
3. If fetching, run `git fetch <remote>`. If fetching or target resolution
   fails before the rebase begins, restore the stash created in step 1 before
   stopping.
4. Run: `git rebase <target>`
5. If conflicts occur, handle them carefully (see below)
6. Continue until the rebase is complete
7. If step 1 created a stash, restore it after the rebase succeeds with
   `git stash pop --index`. If restoration conflicts, preserve the stash,
   report the conflicts, and leave the affected files for manual resolution.

## Handling conflicts

- BEFORE resolving any conflict, understand what changes were made to each
  conflicting file in the target branch: `git log -p -n 3 <target> -- <file>`
- The goal is to preserve BOTH the target branch's changes AND this branch's
  changes
- After resolving each conflict, stage the file and continue with
  `git rebase --continue`
- If a conflict is too complex or unclear, ask for guidance before proceeding
- If resolution fails or the user says abort: run `git rebase --abort`, restore
  the stash if step 1 created one, and report — the branch is left as it was