import type { Observation, Reflection } from "./types.ts";

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.`;

export function observationToSummaryLine(observation: Observation): string {
  return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function reflectionToSummaryLine(reflection: Reflection): string {
  return `[${reflection.id}] ${reflection.content}`;
}

export function renderSummary(
  reflections: Reflection[],
  observations: Observation[],
): string {
  if (reflections.length === 0 && observations.length === 0) return "";

  const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];
  if (reflections.length > 0) {
    parts.push(
      `## Reflections\n${reflections.map(reflectionToSummaryLine).join("\n")}`,
    );
  }
  if (observations.length > 0) {
    parts.push(
      `## Observations\n${observations.map(observationToSummaryLine).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

const HANDOVER_CONTEXT_INSTRUCTIONS = `This is a handover document from a previous session phase. Use it to continue work effectively.

- Durable Facts: stable, long-lived facts about the user, project, decisions, and constraints. Preserve these as-is — they have been validated by the reflector.
- Observations: timestamped events from the previous session. These are transient context — the new session's observer will produce fresh observations going forward.

Treat durable facts as ground truth. Observations provide orientation but may be superseded by new events.`;

export function renderHandoverSummary(
  reflections: Reflection[],
  observations: Observation[],
): string {
  if (reflections.length === 0 && observations.length === 0) return "";

  const parts: string[] = [HANDOVER_CONTEXT_INSTRUCTIONS];
  if (reflections.length > 0) {
    parts.push(
      `## Durable Facts (from reflections — preserve as-is)\n${reflections.map((r) => `- ${r.content}`).join("\n")}`,
    );
  }
  if (observations.length > 0) {
    parts.push(
      `## Observations (live session events)\n${observations.map((o) => `- ${o.timestamp} — ${o.content}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}
