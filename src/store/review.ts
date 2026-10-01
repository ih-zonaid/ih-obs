import { applyReview } from "../srs/review";
import type { ReviewGrade } from "../srs/grade";
import type { ReviewRow } from "../srs/row";
import type { WorkloadLookup } from "../srs/algorithm";
import { ensureDirPath, readText, writeText } from "../vault/fs";

// Per-document review state, in its own file beside the annotation sidecar.
//
// Deliberately NOT inside the `.ihobs` annotation document. That file is
// authoring data (boxes, marks, notes) and `SidecarStore.saveEntities` rewrites
// the whole entity array on every mark drag; study progress living there would
// be rewritten by every geometry edit, and the two writers would fight. Separate
// files keep one writer each — the same discipline the `nie` sidecar store is
// careful about.
//
// The document stores state ONLY. Which marks are cards is owned by the
// annotation sidecar, so deleting a mark just drops its row here and nothing
// else needs to know.

export const REVIEW_VERSION = 1;

export interface StoredReviewDoc {
	version: number;
	/** The document path these rows belong to, for debugging a moved file. */
	doc: string;
	updatedAt: number;
	/** mark id → schedule row. */
	rows: Record<string, ReviewRow>;
}

const ROOT = ".ihobs";
const DIR = "review";
const EXT = ".json";

function reviewName(docPath: string): string {
	return docPath.replace(/[\\/]/g, "__") + EXT;
}

function emptyDoc(docPath: string): StoredReviewDoc {
	return { version: REVIEW_VERSION, doc: docPath, updatedAt: 0, rows: {} };
}

/** True when a document has no reviews worth persisting. */
export function isEmptyDoc(doc: StoredReviewDoc): boolean {
	return Object.keys(doc.rows).length === 0;
}

/**
 * Brings a stored document up to the current version, or returns null when it
 * cannot be read at all. Null means "treat this document as unreviewed", which
 * loses schedules but never corrupts them, so it is the safe failure.
 */
export function migrateReviewDoc(stored: unknown, docPath: string): StoredReviewDoc | null {
	if (!stored || typeof stored !== "object") return null;
	const data = stored as Partial<StoredReviewDoc>;
	if (typeof data.version !== "number" || data.version > REVIEW_VERSION) return null;
	if (!data.rows || typeof data.rows !== "object") return null;

	const rows: Record<string, ReviewRow> = {};
	for (const [markId, row] of Object.entries(data.rows)) {
		if (!row || typeof row !== "object") continue;
		const r = row as Partial<ReviewRow>;
		if (typeof r.due !== "number" || typeof r.algo !== "string") continue;
		rows[markId] = {
			due: r.due,
			algo: r.algo,
			d: typeof r.d === "object" && r.d ? r.d : {},
			reps: typeof r.reps === "number" ? r.reps : 0,
			lapses: typeof r.lapses === "number" ? r.lapses : 0,
			last: typeof r.last === "number" ? r.last : 0,
		};
	}
	return { version: REVIEW_VERSION, doc: docPath, updatedAt: data.updatedAt ?? 0, rows };
}

export class ReviewStore {
	private readonly vault: FileSystemDirectoryHandle;
	private readonly cache = new Map<string, StoredReviewDoc>();

	constructor(vault: FileSystemDirectoryHandle) {
		this.vault = vault;
	}

	private async dir(): Promise<FileSystemDirectoryHandle> {
		const ihobs = await ensureDirPath(this.vault, [ROOT]);
		return ensureDirPath(ihobs, [DIR]);
	}

	async load(docPath: string): Promise<StoredReviewDoc> {
		const hit = this.cache.get(docPath);
		if (hit) return hit;
		const dir = await this.dir();
		let parsed: unknown = null;
		try {
			const file = await dir.getFileHandle(reviewName(docPath));
			parsed = JSON.parse(await readText(file));
		} catch {
			parsed = null;
		}
		const model = (parsed ? migrateReviewDoc(parsed, docPath) : null) ?? emptyDoc(docPath);
		this.cache.set(docPath, model);
		return model;
	}

	/** Synchronous read for render paths, after `load` has populated the cache. */
	rows(docPath: string): Record<string, ReviewRow> {
		return this.cache.get(docPath)?.rows ?? {};
	}

	/** Every card id that has a row, for a document-wide workload histogram. */
	reviewedIds(docPath: string): string[] {
		return Object.keys(this.rows(docPath));
	}

	/**
	 * The single write path for a review. Applies the grade to whatever row the
	 * card already has (or seeds a new one) and persists.
	 */
	async grade(params: {
		docPath: string;
		markId: string;
		grade: ReviewGrade;
		workload?: WorkloadLookup;
		now?: number;
	}): Promise<ReviewRow> {
		const { docPath, markId, grade, workload, now = Date.now() } = params;
		const doc = await this.load(docPath);
		const row = applyReview({ row: doc.rows[markId] ?? null, grade, now, workload });
		doc.rows[markId] = row;
		await this.write(docPath, doc);
		return row;
	}

	/** Drops rows for marks that no longer exist. Never creates a file. */
	async drop(docPath: string, markIds: string[]): Promise<void> {
		const doc = this.cache.get(docPath);
		if (!doc || markIds.length === 0) return;
		let changed = false;
		for (const id of markIds) {
			if (doc.rows[id]) {
				delete doc.rows[id];
				changed = true;
			}
		}
		if (!changed) return;
		// A document with nothing left removes its file rather than leaving an
		// empty stub behind for every document ever reviewed once.
		if (isEmptyDoc(doc)) {
			this.cache.set(docPath, emptyDoc(docPath));
			try {
				const dir = await this.dir();
				await dir.removeEntry(reviewName(docPath));
			} catch {
				/* already gone */
			}
			return;
		}
		await this.write(docPath, doc);
	}

	private async write(docPath: string, doc: StoredReviewDoc): Promise<void> {
		const next: StoredReviewDoc = { ...doc, version: REVIEW_VERSION, updatedAt: Date.now() };
		const dir = await this.dir();
		await writeText(dir, reviewName(docPath), JSON.stringify(next, null, 2));
		this.cache.set(docPath, next);
	}

	invalidate(docPath: string): void {
		this.cache.delete(docPath);
	}
}
