import type { WorkloadLookup } from "./algorithm";

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Counts of cards due N days from now, keyed by whole days. Ported from the
 * Obsidian plugin's due-date histogram, which it uses to spread long intervals
 * instead of applying random fuzz.
 *
 * Random fuzz makes each card's interval slightly unpredictable; load balancing
 * makes the *daily total* predictable, which is the property that actually
 * matters when a whole document's cards were marked on the same afternoon.
 *
 * FSRS ignores this. It is here for SM-2, and for a queue that wants to show a
 * "cards due per day" spread.
 */
export class DueDateHistogram implements WorkloadLookup {
	private readonly byDay = new Map<number, number>();

	/** Build from every scheduled due timestamp the queue currently knows about. */
	static from(dueTimestamps: Iterable<number>, now: number): DueDateHistogram {
		const histogram = new DueDateHistogram();
		for (const due of dueTimestamps) {
			histogram.increment(Math.ceil((due - now) / DAY_MS));
		}
		return histogram;
	}

	countAt(days: number): number | undefined {
		return this.byDay.get(days);
	}

	increment(days: number): void {
		this.byDay.set(days, (this.byDay.get(days) ?? 0) + 1);
	}

	/**
	 * The least crowded day within `fuzz` days either side of `interval`.
	 *
	 * An empty day wins immediately — nothing beats zero, so there is no reason
	 * to keep looking. Otherwise the search widens one day at a time and keeps
	 * the smallest count found, which biases toward staying near the interval the
	 * algorithm actually asked for.
	 */
	leastUsedWithin(interval: number, fuzz: number): number {
		if (this.countAt(interval) === undefined) return interval;

		let best = interval;
		for (let offset = 1; offset <= fuzz; offset++) {
			for (const candidate of [interval - offset, interval + offset]) {
				if (candidate < 1) continue;
				if (this.countAt(candidate) === undefined) return candidate;
				if ((this.countAt(candidate) ?? 0) < (this.countAt(best) ?? 0)) best = candidate;
			}
		}
		return best;
	}
}
