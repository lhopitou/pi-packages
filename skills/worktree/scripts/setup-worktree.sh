#!/usr/bin/env bash
# setup-worktree.sh — deterministic worktree setup: file copy/symlink + post_create hooks.
#
# Usage: setup-worktree.sh <main-checkout-root> <worktree-path>
#
# Reads <main-checkout-root>/.pi/worktrees.json:
#   { "copy": [".env"], "symlink": ["node_modules"], "post_create": ["npm install"] }
#
# When no config file exists, applies defaults:
#   copy .env if it exists, symlink node_modules if it exists.
#
# Contract:
#   - copy/symlink entries with a missing source are warned about and skipped
#   - every post_create command runs literally (bash -c) in the worktree dir
#   - the first failing post_create command aborts the script with a non-zero exit

set -euo pipefail

MAIN="${1:?usage: setup-worktree.sh <main-checkout-root> <worktree-path>}"
WT="${2:?usage: setup-worktree.sh <main-checkout-root> <worktree-path>}"

CONFIG="$MAIN/.pi/worktrees.json"

apply_defaults() {
  [ -e "$MAIN/.env" ] && printf 'copy\t%s\n' ".env"
  [ -e "$MAIN/node_modules" ] && printf 'symlink\t%s\n' "node_modules"
  return 0
}

if [ -f "$CONFIG" ]; then
  # Parse config with node (fails loudly on malformed JSON)
  node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const kind of ["copy", "symlink", "post_create"]) {
      const list = cfg[kind];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) {
        console.error(`config error: "${kind}" must be an array of strings`);
        process.exit(1);
      }
      for (const entry of list) console.log(`${kind}\t${entry}`);
    }
  ' "$CONFIG" || exit 1
else
  apply_defaults
fi | while IFS=$'\t' read -r op src; do
  case "$op" in
    copy)
      if [ -e "$MAIN/$src" ]; then
        mkdir -p "$WT/$(dirname "$src")"
        cp -Rp "$MAIN/$src" "$WT/$src"
        echo "copied: $src"
      else
        echo "WARNING: copy source missing, skipped: $src" >&2
      fi
      ;;
    symlink)
      if [ -e "$MAIN/$src" ]; then
        mkdir -p "$WT/$(dirname "$src")"
        ln -sfn "$MAIN/$src" "$WT/$src"
        echo "symlinked: $src -> $MAIN/$src"
      else
        echo "WARNING: symlink source missing, skipped: $src" >&2
      fi
      ;;
    post_create)
      echo "running: $src"
      if ! (cd "$WT" && bash -c "$src"); then
        echo "ERROR: post_create command failed: $src" >&2
        exit 1
      fi
      ;;
    *)
      echo "ERROR: unknown op: $op" >&2
      exit 1
      ;;
  esac
done

echo "worktree setup complete: $WT"