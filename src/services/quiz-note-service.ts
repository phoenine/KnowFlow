import { TFile, normalizePath } from "obsidian";
import type { App } from "obsidian";
import type { KnowFlowSettings, QuizQuestion, QuizStats } from "../types";
import { applyQuizAnswer, buildQuizNoteContent, computeQuizStats, parseQuizCallout, parseQuizNote, sanitizeQuizFileName, setExamPassed, updateQuizSourcePath, upsertQuizCallout } from "./quiz-notes";

/**
 * Bridges the pure quiz-notes.ts markdown logic with the vault: creates/
 * updates quiz notes under settings.archiveFolder. The source article's
 * managed Quiz callout is the only index pointing back to its quiz note.
 */
export class QuizNoteService {
  constructor(
    private app: App,
    private settings: KnowFlowSettings
  ) {}

  updateSettings(settings: KnowFlowSettings): void {
    this.settings = settings;
  }

  async saveQuiz(sourceFile: TFile, category: string, questions: QuizQuestion[]): Promise<string> {
    await this.ensureArchiveFolder();
    const sourceContent = await this.app.vault.read(sourceFile);
    const existingPath = parseQuizCallout(sourceContent);
    const quizPath = existingPath && await this.app.vault.adapter.exists(existingPath)
      ? existingPath
      : await this.resolveNewQuizPath(sourceFile.basename, new Date());

    const content = buildQuizNoteContent(
      { sourcePath: sourceFile.path, category, createdAt: new Date().toISOString() },
      questions
    );

    const existingFile = this.app.vault.getAbstractFileByPath(quizPath);
    if (existingFile instanceof TFile) {
      await this.app.vault.modify(existingFile, content);
    } else {
      await this.app.vault.create(quizPath, content);
    }

    const nextSourceContent = upsertQuizCallout(sourceContent, quizPath);
    if (nextSourceContent !== sourceContent) {
      await this.app.vault.modify(sourceFile, nextSourceContent);
    }
    return quizPath;
  }

  async loadQuestions(notePath: string): Promise<{ quizPath: string; questions: QuizQuestion[] } | null> {
    const quizPath = await this.resolveQuizPath(notePath);
    if (!quizPath) return null;
    const file = this.app.vault.getAbstractFileByPath(quizPath);
    if (!(file instanceof TFile)) return null;
    const content = await this.app.vault.read(file);
    const questions = parseQuizNote(content, notePath);
    return questions.length > 0 ? { quizPath, questions } : null;
  }

  async getStats(notePath: string): Promise<QuizStats> {
    const empty: QuizStats = { total: 0, answered: 0, accuracy: null, wrong: 0 };
    const quizPath = await this.resolveQuizPath(notePath);
    if (!quizPath) return empty;
    const file = this.app.vault.getAbstractFileByPath(quizPath);
    if (!(file instanceof TFile)) return empty;
    const content = await this.app.vault.read(file);
    return computeQuizStats(content);
  }

  async updateSourcePath(newPath: string): Promise<void> {
    const quizPath = await this.resolveQuizPath(newPath);
    if (!quizPath) return;
    await this.updateQuizSourceLink(quizPath, newPath);
  }

  async updateSourceFolder(newFolder: string): Promise<void> {
    const prefix = `${newFolder}/`;
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(prefix));
    await Promise.all(files.map((file) => this.updateSourcePath(file.path)));
  }

  /** `displayIndex` is 1-based, matching the question's position in the session. Returns whether the answer was correct. */
  async recordAnswer(quizPath: string, displayIndex: number, selectedKey: string, correctAnswerKey: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(quizPath);
    if (!(file instanceof TFile)) throw new Error(`Quiz note not found: ${quizPath}`);
    const content = await this.app.vault.read(file);
    const correct = selectedKey === correctAnswerKey;
    const date = new Date().toISOString().slice(0, 10);
    const patched = applyQuizAnswer(content, displayIndex, selectedKey, correct, date);
    // "考试结果" mirrors the study-quiz convention: true once every question
    // in the note has been answered and every answer is currently correct.
    const stats = computeQuizStats(patched);
    const passed = stats.total > 0 && stats.answered === stats.total && stats.wrong === 0;
    await this.app.vault.modify(file, setExamPassed(patched, passed));
    return correct;
  }

  private async resolveNewQuizPath(title: string, date: Date): Promise<string> {
    const base = sanitizeQuizFileName(title);
    const folder = this.archiveFolder();
    const datePrefix = date.toISOString().slice(0, 10);
    let candidate = normalizePath(`${folder}/${datePrefix}_${base}_Quiz.md`);
    let suffix = 2;
    while (await this.app.vault.adapter.exists(candidate)) {
      candidate = normalizePath(`${folder}/${datePrefix}_${base}_Quiz ${suffix}.md`);
      suffix += 1;
    }
    return candidate;
  }

  private async ensureArchiveFolder(): Promise<void> {
    const folder = normalizePath(this.archiveFolder());
    if (await this.app.vault.adapter.exists(folder)) return;
    await this.app.vault.createFolder(folder);
  }

  private async updateQuizSourceLink(quizPath: string, sourcePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(quizPath);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const next = updateQuizSourcePath(content, sourcePath);
    if (next !== content) {
      await this.app.vault.modify(file, next);
    }
  }

  private async resolveQuizPath(sourcePath: string): Promise<string | null> {
    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(sourceFile instanceof TFile)) return null;
    const sourceContent = await this.app.vault.read(sourceFile);
    return parseQuizCallout(sourceContent);
  }

  private archiveFolder(): string {
    return this.settings.archiveFolder || "Archives";
  }
}
