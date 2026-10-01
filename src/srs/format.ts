// Human-readable intervals, ported from the plugin's `textInterval`.
//
// The scale changes with the size of the number because a learner reading four
// buttons at once needs to compare them at a glance: "2.5d" and "1.4y" are
// comparable, "2.5 days" and "511 days" are not.
//
// Deliberately not translated. The units are single letters that already appear
// in the plugin, in Anki and in every other reviewer, and a translated word
// would not fit under a grade label on a narrow button.

/** Days per month and per year, matching the plugin's constants exactly. */
const DAYS_PER_MONTH = 3.04375 * 10;
const DAYS_PER_YEAR = 36.525 * 10;

/** One decimal at most, and none at all when the number is whole. */
function trim(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatInterval(days: number): string {
	// Interval zero is what "again" produces: due immediately, not in a day.
	if (!Number.isFinite(days) || days <= 0) return "now";

	const months = Math.round((days / DAYS_PER_MONTH) * 10) / 10;
	const years = Math.round((days / DAYS_PER_YEAR) * 10) / 10;

	if (months >= 1) {
		if (years < 1) return `${trim(months)}mo`;
		return `${trim(years)}y`;
	}

	if (days >= 1) return `${trim(Math.round(days * 10) / 10)}d`;

	// FSRS learning steps are often minutes; rounding sub-day intervals to "0d"
	// hid them.
	const minutes = days * 24 * 60;
	if (minutes < 60) {
		const rounded = Math.round(minutes);
		return `${rounded > 0 ? rounded : 1}m`;
	}

	const hours = days * 24;
	return `${trim(Math.round(hours * 10) / 10)}h`;
}
