# pi-packages

Personal pi extensions, agents, and tools.

## Extensions

| Extension | Description |
|-----------|-------------|
| `rg-fd` | rg/fd as first-class tools (instead of grep/find via bash) |
| `pi-web-access` | Web search (Exa MCP) and content extraction |
| `pi-subagent` | Subagent delegation system with agent discovery |
| `scopy` | Select & copy messages from conversation |
| `auto-memory` | `/save-memories` — extract corrections from session, persist to `.agents/memory.md`, auto-inject at session start |
| `git-checkpoint` | Git stash checkpoints with undo/redo |
| `permissions` | Permission gates for tool calls (bash, write, etc.) |
| `pi-worktree` | Status tracking for parallel git-worktree pi agents: reporter mode inside worktree agents (status file + `●`/`✓` pane rename), `worktree_status`/`worktree_wait` tools in the main session |

## Agents

Agent definitions for the pi-subagent system:

| Agent | Description |
|-------|-------------|
| `explore` | Fast read-only codebase exploration |
| `planner` | Architecture design and migration planning |
| `reviewer` | Independent code review and verification |

## Install

```bash
# Install all extensions from this repo
pi install git:github.com/<user>/pi-packages

# Or install locally for development
pi install ~/pi-packages

# Try without installing
pi -e ~/pi-packages
```

## Runtime Config

The `config/` directory contains reference copies of runtime configuration. These are **not** symlinked — extensions write to them at runtime (e.g., `/permissions add`), so they must be real files at `~/.pi/agent/`:

```bash
cp config/permissions.json ~/.pi/agent/
cp config/subagent.json ~/.pi/agent/
```

### Agent Definitions

Copy agent definitions to `~/.pi/agent/agents/` (or `.pi/agents/` for project-local):

```bash
cp agents/*.md ~/.pi/agent/agents/
```

## Development

```bash
# Install dependencies
npm install

# Type-check
npm run check
```

## Project Structure

```
├── extensions/
│   ├── pi-web-access/    # Web search & content extraction
│   ├── pi-subagent/      # Subagent delegation system
│   ├── scopy.ts          # Select & copy messages
│   ├── git-checkpoint.ts # Git stash checkpoints
│   └── permissions/      # Permission gates
│   ├── auto-memory.ts    # /save-memories — persistent agent memory
│   ├── rg-fd.ts          # rg/fd as named tools
├── agents/               # Subagent agent definitions
├── config/               # Example runtime config files
└── package.json          # Pi package manifest
```
