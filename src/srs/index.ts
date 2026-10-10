// Spaced repetition over ih-obs cards.
//
// Pure logic, no DOM and no filesystem, so it is testable against a frozen
// clock and reusable from any surface:
//
//   algorithm  the scheduling contract and its opaque per-algorithm data
//   registry   the id → algorithm table; cards pin an id, so adding SM-2 needs
//              no migration
//   fsrs       the built-in algorithm, a thin adapter over ts-fsrs
//   workload   due-date histogram used by interval load balancing
//   review     the single place a schedule advances, and the grade previews
//   queue      deck assembly (due-first) and the counts a deck row shows
//   format     human-readable intervals for grade buttons
//   row        one card's stored schedule state
//
// Cards are marks: identity is the mark id, owned by the annotation sidecar.
// Nothing here knows what a card looks like — it only schedules ids.

export type {
	NextContext,
	ScheduleAlgorithm,
	ScheduleResult,
	WorkloadLookup,
} from "./algorithm";
export { REVIEW_GRADES } from "./algorithm";
export { formatInterval } from "./format";
export type { ReviewGrade } from "./grade";
export type { ReviewRow } from "./row";
export { deriveStatus } from "./status";
export type { CardStatus } from "./status";
export { fsrsAlgorithm, fsrsDataToRecord, recordToFsrsData } from "./fsrs";
export type { FsrsData, FsrsOptions } from "./fsrs";
export {
	currentScheduleAlgorithmId,
	deserializeScheduleData,
	getScheduleAlgorithm,
	isScheduleAlgorithmId,
	registerScheduleAlgorithm,
	seedReviewRow,
	serializeScheduleData,
	setCurrentScheduleAlgorithm,
} from "./registry";
export { applyReview, formatPreviews, previewIntervals } from "./review";
export type { ApplyReviewParams } from "./review";
export {
	buildQueue,
	buryGroup,
	countDeck,
	isActionable,
	shuffleWithinTiers,
	sumCounts,
	workloadFrom,
} from "./queue";
export type { DeckCard, DeckCounts } from "./queue";
export { DAY_MS, DueDateHistogram } from "./workload";
