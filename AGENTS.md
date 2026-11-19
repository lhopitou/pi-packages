# AGENTS.md

Personal pi package: extensions, skills, prompt templates, and subagent definitions, loaded through the `pi` manifest in `package.json`.

**Load the `extending-pi` skill before writing or reviewing extension code** — it is the reference for the pi extension API and its extension points.

## Inventory churns

Extensions and skills retire into `old/`, an archive that is neither loaded nor typechecked. So:

- Trust the tree, not prose: `ls extensions/ skills/` beats any list in this file or `README.md` (which lags reality).
- Retiring an artifact means `git mv` into `old/extensions/` or `old/skills/` — never delete. Keep `old` excluded from the tsconfig `include`.
- `old/` code targets old APIs; don't copy from it without checking current interfaces.

## Layout

- `extensions/` — loaded by the globs in `package.json` (`extensions/*.ts`, `extensions/*/index.ts`); a new extension needs no registration beyond matching a glob. A directory extension's entry point is `index.ts`.
- A `DESIGN.md` inside an extension directory is a design doc and may describe unimplemented plans — directory presence does not imply working code.
- `agents/*.md` — subagent definitions. Frontmatter: `description`, `tools`, `thinking`, `delegate_when`, `extensions`, `skills`, `prompt_mode`.
- `prompts/*.md` — prompt templates. Frontmatter: `description` + `argument-hint`; bodies conventionally start with "Load /coding-guidelines skill if not loaded."
- `skills/<name>/SKILL.md` — frontmatter `name` + `description`; the description is the routing trigger (see the writing-for-agents skill when editing).
- `config/` — reference copies of runtime config (`permissions.json`, `subagent.json`). They must be real files at `~/.pi/agent/`, never symlinked: extensions write to them at runtime.

## TypeScript

- No build step — pi loads `.ts` directly. ESM with `.ts` import specifiers; `verbatimModuleSyntax` is on, so use `import type`.
- Strict mode plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noFallthroughCasesInSwitch`. `npm run typecheck` must pass clean.
- Extensions import from `@earendil-works/pi-coding-agent` (plus `pi-tui`, `pi-ai`) and declare tool schemas with `typebox`.
- `typebox` is pinned to the version pi uses — never bump it independently of `@earendil-works/*`.
- Format with prettier defaults (`npm run format`); there is no prettier config file.
- No test suite. Verify with `npm run typecheck`, then smoke-load with `pi -e ~/pi-packages`.

pi's API drifts between releases (e.g. session-manager type renames). When an extension breaks after an upgrade, adapt it to the new API at the call site rather than pinning the old.

## GLOBAL-AGENTS.md

Root `GLOBAL-AGENTS.md` is the source copy of the user's global agent rules (synced to `~/.pi/agent/AGENTS.md`: ast-grep default, multiplexer rules, Mermaid policy, question-vs-change-request classification). Repo-specific guidance belongs here; behaviour that should apply everywhere belongs there.
