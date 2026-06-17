import {
	OM_FOLDED,
	isMemoryDetails,
	isObservationsDroppedEntry,
	isObservationsRecordedEntry,
	isReflectionsRecordedEntry,
	isReflectionsSupersededEntry,
	type Entry,
	type MemoryDetails,
	type Observation,
	type Reflection,
} from "./types.ts";

export type Projection = {
	observations: Observation[];
	reflections: Reflection[];
};

export type ProjectionDiff = {
	observationsOnlyInFull: Observation[];
	reflectionsOnlyInFull: Reflection[];
	droppedOnlyInFull: Observation[];
};

export type CompactionProjection = Projection & {
	details: MemoryDetails;
};

type ProjectionBoundary =
	| { kind: "entry"; entryId: string }
	| { kind: "tip" }
	| { kind: "none" };

type ProjectionFoldOptions = {
	observationsBoundary: ProjectionBoundary;
	reflectionsBoundary: ProjectionBoundary;
	dropsBoundary: ProjectionBoundary;
	supersedeBoundary: ProjectionBoundary;
};

function entryIndexById(entries: Entry[]): Map<string, number> {
	const indexes = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) indexes.set(entries[i].id, i);
	return indexes;
}

function entryBoundary(entryId: string): ProjectionBoundary {
	return { kind: "entry", entryId };
}

function tipBoundary(): ProjectionBoundary {
	return { kind: "tip" };
}

function boundaryIndex(entries: Entry[], indexes: Map<string, number>, boundary: ProjectionBoundary): number {
	if (boundary.kind === "tip") return entries.length - 1;
	if (boundary.kind === "none") return -1;
	return indexes.get(boundary.entryId) ?? -1;
}

function coverageIndex(entry: Entry & { data: { coversUpToId: string } }, indexes: Map<string, number>): number {
	return indexes.get(entry.data.coversUpToId) ?? -1;
}

function isAtOrBefore(index: number, boundaryIndex: number): boolean {
	return index >= 0 && boundaryIndex >= 0 && index <= boundaryIndex;
}

function isCoveredAtOrBefore(
	entry: Entry & { data: { coversUpToId: string } },
	indexes: Map<string, number>,
	boundaryIndex: number,
): boolean {
	return isAtOrBefore(coverageIndex(entry, indexes), boundaryIndex);
}

function foldProjection(entries: Entry[], options: ProjectionFoldOptions): Projection {
	const indexes = entryIndexById(entries);
	const observationsBoundary = boundaryIndex(entries, indexes, options.observationsBoundary);
	const reflectionsBoundary = boundaryIndex(entries, indexes, options.reflectionsBoundary);
	const dropsBoundary = boundaryIndex(entries, indexes, options.dropsBoundary);
	const supersedeBoundary = boundaryIndex(entries, indexes, options.supersedeBoundary);
	const observations: Observation[] = [];
	const reflections: Reflection[] = [];
	const observationsById = new Set<string>();
	const reflectionsById = new Set<string>();
	const droppedObservationIds = new Set<string>();
	const supersededReflectionIds = new Set<string>();

	for (const entry of entries) {
		if (isObservationsRecordedEntry(entry) && isCoveredAtOrBefore(entry, indexes, observationsBoundary)) {
			for (const observation of entry.data.observations) {
				if (observationsById.has(observation.id)) continue;
				observationsById.add(observation.id);
				observations.push(observation);
			}
			continue;
		}

		if (isReflectionsRecordedEntry(entry) && isCoveredAtOrBefore(entry, indexes, reflectionsBoundary)) {
			for (const reflection of entry.data.reflections) {
				if (reflectionsById.has(reflection.id)) continue;
				reflectionsById.add(reflection.id);
				reflections.push(reflection);
			}
			continue;
		}

		if (isObservationsDroppedEntry(entry) && isCoveredAtOrBefore(entry, indexes, dropsBoundary)) {
			for (const observationId of entry.data.observationIds) droppedObservationIds.add(observationId);
			continue;
		}

		if (isReflectionsSupersededEntry(entry) && isCoveredAtOrBefore(entry, indexes, supersedeBoundary)) {
			for (const reflectionId of entry.data.reflectionIds) supersededReflectionIds.add(reflectionId);
		}
	}

	return {
		observations: observations.filter((observation) => !droppedObservationIds.has(observation.id)),
		reflections: reflections.filter((reflection) => !supersededReflectionIds.has(reflection.id)),
	};
}

function projectionFromMemoryDetails(details: MemoryDetails): Projection {
	return {
		observations: [...details.observations],
		reflections: [...details.reflections],
	};
}

function latestV3CompactionDetails(entries: Entry[]): MemoryDetails | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "compaction") continue;
		if (isMemoryDetails(entry.details)) return entry.details;
	}
	return undefined;
}

export function fullProjection(entries: Entry[], upToEntryId?: string): Projection {
	const boundary = upToEntryId ? entryBoundary(upToEntryId) : tipBoundary();
	return foldProjection(entries, {
		observationsBoundary: boundary,
		reflectionsBoundary: boundary,
		dropsBoundary: boundary,
		supersedeBoundary: boundary,
	});
}

export function visibleProjection(entries: Entry[], upToEntryId?: string): Projection {
	if (!upToEntryId) {
		const details = latestV3CompactionDetails(entries);
		return details ? projectionFromMemoryDetails(details) : { observations: [], reflections: [] };
	}

	return buildCompactionProjection(entries, upToEntryId);
}

/**
 * Build the compaction projection: fold all observations, reflections,
 * drops, and supersedes up to the compaction cut point.
 *
 * Every compaction is a full fold — the reflector controls the observation
 * pool size via reflectAfterTokens, so there's no need for a separate
 * "maintenance fold" that leaves reflections as raw kept entries.
 */
export function buildCompactionProjection(
	entries: Entry[],
	firstKeptEntryId: string,
): CompactionProjection {
	const boundary = entryBoundary(firstKeptEntryId);
	const projection = foldProjection(entries, {
		observationsBoundary: boundary,
		reflectionsBoundary: boundary,
		dropsBoundary: boundary,
		supersedeBoundary: boundary,
	});

	const details: MemoryDetails = {
		type: OM_FOLDED,
		version: 1,
		observations: projection.observations,
		reflections: projection.reflections,
	};

	return {
		observations: projection.observations,
		reflections: projection.reflections,
		details,
	};
}

export function diffProjection(visible: Projection, full: Projection): ProjectionDiff {
	const visibleObservationIds = new Set(visible.observations.map((observation) => observation.id));
	const fullObservationIds = new Set(full.observations.map((observation) => observation.id));
	const visibleReflectionIds = new Set(visible.reflections.map((reflection) => reflection.id));

	return {
		observationsOnlyInFull: full.observations.filter((observation) => !visibleObservationIds.has(observation.id)),
		reflectionsOnlyInFull: full.reflections.filter((reflection) => !visibleReflectionIds.has(reflection.id)),
		droppedOnlyInFull: visible.observations.filter((observation) => !fullObservationIds.has(observation.id)),
	};
}
