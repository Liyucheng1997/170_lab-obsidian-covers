import { App, Modal, Platform, Setting, requestUrl } from "obsidian";

/* ------------------------------------------------------------------ */
/*  Web cover search: Douban + Wikipedia                               */
/* ------------------------------------------------------------------ */

export type MediaKind = "auto" | "book" | "movie" | "person";

export const KIND_LABELS: Record<MediaKind, string> = {
	auto: "Auto (any)",
	book: "Book",
	movie: "Movie / TV",
	person: "Person",
};

export interface CoverCandidate {
	source: "Douban" | "Wikipedia";
	kind: MediaKind;
	title: string;
	subtitle?: string;
	year?: string;
	/** Small image for the picker preview. */
	thumbUrl: string;
	/** Largest image we know how to get. */
	fullUrl: string;
	/** Referer header the image host requires (Douban hotlink protection). */
	referer?: string;
}

export interface SearchOptions {
	useDouban: boolean;
	useWikipedia: boolean;
	/** Wikipedia language editions to try, in order. */
	wikiLangs: string[];
}

const DOUBAN_REFERER = "https://www.douban.com/";

/**
 * Search Douban first; Wikipedia editions are only asked, one at a time, while
 * nothing found so far matches the title (Wikimedia rate-limits quickly).
 */
export async function searchCovers(
	query: string,
	kind: MediaKind,
	opts: SearchOptions
): Promise<CoverCandidate[]> {
	const q = query.trim();
	if (!q) return [];

	const out: CoverCandidate[] = [];
	if (opts.useDouban) out.push(...(await searchDouban(q, kind).catch(logEmpty("Douban"))));
	if (opts.useWikipedia) {
		for (const lang of opts.wikiLangs) {
			if (pickBest(out, q, true)) break;
			out.push(
				...(await searchWikipedia(q, kind, lang).catch(logEmpty(`Wikipedia ${lang}`)))
			);
		}
	}
	return out;
}

function logEmpty(source: string) {
	return (err: unknown): CoverCandidate[] => {
		console.warn(`[Base Cover Image] ${source} search failed:`, err);
		return [];
	};
}

/* ---- Douban -------------------------------------------------------- */
/* The suggest endpoints are what the site's own search box uses; they  */
/* need no API key. movie.douban.com returns films, TV and people.      */

async function searchDouban(q: string, kind: MediaKind): Promise<CoverCandidate[]> {
	const out: CoverCandidate[] = [];
	const enc = encodeURIComponent(q);

	if (kind === "book" || kind === "auto") {
		const items = await getJson(`https://book.douban.com/j/subject_suggest?q=${enc}`);
		for (const it of Array.isArray(items) ? items : []) {
			if (it?.type !== "b" || !it.pic) continue;
			out.push({
				source: "Douban",
				kind: "book",
				title: String(it.title ?? ""),
				subtitle: it.author_name ? String(it.author_name) : undefined,
				year: it.year ? String(it.year) : undefined,
				thumbUrl: it.pic,
				fullUrl: doubanLarge(it.pic),
				referer: DOUBAN_REFERER,
			});
		}
	}

	if (kind === "movie" || kind === "person" || kind === "auto") {
		const items = await getJson(`https://movie.douban.com/j/subject_suggest?q=${enc}`);
		for (const it of Array.isArray(items) ? items : []) {
			if (!it?.img) continue;
			const itemKind: MediaKind =
				it.type === "celebrity" ? "person" : it.type === "movie" ? "movie" : "auto";
			if (kind !== "auto" && itemKind !== kind) continue;
			out.push({
				source: "Douban",
				kind: itemKind,
				title: String(it.title ?? ""),
				subtitle: it.sub_title && it.sub_title !== it.title ? String(it.sub_title) : undefined,
				year: it.year ? String(it.year) : undefined,
				thumbUrl: it.img,
				fullUrl: doubanLarge(it.img),
				referer: DOUBAN_REFERER,
			});
		}
	}
	return out;
}

/** Rewrite a Douban thumbnail URL to its large variant. */
function doubanLarge(url: string): string {
	return url
		.replace(/\/[sm]_ratio_(poster|celebrity)\//, "/l_ratio_$1/")
		.replace(/\/view\/(subject|celebrity|personage)\/[sm]\//, "/view/$1/l/");
}

/* ---- Wikipedia ----------------------------------------------------- */

async function searchWikipedia(
	q: string,
	kind: MediaKind,
	lang: string
): Promise<CoverCandidate[]> {
	const params = new URLSearchParams({
		action: "query",
		generator: "search",
		gsrsearch: q,
		gsrlimit: "6",
		prop: "pageimages",
		piprop: "thumbnail",
		pithumbsize: "800",
		// Include non-free images: film posters and book covers are usually non-free.
		pilicense: "any",
		format: "json",
		formatversion: "2",
		redirects: "1",
	});
	const json = await getJson(`https://${lang}.wikipedia.org/w/api.php?${params}`, undefined, {
		// Wikimedia throttles anonymous generic clients; identify ourselves.
		"Api-User-Agent": "BaseCoverImage/1.1 (Obsidian plugin)",
	});
	const pages: any[] = json?.query?.pages ?? [];
	return pages
		.filter((p) => p?.thumbnail?.source)
		.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
		.map((p) => ({
			source: "Wikipedia" as const,
			kind,
			title: String(p.title),
			subtitle: `${lang}.wikipedia`,
			thumbUrl: p.thumbnail.source,
			fullUrl: p.thumbnail.source,
		}));
}

/* ---- Ranking ------------------------------------------------------- */

function norm(s: string): string {
	return (s ?? "")
		.toLowerCase()
		.replace(/[\s《》<>「」『』【】()（）\[\]·・:：,，.。!！?？'"“”‘’\-—_]/g, "");
}

/**
 * How well a candidate's title matches the query.
 * 3 = exact, 2 = one starts with the other, 1 = one contains the other, 0 = no match.
 */
export function matchScore(c: CoverCandidate, query: string): number {
	const q = norm(query);
	if (!q) return 0;
	let best = 0;
	for (const t of [c.title, c.subtitle ?? ""].map(norm)) {
		if (!t) continue;
		if (t === q) return 3;
		if (t.startsWith(q) || q.startsWith(t)) best = Math.max(best, 2);
		else if (t.includes(q) || q.includes(t)) best = Math.max(best, 1);
	}
	return best;
}

/** Pick the best candidate automatically, or null if nothing matches well enough. */
export function pickBest(
	candidates: CoverCandidate[],
	query: string,
	strict: boolean
): CoverCandidate | null {
	let best: CoverCandidate | null = null;
	let bestScore = -1;
	// Candidates arrive in source-priority order, so ">" keeps the earlier one on ties.
	for (const c of candidates) {
		const s = matchScore(c, query);
		if (s > bestScore) {
			best = c;
			bestScore = s;
		}
	}
	if (strict && bestScore <= 0) return null;
	return best;
}

/* ---- HTTP ---------------------------------------------------------- */

async function getJson(
	url: string,
	referer?: string,
	extraHeaders: Record<string, string> = {}
): Promise<any> {
	const headers: Record<string, string> = { Accept: "application/json", ...extraHeaders };
	if (referer) headers.Referer = referer;
	const res = await requestUrl({ url, headers, throw: false });
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`HTTP ${res.status} for ${url}`);
	}
	return res.json;
}

/**
 * Download an image. Douban's image CDN rejects requests without a douban.com
 * Referer (HTTP 418); if Obsidian's requestUrl can't send one, fall back to
 * Node's https module on desktop.
 */
export async function downloadImage(
	url: string,
	referer?: string
): Promise<{ data: ArrayBuffer; ext: string }> {
	let status = 0;
	try {
		const res = await requestUrl({
			url,
			headers: referer ? { Referer: referer } : {},
			throw: false,
		});
		status = res.status;
		const type = res.headers["content-type"] ?? res.headers["Content-Type"] ?? "";
		if (status >= 200 && status < 300 && res.arrayBuffer.byteLength > 100) {
			return { data: res.arrayBuffer, ext: extFrom(type, url) };
		}
	} catch (err) {
		console.warn("[Base Cover Image] requestUrl image download failed:", err);
	}

	if (Platform.isDesktopApp) {
		return nodeDownload(url, referer ?? "", 3);
	}
	throw new Error(`Image download failed (HTTP ${status}).`);
}

function nodeDownload(
	url: string,
	referer: string,
	redirects: number
): Promise<{ data: ArrayBuffer; ext: string }> {
	return new Promise((resolve, reject) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const lib = require(url.startsWith("https:") ? "https" : "http");
		const req = lib.get(
			url,
			{
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
					...(referer ? { Referer: referer } : {}),
				},
			},
			(res: any) => {
				const code: number = res.statusCode ?? 0;
				if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
					res.resume();
					const next = new URL(res.headers.location, url).toString();
					nodeDownload(next, referer, redirects - 1).then(resolve, reject);
					return;
				}
				if (code < 200 || code >= 300) {
					res.resume();
					reject(new Error(`Image download failed (HTTP ${code}).`));
					return;
				}
				const chunks: Uint8Array[] = [];
				res.on("data", (c: Uint8Array) => chunks.push(c));
				res.on("end", () => {
					const total = chunks.reduce((n, c) => n + c.length, 0);
					const buf = new Uint8Array(total);
					let off = 0;
					for (const c of chunks) {
						buf.set(c, off);
						off += c.length;
					}
					resolve({
						data: buf.buffer,
						ext: extFrom(String(res.headers["content-type"] ?? ""), url),
					});
				});
				res.on("error", reject);
			}
		);
		req.on("error", reject);
		req.setTimeout(20000, () => req.destroy(new Error("Image download timed out.")));
	});
}

function extFrom(contentType: string, url: string): string {
	const t = contentType.toLowerCase();
	if (t.includes("png")) return "png";
	if (t.includes("webp")) return "webp";
	if (t.includes("gif")) return "gif";
	if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
	const m = url.split("?")[0].match(/\.(png|webp|gif|jpe?g)$/i);
	if (m) return m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
	return "jpg";
}

/* ------------------------------------------------------------------ */
/*  Picker modal                                                       */
/* ------------------------------------------------------------------ */

/**
 * Shows search results as a thumbnail grid. The user can edit the query /
 * type and search again, then click an image to use it.
 */
export class CoverPickerModal extends Modal {
	private query: string;
	private kind: MediaKind;
	private opts: SearchOptions;
	private resolve: (c: CoverCandidate | undefined) => void;
	private picked = false;
	private blobUrls: string[] = [];
	private gridEl: HTMLElement;
	private statusEl: HTMLElement;
	private searchSeq = 0;

	constructor(
		app: App,
		noteName: string,
		query: string,
		kind: MediaKind,
		opts: SearchOptions,
		resolve: (c: CoverCandidate | undefined) => void
	) {
		super(app);
		this.query = query;
		this.kind = kind;
		this.opts = opts;
		this.resolve = resolve;
		this.titleEl.setText(`Find a cover for "${noteName}"`);
	}

	onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("base-cover-picker");

		new Setting(contentEl)
			.setName("Search")
			.addText((t) => {
				t.setValue(this.query).onChange((v) => (this.query = v));
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") this.runSearch();
				});
			})
			.addDropdown((d) =>
				d
					.addOptions(KIND_LABELS)
					.setValue(this.kind)
					.onChange((v) => {
						this.kind = v as MediaKind;
						this.runSearch();
					})
			)
			.addButton((b) => b.setButtonText("Search").setCta().onClick(() => this.runSearch()));

		this.statusEl = contentEl.createDiv({ cls: "base-cover-picker-status" });
		this.gridEl = contentEl.createDiv({ cls: "base-cover-picker-grid" });
		this.runSearch();
	}

	private async runSearch() {
		const seq = ++this.searchSeq;
		this.gridEl.empty();
		this.statusEl.setText("Searching…");
		const results = await searchCovers(this.query, this.kind, this.opts);
		if (seq !== this.searchSeq) return; // a newer search started

		if (results.length === 0) {
			this.statusEl.setText("No images found. Try another name or type.");
			return;
		}
		this.statusEl.setText(`${results.length} result(s). Click an image to use it.`);
		for (const c of results) this.renderCandidate(c, seq);
	}

	private renderCandidate(c: CoverCandidate, seq: number) {
		const card = this.gridEl.createDiv({ cls: "base-cover-picker-card" });
		const imgWrap = card.createDiv({ cls: "base-cover-picker-img" });
		imgWrap.setText("…");
		card.createDiv({ cls: "base-cover-picker-title", text: c.title });
		const meta = [c.source, c.subtitle, c.year].filter(Boolean).join(" · ");
		card.createDiv({ cls: "base-cover-picker-meta", text: meta });
		card.addEventListener("click", () => {
			this.picked = true;
			this.resolve(c);
			this.close();
		});

		// Load the preview through requestUrl: Douban images won't render from
		// a plain <img src> because of their Referer check.
		downloadImage(c.thumbUrl, c.referer)
			.then(({ data, ext }) => {
				if (seq !== this.searchSeq) return;
				const url = URL.createObjectURL(
					new Blob([data], { type: `image/${ext === "jpg" ? "jpeg" : ext}` })
				);
				this.blobUrls.push(url);
				imgWrap.empty();
				imgWrap.createEl("img", { attr: { src: url } });
			})
			.catch(() => imgWrap.setText("(preview failed)"));
	}

	onClose() {
		this.searchSeq++;
		this.contentEl.empty();
		for (const u of this.blobUrls) URL.revokeObjectURL(u);
		this.blobUrls = [];
		if (!this.picked) this.resolve(undefined);
	}
}
