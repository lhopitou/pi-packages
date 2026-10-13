# pi-subagent

A custom Pi extension that adds `subagent` and `list_subagents` tools for delegating tasks to specialized, isolated child Pi processes.

## Configuration

The extension reads from `~/.pi/agent/subagent.json`. If the file doesn't exist, defaults are used.

### Creating or modifying the config

When the user asks you to change subagent configuration, read and write `~/.pi/agent/subagent.json`:

```json
{
  "maxRetries": 2,
  "timeoutMs": 900000,
  "permissionConfigPath": "~/.pi/agent/permissions.json",
  "permissionExtensionPath": "",
  "concurrencyLimit": 4
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `maxRetries` | number | 2 | Max retry attempts per subagent invocation (total attempts = maxRetries + 1) |
| `timeoutMs` | number | 900000 | Max time in ms a subagent can run before being killed (default 15 min) |
| `permissionConfigPath` | string | `~/.pi/agent/permissions.json` | Path to the permissions config loaded in child processes |
| `permissionExtensionPath` | string | `""` | Path to a permission gate extension loaded in every child process |
| `concurrencyLimit` | number | 4 | Max concurrent subagent processes |

### Changing config values

Use the `edit` tool on `~/.pi/agent/subagent.json`. For example:

- "Change subagent timeout to 5 minutes" → edit `timeoutMs` to `300000`
- "Set max retries to 0" → edit `maxRetries` to `0`
- "Set concurrency limit to 2" → edit `concurrencyLimit` to `2`
- "Point permission extension to my gate" → edit `permissionExtensionPath` to the extension file path

After editing, the user should run `/reload` for changes to take effect.

## Agent Definitions

Agents are defined as markdown files with YAML frontmatter.

### Locations

| Path | Scope |
|---|---|
| `~/.pi/agent/agents/<name>.md` | Global — all projects |
| `.pi/agents/<name>.md` | Project — this project only |

Project agents override global agents with the same name.

### Creating a new agent

Create a `.md` file in `~/.pi/agent/agents/` or `.pi/agents/`:

```markdown
---
description: Fast read-only codebase exploration
tools: read, grep, find, ls
model: haiku
thinking: low
delegate_when: |
  The task requires reading many files across the codebase,
  mapping project structure, or broad pattern search.
  Delegate early before the parent context fills with file contents.
extensions: []
skills: []
prompt_mode: replace
inherit_context: false
---

You are a fast codebase explorer. Map project structure,
find patterns, and report concise findings. Do not modify files.
```

### Frontmatter fields

| Field | Required | Default | Description |
|---|---|---|---|
| `description` | Yes | — | One-line description for agent listing and LLM decision-making |
| `tools` | No | all 7 built-in | Comma-separated whitelist: `read, bash, edit, write, grep, find, ls` |
| `model` | No | parent model | Model name from `/model` list. Falls back to parent model |
| `thinking` | No | parent level | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `delegate_when` | No | — | Natural language rules for when the LLM should use this agent |
| `extensions` | No | `[]` | List of extension paths to load in the child process |
| `skills` | No | `[]` | List of skill names to preload from `.pi/skills/` |
| `prompt_mode` | No | `replace` | `replace`: body is full system prompt. `append`: body added to parent's prompt |
| `inherit_context` | No | `false` | Fork parent conversation into subagent's first prompt |

The markdown body (after `---`) is the system prompt for `replace` mode, or appended instructions for `append` mode.

After creating or editing agent files, run `/reload` for changes to take effect.

## Tools

### `subagent`

Delegate a task to a specialized subagent with isolated context.

Parameters:
- `agent` (required) — agent type name
- `task` (required) — self-contained task prompt
- `inherit_context` (optional) — override agent's default context inheritance

### `list_subagents`

List all available subagent types with full delegation rules, tool lists, and model info.

## Commands

- `/subagents` — list agents and current configuration
- `/subagent-stats` — view cumulative per-agent usage stats (tokens, cost, duration). Use `/subagent-stats clear` to reset.
- `/subagent-view` — open scrollable overlay to inspect a subagent's conversation

## Stats & Footer

After each subagent run, the extension:

1. **Records** the run (agent name, token usage, cost, duration, turns, tool calls) to `~/.pi/agent/subagent-stats.jsonl`
2. **Updates the footer** via `ctx.ui.setStatus("subagent", ...)` — shows aggregate totals like `3 runs · ↑12k ↓2k $0.042`
3. **Provides `/subagent-stats`** for a detailed per-agent breakdown

Example `/subagent-stats` output:

```
Subagent Usage Stats

  Total: 5 runs (4 ✓, 1 ✗) · ↑52k ↓8k R31k CH60% · $0.342 · 3m12s

  explore: 3 runs · 7t · 12 tools · ↑28k ↓4k CH57% · $0.186 · 2m4s
  reviewer: 1 run · 2t · 4 tools · ↑14k ↓2k CH71% · $0.098 · 48.2s
  worker: 1 run · 0t · 0 tools · ↑10k ↓0 · $0.058 · 2.1s · 1 ✗
```

The footer status line appears in Pi's built-in footer on the extensions row. Stats persist across `/reload` within the same Pi process. Use `/subagent-stats clear` to reset.
