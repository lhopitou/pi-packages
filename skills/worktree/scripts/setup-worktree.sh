#!/usr/bin/env bash
# setup-worktree.sh — deterministic worktree setup: file copy/symlink + post_create hooks.
#
# Usage: setup-worktree.sh <main-checkout-root> <worktree-path>
#
# Reads <main-checkout-root>/.pi/worktrees.json:
#   { "copy": [".env"], "symlink": ["node_modules"], "post_create": ["npm install"] }
#
# copy/symlink entries are gitignore-style globs, expanded relative to the
# main checkout (e.g. ".env.*" matches .env.local, .env.production, ...).
# Literal paths still work: a plain name only matches itself.
# Supported wildcards: * ? [class] and ** (recursive, e.g. "**/*.log").
# A trailing / (gitignore's dir-only marker) is stripped; "dir/**" means the
# contents of dir (the bare dir itself is not matched, per gitignore).
# Leading / and ! negation are NOT supported (patterns are already anchored
# at the checkout root). Like gitignore, * and ** do not match dotfiles
# unless the pattern literally starts with a dot.
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

WTREAL=$(realpath -m "$WT")

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
      # Expand the entry as a glob relative to MAIN; a literal entry only
      # matches itself, so exact paths keep working. globstar enables the
      # recursive ** wildcard; compgen -G prints one match per line and
      # exits non-zero (empty output) when nothing matches.
      pat=${src%/}
      # gitignore's "dir/**" means the contents of dir; globstar also
      # matches the bare dir itself, so track it (pre) and drop that match.
      case $pat in *'/**') pre=${pat%'/**'} ;; *) pre= ;; esac
      matches=$(cd "$MAIN" && shopt -s globstar && compgen -G "$pat" || true)
      if [ -n "$matches" ]; then
        while IFS= read -r m; do
          [ -n "$m" ] || continue
          m=${m%/}   # globstar "dir/**" can yield a bare "dir/" match
          if [ "$m" = "$pre" ]; then continue; fi
          d="$WT/$(dirname "$m")"
          # Guard: if an ancestor of the target resolves outside the
          # worktree (e.g. an earlier symlink points into MAIN), cp here
          # would clobber files in the main checkout — skip instead.
          case "$(realpath -m "$d")" in
            "$WTREAL"|"$WTREAL"/*) ;;
            *) echo "WARNING: path resolves outside worktree (ancestor symlink into main?), skipped: $m" >&2; continue ;;
          esac
          mkdir -p "$d"
          cp -Rp "$MAIN/$m" "$WT/$m"
          echo "copied: $m"
        done <<< "$matches"
      else
        echo "WARNING: copy source missing, skipped: $src" >&2
      fi
      ;;
    symlink)
      pat=${src%/}
      case $pat in *'/**') pre=${pat%'/**'} ;; *) pre= ;; esac
      matches=$(cd "$MAIN" && shopt -s globstar && compgen -G "$pat" || true)
      if [ -n "$matches" ]; then
        while IFS= read -r m; do
          [ -n "$m" ] || continue
          m=${m%/}
          if [ "$m" = "$pre" ]; then continue; fi
          d="$WT/$(dirname "$m")"
          # Guard: without this, "symlink": ["logs", "logs/**"] would first
          # symlink logs -> MAIN/logs, then ln through it, replacing files
          # IN the main checkout with self-referential symlinks.
          case "$(realpath -m "$d")" in
            "$WTREAL"|"$WTREAL"/*) ;;
            *) echo "WARNING: symlink path resolves outside worktree (ancestor symlink into main?), skipped: $m" >&2; continue ;;
          esac
          mkdir -p "$d"
          ln -sfn "$MAIN/$m" "$WT/$m"
          echo "symlinked: $m -> $MAIN/$m"
        done <<< "$matches"
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