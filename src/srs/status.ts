/**
 * Where a card sits, for a progress bar. `mastered` means "not due for a long
 * time", not "finished" — the card still comes back, and the label is honest
 * about being a snapshot.
 */
export type CardStatus = "learning" | "review" | "mastered";

/**
 * Interval thresholds for the three status labels the UI shows. Taken from the
 * plugin's own "mature at 32 days" line, with a learning band below a week.
 */
export function deriveStatus(intervalDays: number): CardStatus {
	if (intervalDays < 7) return "learning";
	if (intervalDays < 32) return "review";
	return "mastered";
}
