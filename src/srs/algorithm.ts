// The scheduling contract.
//
// Deliberately the only thing the rest of the app knows about an algorithm, so
// a second one (SM-2, later) drops in without any other layer changing. Cards
// pin the algorithm they were first reviewed with, so adding one never needs a
// migration — see `registry.ts`.
//
// Pure and clock-free: `now` is always passed in, never read from `Date`. That
// is what makes the scheduler and the queue testable against a frozen clock.
//
// Ported from the spaced-repetition scheduler extracted in the `nie` project
// (@packages/srs), adapted to ih-obs: cards are marks, so the "descriptor" and
// content-hash machinery of that package is gone and this stays pure math.

import type { ReviewGrade } from "./grade";

export type { ReviewGrade };

/** Hardest first, so a button row built from this reads as a scale. */
export const REVIEW_GRADES: readonly ReviewGrade[] = ["again", "hard", "good", "easy"];

/**
 * How many cards are already scheduled N days out. Supplied by the queue layer
 * from the review state it has loaded, so the scheduler can drop a long interval
 * on a quieter day instead of piling every card onto the same one.
 *
 * Optional: FSRS ignores it, and a preview with no session context may omit it.
 */
export interface WorkloadLookup {
	/** Undefined means nothing is scheduled that day, which is the best slot. */
	countAt(days: number): number | undefined;
	/** The quietest day within `fuzz` days either side of the target interval. */
	leastUsedWithin(interval: number, fuzz: number): number;
}

export interface NextContext {
	/**
	 * When this card was due before this review, used for the overdue credit.
	 * Null for a card being answered for the first time.
	 */
	dueAt: number | null;
	/** Omit to schedule without load balancing, e.g. in a test or a preview. */
	workload?: WorkloadLookup;
	/** FSRS uses the stored card's review history; a forgetting-curve algo may not. */
	reps?: number;
	lapses?: number;
	/** Epoch ms of the last review, 0 when never reviewed. */
	last?: number;
}

export interface ScheduleResult<TData> {
	/** Canonical, algorithm-agnostic. Every "is it due" question reads this. */
	dueAt: number;
	/** Opaque to every layer except the algorithm that produced it. */
	data: TData;
}

export interface ScheduleAlgorithm<TData> {
	readonly id: string;

	/** Baseline for a card about to be answered for the first time. */
	initial(now: number): ScheduleResult<TData>;

	next(prev: TData, grade: ReviewGrade, now: number, ctx: NextContext): ScheduleResult<TData>;

	/**
	 * Keeps whatever the algorithm knows about the learner's difficulty with
	 * this card and makes it due again now. Included so a future "the answer
	 * changed, reset the schedule" flow has a place to live; it is unused while
	 * card identity is the mark id (editing a mark is not editing an answer).
	 */
	resetSchedule(prev: TData, now: number): ScheduleResult<TData>;

	/** Days until the next review, for status labels and stats. */
	intervalDays(data: TData): number;

	/**
	 * Serializes `data` to the flat record the store persists. Optional: when an
	 * algorithm's data is already a `Record<string, number>` (SM-2's
	 * `{interval, ease}` is), it can omit this and the registry uses the data
	 * as-is. FSRS needs it because `FsrsData` has named fields.
	 */
	toRecord?(data: TData): Record<string, number>;

	/**
	 * Reads a persisted record back into `data`, or null when it cannot be read.
	 * Optional for the same reason as `toRecord`; the registry falls back to
	 * treating the record as `data` directly.
	 */
	fromRecord?(record: Record<string, number>): TData | null;
}
