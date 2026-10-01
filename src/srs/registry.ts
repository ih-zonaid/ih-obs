import type { ScheduleAlgorithm } from "./algorithm";
import { fsrsAlgorithm } from "./fsrs";
import type { ReviewRow } from "./row";

// The algorithm seam.
//
// Cards pin their algorithm id at first review, so adding a second algorithm
// never migrates existing cards: the id they stored still resolves. SM-2 is the
// intended second implementation — see the bottom of this file for exactly what
// adding it takes.

const registry: Record<string, ScheduleAlgorithm<any>> = {
	fsrs: fsrsAlgorithm,
	// sm2: sm2Algorithm,
};

/** Assigned to a card reviewed for the first time from now on. */
let currentId = "fsrs";

/**
 * Adds an algorithm at runtime. This is the seam the app calls once when an SM-2
 * module is ported, so the store, the player and the sidecar never change.
 */
export function registerScheduleAlgorithm(algorithm: ScheduleAlgorithm<any>): void {
	registry[algorithm.id] = algorithm;
}

/** Pins which algorithm a first-time card is reviewed with. */
export function setCurrentScheduleAlgorithm(id: string): void {
	if (registry[id]) currentId = id;
}

export function currentScheduleAlgorithmId(): string {
	return currentId;
}

export function getScheduleAlgorithm(id: string): ScheduleAlgorithm<any> | undefined {
	return registry[id];
}

export function isScheduleAlgorithmId(value: string): boolean {
	return value in registry;
}

/** Serializes algorithm-owned `data` to the flat record the store persists. */
export function serializeScheduleData(algo: string, data: unknown): Record<string, number> {
	const algorithm = registry[algo];
	if (algorithm?.toRecord) return algorithm.toRecord(data as never);
	return data as Record<string, number>;
}

/**
 * Reads a stored `d` back into the algorithm's own data. Returns null when the
 * record cannot be read, which the caller treats as "never reviewed" rather than
 * scheduling from a half-written blob.
 */
export function deserializeScheduleData(
	algo: string,
	record: Record<string, number>,
): unknown | null {
	const algorithm = registry[algo];
	if (!algorithm) return null;
	return algorithm.fromRecord ? algorithm.fromRecord(record) : (record as unknown);
}

/** A fresh row for a card about to be reviewed for the first time. */
export function seedReviewRow(id: string, now: number): ReviewRow {
	const algorithm = registry[id] ?? fsrsAlgorithm;
	const seed = algorithm.initial(now);
	return {
		due: seed.dueAt,
		algo: id,
		d: serializeScheduleData(id, seed.data),
		reps: 0,
		lapses: 0,
		last: 0,
	};
}

// Adding SM-2 later:
//   1. create `sm2.ts` exporting an object with `id: "sm2"` satisfying
//      `ScheduleAlgorithm<Sm2Data>`. Its `data` is already `{ interval, ease }`,
//      so it can omit `toRecord`/`fromRecord`.
//   2. call `registerScheduleAlgorithm(sm2Algorithm)` once at startup (or add
//      it to the `registry` table above).
//   3. optionally `setCurrentScheduleAlgorithm("sm2")` to make it the default
//      for new cards.
// Nothing else: existing FSRS cards keep `algo: "fsrs"` and never see SM-2; new
// cards follow `current`. That is the whole point of pinning per card.
