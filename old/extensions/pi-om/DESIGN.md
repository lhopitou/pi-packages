# pi-om Design

## Architecture overview

pi-om maintains a **branch-local ledger** as the source of truth for session memory. Three background agents — Observer, Reflector, and Dropper — write to the ledger as the session progresses. Compaction is deterministic and model-free: it folds the ledger and renders a summary the agent sees.

```
                    ┌──────────────┐
  Raw messages ────▶│   Observer   │───▶ om.observations.recorded
                    └──────────────┘
                           │
                           ▼
                    ┌──────────────┐
  Observations ────▶│  Reflector   │───▶ om.reflections.recorded
                    └──────────────┘
                           │
                    (same-turn reflections produced)
                           │
                           ▼
                    ┌──────────────┐
  Observation pool ─│   Dropper    │───▶ om.observations.dropped
  over target?      └──────────────┘
                           │
                           ▼
                    ┌──────────────┐
  Compaction ──────▶│  Ledger fold │───▶ agent context summary
  (deterministic)   └──────────────┘
```

## Two views of memory: live vs context

The same ledger data is seen through two lenses:

| | **Live** (ledger state) | **Context** (agent view) |
|---|---|---|
| **What it is** | Observations not yet tombstoned in the ledger | The snapshot the agent sees in its context window |
| **Source of truth** | Ledger folded from branch root to tip | Last `om.folded` compaction details |
| **Updates** | Continuously — agents write to ledger between compactions | Only at compaction time — frozen snapshot |
| **Commands** | `/om:view full` | `/om:view` (default) |

**Drift** is the difference between live and context memory. It's normal and intentional: background agents can record new observations, create reflections, and drop stale observations between compactions. The agent keeps working with its last-known context snapshot while the ledger updates. The next compaction picks up all accumulated changes.

`/om:status` shows drift explicitly:

```
── Memory ──
Observations: 22 recorded / 3 dropped / 19 live / 15 in context +4
Reflections:  5 recorded / 0 superseded / 5 live / 3 in context +2
```

## The three agents

### Observer

Runs when raw/source tokens since the last observation coverage marker reach `observeAfterTokens`. Receives raw conversation entries, emits timestamped observations with relevance levels and source provenance.

- **Priority**: The observer always runs first. Reflector and dropper wait.
- **No-output**: If no observations are worth recording, the observer writes no entry and does not advance the coverage marker. A later eligible run will see a larger range.
- **Source validation**: Observation `sourceEntryIds` are validated against the input. Invalid or missing ids cause rejection.

### Reflector

Runs when observation pool tokens reach `reflectAfterTokens` and the observer is not due. Distills durable facts from observations into reflections.

- **Future-agent utility test**: Would a future assistant need this fact automatically in compressed context to avoid a wrong decision, repeated work, or user-preference violation?
- **Abstraction gate**: Don't turn each observation into a reflection. Prefer fewer, higher-value reflections.
- **Coverage stewardship**: Each observation is annotated with `none`/`partial`/`strong` coverage tiers. These are review context, not quotas.
- **Post-reflection drop**: After recording new reflections, observations covered by those reflections are automatically dropped (deterministic, not model-based).

### Dropper

Runs **only as post-reflection maintenance**: when the reflector just produced new reflections in the same run and the live observation pool still exceeds `observationsPoolTargetTokens`.

- **Model-based**: The dropper is an LLM agent that decides which observations are safe to prune.
- **Coverage-guided**: Uses reflection coverage tiers as evidence, not automatic decisions.
- **Preservation floor**: User assertions, concrete completions, named identifiers, error messages, architectural decisions, and unresolved blockers are never dropped.
- **Max drop count**: Computed from tokens over target, converted to approximate observation count. The model may drop fewer or none.

## Compaction

Compaction is triggered when raw tokens since the last compaction reach `compactAfterTokens` and the agent is idle.

The compaction hook (`session_before_compact`) is **deterministic and model-free**:

1. Folds the ledger up to `firstKeptEntryId` (Pi's cut point)
2. Renders observations and reflections into a summary
3. Returns `om.folded` details for future context projections

It does not call a model, run background agents, or wait for worker promises. This is why compactions feel instantaneous.

After compaction, the agent's context window contains:

```
┌─────────────────────────────────┐
│ System prompt                   │
├─────────────────────────────────┤
│ pi-om memory summary            │ ← observations + reflections
│ (replaces old raw messages)     │
├─────────────────────────────────┤
│ Recent raw messages             │ ← Pi's kept messages
│ (after firstKeptEntryId)        │
└─────────────────────────────────┘
```

## Ledger entries

V3 uses four custom memory ledger entry types:

| Type | Purpose |
|---|---|
| `om.observations.recorded` | New observations and a `coversUpToId` progress watermark |
| `om.reflections.recorded` | New reflections and a `coversUpToId` progress watermark |
| `om.observations.dropped` | Tombstones for observation ids to remove from live memory |
| `om.reflections.superseded` | Tombstones for reflection ids to remove from live memory |

`coversUpToId` is a progress/projection watermark, not provenance. It tells V3 where a worker's raw-token progress has reached. Source provenance lives on `Observation.sourceEntryIds` and `Reflection.supportingObservationIds`.

## Token budgets and steady state

With default config:

| Parameter | Value | Role |
|---|---|---|
| `observeAfterTokens` | 10,000 | Observer runs every ~10k raw tokens |
| `reflectAfterTokens` | 20,000 | Reflector fires when observation pool ≥ 20k |
| `observationsPoolTargetTokens` | 10,000 | Dropper prunes toward 10k |
| `compactAfterTokens` | 81,000 | Compaction triggers at ~81k raw tokens |

The observation pool is bounded at the target token count regardless of session length. The dropper ensures that when new observations enter, old ones exit — but only when their durable meaning is preserved in reflections.

The reflection pool is the only component that grows, but it grows logarithmically: there are only so many durable facts about a project. Context stabilizes at ~30-40k tokens, well within any modern model's window.

## Configuration

Settings live under the `pi-om` namespace in `~/.pi/agent/settings.json` or project-local `.pi/settings.json`.

| Setting | Default | Meaning |
|---|---|---|
| `observeAfterTokens` | 10,000 | Raw token threshold for observer runs |
| `reflectAfterTokens` | 20,000 | Observation token threshold for reflector runs |
| `compactAfterTokens` | 81,000 | Raw token threshold for auto-compaction |
| `observationsPoolTargetTokens` | half of reflectAfterTokens | Dropper target for live observation pool |
| `agentMaxTurns` | 16 | Max tool-calling turns for LLM agents |
| `model` | — | Override model for observer/reflector/dropper |
| `passive` | false | Disable all background work |
| `debugLog` | false | Write debug logs to `.pi/pi-om-debug/` |

**Important**: `observationsPoolTargetTokens` must be strictly less than `reflectAfterTokens`. If not, it's silently rejected and derived as `reflectAfterTokens / 2`.

## Commands

| Command | Purpose |
|---|---|
| `/om:status` | Show live counts, context counts, drift, progress clocks, worker state |
| `/om:view` | Show context memory (what the agent sees) |
| `/om:view full` | Show full live ledger memory |
| `/om:handover` | Flush observer + reflector, produce handover summary for next session |

## Recall tool

The `recall` tool recovers exact source evidence behind a 16-character memory id. It indexes the ledger history on the current branch and returns:

- Observation source entries (marked `live` or `dropped`)
- Reflection source entries (marked `live` or `superseded`)
- Diagnostics when source entries are unavailable

Use `recall` when a compacted observation or reflection matters for a decision and exact wording, provenance, or context is needed.