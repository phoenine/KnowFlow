import { Notice, TFile, normalizePath } from "obsidian";
import type { App } from "obsidian";
import type { KnowFlowSettings } from "../types";
import type { AiService } from "./ai-service";
import { removeCodeWatermarkLines } from "./cleanup-rules";
import {
  applyFormattingDecisions,
  cleanHeadingNumberNoise,
  collectCodeCandidates,
  collectHeadingCandidates,
  normalizeOrphanBoldTriplet,
  stripSequentialLineNumbers,
  type FormattingCandidate
} from "./formatting-candidates";
import { applyArticleFrontmatter, updateFrontmatterCategory } from "./frontmatter-rules";
import { loadUserSkillFile, loadSkill } from "./repair-skill";
import { validateMarkdownIntegrity } from "./repair-validator";
import { KnowledgeStore } from "./store";
import {
  applyTranslationDecisions,
  collectTranslationCandidates,
  isPredominantlyEnglishArticle
} from "./translation-candidates";

export const ARTICLE_CATEGORIES = [
  "人工智能",
  "知识积累",
  "操作系统",
  "常用工具",
  "算法分析",
  "系统架构",
  "编程语法",
  "项目管理",
  "工作相关",
  "奇思妙想",
  "论文相关",
  "休闲时光"
];

export class ClippingPipeline {
  constructor(
    private app: App,
    private settings: KnowFlowSettings,
    private store: KnowledgeStore,
    private ai: AiService
  ) {}

  updateSettings(settings: KnowFlowSettings): void {
    this.settings = settings;
  }

  async process(
    file: TFile,
    onProgress?: (step: string, status: "active" | "completed" | "skipped") => void
  ): Promise<void> {
    const report = async (
      step: string,
      status: "active" | "completed" | "skipped" = "active"
    ): Promise<void> => {
      onProgress?.(step, status);
      await Promise.resolve();
    };

    try {
      await report("整理 Markdown 样式");
      const original = await this.app.vault.read(file);
      const title = file.basename;
      let formatted = this.stripFrontmatterBody(original);
      this.assertReadableBody(formatted);

      // Phase 1: 规则清理
      formatted = normalizeOrphanBoldTriplet(formatted);
      formatted = this.organizeMarkdownStyle(formatted);

      // Load Clipping Repair Skill (builtin + user vault override) before any LLM call
      const userSkill = await loadUserSkillFile(this.app.vault.adapter);
      this.ai.setSkill(loadSkill(userSkill ?? undefined));

      // Phase 2: 代码格式化（规则，先跑，把代码块结构定下来）
      await report("格式化代码块");
      formatted = this.formatCodeBlocks(formatted);

      // Phase 3: 代码收集（置信度分级）→ HIGH 自动包围栏 / MEDIUM 送 LLM
      const codeResult = collectCodeCandidates(formatted);
      const highConfidence = codeResult.possibleCode.filter((c) => c.autoLanguage);
      const mediumConfidence = codeResult.possibleCode.filter((c) => !c.autoLanguage);
      const hasMediumCode = mediumConfidence.length > 0;
      const hasFencedCode = codeResult.fencedCode.length > 0;

      // HIGH: 直接包围栏，不走 LLM
      if (highConfidence.length > 0) {
        formatted = this.applyAutoCodeWraps(formatted, highConfidence);
      }

      if (!hasMediumCode) await report("AI 判断未围栏代码", "skipped");
      if (!hasFencedCode) await report("AI 判断代码语言", "skipped");

      if (hasMediumCode || hasFencedCode) {
        await report(hasMediumCode ? "AI 判断未围栏代码" : "AI 判断代码语言");
        const [codeDecisions, fencedDecisions] = await Promise.all([
          hasMediumCode
            ? this.ai.analyzePossibleCodeCandidates(title, mediumConfidence)
            : Promise.resolve([]),
          hasFencedCode
            ? this.ai.analyzeFencedCodeCandidates(title, codeResult.fencedCode)
            : Promise.resolve([])
        ]);
        if (hasMediumCode) {
          formatted = applyFormattingDecisions(formatted, mediumConfidence, codeDecisions);
        }
        if (hasFencedCode) {
          formatted = applyFormattingDecisions(formatted, codeResult.fencedCode, fencedDecisions);
        }
        if (hasMediumCode) await report("AI 判断未围栏代码", "completed");
        if (hasFencedCode) await report("AI 判断代码语言", "completed");
      }

      // Phase 4: 标题 LLM（放在代码整理之后，候选质量更高）
      await report("AI 判断标题");
      const headingCandidates = collectHeadingCandidates(formatted);
      if (headingCandidates.length > 0) {
        const headingDecisions = await this.ai.analyzeHeadingCandidates(title, headingCandidates);
        formatted = applyFormattingDecisions(formatted, headingCandidates, headingDecisions);
      }
      formatted = this.normalizeHeadingLevels(formatted);

      // Phase 6: 英文翻译
      await report("英文翻译（可选）");
      if (this.settings.translateEnglishClippings && isPredominantlyEnglishArticle(formatted)) {
        const translationCandidates = collectTranslationCandidates(formatted);
        const translations = await this.ai.translateEnglishParagraphs(title, translationCandidates);
        formatted = applyTranslationDecisions(formatted, translationCandidates, translations);
      }

      // Phase 7: 验证 + 写入
      await report("补全 Frontmatter");
      const normalized = this.normalizeFinalBody(formatted);
      const withFrontmatter = await this.applyFrontmatter(normalized, original, { title });

      const current = await this.app.vault.read(file);
      if (current !== original) {
        throw new Error("文章在修复期间被用户修改，请重新执行。");
      }

      const integrity = validateMarkdownIntegrity(withFrontmatter);
      if (!integrity.valid) {
        throw new Error(`修复后 Markdown 结构异常：${integrity.error}`);
      }

      await this.app.vault.modify(file, withFrontmatter);

      await this.store.recordPipelineSuccess({
        path: file.path,
        status: "processed",
        updatedAt: new Date().toISOString()
      });
      new Notice("KnowFlow: clipping formatted");
    } catch (error) {
      await this.store.setPipelineStatus({
        path: file.path,
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async moveToCategory(file: TFile, category: string): Promise<TFile> {
    const targetFolder = normalizePath(`${this.settings.articlesFolder}/${category}`);
    await this.ensureCategoryFolder(targetFolder, category);

    const oldPath = file.path;
    const targetPath = normalizePath(`${targetFolder}/${file.name}`);
    const content = await this.app.vault.read(file);
    await this.app.vault.modify(file, this.updateFrontmatterCategory(content, category));

    if (oldPath !== targetPath) {
      await this.app.fileManager.renameFile(file, targetPath);
    }

    const moved = this.app.vault.getAbstractFileByPath(targetPath);
    const movedFile = moved instanceof TFile ? moved : file;

    await this.store.recordCategoryMove({ oldPath, newPath: movedFile.path });
    new Notice(`KnowFlow: moved to ${category}`);
    return movedFile;
  }

  private async ensureCategoryFolder(targetFolder: string, category: string): Promise<void> {
    if (await this.app.vault.adapter.exists(targetFolder)) return;
    if (!this.settings.autoCreateCategoryFolders && !ARTICLE_CATEGORIES.includes(category)) {
      throw new Error(`目标分类目录不存在：${targetFolder}`);
    }
    await this.app.vault.createFolder(targetFolder);
  }

  private stripFrontmatterBody(content: string): string {
    return content.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "");
  }

  private assertReadableBody(body: string): void {
    const visibleText = body
      .replace(/!\[\[.*?\]\]/g, "")
      .replace(/!\[.*?\]\(.*?\)/g, "")
      .replace(/[#>*_\-\s`=[\]()]/g, "")
      .trim();
    if (visibleText.length < 20) {
      throw new Error("当前剪藏正文过短，可能是 Web Clipper 只保存了 Frontmatter。");
    }
  }

  private organizeMarkdownStyle(content: string): string {
    const noNbsp = stripOrphanBoldDelimiters(content)
      .replace(/\u00a0/g, " ")
      .replace(/(^|\n)\s*\*\*\s*(\n|$)/g, "$1$2");  // remove standalone ** lines
    return mapLinesOutsideCode(noNbsp, (line) => {
      let next = normalizeListIndent(line)
        .replace(/\t/g, "  ")
        .replace(/^(\s*)•\s+/g, "$1- ")
        .replace(/\*\*\*\*([^*\n]+)\*\*\*\*/g, "**$1**")
        .replace(/\*\*(.+?)\*\*\*\*/g, "**$1**")
        .replace(/\*\*\*\*(.+?)\*\*/g, "**$1**")
        .replace(/[ \t]+$/g, "");
      // Clean trailing ** from heading lines (orphan bold artifact)
      next = next.replace(/^(#{1,6}\s+.*?)\s*\*\*\s*$/g, "$1");
      // Clean pure-number heading noise: "## 1. 01" → "## "
      next = next.replace(/^(#{1,6})\s+\d+[.\、\)]\s*\d*\s*$/g, "$1 ");
      // Strip redundant Chinese numbering after heading prefix: "## 1. 一、xxx" → "## 1. xxx"
      next = next.replace(/^(#{1,6}\s+\d+[.\、\)]\s*)[一二三四五六七八九十]+[、.]\s*/g, "$1");
      next = next.replace(/^(\s*)(\d+)[、)]\s+/g, "$1$2. ");
      next = next.replace(/^(\s*)([一二三四五六七八九十]+)([、.])\s+/g, (_m, sp, num, sep) =>
        `${sp}${chineseToArabic(num)}. `);
      next = next.replace(/^\s+\|(\s*:?-{3,}:?\s*\|.*)$/g, "|$1");
      return next;
    });
  }

  private formatCodeBlocks(content: string): string {
    return removeCodeWatermarkLines(content).replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, rawLang: string, rawBody: string) => {
      const body = stripSequentialLineNumbers(rawBody
        .replace(/^\s*(体验AI代码助手|代码解读复制代码)\s*$/gm, "")
        .replace(/体验AI代码助手\s*代码解读复制代码/g, "")
        .replace(/^\s*(In \[\d+\]:|Out\[\d+\]:)\s*$/gm, "")
        .replace(/[ \t]+$/gm, ""));
      const lang = normalizeCodeLanguage(rawLang, body);
      return `\`\`\`${lang}\n${body.trim()}\n\`\`\``;
    });
  }

  /** Auto-wrap HIGH-confidence code candidates with their detected language fence. */
  private applyAutoCodeWraps(content: string, candidates: FormattingCandidate[]): string {
    const lines = content.split("\n");
    // Process bottom-up
    const sorted = [...candidates].sort((a, b) => b.startLine - a.startLine);
    for (const candidate of sorted) {
      if (!candidate.autoLanguage) continue;
      const current = lines.slice(candidate.startLine, candidate.endLine + 1).join("\n");
      if (current !== candidate.content) continue;
      lines.splice(candidate.startLine, candidate.endLine - candidate.startLine + 1,
        `\`\`\`${candidate.autoLanguage}`, current, "```");
    }
    return lines.join("\n");
  }

  /**
   * Normalize heading levels so the shallowest body heading is H2.
   * Article title is the implicit H1 — body headings must start at ##.
   * # → ## (demote), ### → ## (promote), H2 → unchanged.
   */
  private normalizeHeadingLevels(content: string): string {
    const lines = content.split("\n");
    let minLevel = 6;
    for (const line of lines) {
      const match = /^(#{1,6})\s/.exec(line);
      if (match) minLevel = Math.min(minLevel, match[1].length);
    }
    // Already H2 — no shift needed
    if (minLevel === 2) return content;
    // shift > 0: promote (H3+ → H2+); shift < 0: demote (H1 → H2+)
    const shift = minLevel - 2;
    return lines.map((line) => {
      const match = /^(#{1,6})\s/.exec(line);
      if (!match) return line;
      const newLevel = Math.max(2, Math.min(6, match[1].length - shift));
      return `${"#".repeat(newLevel)}${line.slice(match[1].length)}`;
    }).join("\n");
  }

  private normalizeFinalBody(content: string): string {
    return content
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n";
  }

  private async applyFrontmatter(
    content: string,
    originalContent: string,
    data: { title: string }
  ): Promise<string> {
    const today = window.moment().format("YYYY-MM-DD");
    const template = await this.readTemplateFrontmatter();
    return applyArticleFrontmatter(content, originalContent, template, { ...data, today });
  }

  private async readTemplateFrontmatter(): Promise<string> {
    const path = normalizePath(this.settings.templatePath);
    if (!path || !(await this.app.vault.adapter.exists(path))) return "";
    return this.app.vault.adapter.read(path);
  }

  private updateFrontmatterCategory(content: string, category: string): string {
    return updateFrontmatterCategory(content, category);
  }
}

function mapLinesOutsideCode(content: string, mapper: (line: string) => string): string {
  let inCode = false;
  return content
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inCode = !inCode;
        return line.trimEnd();
      }
      return inCode ? line : mapper(line);
    })
    .join("\n");
}

function normalizeListIndent(line: string): string {
  const match = /^(\s+)([-*+]|\d+\.)\s+/.exec(line);
  if (!match) return line;
  const spaces = match[1].length;
  if (spaces % 2 === 0) return line;
  return `${" ".repeat(spaces - 1)}${line.slice(spaces)}`;
}

function stripOrphanBoldDelimiters(content: string): string {
  return content.replace(
    /(^|\n)[ \t]*\*\*[ \t]*\n+([^\n*][^\n]*?)\n+[ \t]*\*\*[ \t]*(?=\n|$)/g,
    (_match, prefix: string, title: string) => `${prefix}**${title.trim()}**`
  );
}

function normalizeCodeLanguage(rawLang: string, body: string): string {
  const raw = rawLang.trim();
  const lang = /^(体验AI代码助手|代码解读|复制代码)/.test(raw)
    ? ""
    : raw.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (lang && lang !== "plain" && lang !== "text") return lang;

  const sample = body.trimStart();
  if (/^(import|from|def|class|@[\w.]+|if __name__)/m.test(sample)) return "python";
  if (/^(const|let|var|import .* from|export |function|async function)/m.test(sample)) return "typescript";
  if (/^\s*[{[]/.test(sample)) return "json";
  if (/^(curl|sudo|git|npm|pnpm|yarn|docker|kubectl|cd|mkdir|chmod)\b/m.test(sample)) return "bash";
  if (/^(select|with|insert|update|delete|create table)\b/im.test(sample)) return "sql";
  if (/^<[\w!?]/.test(sample)) return "html";
  return lang || "";
}

const CHINESE_DIGITS: Record<string, number> = {
  "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
  "六": 6, "七": 7, "八": 8, "九": 9, "十": 10
};

function chineseToArabic(chinese: string): string {
  if (chinese === "十") return "10";
  if (chinese.startsWith("十")) return String(10 + (CHINESE_DIGITS[chinese[1]] ?? 0));
  if (chinese.endsWith("十")) return String((CHINESE_DIGITS[chinese[0]] ?? 0) * 10);
  if (chinese.includes("十")) {
    const [tens, ones] = chinese.split("十");
    return String((CHINESE_DIGITS[tens] ?? 0) * 10 + (CHINESE_DIGITS[ones] ?? 0));
  }
  return String(CHINESE_DIGITS[chinese] ?? chinese);
}
