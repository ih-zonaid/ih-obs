import type { ReviewRow } from "./row";
import { DueDateHistogram } from "./workload";

// Deck assembly.
//
// A "deck" is a set of card marks in some scope — a frame, a question, or a
// whole outline branch. This layer turns that set plus the review rows into an
// order and the four numbers a row shows. It knows nothing about geometry or
// the outline tree; membership is decided by the caller (see `marksForBox` in
// the app), so the same functions serve any future scope.
//
// Due before new, always, which is what removes the need for a daily cap: a
// learner who stops after the due pile simply never draws a new card that day,
// and nothing marks them as having failed.

export interface DeckCard {
	markId: string;
	/** Null for a card being seen for the first time. */
	row: ReviewRow | null;
}

export interface DeckCounts {
	/** Scheduled and ready now. The obligation. */
	due: number;
	/** Never reviewed. */
	fresh: number;
	/** Scheduled but not ready yet. Reads as progress. */
	seen: number;
	/** Every card the scope yields. */
	total: number;
}

interface Split {
	due: DeckCard[];
	fresh: DeckCard[];
	later: DeckCard[];
	seen: number;
}

function split(
	cardIds: string[],
	rows: Record<string, ReviewRow>,
	now: number,
): Split {
	const due: DeckCard[] = [];
	const fresh: DeckCard[] = [];
	const later: DeckCard[] = [];
	let seen = 0;

	for (const markId of cardIds) {
		const row = rows[markId] ?? null;
		if (!row || row.last === 0) {
			fresh.push({ markId, row: null });
		} else if (row.due <= now) {
			due.push({ markId, row });
		} else {
			later.push({ markId, row });
			seen += 1;
		}
	}
	return { due, fresh, later, seen };
}

// Longest overdue first: those have decayed most and are the likeliest to be
// forgotten outright if the session ends early.
function byDueAsc(a: DeckCard, b: DeckCard): number {
	return (a.row?.due ?? 0) - (b.row?.due ?? 0);
}

/**
 * Orders a deck: overdue first, then new. Cards scheduled for later are left
 * out — a session answers what is ready, and the rest is progress, not a queue.
 *
 * Pass `includeNotDue` to also schedule cards before they are due (a deliberate
 * cram/study-ahead), in which case they follow the new pile in due order.
 */
export function buildQueue(
	cardIds: string[],
	rows: Record<string, ReviewRow>,
	now: number,
	includeNotDue = false,
): DeckCard[] {
	const { due, fresh, later } = split(cardIds, rows, now);
	due.sort(byDueAsc);
	if (!includeNotDue) return [...due, ...fresh];
	later.sort(byDueAsc);
	return [...due, ...fresh, ...later];
}

/**
 * Shuffles cards within each same-priority run, leaving the runs themselves in
 * order.
 *
 * `buildQueue` returns overdue cards first (in due order) then the new pile, so a
 * priority run is a contiguous block of equal tier. Shuffling inside a run
 * randomizes *which* same-priority card comes first without ever letting a new
 * card jump an overdue one. `random` is injected rather than read from
 * `Math.random`, so a session can be replayed deterministically like everything
 * else here.
 */
export function shuffleWithinTiers(cards: DeckCard[], random: () => number): DeckCard[] {
	const out = [...cards];
	let start = 0;
	while (start < out.length) {
		const fresh = out[start].row === null;
		let end = start + 1;
		while (end < out.length && (out[end].row === null) === fresh) end += 1;
		// Fisher-Yates within [start, end).
		for (let i = end - 1; i > start; i--) {
			const j = start + Math.floor(random() * (i - start + 1));
			[out[i], out[j]] = [out[j], out[i]];
		}
		start = end;
	}
	return out;
}

/**
 * The four numbers on a deck row, taken from the plugin's deck stats. `fresh`
 * is the one that is easy to leave out and shouldn't be: without it a finished
 * deck and an empty deck look identical.
 */
export function countDeck(
	cardIds: string[],
	rows: Record<string, ReviewRow>,
	now: number,
): DeckCounts {
	const { due, fresh, seen } = split(cardIds, rows, now);
	return { due: due.length, fresh: fresh.length, seen, total: cardIds.length };
}

/** The roll-up row above a deck, and any parent deck containing it. */
export function sumCounts(counts: DeckCounts[]): DeckCounts {
	return counts.reduce<DeckCounts>(
		(total, one) => ({
			due: total.due + one.due,
			fresh: total.fresh + one.fresh,
			seen: total.seen + one.seen,
			total: total.total + one.total,
		}),
		{ due: 0, fresh: 0, seen: 0, total: 0 },
	);
}

/** Rows with nothing to do stay in the list, greyed. This is what greys them. */
export function isActionable(counts: DeckCounts): boolean {
	return counts.due > 0 || counts.fresh > 0;
}

/**
 * Drops the remaining cards sharing a reveal group with one just answered.
 *
 * A reveal group is several marks that reveal together as one logical answer, so
 * asking each in turn in one sitting is asking the same thing repeatedly. Cards
 * with no group are never siblings.
 */
export function buryGroup(
	queue: DeckCard[],
	answeredId: string,
	groupOf: (markId: string) => string | undefined,
): DeckCard[] {
	const group = groupOf(answeredId);
	if (!group) return queue;
	return queue.filter((card) => card.markId === answeredId || groupOf(card.markId) !== group);
}

/**
 * Every scheduled due date the deck can see, for spreading long intervals. Built
 * from the given cards' rows so a document-wide balance is possible without
 * changing this signature.
 */
export function workloadFrom(
	cardIds: string[],
	rows: Record<string, ReviewRow>,
	now: number,
): DueDateHistogram {
	const dues: number[] = [];
	for (const markId of cardIds) {
		const row = rows[markId];
		if (row && row.last > 0) dues.push(row.due);
	}
	return DueDateHistogram.from(dues, now);
}
