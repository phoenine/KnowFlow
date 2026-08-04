import { splitFrontmatter } from "./frontmatter-rules";

// The long-form AI summary lives in a collapsible callout inside the
// note's own body instead of data.json (see StoredSummaryMeta in
// types.ts). No start/end marker comments: the callout's own title line,
// plus the "every line in the block is quoted" convention Obsidian itself
// uses to delimit a callout, is already enough to find it again for an
// idempotent regenerate — a marker comment would just be visible clutter
// in a note that's meant to read like something a person wrote.
const CALLOUT_TITLE = "> [!summary]- AI 摘要";
const CALLOUT_TITLE_PATTERN = /^> \[!summary\]/;

export interface SummaryText {
  summary: string;
  reason: string;
}

/** Renders the collapsed-by-default callout block. */
export function buildSummaryCallout(text: SummaryText): string {
  const body = quoteAsCallout(text.summary.trim() || "AI 未返回有效摘要。");
  const reasonBlock = text.reason.trim() ? [">", `> **推荐理由**：${text.reason.trim()}`] : [];
  return [CALLOUT_TITLE, ...body, ...reasonBlock].join("\n");
}

/**
 * Inserts the callout right after frontmatter, or replaces the existing
 * one in place if the note was already summarized before.
 */
export function upsertSummaryCallout(content: string, text: SummaryText): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const callout = buildSummaryCallout(text);
  const lines = normalized.split("\n");
  const range = findCalloutLineRange(lines);
  if (range) {
    return [...lines.slice(0, range.start), ...callout.split("\n"), ...lines.slice(range.end)].join("\n");
  }
  const { frontmatter, body } = splitFrontmatter(normalized);
  const trimmedBody = body.replace(/^\n+/, "");
  if (frontmatter === null) {
    return `${callout}\n\n${trimmedBody}`;
  }
  return `---\n${frontmatter}\n---\n\n${callout}\n\n${trimmedBody}`;
}

/** Extracts the summary/reason text back out of a note's markdown. */
export function parseSummaryCallout(content: string): SummaryText | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const range = findCalloutLineRange(lines);
  if (!range) return null;

  const blockLines = lines.slice(range.start, range.end).filter((line) => !CALLOUT_TITLE_PATTERN.test(line));
  const reasonIndex = blockLines.findIndex((line) => /^>\s*\*\*推荐理由\*\*：/.test(line));
  const summaryLines = reasonIndex >= 0 ? blockLines.slice(0, reasonIndex) : blockLines;
  const reasonLine = reasonIndex >= 0 ? blockLines[reasonIndex] : "";

  return {
    summary: unquoteCallout(summaryLines),
    reason: reasonLine.replace(/^>\s*\*\*推荐理由\*\*：/, "").trim()
  };
}

/**
 * Returns the character offset right after the summary callout block, so
 * other note-writing code (see mermaid-service.ts) can insert content
 * immediately following it instead of just appending to the end of the
 * file. Returns null if there's no summary callout yet.
 */
export function findSummaryCalloutEndIndex(content: string): number | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const range = findCalloutLineRange(lines);
  if (!range) return null;
  return lines.slice(0, range.end).join("\n").length;
}

/**
 * A callout/blockquote in Obsidian runs from its title line through the
 * last contiguous line starting with `>` — the first line that doesn't is
 * what ends it, no explicit terminator needed.
 */
function findCalloutLineRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => CALLOUT_TITLE_PATTERN.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith(">")) {
    end += 1;
  }
  return { start, end };
}

function quoteAsCallout(text: string): string[] {
  return text.split("\n").map((line) => (line ? `> ${line}` : ">"));
}

function unquoteCallout(lines: string[]): string {
  return lines
    .map((line) => line.replace(/^>\s?/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}
