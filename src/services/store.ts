import type { NoteSummary, PipelineStatus, StoredSummaryMeta } from "../types";

interface LegacySummaryText {
  summary: string;
  reason: string;
}

interface StoredData {
  summaries: Record<string, StoredSummaryMeta>;
  pipelineStatuses: Record<string, PipelineStatus>;
  // Quiz questions/answers live in their own markdown notes (see
  // quiz-notes.ts), not here — this is just a small path index so a source
  // note can be mapped to its quiz note without scanning the vault. Keeping
  // quiz content out of data.json is what stops this file from growing
  // without bound as the number of articles/quizzes increases.
  quizNotePaths: Record<string, string>;
  learnedPaths: string[];
}

const EMPTY_DATA: StoredData = {
  summaries: {},
  pipelineStatuses: {},
  quizNotePaths: {},
  learnedPaths: []
};

export interface PluginDataHost {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export class KnowledgeStore {
  private data: StoredData = structuredClone(EMPTY_DATA);
  // Populated by load() with any pre-existing full-text summary/reason found
  // on disk (from before that text moved into each note's own callout — see
  // summary-notes.ts). main.ts drains this once at startup to write that
  // text into the corresponding notes instead of silently discarding real
  // AI analysis the user already generated.
  private pendingLegacySummaryText: Record<string, LegacySummaryText> = {};

  constructor(private host: PluginDataHost) {}

  async load(): Promise<void> {
    const raw = await this.host.loadData();
    this.data = {
      ...structuredClone(EMPTY_DATA),
      ...(raw && typeof raw === "object" ? raw : {})
    } as StoredData;

    this.pendingLegacySummaryText = {};
    for (const [path, summary] of Object.entries(this.data.summaries)) {
      const legacy = summary as StoredSummaryMeta & { summary?: unknown; reason?: unknown };
      if (typeof legacy.summary === "string" && legacy.summary.trim()) {
        this.pendingLegacySummaryText[path] = {
          summary: legacy.summary,
          reason: typeof legacy.reason === "string" ? legacy.reason : ""
        };
      }
    }

    this.data.summaries = Object.fromEntries(
      Object.entries(this.data.summaries).map(([path, summary]) => [
        path,
        normalizeSummary(summary)
      ])
    );
    // Drop fields from older plugin versions so they don't linger in
    // data.json forever: quizStats was a short-lived intermediate shape,
    // quizzes/quizAttempts were replaced by markdown quiz notes (see
    // quiz-notes.ts) plus the lightweight quizNotePaths index above, and
    // pipelineResults was a capped history log whose title/category/
    // readingValue duplicated frontmatter and whose only reader
    // (sidebar-view.ts's showLastPipeline) was itself dead code.
    const legacy = this.data as StoredData & { quizStats?: unknown; quizzes?: unknown; quizAttempts?: unknown; pipelineResults?: unknown };
    delete legacy.quizStats;
    delete legacy.quizzes;
    delete legacy.quizAttempts;
    delete legacy.pipelineResults;
  }

  /**
   * Drains and returns any legacy full-text summaries found by load(),
   * clearing them so this only ever runs once per startup. Call this
   * before the first save() so main.ts has a chance to migrate the text
   * into notes first.
   */
  takeLegacySummaryText(): Record<string, LegacySummaryText> {
    const pending = this.pendingLegacySummaryText;
    this.pendingLegacySummaryText = {};
    return pending;
  }

  async save(): Promise<void> {
    await this.host.saveData(this.data);
  }

  getSummary(path: string): StoredSummaryMeta | null {
    return this.data.summaries[path] ?? null;
  }

  /**
   * Persists only recommendedAction/updatedAt (see StoredSummaryMeta) —
   * every other field either lives in the note's own frontmatter/callout
   * already (written by SummaryNoteService.applySummary, which callers
   * are expected to have called with this same `summary`) or is derived
   * from the file itself (filePath/title).
   */
  async setSummary(summary: NoteSummary): Promise<void> {
    this.setSummaryInMemory(summary);
    await this.save();
  }

  private setSummaryInMemory(summary: NoteSummary): void {
    this.data.summaries[summary.filePath] = {
      recommendedAction: summary.recommendedAction,
      updatedAt: summary.updatedAt
    };
  }

  async migratePath(oldPath: string, newPath: string): Promise<void> {
    if (this.migratePathInMemory(oldPath, newPath)) {
      await this.save();
    }
  }

  /**
   * Migrates every stored record (summaries, quizzes, attempts, learned
   * state, pipeline history) whose path lives under `oldFolder` to the same
   * relative path under `newFolder`. Needed because Obsidian only emits one
   * "rename" event for a renamed folder itself, not one per descendant file.
   */
  async migrateFolder(oldFolder: string, newFolder: string): Promise<void> {
    if (!oldFolder || !newFolder || oldFolder === newFolder) return;
    const oldPrefix = `${oldFolder}/`;
    const affectedPaths = new Set<string>();
    const collect = (path: string): void => {
      if (path.startsWith(oldPrefix)) affectedPaths.add(path);
    };

    Object.keys(this.data.summaries).forEach(collect);
    Object.keys(this.data.pipelineStatuses).forEach(collect);
    Object.keys(this.data.quizNotePaths).forEach(collect);
    this.data.learnedPaths.forEach(collect);

    let changed = false;
    for (const oldPath of affectedPaths) {
      const newPath = `${newFolder}/${oldPath.slice(oldPrefix.length)}`;
      changed = this.migratePathInMemory(oldPath, newPath) || changed;
    }

    if (changed) {
      await this.save();
    }
  }

  private migratePathInMemory(oldPath: string, newPath: string): boolean {
    if (!oldPath || !newPath || oldPath === newPath) return false;
    let changed = false;

    const summary = this.data.summaries[oldPath];
    if (summary) {
      this.data.summaries[newPath] = summary;
      delete this.data.summaries[oldPath];
      changed = true;
    }

    const pipelineStatus = this.data.pipelineStatuses[oldPath];
    if (pipelineStatus) {
      this.data.pipelineStatuses[newPath] = { ...pipelineStatus, path: newPath };
      delete this.data.pipelineStatuses[oldPath];
      changed = true;
    }

    const quizNotePath = this.data.quizNotePaths[oldPath];
    if (quizNotePath) {
      // Only the index entry moves; the quiz note file itself keeps its
      // original name/location on disk (see quiz-note-service.ts).
      this.data.quizNotePaths[newPath] = quizNotePath;
      delete this.data.quizNotePaths[oldPath];
      changed = true;
    }

    const learnedIndex = this.data.learnedPaths.indexOf(oldPath);
    if (learnedIndex >= 0) {
      this.data.learnedPaths[learnedIndex] = newPath;
      this.data.learnedPaths = Array.from(new Set(this.data.learnedPaths));
      changed = true;
    }

    return changed;
  }

  /**
   * Drops every stored record for a single deleted file so data.json doesn't
   * keep accumulating entries for notes that no longer exist in the vault.
   * The quiz note file itself (if any) is left untouched on disk — only the
   * bookkeeping index that points to it is removed.
   */
  async forgetPath(path: string): Promise<void> {
    if (this.forgetPathInMemory(path)) {
      await this.save();
    }
  }

  /**
   * Same as forgetPath but for an entire deleted folder, mirroring
   * migrateFolder: Obsidian only emits one "delete" event for the folder
   * itself, not one per descendant file.
   */
  async forgetFolder(folderPath: string): Promise<void> {
    if (!folderPath) return;
    const prefix = `${folderPath}/`;
    const affectedPaths = new Set<string>();
    const collect = (path: string): void => {
      if (path === folderPath || path.startsWith(prefix)) affectedPaths.add(path);
    };

    Object.keys(this.data.summaries).forEach(collect);
    Object.keys(this.data.pipelineStatuses).forEach(collect);
    Object.keys(this.data.quizNotePaths).forEach(collect);
    this.data.learnedPaths.forEach(collect);

    let changed = false;
    for (const path of affectedPaths) {
      changed = this.forgetPathInMemory(path) || changed;
    }
    if (changed) {
      await this.save();
    }
  }

  private forgetPathInMemory(path: string): boolean {
    let changed = false;

    if (path in this.data.summaries) {
      delete this.data.summaries[path];
      changed = true;
    }
    if (path in this.data.pipelineStatuses) {
      delete this.data.pipelineStatuses[path];
      changed = true;
    }
    if (path in this.data.quizNotePaths) {
      delete this.data.quizNotePaths[path];
      changed = true;
    }
    const learnedIndex = this.data.learnedPaths.indexOf(path);
    if (learnedIndex >= 0) {
      this.data.learnedPaths.splice(learnedIndex, 1);
      changed = true;
    }

    return changed;
  }

  getQuizNotePath(path: string): string | null {
    return this.data.quizNotePaths[path] ?? null;
  }

  async setQuizNotePath(path: string, quizNotePath: string): Promise<void> {
    this.data.quizNotePaths[path] = quizNotePath;
    await this.save();
  }

  getPipelineStatus(path: string): PipelineStatus {
    return this.data.pipelineStatuses[path] ?? { path, status: "raw", updatedAt: "" };
  }

  async setPipelineStatus(status: PipelineStatus): Promise<void> {
    this.setPipelineStatusInMemory(status);
    await this.save();
  }

  private setPipelineStatusInMemory(status: PipelineStatus): void {
    this.data.pipelineStatuses[status.path] = status;
  }

  /** Kept as its own method (rather than inlining setPipelineStatus at each
   * call site) so ClippingPipeline.process() reads as "record success",
   * matching recordCategoryMove below. */
  async recordPipelineSuccess(status: PipelineStatus): Promise<void> {
    this.setPipelineStatusInMemory(status);
    await this.save();
  }

  /**
   * ClippingPipeline.moveToCategory() migrates the stored path. The
   * category itself isn't cached in data.json at all (see
   * StoredSummaryMeta) — moveToCategory()'s own updateFrontmatterCategory()
   * call is what keeps the note's frontmatter current.
   */
  async recordCategoryMove(migration: { oldPath: string; newPath: string }): Promise<void> {
    if (this.migratePathInMemory(migration.oldPath, migration.newPath)) {
      await this.save();
    }
  }

  isLearned(path: string): boolean {
    return this.data.learnedPaths.includes(path);
  }

  async markLearned(path: string): Promise<void> {
    if (!this.data.learnedPaths.includes(path)) {
      this.data.learnedPaths.push(path);
      await this.save();
    }
  }

  exportData(): StoredData {
    return structuredClone(this.data);
  }
}

// Spreading `summary` here would also carry over legacy fields (the old
// full-text summary/reason, filePath/title, and briefDescription/
// readingValue/category/tags from before those moved to frontmatter-only)
// at runtime, since TS types don't strip them — so list the two fields
// StoredSummaryMeta actually declares explicitly instead.
function normalizeSummary(summary: StoredSummaryMeta): StoredSummaryMeta {
  return {
    recommendedAction: summary.recommendedAction ?? "skim",
    updatedAt: summary.updatedAt ?? ""
  };
}

