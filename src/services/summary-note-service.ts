import { TFile } from "obsidian";
import type { App } from "obsidian";
import { applySummaryFrontmatter, type SummaryFrontmatterData } from "./frontmatter-rules";
import { parseSummaryCallout, upsertSummaryCallout, type SummaryText } from "./summary-notes";

/**
 * Bridges the pure summary-notes.ts/frontmatter-rules.ts markdown logic
 * with the vault. Unlike quizzes, a summary is written straight into the
 * source note's own body (as a collapsed callout) and frontmatter rather
 * than a separate note, so there's no index to maintain — the note itself
 * is the only thing to look up.
 */
export class SummaryNoteService {
  constructor(private app: App) {}

  /**
   * `meta` is omitted only by the one-off legacy-text migration in
   * main.ts, which has summary/reason text to relocate but not the
   * structured fields to backfill into frontmatter.
   */
  async applySummary(file: TFile, text: SummaryText, meta?: SummaryFrontmatterData): Promise<void> {
    const content = await this.app.vault.read(file);
    const withFrontmatter = meta ? applySummaryFrontmatter(content, meta) : content;
    const next = upsertSummaryCallout(withFrontmatter, text);
    if (next !== content) {
      await this.app.vault.modify(file, next);
    }
  }

  async loadSummaryText(file: TFile): Promise<SummaryText | null> {
    const content = await this.app.vault.read(file);
    return parseSummaryCallout(content);
  }
}
