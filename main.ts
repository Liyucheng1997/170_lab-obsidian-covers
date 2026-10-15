import {
	App,
	FuzzySuggestModal,
	Menu,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
	base64ToArrayBuffer,
	normalizePath,
	parseYaml,
	requestUrl,
} from "obsidian";
import {
	CoverCandidate,
	CoverPickerModal,
	KIND_LABELS,
	MediaKind,
	SearchOptions,
	downloadImage,
	pickBest,
	searchCovers,
} from "./web-cover";

/* ------------------------------------------------------------------ */
/*  Settings                                                           */
/* ------------------------------------------------------------------ */

interface CoverImageSettings {
	apiKey: string;
	model: string;
	/** When true, images are saved to Obsidian's configured attachment folder. */
	useDefaultAttachmentFolder: boolean;
	/** Custom folder used when useDefaultAttachmentFolder is false. */
	imageFolder: string;
	/** Frontmatter property that holds the cover link. */
	coverProperty: string;
	/** Prompt sent to the model. Supports {{title}}, {{content}}, {{prop:name}}. */
	promptTemplate: string;
	aspectRatio: string;
	imageSize: string;
	/** How many characters of note body to feed into {{content}}. */
	contentLength: number;
	/** Write the link as an embed (![[..]]) instead of a plain link ([[..]]). */
	useEmbed: boolean;
	/** How many images to generate at once during batch runs. */
	concurrency: number;

	/* ---- Web cover search (Douban / Wikipedia) ---- */
	useDouban: boolean;
	useWikipedia: boolean;
	/** Comma-separated Wikipedia language editions, tried in order. */
	wikiLangs: string;
	/** Frontmatter property that says what a note is (book / movie / person). */
	typeProperty: string;
	bookKeywords: string;
	movieKeywords: string;
	personKeywords: string;
	/** Search text. Supports {{title}} (cleaned note name) and {{prop:name}}. */
	searchTemplate: string;
	/** Regex removed from the note name to build {{title}}. */
	titleCleanup: string;
	/** Single note: show a picker with all results instead of taking the best. */
	webPickManually: boolean;
	/** Batch: skip notes whose results don't match the title. */
	webStrictMatch: boolean;
	/** Batch: delay between requests per worker, to be polite to Douban. */
	webInterval: number;
	webConcurrency: number;
}

const DEFAULT_SETTINGS: CoverImageSettings = {
	apiKey: "",
	model: "gemini-3.1-flash-lite-image",
	useDefaultAttachmentFolder: true,
	imageFolder: "covers",
	coverProperty: "cover",
	promptTemplate:
		'Modern flat vector illustration representing the concept of "{{title}}". ' +
		"A clear central metaphor with a few supporting elements, balanced and not cluttered, " +
		"soft gradients, harmonious 3-4 color palette, clean simple background. " +
		'Prominently display the title text exactly reading "{{title}}" in an elegant, ' +
		"legible modern font as part of the design, correctly spelled. " +
		"No watermark, no card, no frame, no border.",
	aspectRatio: "16:9",
	imageSize: "1K",
	contentLength: 800,
	useEmbed: false,
	concurrency: 3,

	useDouban: true,
	useWikipedia: true,
	wikiLangs: "zh, en",
	typeProperty: "类型",
	bookKeywords: "书籍, 书, 小说, book",
	movieKeywords: "电影, 电视剧, 纪录片, 动画, 动漫, 综艺, movie, tv, film",
	personKeywords: "人物, 皇帝, 作家, 演员, person, people",
	searchTemplate: "{{title}}",
	titleCleanup: "^【[^】]*】\\s*|[《》]",
	webPickManually: true,
	webStrictMatch: true,
	webInterval: 1200,
	webConcurrency: 2,
};

/* ------------------------------------------------------------------ */
/*  Plugin                                                             */
/* ------------------------------------------------------------------ */

export default class CoverImagePlugin extends Plugin {
	settings: CoverImageSettings;
	/** Files currently being generated, to avoid duplicate concurrent runs. */
	private inFlight = new Set<string>();

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new CoverImageSettingTab(this.app, this));

		// Ribbon icon -> generate for the active note.
		this.addRibbonIcon("image-plus", "Generate cover image", () => {
			const file = this.app.workspace.getActiveFile();
			if (file) this.generateCover(file);
			else new Notice("No active note.");
		});

		// Command palette.
		this.addCommand({
			id: "generate-cover-active",
			name: "Generate cover for the current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) this.generateCover(file);
				return true;
			},
		});

		this.addCommand({
			id: "regenerate-cover-active",
			name: "Regenerate cover for the current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) this.generateCover(file, true);
				return true;
			},
		});

		this.addCommand({
			id: "fetch-web-cover-active",
			name: "Find cover on the web (Douban / Wikipedia) for the current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) this.fetchWebCover(file);
				return true;
			},
		});

		this.addCommand({
			id: "fetch-web-covers-active-base",
			name: "Find covers on the web for notes in the active Base (missing one)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "base") return false;
				if (!checking) this.fetchForBase(file);
				return true;
			},
		});

		// Batch: generate covers for every note in the currently open Base.
		this.addCommand({
			id: "generate-covers-active-base",
			name: "Generate covers for notes in the active Base (missing one)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "base") return false;
				if (!checking) this.generateForBase(file, true);
				return true;
			},
		});

		this.addCommand({
			id: "regenerate-covers-active-base",
			name: "Regenerate covers for ALL notes in the active Base",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "base") return false;
				if (!checking) this.generateForBase(file, false);
				return true;
			},
		});

		// Right-click on a note or folder (File Explorer, Bases, etc.).
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) =>
				this.buildFileMenu(menu, file)
			)
		);

		// Right-click inside the editor.
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, _editor, view) => {
				const file = view.file;
				if (!file || file.extension !== "md") return;
				this.addNoteMenuItems(menu, file);
			})
		);
	}

	onunload() {
		this.inFlight.clear();
	}

	/* ---------------------------- settings ---------------------------- */

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/* ---------------------------- menus ------------------------------- */

	private buildFileMenu(menu: Menu, file: TAbstractFile) {
		if (file instanceof TFile && file.extension === "base") {
			menu.addItem((item) =>
				item
					.setTitle("Generate covers for notes in this Base (missing one)")
					.setIcon("image-plus")
					.onClick(() => this.generateForBase(file, true))
			);
			menu.addItem((item) =>
				item
					.setTitle("Regenerate covers for ALL notes in this Base")
					.setIcon("image-plus")
					.onClick(() => this.generateForBase(file, false))
			);
			menu.addItem((item) =>
				item
					.setTitle("Find covers on the web for notes in this Base (missing one)")
					.setIcon("globe")
					.onClick(() => this.fetchForBase(file))
			);
		} else if (file instanceof TFile && file.extension === "md") {
			this.addNoteMenuItems(menu, file);
		} else if (file instanceof TFolder) {
			menu.addItem((item) =>
				item
					.setTitle("Generate covers for notes in folder")
					.setIcon("image-plus")
					.onClick(() => this.generateForFolder(file, false))
			);
			menu.addItem((item) =>
				item
					.setTitle("Generate covers for notes missing one")
					.setIcon("image-plus")
					.onClick(() => this.generateForFolder(file, true))
			);
			menu.addItem((item) =>
				item
					.setTitle("Find covers on the web for notes missing one")
					.setIcon("globe")
					.onClick(() => this.fetchForFolder(file))
			);
		}
	}

	private addNoteMenuItems(menu: Menu, file: TFile) {
		const hasCover = this.noteHasCover(file);
		menu.addItem((item) =>
			item
				.setTitle(hasCover ? "Regenerate cover image" : "Generate cover image")
				.setIcon("image-plus")
				.onClick(() => this.generateCover(file, hasCover))
		);
		menu.addItem((item) =>
			item
				.setTitle("Find cover on the web (Douban / Wikipedia)")
				.setIcon("globe")
				.onClick(() => this.fetchWebCover(file))
		);
	}

	private noteHasCover(file: TFile): boolean {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const v = fm?.[this.settings.coverProperty];
		return typeof v === "string" && v.trim().length > 0;
	}

	/* -------------------------- generation ---------------------------- */

	async generateForFolder(folder: TFolder, onlyMissing: boolean) {
		const notes = this.collectFolderNotes(folder, onlyMissing);
		if (notes.length === 0) {
			new Notice("No matching notes found in this folder.");
			return;
		}
		await this.runBatch(notes, folder.name, (n) => this.generateCover(n, false, true));
	}

	async fetchForFolder(folder: TFolder) {
		const notes = this.collectFolderNotes(folder, true);
		if (notes.length === 0) {
			new Notice("No notes without a cover in this folder.");
			return;
		}
		await this.runWebBatch(notes, folder.name);
	}

	private collectFolderNotes(folder: TFolder, onlyMissing: boolean): TFile[] {
		const notes: TFile[] = [];
		const walk = (f: TAbstractFile) => {
			if (f instanceof TFile && f.extension === "md") {
				if (!onlyMissing || !this.noteHasCover(f)) notes.push(f);
			} else if (f instanceof TFolder) {
				f.children.forEach(walk);
			}
		};
		folder.children.forEach(walk);
		return notes;
	}

	/** Resolve the notes a .base file selects, then generate covers for them. */
	async generateForBase(baseFile: TFile, onlyMissing: boolean) {
		const targets = await this.resolveBaseNotes(baseFile, onlyMissing);
		if (!targets) return;
		await this.runBatch(targets, baseFile.basename, (n) =>
			this.generateCover(n, false, true)
		);
	}

	async fetchForBase(baseFile: TFile) {
		const targets = await this.resolveBaseNotes(baseFile, true);
		if (!targets) return;
		await this.runWebBatch(targets, baseFile.basename);
	}

	/**
	 * Notes a .base file selects (optionally only those without a cover).
	 * Returns null — after telling the user why — when there is nothing to do.
	 */
	private async resolveBaseNotes(
		baseFile: TFile,
		onlyMissing: boolean
	): Promise<TFile[] | null> {
		let config: any;
		try {
			config = parseYaml(await this.app.vault.cachedRead(baseFile));
		} catch (e) {
			new Notice("Could not read this Base file.");
			return null;
		}

		const topFilter = config?.filters ?? null;
		const views: any[] = Array.isArray(config?.views) ? config.views : [];

		// If the Base has more than one view (tab/page), let the user pick which
		// one to target — or the whole Base.
		let viewFilters: any[];
		if (views.length > 1) {
			const choice = await this.pickView(views);
			if (choice === undefined) return null; // cancelled
			viewFilters =
				choice === "ALL"
					? views.map((v) => v?.filters).filter((f) => f != null)
					: [choice?.filters ?? null];
		} else {
			viewFilters = views.map((v) => v?.filters).filter((f) => f != null);
		}

		// A note belongs when it passes the top-level filter AND matches the
		// selected view filter(s) (or there are none).
		const notes = this.app.vault.getMarkdownFiles().filter((n) => {
			if (!matchesFilter(this.app, n, topFilter)) return false;
			if (viewFilters.length === 0) return true;
			return viewFilters.some((f) => matchesFilter(this.app, n, f));
		});

		const targets = onlyMissing
			? notes.filter((n) => !this.noteHasCover(n))
			: notes;

		if (targets.length === 0) {
			new Notice(
				notes.length === 0
					? "No notes matched this Base's filters."
					: "All notes already have a cover."
			);
			return null;
		}
		return targets;
	}

	/** Pop a picker to choose a single view or the whole Base. */
	private pickView(
		views: any[]
	): Promise<any | "ALL" | undefined> {
		return new Promise((resolve) => {
			new ViewPickerModal(this.app, views, resolve).open();
		});
	}

	/** Run a job over many notes with a bounded concurrency pool. */
	private async runBatch(
		notes: TFile[],
		label: string,
		job: (note: TFile) => Promise<boolean>,
		concurrency = this.settings.concurrency,
		verb = "Generating",
		delayMs = 0
	) {
		const total = notes.length;
		const workers = Math.max(1, Math.min(concurrency || 1, total));
		let ok = 0;
		let done = 0;
		let next = 0;

		const progress = new Notice(`${verb} covers (0/${total})…`, 0);
		const tick = () => progress.setMessage(`${verb} covers (${done}/${total})…`);

		const worker = async () => {
			while (next < total) {
				const note = notes[next++];
				const success = await job(note);
				done++;
				if (success) ok++;
				tick();
				if (delayMs > 0 && next < total) await sleep(delayMs);
			}
		};

		await Promise.all(Array.from({ length: workers }, () => worker()));
		progress.hide();
		new Notice(`Done "${label}": ${ok}/${total} cover(s) set.`, 6000);
	}

	private runWebBatch(notes: TFile[], label: string) {
		return this.runBatch(
			notes,
			label,
			(n) => this.fetchWebCover(n, true),
			this.settings.webConcurrency,
			"Fetching",
			this.settings.webInterval
		);
	}

	/**
	 * Generate (or regenerate) a cover for a single note.
	 * @returns true on success.
	 */
	async generateCover(
		file: TFile,
		_regenerate = false,
		silentStart = false
	): Promise<boolean> {
		if (!this.settings.apiKey) {
			new Notice("Set your Gemini API key in the plugin settings first.");
			return false;
		}
		if (this.inFlight.has(file.path)) {
			new Notice("A cover is already being generated for this note.");
			return false;
		}

		this.inFlight.add(file.path);
		const notice = silentStart
			? null
			: new Notice(`Generating cover for "${file.basename}"…`, 0);
		try {
			const prompt = await this.buildPrompt(file);
			const image = await this.callGemini(prompt);
			const imageFile = await this.saveImage(file, image.data, image.ext);
			await this.setCoverProperty(file, imageFile);
			notice?.hide();
			if (!silentStart) new Notice(`Cover set for "${file.basename}".`);
			return true;
		} catch (err) {
			notice?.hide();
			console.error("[Base Cover Image] generation failed:", err);
			new Notice(
				`Cover generation failed for "${file.basename}": ${
					err instanceof Error ? err.message : String(err)
				}`,
				8000
			);
			return false;
		} finally {
			this.inFlight.delete(file.path);
		}
	}

	/* ------------------------ web covers ----------------------------- */

	/**
	 * Search Douban / Wikipedia for a cover matching the note and save it.
	 * Single notes show a picker (if enabled); batch runs pick automatically.
	 * @returns true on success.
	 */
	async fetchWebCover(file: TFile, batch = false): Promise<boolean> {
		if (!this.settings.useDouban && !this.settings.useWikipedia) {
			new Notice("Enable Douban or Wikipedia in the plugin settings first.");
			return false;
		}
		if (this.inFlight.has(file.path)) {
			if (!batch) new Notice("A cover is already being processed for this note.");
			return false;
		}

		const query = this.buildSearchQuery(file);
		const kind = this.detectKind(file);
		const opts = this.searchOptions();

		this.inFlight.add(file.path);
		let notice: Notice | null = null;
		try {
			let choice: CoverCandidate | null | undefined;
			if (!batch && this.settings.webPickManually) {
				choice = await new Promise<CoverCandidate | undefined>((resolve) =>
					new CoverPickerModal(this.app, file.basename, query, kind, opts, resolve).open()
				);
				if (!choice) return false; // cancelled
			} else {
				if (!batch) notice = new Notice(`Searching cover for "${query}"…`, 0);
				const results = await searchCovers(query, kind, opts);
				choice = pickBest(results, query, batch && this.settings.webStrictMatch);
				if (!choice) {
					throw new Error(
						results.length === 0
							? `nothing found for "${query}" (${KIND_LABELS[kind]})`
							: `no result matched "${query}" closely enough`
					);
				}
			}

			const picked = choice;
			if (!notice && !batch) notice = new Notice("Downloading cover…", 0);
			const image = await downloadImage(picked.fullUrl, picked.referer).catch(() =>
				// The large variant occasionally doesn't exist; the preview always does.
				downloadImage(picked.thumbUrl, picked.referer)
			);
			const imageFile = await this.saveImage(file, image.data, image.ext);
			await this.setCoverProperty(file, imageFile);
			notice?.hide();
			if (!batch) new Notice(`Cover set for "${file.basename}" from ${picked.source}.`);
			return true;
		} catch (err) {
			notice?.hide();
			console.error("[Base Cover Image] web cover failed:", err);
			new Notice(
				`No web cover for "${file.basename}": ${
					err instanceof Error ? err.message : String(err)
				}`,
				batch ? 4000 : 8000
			);
			return false;
		} finally {
			this.inFlight.delete(file.path);
		}
	}

	private searchOptions(): SearchOptions {
		return {
			useDouban: this.settings.useDouban,
			useWikipedia: this.settings.useWikipedia,
			wikiLangs: splitList(this.settings.wikiLangs).filter((l) => /^[a-z-]+$/i.test(l)),
		};
	}

	/** The note name with prefixes like 【书籍】 and 《》 removed. */
	private cleanTitle(file: TFile): string {
		let title = file.basename;
		if (this.settings.titleCleanup) {
			try {
				title = title.replace(new RegExp(this.settings.titleCleanup, "g"), "");
			} catch {
				/* invalid regex in settings — use the raw name */
			}
		}
		return title.trim() || file.basename;
	}

	private buildSearchQuery(file: TFile): string {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const q = (this.settings.searchTemplate || "{{title}}")
			.replace(/\{\{title\}\}/g, this.cleanTitle(file))
			.replace(/\{\{prop:([^}]+)\}\}/g, (_m, name: string) => {
				const val = fm[name.trim()];
				if (val == null) return "";
				return Array.isArray(val) ? val.join(" ") : String(val);
			})
			.replace(/\s+/g, " ")
			.trim();
		return q || this.cleanTitle(file);
	}

	/**
	 * Decide whether a note is a book, movie or person from its type property,
	 * its tags and a 【…】 prefix in its name. Falls back to "auto".
	 */
	private detectKind(file: TFile): MediaKind {
		const cache = this.app.metadataCache.getFileCache(file);
		const hints: string[] = [];
		const typeVal = cache?.frontmatter?.[this.settings.typeProperty];
		if (Array.isArray(typeVal)) hints.push(...typeVal.map(String));
		else if (typeVal != null) hints.push(String(typeVal));
		hints.push(...getNoteTags(this.app, file));
		const prefix = file.basename.match(/^【([^】]+)】/);
		if (prefix) hints.push(prefix[1]);

		const lists: [MediaKind, string][] = [
			["book", this.settings.bookKeywords],
			["movie", this.settings.movieKeywords],
			["person", this.settings.personKeywords],
		];
		for (const hint of hints.map((h) => h.toLowerCase().trim())) {
			for (const [kind, list] of lists) {
				if (splitList(list).some((k) => k.toLowerCase() === hint)) return kind;
			}
		}
		return "auto";
	}

	/* --------------------------- prompt ------------------------------- */

	private async buildPrompt(file: TFile): Promise<string> {
		const raw = await this.app.vault.cachedRead(file);
		const body = this.stripFrontmatter(raw)
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, Math.max(0, this.settings.contentLength));
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};

		return this.settings.promptTemplate
			.replace(/\{\{title\}\}/g, file.basename)
			.replace(/\{\{content\}\}/g, body || file.basename)
			.replace(/\{\{prop:([^}]+)\}\}/g, (_m, name: string) => {
				const val = fm[name.trim()];
				if (val == null) return "";
				return Array.isArray(val) ? val.join(", ") : String(val);
			})
			.trim();
	}

	private stripFrontmatter(text: string): string {
		if (text.startsWith("---")) {
			const end = text.indexOf("\n---", 3);
			if (end !== -1) {
				const after = text.indexOf("\n", end + 1);
				return after !== -1 ? text.slice(after + 1) : "";
			}
		}
		return text;
	}

	/* ---------------------------- API --------------------------------- */

	private async callGemini(
		prompt: string
	): Promise<{ data: ArrayBuffer; ext: string }> {
		const body = {
			model: this.settings.model,
			input: [{ type: "text", text: prompt }],
			response_format: {
				type: "image",
				mime_type: "image/jpeg",
				aspect_ratio: this.settings.aspectRatio,
				image_size: this.settings.imageSize,
			},
		};

		const res = await requestUrl({
			url: "https://generativelanguage.googleapis.com/v1beta/interactions",
			method: "POST",
			headers: {
				"x-goog-api-key": this.settings.apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			throw: false,
		});

		if (res.status < 200 || res.status >= 300) {
			throw new Error(
				`API error ${res.status}: ${this.readApiError(res.text)}`
			);
		}

		const found = extractImage(res.json);
		if (!found) {
			throw new Error(
				"No image returned by the model. " + this.readApiError(res.text)
			);
		}
		return {
			data: base64ToArrayBuffer(found.data),
			ext: mimeToExt(found.mime),
		};
	}

	private readApiError(text: string): string {
		try {
			const j = JSON.parse(text);
			return j?.error?.message ?? text.slice(0, 300);
		} catch {
			return (text ?? "").slice(0, 300);
		}
	}

	/* --------------------------- files -------------------------------- */

	private async saveImage(
		note: TFile,
		data: ArrayBuffer,
		ext: string
	): Promise<TFile> {
		const base = sanitize(note.basename);
		const filename = `${base}-cover.${ext}`;

		let path: string;
		if (this.settings.useDefaultAttachmentFolder) {
			path = await this.app.fileManager.getAvailablePathForAttachment(
				filename,
				note.path
			);
		} else {
			const folder = normalizePath(this.settings.imageFolder || "covers");
			await this.ensureFolder(folder);
			path = this.dedupePath(`${folder}/${filename}`);
		}

		return this.app.vault.createBinary(path, data);
	}

	private async ensureFolder(folder: string) {
		if (!folder) return;
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder).catch(() => {
				/* already exists / race — ignore */
			});
		}
	}

	private dedupePath(path: string): string {
		if (!this.app.vault.getAbstractFileByPath(path)) return path;
		const dot = path.lastIndexOf(".");
		const stem = dot === -1 ? path : path.slice(0, dot);
		const ext = dot === -1 ? "" : path.slice(dot);
		let i = 1;
		while (this.app.vault.getAbstractFileByPath(`${stem}-${i}${ext}`)) i++;
		return `${stem}-${i}${ext}`;
	}

	private async setCoverProperty(note: TFile, image: TFile) {
		// Build the standard embed link, then strip the leading "!" so it becomes
		// a plain link ([[image.png]]) that Bases renders as a card cover.
		let link = this.app.fileManager.generateMarkdownLink(image, note.path);
		if (!this.settings.useEmbed && link.startsWith("!")) {
			link = link.slice(1);
		}
		await this.app.fileManager.processFrontMatter(note, (fm) => {
			fm[this.settings.coverProperty] = link;
		});
	}
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function extractImage(
	json: any
): { data: string; mime: string } | null {
	if (!json) return null;

	// New /interactions API: steps[].content[] with { type:"image", data }.
	const steps = json.steps ?? json.output ?? [];
	for (const step of Array.isArray(steps) ? steps : []) {
		const content = step?.content ?? step?.output ?? [];
		for (const c of Array.isArray(content) ? content : []) {
			if (c?.data && (c.type === "image" || String(c.mime_type).startsWith("image/"))) {
				return { data: c.data, mime: c.mime_type ?? "image/png" };
			}
		}
	}

	// Legacy generateContent API: candidates[].content.parts[].inlineData.
	const parts = json.candidates?.[0]?.content?.parts ?? [];
	for (const p of Array.isArray(parts) ? parts : []) {
		const inline = p.inlineData ?? p.inline_data;
		if (inline?.data) {
			return { data: inline.data, mime: inline.mimeType ?? inline.mime_type ?? "image/png" };
		}
	}
	return null;
}

/* ---- Minimal Bases filter evaluator ------------------------------- */
/* Supports and/or/not nesting and common leaf expressions:            */
/*   prop == "v" | prop != "v" | prop > 1 | prop.contains("x")         */
/*   file.name / file.path / file.ext / file.folder comparisons        */
/*   file.inFolder("X") | file.hasTag("t") | bare `prop` | `!prop`     */

function matchesFilter(app: App, note: TFile, node: any): boolean {
	if (node == null) return true;

	if (Array.isArray(node)) {
		// A bare list is treated as AND.
		return node.every((n) => matchesFilter(app, note, n));
	}
	if (typeof node === "object") {
		if ("and" in node) return toArray(node.and).every((n) => matchesFilter(app, note, n));
		if ("or" in node) return toArray(node.or).some((n) => matchesFilter(app, note, n));
		if ("not" in node) return !matchesFilter(app, note, node.not);
		return true;
	}
	if (typeof node === "string") {
		try {
			return evalLeaf(app, note, node.trim());
		} catch {
			// Unparseable clause: don't let it silently include everything.
			return false;
		}
	}
	return true;
}

function toArray(x: any): any[] {
	return Array.isArray(x) ? x : [x];
}

function evalLeaf(app: App, note: TFile, expr: string): boolean {
	if (!expr) return true;

	let m: RegExpMatchArray | null;

	// file.inFolder("X")
	if ((m = expr.match(/^!?\s*(?:file\.)?inFolder\(\s*(['"])(.*?)\1\s*\)$/i))) {
		const folder = normalizePath(m[2]);
		const inside =
			note.path === folder ||
			note.path.startsWith(folder.replace(/\/$/, "") + "/");
		return expr.startsWith("!") ? !inside : inside;
	}

	// file.hasTag("t") / hasTag('#t')
	if ((m = expr.match(/^!?\s*(?:file\.)?hasTag\(\s*(['"])(.*?)\1\s*\)$/i))) {
		const want = m[2].replace(/^#/, "");
		const tags = getNoteTags(app, note);
		const has = tags.includes(want);
		return expr.startsWith("!") ? !has : has;
	}

	// prop.contains("x")
	if ((m = expr.match(/^(.+?)\.contains\(\s*(['"])(.*?)\2\s*\)$/i))) {
		const val = getField(app, note, m[1].trim());
		const needle = m[3];
		if (Array.isArray(val)) return val.map(String).includes(needle);
		return String(val ?? "").includes(needle);
	}

	// binary: LHS OP RHS  (order matters: check 2-char ops first)
	const opMatch = expr.match(/^(.*?)\s*(==|!=|>=|<=|>|<)\s*(.*)$/);
	if (opMatch) {
		const lhs = getField(app, note, opMatch[1].trim());
		const op = opMatch[2];
		const rhs = parseLiteral(opMatch[3].trim());
		return compare(lhs, op, rhs);
	}

	// bare `!prop` / `prop` -> falsy / truthy test
	if (expr.startsWith("!")) return !truthy(getField(app, note, expr.slice(1).trim()));
	return truthy(getField(app, note, expr));
}

function getField(app: App, note: TFile, field: string): any {
	switch (field) {
		case "file.name":
			return note.basename;
		case "file.path":
			return note.path;
		case "file.ext":
			return note.extension;
		case "file.folder":
			return note.parent?.path ?? "";
	}
	const fm = app.metadataCache.getFileCache(note)?.frontmatter ?? {};
	return fm[field];
}

function getNoteTags(app: App, note: TFile): string[] {
	const cache = app.metadataCache.getFileCache(note);
	const out: string[] = [];
	for (const t of cache?.tags ?? []) out.push(t.tag.replace(/^#/, ""));
	const fmTags = cache?.frontmatter?.tags;
	if (Array.isArray(fmTags)) for (const t of fmTags) out.push(String(t).replace(/^#/, ""));
	else if (typeof fmTags === "string") out.push(fmTags.replace(/^#/, ""));
	return out;
}

function parseLiteral(raw: string): any {
	if (/^(['"]).*\1$/.test(raw)) return raw.slice(1, -1);
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null") return null;
	if (raw !== "" && !isNaN(Number(raw))) return Number(raw);
	return raw;
}

function compare(a: any, op: string, b: any): boolean {
	if (op === "==" || op === "!=") {
		let eq: boolean;
		if (Array.isArray(a)) eq = a.map(String).includes(String(b));
		else eq = String(a ?? "") === String(b ?? "");
		return op === "==" ? eq : !eq;
	}
	const na = Number(a);
	const nb = Number(b);
	if (isNaN(na) || isNaN(nb)) return false;
	switch (op) {
		case ">":
			return na > nb;
		case "<":
			return na < nb;
		case ">=":
			return na >= nb;
		case "<=":
			return na <= nb;
	}
	return false;
}

function truthy(v: any): boolean {
	if (v == null) return false;
	if (Array.isArray(v)) return v.length > 0;
	if (typeof v === "string") return v.trim().length > 0;
	return Boolean(v);
}

function splitList(s: string): string[] {
	return (s ?? "")
		.split(/[,，]/)
		.map((x) => x.trim())
		.filter(Boolean);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}

function mimeToExt(mime: string): string {
	switch ((mime || "").toLowerCase()) {
		case "image/jpeg":
		case "image/jpg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return "png";
	}
}

function sanitize(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "cover";
}

/* ------------------------------------------------------------------ */
/*  View picker modal                                                  */
/* ------------------------------------------------------------------ */

type ViewChoice = any | "ALL";

class ViewPickerModal extends FuzzySuggestModal<ViewChoice> {
	private views: any[];
	private resolve: (choice: ViewChoice | undefined) => void;
	private picked = false;

	constructor(
		app: App,
		views: any[],
		resolve: (choice: ViewChoice | undefined) => void
	) {
		super(app);
		this.views = views;
		this.resolve = resolve;
		this.setPlaceholder("Choose a view (page) to generate covers for");
	}

	getItems(): ViewChoice[] {
		return ["ALL", ...this.views];
	}

	getItemText(item: ViewChoice): string {
		if (item === "ALL") return "★ Entire Base (all views)";
		return item?.name || item?.type || "Untitled view";
	}

	onChooseItem(item: ViewChoice): void {
		this.picked = true;
		this.resolve(item);
	}

	onClose(): void {
		super.onClose();
		if (!this.picked) this.resolve(undefined);
	}
}

/* ------------------------------------------------------------------ */
/*  Settings tab                                                       */
/* ------------------------------------------------------------------ */

class CoverImageSettingTab extends PluginSettingTab {
	plugin: CoverImagePlugin;

	constructor(app: App, plugin: CoverImagePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Gemini API").setHeading();

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Your Google Gemini API key. Stored locally in this vault.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("AIza…")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (v) => {
						this.plugin.settings.apiKey = v.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Model")
			.setDesc(
				"Image model id. Default: gemini-3.1-flash-lite-image (Nano Banana 2 Lite)."
			)
			.addText((text) =>
				text
					.setPlaceholder("gemini-3.1-flash-lite-image")
					.setValue(this.plugin.settings.model)
					.onChange(async (v) => {
						this.plugin.settings.model =
							v.trim() || DEFAULT_SETTINGS.model;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Aspect ratio")
			.setDesc("Requested aspect ratio for generated images.")
			.addDropdown((d) =>
				d
					.addOptions({
						"16:9": "16:9 (landscape)",
						"4:3": "4:3",
						"1:1": "1:1 (square)",
						"3:4": "3:4",
						"9:16": "9:16 (portrait)",
					})
					.setValue(this.plugin.settings.aspectRatio)
					.onChange(async (v) => {
						this.plugin.settings.aspectRatio = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Image size")
			.setDesc("Resolution. Nano Banana 2 Lite supports 512 and 1K.")
			.addDropdown((d) =>
				d
					.addOptions({ "512": "512", "1K": "1K", "2K": "2K", "4K": "4K" })
					.setValue(this.plugin.settings.imageSize)
					.onChange(async (v) => {
						this.plugin.settings.imageSize = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Storage").setHeading();

		new Setting(containerEl)
			.setName("Use Obsidian's default attachment folder")
			.setDesc(
				"When on, images follow your Files & Links attachment location setting."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.useDefaultAttachmentFolder)
					.onChange(async (v) => {
						this.plugin.settings.useDefaultAttachmentFolder = v;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (!this.plugin.settings.useDefaultAttachmentFolder) {
			new Setting(containerEl)
				.setName("Image folder")
				.setDesc("Vault-relative folder where covers are saved.")
				.addText((text) =>
					text
						.setPlaceholder("covers")
						.setValue(this.plugin.settings.imageFolder)
						.onChange(async (v) => {
							this.plugin.settings.imageFolder = v.trim();
							await this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl).setName("Batch").setHeading();

		new Setting(containerEl)
			.setName("Concurrency")
			.setDesc(
				"How many images to generate at once during batch runs (folder / Base). Higher is faster but may hit API rate limits."
			)
			.addSlider((s) =>
				s
					.setLimits(1, 8, 1)
					.setValue(this.plugin.settings.concurrency)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.concurrency = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Cover property").setHeading();

		new Setting(containerEl)
			.setName("Property name")
			.setDesc("Frontmatter property that stores the cover link.")
			.addText((text) =>
				text
					.setPlaceholder("cover")
					.setValue(this.plugin.settings.coverProperty)
					.onChange(async (v) => {
						this.plugin.settings.coverProperty =
							v.trim() || DEFAULT_SETTINGS.coverProperty;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Write as embed")
			.setDesc(
				"Off (recommended): store as a link [[image]] so Bases shows it as a cover. On: store as an embed ![[image]]."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.useEmbed)
					.onChange(async (v) => {
						this.plugin.settings.useEmbed = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Prompt").setHeading();

		new Setting(containerEl)
			.setName("Prompt template")
			.setDesc(
				"Placeholders: {{title}}, {{content}}, {{prop:name}} for a frontmatter property."
			)
			.addTextArea((ta) => {
				ta.inputEl.rows = 5;
				ta.inputEl.style.width = "100%";
				ta
					.setValue(this.plugin.settings.promptTemplate)
					.onChange(async (v) => {
						this.plugin.settings.promptTemplate = v;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Content length")
			.setDesc(
				"Max characters of the note body fed into {{content}} (0 = title only)."
			)
			.addText((text) =>
				text
					.setPlaceholder("800")
					.setValue(String(this.plugin.settings.contentLength))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						this.plugin.settings.contentLength = isNaN(n)
							? DEFAULT_SETTINGS.contentLength
							: Math.max(0, n);
						await this.plugin.saveSettings();
					})
			);

		this.displayWebSettings(containerEl);
	}

	private displayWebSettings(containerEl: HTMLElement) {
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();

		new Setting(containerEl).setName("Web cover search (books, movies, people)").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Find an existing cover (book cover, film poster, portrait) by note name on Douban, " +
				"with Wikipedia as a fallback. No API key needed. Images are saved with the Storage settings above.",
		});

		new Setting(containerEl)
			.setName("Search Douban")
			.setDesc("Books, movies, TV series and people (豆瓣读书 / 豆瓣电影).")
			.addToggle((t) =>
				t.setValue(s.useDouban).onChange(async (v) => {
					s.useDouban = v;
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Search Wikipedia")
			.setDesc("Good for historical figures and anything Douban lacks. Languages are tried in order.")
			.addToggle((t) =>
				t.setValue(s.useWikipedia).onChange(async (v) => {
					s.useWikipedia = v;
					await save();
				})
			)
			.addText((text) =>
				text
					.setPlaceholder("zh, en")
					.setValue(s.wikiLangs)
					.onChange(async (v) => {
						s.wikiLangs = v;
						await save();
					})
			);

		new Setting(containerEl)
			.setName("Pick from results")
			.setDesc(
				"For a single note, show all results as thumbnails to choose from. Off: take the best match automatically. Batch runs always pick automatically."
			)
			.addToggle((t) =>
				t.setValue(s.webPickManually).onChange(async (v) => {
					s.webPickManually = v;
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Search text")
			.setDesc(
				"{{title}} = note name after cleanup; {{prop:name}} = a frontmatter property (e.g. {{title}} {{prop:author}})."
			)
			.addText((text) =>
				text
					.setPlaceholder("{{title}}")
					.setValue(s.searchTemplate)
					.onChange(async (v) => {
						s.searchTemplate = v;
						await save();
					})
			);

		new Setting(containerEl)
			.setName("Title cleanup (regex)")
			.setDesc("Removed from the note name to build {{title}}. Default strips a 【书籍】-style prefix and 《》.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.titleCleanup)
					.setValue(s.titleCleanup)
					.onChange(async (v) => {
						s.titleCleanup = v;
						await save();
					})
			);

		new Setting(containerEl)
			.setName("Type property")
			.setDesc(
				"Frontmatter property that says what the note is. Its value (or a tag, or a 【…】 name prefix) is matched against the keyword lists below. No match = search everything."
			)
			.addText((text) =>
				text
					.setPlaceholder("类型")
					.setValue(s.typeProperty)
					.onChange(async (v) => {
						s.typeProperty = v.trim() || DEFAULT_SETTINGS.typeProperty;
						await save();
					})
			);

		const keywordSetting = (
			name: string,
			key: "bookKeywords" | "movieKeywords" | "personKeywords"
		) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc("Comma-separated values.")
				.addText((text) =>
					text.setValue(s[key]).onChange(async (v) => {
						s[key] = v;
						await save();
					})
				);
		keywordSetting("Book keywords", "bookKeywords");
		keywordSetting("Movie / TV keywords", "movieKeywords");
		keywordSetting("Person keywords", "personKeywords");

		new Setting(containerEl)
			.setName("Batch: only accept matching titles")
			.setDesc(
				"Skip a note when no result's title matches its name, instead of using the top result. Recommended to avoid wrong covers."
			)
			.addToggle((t) =>
				t.setValue(s.webStrictMatch).onChange(async (v) => {
					s.webStrictMatch = v;
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Batch: parallel requests")
			.setDesc("Keep this low — Douban blocks clients that send too many requests.")
			.addSlider((sl) =>
				sl
					.setLimits(1, 4, 1)
					.setValue(s.webConcurrency)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.webConcurrency = v;
						await save();
					})
			);

		new Setting(containerEl)
			.setName("Batch: delay between notes (ms)")
			.addText((text) =>
				text
					.setPlaceholder("1200")
					.setValue(String(s.webInterval))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						s.webInterval = isNaN(n) ? DEFAULT_SETTINGS.webInterval : Math.max(0, n);
						await save();
					})
			);
	}
}
