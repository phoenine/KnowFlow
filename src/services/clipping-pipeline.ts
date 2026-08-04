import { Notice, TFile, normalizePath } from "obsidian";
import type { App } from "obsidian";
import type { KnowFlowSettings } from "../types";
import type { AiService } from "./ai-service";
import { cleanupPromotionalNoise } from "./cleanup-rules";
import { applyArticleFrontmatter, updateFrontmatterCategory } from "./frontmatter-rules";
import { KnowledgeStore } from "./store";

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

  async process(file: TFile, onProgress?: (step: string) => void): Promise<void> {
    const report = async (step: string): Promise<void> => {
      onProgress?.(step);
      await Promise.resolve();
    };

    try {
      await report("清理残留格式");
      const original = await this.app.vault.read(file);
      const title = file.basename;
      let formatted = this.stripFrontmatterBody(original);
      this.assertReadableBody(formatted);

      formatted = this.cleanResidualFormat(formatted);
      await report("整理 Markdown 样式");
      formatted = this.organizeMarkdownStyle(formatted);
      await report("编辑章节结构");
      formatted = this.editSectionStructure(formatted);
      await report("格式化代码块");
      formatted = this.formatCodeBlocks(formatted);
      await report("转换公式");
      formatted = this.convertFormulaMarkup(formatted);
      await report("去除广告、二维码和页脚");
      formatted = this.removePromotionalNoise(formatted);
      await report("AI 优化 Markdown");
      formatted = await this.ai.polishClippingMarkdown(title, formatted);
      const normalized = this.normalizeFinalBody(formatted);
      await report("补全 Frontmatter");
      const withFrontmatter = await this.applyFrontmatter(normalized, original, { title });

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

  private cleanResidualFormat(content: string): string {
    const fixedLinks = fixSwallowedUrlPunctuation(stripOrphanBoldDelimiters(content).replace(/\u00a0/g, " "));
    return mapLinesOutsideCode(fixedLinks, (line) =>
      normalizeListIndent(line)
        .replace(/\t/g, "  ")
        .replace(/^(\s*)•\s+/g, "$1- ")
        .replace(/\\([_\[\]*#-])/g, "$1")
        .replace(/\\\./g, ".")
        .replace(/\[==([^=\]]+)==\]\(([^)]+)\)/g, "[$1]($2)")
        .replace(/(^|[^=])==([^=\n]+)==([^=]|$)/g, "$1$2$3")
        .replace(/\*\*\*\*([^*\n]+)\*\*\*\*/g, "**$1**")
        .replace(/\*\*(.+?)\*\*\*\*/g, "**$1**")
        .replace(/\*\*\*\*(.+?)\*\*/g, "**$1**")
        .replace(/[ \t]+$/g, "")
    );
  }

  private organizeMarkdownStyle(content: string): string {
    return mapLinesOutsideCode(content, (line) => {
      let next = line.replace(/^(\s*)(\d+)[、)]\s+/g, "$1$2. ");
      next = next.replace(/^(#{1,6})\s+\*\*(.+?)\*\*\s*$/g, "$1 $2");
      next = next.replace(/^(#{1,6})\s+\d+(?:\.\d+)*\.\s+/g, "$1 ");
      next = next.replace(/^(#{1,6})\s+(.+?)\\\./g, "$1 $2.");
      next = next.replace(/^\s+\|(\s*:?-{3,}:?\s*\|.*)$/g, "|$1");

      const h1 = /^#\s+(.+)$/.exec(next);
      if (h1 && !looksLikeShellCommand(h1[1])) {
        next = `## ${h1[1].trim()}`;
      }

      const deepHeading = /^(#{4,6})\s+(.+)$/.exec(next);
      if (deepHeading) {
        const text = deepHeading[2].trim();
        if (/^[一二三四五六七八九十]+[、，]/.test(text)) return `## ${text}`;
        if (/[。！？？，]$/.test(text)) return `**${text}**`;
        return `### ${text}`;
      }

      return next;
    });
  }

  private editSectionStructure(content: string): string {
    const lines = renumberOrderedLists(formatAuthorMetadata(content)).split("\n");
    const result: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      const next = lines[index + 1]?.trim() ?? "";
      const afterBlank = lines[index + 2]?.trim() ?? "";

      const numberedBold = /^(\d{1,2})$/.exec(trimmed);
      const boldTitle = /^\*\*(.+?)\*\*$/.exec(next);
      if (numberedBold && boldTitle && isLikelyHeadingText(boldTitle[1])) {
        result.push(`## ${numberedBold[1]}. ${boldTitle[1].trim()}`);
        index += 1;
        continue;
      }

      const numberedPlain = /^(\d{1,2})$/.exec(trimmed);
      if (numberedPlain && !next && afterBlank && isLikelyHeadingText(afterBlank)) {
        result.push(`## ${numberedPlain[1]}. ${unwrapBold(afterBlank)}`);
        index += 2;
        continue;
      }

      const chineseHeading = /^([一二三四五六七八九十]+[、，].+)$/.exec(trimmed);
      if (chineseHeading && isLikelyHeadingText(chineseHeading[1])) {
        result.push(`## ${chineseHeading[1]}`);
        continue;
      }

      const standaloneBold = /^\*\*(.+?)\*\*$/.exec(trimmed);
      if (standaloneBold && isLikelyHeadingText(standaloneBold[1]) && !isFooterText(standaloneBold[1])) {
        result.push(`### ${standaloneBold[1].trim()}`);
        continue;
      }

      result.push(line);
    }

    return result.join("\n");
  }

  private formatCodeBlocks(content: string): string {
    const fenced = convertBlockquoteCodeBlocks(content);
    return fenced.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, rawLang: string, rawBody: string) => {
      const lang = normalizeCodeLanguage(rawLang, rawBody);
      const body = rawBody
        .replace(/^\s*(体验AI代码助手|代码解读复制代码|复制代码)\s*$/gm, "")
        .replace(/体验AI代码助手\s*代码解读复制代码/g, "")
        .replace(/^\s*(In \[\d+\]:|Out\[\d+\]:)\s*$/gm, "")
        .replace(/\\`/g, "`")
        .replace(/\\#/g, "#")
        .replace(/\\\[/g, "[")
        .replace(/\\\]/g, "]")
        .replace(/[ \t]+$/gm, "");
      return `\`\`\`${lang}\n${unboldCodeKeywords(unsquishCodeBlock(body)).trim()}\n\`\`\``;
    });
  }

  private convertFormulaMarkup(content: string): string {
    return mapLinesOutsideCode(content, (line) =>
      line
        .replace(/\\\[/g, "$$")
        .replace(/\\\]/g, "$$")
        .replace(/\\\(/g, "$")
        .replace(/\\\)/g, "$")
    ).replace(/\n{3,}/g, "\n\n");
  }

  private removePromotionalNoise(content: string): string {
    return cleanupPromotionalNoise(content);
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

function fixSwallowedUrlPunctuation(content: string): string {
  return content
    .replace(/\[([^\]\s]+?)。\]\(([^)]+?)%E3%80%82\)/g, "[$1]($2)。")
    .replace(/\[([^\]\s]+?)）。\]\(([^)]+?)%EF%BC%89%E3%80%82\)/g, "[$1]($2)。")
    .replace(/（\[([^\]]+?)\]\(([^)]+?)%EF%BC%89\)）/g, "（[$1]($2)）");
}

function stripOrphanBoldDelimiters(content: string): string {
  return content.replace(
    /(^|\n)[ \t]*\*\*[ \t]*\n+([^\n*][^\n]*?)\n+[ \t]*\*\*[ \t]*(?=\n|$)/g,
    (_match, prefix: string, title: string) => `${prefix}**${title.trim()}**`
  );
}

function formatAuthorMetadata(content: string): string {
  return mapLinesOutsideCode(content, (line) => {
    const trimmed = line.trim();
    if (/^(作者|审校|编辑|编译|策划)\s*[|｜]\s+.+/.test(trimmed) && !trimmed.startsWith("*")) {
      return line.replace(trimmed, `*${trimmed}*`);
    }
    return line;
  });
}

function renumberOrderedLists(content: string): string {
  let inCode = false;
  let counter = 1;
  return content
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inCode = !inCode;
        counter = 1;
        return line;
      }
      if (inCode) return line;

      const match = /^(\s*)1\.\s+(.+)$/.exec(line);
      if (!match) {
        if (line.trim() && !/^\s{2,}\S/.test(line)) counter = 1;
        return line;
      }
      const next = `${match[1]}${counter}. ${match[2]}`;
      counter += 1;
      return next;
    })
    .join("\n");
}

function convertBlockquoteCodeBlocks(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim().startsWith(">")) {
      result.push(lines[index]);
      index += 1;
      continue;
    }

    const block: string[] = [];
    let cursor = index;
    while (cursor < lines.length && (lines[cursor].trim().startsWith(">") || lines[cursor].trim() === "")) {
      const stripped = lines[cursor].replace(/^\s*>\s?/, "");
      block.push(stripped);
      cursor += 1;
    }

    if (isLikelyCodeBlock(block)) {
      const body = block.join("\n").replace(/\*\*(def|class|for|if|elif|else|self|return|True|False|None|in|not|or|and|int|float|str)\*\*/g, "$1");
      result.push(`\`\`\`${normalizeCodeLanguage("", body)}`);
      result.push(body.trim());
      result.push("```");
    } else {
      result.push(...lines.slice(index, cursor));
    }
    index = cursor;
  }

  return result.join("\n");
}

function isLikelyCodeBlock(lines: string[]): boolean {
  const body = lines.join("\n").trim();
  if (body.length < 20) return false;
  return /^(def |class |import |from |for |if |return |const |let |var |function |async |curl |sudo |git |npm |docker |kubectl |\{|\[)/m.test(body)
    || /;\s*$/.test(body)
    || /[{}]\s*$/.test(body);
}

function unboldCodeKeywords(body: string): string {
  return body.replace(/\*\*(def|class|for|if|elif|else|self|return|True|False|None|in|not|or|and|int|float|str|import|from)\*\*/g, "$1");
}

function looksLikeShellCommand(text: string): boolean {
  const command = text.trim().split(/\s+/)[0] ?? "";
  return [
    "mount",
    "mkdir",
    "cd",
    "make",
    "apt",
    "yum",
    "pip",
    "git",
    "sudo",
    "ls",
    "cat",
    "rm",
    "cp",
    "mv",
    "echo",
    "chmod",
    "./"
  ].includes(command) || text.trim().startsWith("/");
}

function isLikelyHeadingText(text: string): boolean {
  const value = text.replace(/\*\*/g, "").trim();
  if (!value || value.length > 70) return false;
  if (/^[,，。！？；;：:、]+$/.test(value)) return false;
  if (/[。！？]$/.test(value) && value.length > 18) return false;
  if (/^https?:\/\//i.test(value)) return false;
  return true;
}

function unwrapBold(text: string): string {
  return text.replace(/^\*\*(.+?)\*\*$/g, "$1").trim();
}

function isFooterText(text: string): boolean {
  return /(球分享|球点赞|球在看|继续滑动看下一个|向上滑动看下一个|阅读原文|二维码|关注公众号)/.test(text);
}

function normalizeCodeLanguage(rawLang: string, body: string): string {
  const lang = rawLang.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
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

function unsquishCodeBlock(body: string): string {
  if (!body.split("\n").some((line) => line.length > 180)) return body;
  if (/\\".*\\".*\\"/.test(body) || /[┌└│←→]/.test(body)) return body;

  return body
    .replace(/(?<!\n)(---)/g, "\n$1")
    .replace(/(?<!\n)(###?\s+)/g, "\n$1")
    .replace(/(?<!\n)(\*\*[^*\n]{2,60}\*\*)/g, "\n$1")
    .replace(/([^\n])(\d+\.\s+)/g, "$1\n$2")
    .replace(/([^\n])(-\s+)/g, "$1\n$2")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
}
