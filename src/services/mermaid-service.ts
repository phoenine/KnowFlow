import { Notice, TFile } from "obsidian";
import type { App } from "obsidian";

export class MermaidService {
  constructor(private app: App) {}

  async generateForFile(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file);
    const mermaid = this.buildMindmap(file.basename, content);
    const nextContent = upsertKnowledgeMap(content, mermaid);
    await this.app.vault.modify(file, nextContent);
    new Notice("KnowFlow: Mermaid knowledge map inserted");
  }

  buildMindmap(title: string, content: string): string {
    const headings = extractHeadings(content);
    const root = escapeMermaidText(title);
    const lines = ["mindmap", `  root((${root}))`];

    if (headings.length === 0) {
      lines.push("    核心主题");
      lines.push("    关键概念");
      lines.push("    实践价值");
      return lines.join("\n");
    }

    for (const heading of headings.slice(0, 10)) {
      const indent = "  ".repeat(Math.min(heading.level, 4));
      lines.push(`${indent}${escapeMermaidText(heading.text)}`);
    }

    return lines.join("\n");
  }
}

function upsertKnowledgeMap(content: string, mermaid: string): string {
  const block = `## Knowledge Map\n\n\`\`\`mermaid\n${mermaid}\n\`\`\``;
  const normalized = content.trimEnd();
  const sectionPattern = /^## Knowledge Map\n[\s\S]*?(?=^##\s|(?![\s\S]))/m;

  if (sectionPattern.test(normalized)) {
    return `${normalized.replace(sectionPattern, block)}\n`;
  }

  return `${normalized}\n\n${block}\n`;
}

function extractHeadings(content: string): Array<{ level: number; text: string }> {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const headings: Array<{ level: number; text: string }> = [];

  for (const line of body.split("\n")) {
    const match = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const text = match[2]
      .replace(/[#*_`[\]]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || /^knowledge map$/i.test(text)) continue;
    headings.push({ level: match[1].length, text: text.slice(0, 28) });
  }

  return headings;
}

function escapeMermaidText(value: string): string {
  return value
    .replace(/[(){}[\]"'`]/g, "")
    .replace(/[:|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32) || "Untitled";
}
