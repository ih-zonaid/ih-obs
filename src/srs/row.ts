// A single card's review row. This is what lives in the review store, keyed by
// mark id. It holds schedule state only — never geometry, wording, or card
// membership — so the mark sidecar stays the sole owner of "what is a card" and
// deleting a mark simply drops its row.

export interface ReviewRow {
	/** Epoch ms the card is next due. The one field every "is it due" check reads. */
	due: number;
	/** Which algorithm produced `d`, pinned at first review. */
	algo: string;
	/** Algorithm-owned and opaque to everything else. See `schedule/`. */
	d: Record<string, number>;
	reps: number;
	lapses: number;
	/** Last review, epoch ms. Zero means never reviewed. */
	last: number;
}
