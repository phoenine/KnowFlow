import type { PipelineStatus } from "../types";

interface StoredData {
  pipelineStatuses: Record<string, PipelineStatus>;
  learnedPaths: string[];
}

const EMPTY_DATA: StoredData = {
  pipelineStatuses: {},
  learnedPaths: []
};

export interface PluginDataHost {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export class KnowledgeStore {
  private data: StoredData = structuredClone(EMPTY_DATA);

  constructor(private host: PluginDataHost) {}

  async load(): Promise<void> {
    const raw = await this.host.loadData();
    const persisted = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};

    this.data = {
      ...structuredClone(EMPTY_DATA),
      ...persisted
    } as StoredData;

    const hadChatThreads = "chatThreads" in persisted;
    delete (this.data as StoredData & { summaries?: unknown }).summaries;
    delete (this.data as StoredData & { quizNotePaths?: unknown }).quizNotePaths;
    delete (this.data as StoredData & { chatThreads?: unknown }).chatThreads;
    // Drop fields from older plugin versions so they don't linger in
    // data.json forever: quizStats was a short-lived intermediate shape,
    // quizzes/quizAttempts were replaced by markdown quiz notes (see
    // quiz-notes.ts), and
    // pipelineResults was a capped history log whose title/category/
    // readingValue duplicated frontmatter and whose only reader
    // (sidebar-view.ts's showLastPipeline) was itself dead code.
    const legacy = this.data as StoredData & { quizStats?: unknown; quizzes?: unknown; quizAttempts?: unknown; pipelineResults?: unknown };
    delete legacy.quizStats;
    delete legacy.quizzes;
    delete legacy.quizAttempts;
    delete legacy.pipelineResults;
    if (hadChatThreads) await this.save();
  }

  async save(): Promise<void> {
    await this.host.saveData(this.data);
  }

  async migratePath(oldPath: string, newPath: string): Promise<void> {
    if (this.migratePathInMemory(oldPath, newPath)) {
      await this.save();
    }
  }

  /**
   * Migrates every stored record (learned state and pipeline history)
   * whose path lives under `oldFolder` to the same
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

    Object.keys(this.data.pipelineStatuses).forEach(collect);
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

    const pipelineStatus = this.data.pipelineStatuses[oldPath];
    if (pipelineStatus) {
      this.data.pipelineStatuses[newPath] = { ...pipelineStatus, path: newPath };
      delete this.data.pipelineStatuses[oldPath];
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

    Object.keys(this.data.pipelineStatuses).forEach(collect);
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

    if (path in this.data.pipelineStatuses) {
      delete this.data.pipelineStatuses[path];
      changed = true;
    }
    const learnedIndex = this.data.learnedPaths.indexOf(path);
    if (learnedIndex >= 0) {
      this.data.learnedPaths.splice(learnedIndex, 1);
      changed = true;
    }

    return changed;
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
   * A category move ends the clipping pipeline lifecycle. Migrate any other
   * path-keyed state, then remove pipeline status at both paths so this stays
   * correct whether Obsidian's rename event ran before or after this call.
   */
  async recordCategoryMove(migration: { oldPath: string; newPath: string }): Promise<void> {
    let changed = this.migratePathInMemory(migration.oldPath, migration.newPath);
    if (migration.oldPath in this.data.pipelineStatuses) {
      delete this.data.pipelineStatuses[migration.oldPath];
      changed = true;
    }
    if (migration.newPath in this.data.pipelineStatuses) {
      delete this.data.pipelineStatuses[migration.newPath];
      changed = true;
    }
    if (changed) {
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

