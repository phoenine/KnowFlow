export type BlockType =
  | "heading"
  | "paragraph"
  | "code"
  | "callout"
  | "table"
  | "math"
  | "list"
  | "quote"
  | "thematic-break"
  | "empty";

export interface MarkdownBlock {
  type: BlockType;
  startLine: number;   // 0-indexed, inclusive
  endLine: number;     // 0-indexed, inclusive
  lines: string[];
  parentType?: BlockType;
  metadata?: {
    level?: number;
    language?: string;
    calloutType?: string;
    foldState?: "+" | "-";
    listMarker?: string;
  };
}

export function parseBlocks(content: string): MarkdownBlock[] {
  const lines = content.split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    // Empty
    if (!trimmed) {
      const start = index;
      while (index < lines.length && !lines[index].trim()) index += 1;
      blocks.push({ type: "empty", startLine: start, endLine: index - 1, lines: lines.slice(start, index) });
      continue;
    }

    // Heading
    const headingMatch = /^(#{1,6})\s+(.+)/.exec(trimmed);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        startLine: index,
        endLine: index,
        lines: [line],
        metadata: { level: headingMatch[1].length }
      });
      index += 1;
      continue;
    }

    // Thematic break
    if (/^(-{3,}|\*{3,})\s*$/.test(trimmed)) {
      blocks.push({ type: "thematic-break", startLine: index, endLine: index, lines: [line] });
      index += 1;
      continue;
    }

    // Code fence
    if (/^\s*```/.test(trimmed)) {
      const openLine = trimmed.replace(/^\s*```/, "");
      const language = openLine.trim();
      const start = index;
      index += 1;
      const codeLines = [line];
      while (index < lines.length) {
        codeLines.push(lines[index]);
        if (/^\s*```/.test(lines[index].trim())) {
          index += 1;
          break;
        }
        index += 1;
      }
      blocks.push({
        type: "code",
        startLine: start,
        endLine: index - 1,
        lines: codeLines,
        metadata: { language: language || undefined }
      });
      continue;
    }

    // Math block
    if (/^\$\$/.test(trimmed)) {
      const start = index;
      index += 1;
      const mathLines = [line];
      while (index < lines.length) {
        mathLines.push(lines[index]);
        if (/^\$\$/.test(lines[index].trim())) {
          index += 1;
          break;
        }
        index += 1;
      }
      blocks.push({ type: "math", startLine: start, endLine: index - 1, lines: mathLines });
      continue;
    }

    // Callout
    const calloutMatch = /^>\s*\[!(\w+)\]\s*([+-])?/.exec(trimmed);
    if (calloutMatch) {
      const start = index;
      const calloutLines = [line];
      index += 1;
      while (index < lines.length) {
        const nextTrimmed = lines[index].trim();
        if (!nextTrimmed || nextTrimmed.startsWith(">")) {
          calloutLines.push(lines[index]);
          index += 1;
        } else {
          break;
        }
      }
      blocks.push({
        type: "callout",
        startLine: start,
        endLine: index - 1,
        lines: calloutLines,
        metadata: {
          calloutType: calloutMatch[1],
          foldState: (calloutMatch[2] as "+" | "-") ?? undefined
        }
      });
      continue;
    }

    // Quote (non-callout)
    if (trimmed.startsWith(">")) {
      const start = index;
      const quoteLines = [line];
      index += 1;
      while (index < lines.length) {
        const nextTrimmed = lines[index].trim();
        if (!nextTrimmed || nextTrimmed.startsWith(">")) {
          quoteLines.push(lines[index]);
          index += 1;
        } else {
          break;
        }
      }
      blocks.push({ type: "quote", startLine: start, endLine: index - 1, lines: quoteLines });
      continue;
    }

    // Table (pipe-delimited, at least 2 consecutive lines starting with |)
    if (trimmed.startsWith("|")) {
      const start = index;
      index += 1;
      const tableLines = [line];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      if (tableLines.length >= 2) {
        blocks.push({ type: "table", startLine: start, endLine: index - 1, lines: tableLines });
      } else {
        // Single pipe line → treat as paragraph
        blocks.push({ type: "paragraph", startLine: start, endLine: start, lines: [line] });
      }
      continue;
    }

    // List
    if (/^(\s*)[-*+]\s+/.test(trimmed) || /^(\s*)\d+\.\s+/.test(trimmed)) {
      const start = index;
      const listLines = [line];
      const listMarker = /^(\s*)\d+\./.test(trimmed) ? "1." : "-";
      index += 1;
      while (index < lines.length) {
        const nextTrimmed = lines[index].trim();
        if (!nextTrimmed) break;
        if (/^(\s*)[-*+]\s+/.test(nextTrimmed) || /^(\s*)\d+\.\s+/.test(nextTrimmed)) {
          listLines.push(lines[index]);
          index += 1;
        } else if (nextTrimmed.startsWith("  ") || nextTrimmed.startsWith("\t")) {
          // Continuation line
          listLines.push(lines[index]);
          index += 1;
        } else {
          break;
        }
      }
      blocks.push({
        type: "list",
        startLine: start,
        endLine: index - 1,
        lines: listLines,
        metadata: { listMarker }
      });
      continue;
    }

    // Paragraph (default)
    {
      const start = index;
      const paraLines = [line];
      index += 1;
      while (index < lines.length) {
        const nextTrimmed = lines[index].trim();
        if (!nextTrimmed) break;
        if (/^(#{1,6})\s/.test(nextTrimmed)) break;
        if (/^\s*```|^\$\$|^\|\s|^>\s*\[!|^>\s|^(\s*)[-*+]\s|^(\s*)\d+\.\s/.test(nextTrimmed)) break;
        paraLines.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: "paragraph", startLine: start, endLine: index - 1, lines: paraLines });
    }
  }

  return blocks;
}

/** 检查 block 是否是受保护类型（不应参与候选收集或内容修改） */
export function isProtectedBlock(block: MarkdownBlock): boolean {
  return block.type === "code" || block.type === "math" || block.type === "callout";
}

/** 从 Block Parser 输出中取所有 paragraph 块（标题候选的唯一来源） */
export function getParagraphBlocks(blocks: MarkdownBlock[]): MarkdownBlock[] {
  return blocks.filter((b) => b.type === "paragraph");
}

/** 从 Block Parser 输出中取所有 code 块 */
export function getCodeBlocks(blocks: MarkdownBlock[]): MarkdownBlock[] {
  return blocks.filter((b) => b.type === "code");
}
