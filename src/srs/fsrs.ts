import {
	type Card,
	type CardInput,
	createEmptyCard,
	fsrs,
	type Grade,
	Rating,
	type State,
} from "ts-fsrs";
import type { NextContext, ScheduleAlgorithm, ScheduleResult } from "./algorithm";
import type { ReviewGrade } from "./grade";
import { DAY_MS } from "./workload";

// FSRS via ts-fsrs, aligned with the defaults the Obsidian spaced-repetition
// plugin uses: desired retention 0.9, short-term learning steps enabled, the
// same four grades. Ported from the `nie` FSRS adapter; kept as a thin shim so
// the algorithm interface, not this file, is what the app depends on.

export interface FsrsData {
	stability: number;
	difficulty: number;
	state: number;
	scheduledDays: number;
	learningSteps: number;
}

export interface FsrsOptions {
	requestRetention?: number;
	maximumInterval?: number;
	enableShortTerm?: boolean;
}

const DEFAULT_FSRS_OPTIONS: FsrsOptions = {
	requestRetention: 0.9,
	maximumInterval: 36500,
	enableShortTerm: true,
};

function gradeToRating(grade: ReviewGrade): Grade {
	switch (grade) {
		case "again":
			return Rating.Again;
		case "hard":
			return Rating.Hard;
		case "good":
			return Rating.Good;
		case "easy":
			return Rating.Easy;
	}
}

/**
 * The scheduler is built once per call rather than cached. `fsrs()` is cheap and
 * stateless for our use (no custom strategy handlers), and caching would make
 * two cards graded in the same millisecond share mutable parameters.
 */
function getScheduler(options?: FsrsOptions) {
	const resolved = { ...DEFAULT_FSRS_OPTIONS, ...options };
	return fsrs({
		request_retention: resolved.requestRetention,
		maximum_interval: resolved.maximumInterval,
		enable_short_term: resolved.enableShortTerm,
	});
}

function toData(card: Card): FsrsData {
	return {
		stability: card.stability,
		difficulty: card.difficulty,
		state: card.state,
		scheduledDays: card.scheduled_days,
		learningSteps: card.learning_steps,
	};
}

function fromCard(card: Card): ScheduleResult<FsrsData> {
	return { dueAt: card.due.getTime(), data: toData(card) };
}

/** The stored `d` blob for an FSRS-scheduled card. */
export function fsrsDataToRecord(data: FsrsData): Record<string, number> {
	return {
		stability: data.stability,
		difficulty: data.difficulty,
		state: data.state,
		scheduledDays: data.scheduledDays,
		learningSteps: data.learningSteps,
	};
}

/**
 * Reads an FSRS blob back out of storage. Returns null when the required fields
 * are missing, which the caller treats as "never reviewed" rather than risk
 * scheduling from a half-written record.
 */
export function recordToFsrsData(record: Record<string, number>): FsrsData | null {
	if (record.stability === undefined || record.difficulty === undefined) return null;
	return {
		stability: record.stability,
		difficulty: record.difficulty,
		state: record.state ?? 0,
		scheduledDays: record.scheduledDays ?? 0,
		learningSteps: record.learningSteps ?? 0,
	};
}

function toCardInput(
	data: FsrsData,
	params: { dueAt: number; last: number; reps: number; lapses: number; now: number },
): CardInput {
	const lastReview = params.last > 0 ? new Date(params.last) : new Date(params.now);
	return {
		due: new Date(params.dueAt),
		stability: data.stability,
		difficulty: data.difficulty,
		elapsed_days: Math.max(0, Math.floor((params.now - lastReview.getTime()) / DAY_MS)),
		scheduled_days: data.scheduledDays,
		learning_steps: data.learningSteps,
		reps: params.reps,
		lapses: params.lapses,
		state: data.state as State,
		last_review: params.last > 0 ? lastReview : undefined,
	};
}

function nextFrom(
	prev: FsrsData,
	grade: ReviewGrade,
	now: number,
	ctx: NextContext,
): ScheduleResult<FsrsData> {
	const scheduler = getScheduler();
	const reps = ctx.reps ?? 0;
	const lapses = ctx.lapses ?? 0;
	const last = ctx.last ?? 0;
	const dueAt = ctx.dueAt ?? now;

	// A card being answered for the first time has no history to replay, so it
	// starts from an empty card rather than a zeroed record.
	const card =
		reps === 0 && last === 0
			? createEmptyCard(new Date(now))
			: toCardInput(prev, { dueAt, last, reps, lapses, now });

	const log = scheduler.next(card, new Date(now), gradeToRating(grade));
	return fromCard(log.card);
}

export const fsrsAlgorithm: ScheduleAlgorithm<FsrsData> = {
	id: "fsrs",

	initial(now) {
		const empty = createEmptyCard(new Date(now));
		return { dueAt: now, data: toData(empty) };
	},

	next(prev, grade, now, ctx) {
		return nextFrom(prev, grade, now, ctx);
	},

	resetSchedule(prev, now) {
		const empty = createEmptyCard(new Date(now));
		// Difficulty describes the learner, the wording does not, so it survives;
		// stability and the schedule do not, because the thing being remembered
		// may have changed.
		empty.difficulty = prev.difficulty;
		empty.due = new Date(now);
		empty.scheduled_days = 0;
		empty.learning_steps = 0;
		return fromCard(empty);
	},

	intervalDays(data) {
		return Math.max(0, data.scheduledDays);
	},

	// FSRS data has named fields, so it cannot be stored as-is; the registry
	// calls these instead of treating the blob as the data.
	toRecord(data) {
		return fsrsDataToRecord(data);
	},

	fromRecord(record) {
		return recordToFsrsData(record);
	},
};
