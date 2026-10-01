import type { WorkloadLookup } from "./algorithm";
import { formatInterval } from "./format";
import type { ReviewGrade } from "./grade";
import {
	currentScheduleAlgorithmId,
	deserializeScheduleData,
	getScheduleAlgorithm,
	seedReviewRow,
	serializeScheduleData,
} from "./registry";
import type { ReviewRow } from "./row";

// The one place a schedule advances.
//
// Keeping it single is not stylistic: two paths applying the same review twice
// is the bug this shape avoids (the word-vocabulary store in `nie` has exactly
// one writer for the same reason). Grading always goes through here; nothing
// else edits a row.

export interface ApplyReviewParams {
	/** Null for a card being answered for the first time. */
	row: ReviewRow | null;
	grade: ReviewGrade;
	now: number;
	/** Omit to schedule without load balancing. */
	workload?: WorkloadLookup;
	/**
	 * Algorithm for a card reviewed for the first time. Ignored once the card has
	 * a row, whose `algo` is authoritative.
	 */
	algorithmId?: string;
}

/** The id a card with no row should be reviewed with. */
function defaultAlgorithmId(explicit?: string): string {
	return explicit ?? currentScheduleAlgorithmId();
}

/**
 * Advances a review row and returns the new one.
 *
 * The row carries the algorithm id it pinned, so a card never silently switches
 * algorithms when the default changes.
 */
export function applyReview(params: ApplyReviewParams): ReviewRow {
	const { row, grade, now, workload } = params;

	const algoId = row?.algo ?? defaultAlgorithmId(params.algorithmId);
	const algorithm = getScheduleAlgorithm(algoId);
	if (!algorithm) throw new Error(`Unknown scheduling algorithm: ${algoId}`);

	const base = row ?? seedReviewRow(algoId, now);
	// A seeded row's `d` is just `initial`'s data already; reading it keeps one
	// path, and `deserialize` is a no-op identity for SM-2.
	const data = deserializeScheduleData(algoId, base.d) ?? algorithm.initial(now).data;

	const result = algorithm.next(data, grade, now, {
		dueAt: row ? row.due : null,
		workload,
		reps: base.reps,
		lapses: base.lapses,
		last: row ? base.last : 0,
	});

	return {
		due: result.dueAt,
		algo: algoId,
		d: serializeScheduleData(algoId, result.data),
		reps: base.reps + 1,
		lapses: base.lapses + (grade === "again" ? 1 : 0),
		last: now,
	};
}

/**
 * What each grade would schedule, in days, without applying it.
 *
 * Shown on the grade buttons the way the plugin shows it, and for the same
 * reason: a learner who can see that "good" means three days and "hard" means
 * one is grading the card, not guessing at a word. It also makes the schedule
 * falsifiable — a button that says 1d and a card that returns in an hour is
 * visibly a bug rather than a feeling.
 *
 * Runs the same `next` the real review will, with the same workload, so the
 * number on the button is the number the card gets.
 */
export function previewIntervals(params: {
	row: ReviewRow | null;
	now: number;
	workload?: WorkloadLookup;
	algorithmId?: string;
}): Record<ReviewGrade, number> {
	const { row, now, workload } = params;
	const algoId = row?.algo ?? defaultAlgorithmId(params.algorithmId);
	const algorithm = getScheduleAlgorithm(algoId);
	if (!algorithm) throw new Error(`Unknown scheduling algorithm: ${algoId}`);

	const stored = row ? deserializeScheduleData(algoId, row.d) : null;
	const data = stored ?? algorithm.initial(now).data;
	const previews = {} as Record<ReviewGrade, number>;

	for (const grade of ["again", "hard", "good", "easy"] as ReviewGrade[]) {
		const result = algorithm.next(data, grade, now, {
			dueAt: row?.due ?? null,
			workload,
			reps: row?.reps ?? 0,
			lapses: row?.lapses ?? 0,
			last: row?.last ?? 0,
		});
		const days = algorithm.intervalDays(result.data);
		// Sub-day FSRS learning steps report 0 days; fall back to the exact span
		// so the button reads "10m" rather than "now".
		previews[grade] = days > 0 ? days : Math.max(0, (result.dueAt - now) / 86_400_000);
	}

	return previews;
}

/** Interval previews already formatted for a button row. */
export function formatPreviews(
	previews: Record<ReviewGrade, number>,
): Record<ReviewGrade, string> {
	return {
		again: formatInterval(previews.again),
		hard: formatInterval(previews.hard),
		good: formatInterval(previews.good),
		easy: formatInterval(previews.easy),
	};
}
