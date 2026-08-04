import type { NoteSummary, PipelineResult, PipelineStatus, QuizAttempt, QuizQuestion, QuizStats } from "../types";

interface StoredData {
  summaries: Record<string, NoteSummary>;
  pipelineResults: PipelineResult[];
  pipelineStatuses: Record<string, PipelineStatus>;
  quizzes: Record<string, QuizQuestion[]>;
  quizAttempts: QuizAttempt[];
  learnedPaths: string[];
}

const EMPTY_DATA: StoredData = {
  summaries: {},
  pipelineResults: [],
  pipelineStatuses: {},
  quizzes: {},
  quizAttempts: [],
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
    this.data = {
      ...structuredClone(EMPTY_DATA),
      ...(raw && typeof raw === "object" ? raw : {})
    } as StoredData;
    this.data.summaries = Object.fromEntries(
      Object.entries(this.data.summaries).map(([path, summary]) => [
        path,
        normalizeSummary(summary)
      ])
    );
    delete (this.data as StoredData & { quizStats?: unknown }).quizStats;
  }

  async save(): Promise<void> {
    await this.host.saveData(this.data);
  }

  getSummary(path: string): NoteSummary | null {
    return this.data.summaries[path] ?? null;
  }

  async setSummary(summary: NoteSummary): Promise<void> {
    this.data.summaries[summary.filePath] = summary;
    await this.save();
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
    Object.keys(this.data.quizzes).forEach(collect);
    this.data.quizAttempts.forEach((attempt) => collect(attempt.notePath));
    this.data.learnedPaths.forEach(collect);
    this.data.pipelineResults.forEach((result) => {
      collect(result.sourcePath);
      collect(result.targetPath);
    });

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
      this.data.summaries[newPath] = { ...summary, filePath: newPath };
      delete this.data.summaries[oldPath];
      changed = true;
    }

    const pipelineStatus = this.data.pipelineStatuses[oldPath];
    if (pipelineStatus) {
      this.data.pipelineStatuses[newPath] = { ...pipelineStatus, path: newPath };
      delete this.data.pipelineStatuses[oldPath];
      changed = true;
    }

    const quizzes = this.data.quizzes[oldPath];
    if (quizzes) {
      this.data.quizzes[newPath] = quizzes.map((quiz) => ({ ...quiz, notePath: newPath }));
      delete this.data.quizzes[oldPath];
      changed = true;
    }

    this.data.quizAttempts = this.data.quizAttempts.map((attempt) => {
      if (attempt.notePath !== oldPath) return attempt;
      changed = true;
      return { ...attempt, notePath: newPath };
    });

    const learnedIndex = this.data.learnedPaths.indexOf(oldPath);
    if (learnedIndex >= 0) {
      this.data.learnedPaths[learnedIndex] = newPath;
      this.data.learnedPaths = Array.from(new Set(this.data.learnedPaths));
      changed = true;
    }

    this.data.pipelineResults = this.data.pipelineResults.map((result) => {
      const next = {
        ...result,
        sourcePath: result.sourcePath === oldPath ? newPath : result.sourcePath,
        targetPath: result.targetPath === oldPath ? newPath : result.targetPath
      };
      if (next.sourcePath !== result.sourcePath || next.targetPath !== result.targetPath) {
        changed = true;
      }
      return next;
    });

    return changed;
  }

  getQuizStats(path: string): QuizStats {
    return calculateQuizStats(this.getQuizzes(path), this.getQuizAttempts(path));
  }

  getQuizzes(path: string): QuizQuestion[] {
    return [...(this.data.quizzes[path] ?? [])];
  }

  async setQuizzes(path: string, questions: QuizQuestion[]): Promise<void> {
    this.data.quizzes[path] = questions.map((question) => ({ ...question, notePath: path }));
    await this.save();
  }

  getQuizAttempts(path: string): QuizAttempt[] {
    return this.data.quizAttempts.filter((attempt) => attempt.notePath === path);
  }

  async addQuizAttempt(attempt: QuizAttempt): Promise<void> {
    this.data.quizAttempts.unshift(attempt);
    await this.save();
  }

  getPipelineResults(): PipelineResult[] {
    return [...this.data.pipelineResults].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async addPipelineResult(result: PipelineResult): Promise<void> {
    this.data.pipelineResults = [result, ...this.data.pipelineResults].slice(0, 20);
    await this.save();
  }

  getPipelineStatus(path: string): PipelineStatus {
    return this.data.pipelineStatuses[path] ?? { path, status: "raw", updatedAt: "" };
  }

  async setPipelineStatus(status: PipelineStatus): Promise<void> {
    this.data.pipelineStatuses[status.path] = status;
    await this.save();
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

function normalizeSummary(summary: NoteSummary): NoteSummary {
  const recommendedAction: NoteSummary["recommendedAction"] =
    summary.recommendedAction
    ?? (summary.readingValue >= 4 ? "deep_learn" : summary.readingValue >= 3 ? "skim" : "skip");

  return {
    ...summary,
    briefDescription: summary.briefDescription ?? summary.summary.replace(/\s+/g, " ").slice(0, 160),
    recommendedAction,
    reason: summary.reason ?? "",
    tags: Array.isArray(summary.tags) ? summary.tags : []
  };
}

function calculateQuizStats(questions: QuizQuestion[], attempts: QuizAttempt[]): QuizStats {
  if (questions.length === 0) return { total: 0, accuracy: null, wrong: 0 };
  const latestByQuiz = new Map<string, QuizAttempt>();
  for (const attempt of attempts) {
    if (!latestByQuiz.has(attempt.quizId)) {
      latestByQuiz.set(attempt.quizId, attempt);
    }
  }

  const answered = questions
    .map((question) => latestByQuiz.get(question.id))
    .filter((attempt): attempt is QuizAttempt => Boolean(attempt));
  if (answered.length === 0) return { total: questions.length, accuracy: null, wrong: 0 };

  const correct = answered.filter((attempt) => attempt.correct).length;
  return {
    total: questions.length,
    accuracy: Math.round((correct / answered.length) * 100),
    wrong: answered.length - correct
  };
}
