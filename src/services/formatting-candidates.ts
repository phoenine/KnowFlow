export type FormattingCandidateType = "possible-heading" | "possible-code" | "fenced-code";

export interface FormattingCandidate {
  id: string;
  type: FormattingCandidateType;
  startLine: number;
  endLine: number;
  content: string;
  before: string;
  after: string;
}

export interface FormattingDecision {
  id: string;
  action: "keep" | "heading" | "wrap-code" | "set-code-language";
  level?: number;
  language?: string;
}

const FORMATTING_BATCH_CHARS = 16000;

export function collectFormattingCandidates(content: string): FormattingCandidate[] {
  const lines = content.split("\n");
  const candidates: FormattingCandidate[] = [];
  const occupied = new Set<number>();
  let inFence = false;
  let fenceStart = -1;
  let fenceLanguage = "";

  for (let index = 0; index < lines.length; index += 1) {
    const fence = /^\s*```([^\s`]*)/.exec(lines[index]);
    if (!fence) continue;

    if (!inFence) {
      inFence = true;
      fenceStart = index;
      fenceLanguage = fence[1].trim();
      continue;
    }

    for (let line = fenceStart; line <= index; line += 1) occupied.add(line);
    if (!fenceLanguage || fenceLanguage === "text" || fenceLanguage === "plain") {
      candidates.push(makeCandidate(
        candidates.length,
        "fenced-code",
        fenceStart,
        index,
        lines.slice(fenceStart + 1, index).join("\n"),
        lines
      ));
    }
    inFence = false;
    fenceStart = -1;
    fenceLanguage = "";
  }

  let index = 0;
  while (index < lines.length) {
    if (occupied.has(index) || !lines[index].trim() || isProtectedMarkdownLine(lines[index])) {
      index += 1;
      continue;
    }

    const start = index;
    while (
      index + 1 < lines.length
      && !occupied.has(index + 1)
      && lines[index + 1].trim()
      && !isProtectedMarkdownLine(lines[index + 1])
    ) {
      index += 1;
    }
    const end = index;
    const block = lines.slice(start, end + 1);

    if (looksLikeUnfencedCode(block, lines[start - 1] ?? "")) {
      candidates.push(makeCandidate(candidates.length, "possible-code", start, end, block.join("\n"), lines));
      for (let line = start; line <= end; line += 1) occupied.add(line);
    }
    index += 1;
  }

  index = 0;
  while (index < lines.length) {
    if (occupied.has(index) || !isPossibleHeadingStart(lines, index)) {
      index += 1;
      continue;
    }

    const range = possibleHeadingRange(lines, index);
    candidates.push(makeCandidate(
      candidates.length,
      "possible-heading",
      range.start,
      range.end,
      lines.slice(range.start, range.end + 1).join("\n"),
      lines
    ));
    index = range.end + 1;
  }

  return candidates;
}

export function batchFormattingCandidates(candidates: FormattingCandidate[]): FormattingCandidate[][] {
  const batches: FormattingCandidate[][] = [];
  let batch: FormattingCandidate[] = [];
  let chars = 0;

  for (const candidate of candidates) {
    const candidateChars = candidate.content.length + candidate.before.length + candidate.after.length;
    if (batch.length > 0 && chars + candidateChars > FORMATTING_BATCH_CHARS) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(candidate);
    chars += candidateChars;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function applyFormattingDecisions(
  content: string,
  candidates: FormattingCandidate[],
  decisions: FormattingDecision[]
): string {
  const lines = content.split("\n");
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const accepted = decisions
    .map((decision) => ({ decision, candidate: byId.get(decision.id) }))
    .filter((item): item is { decision: FormattingDecision; candidate: FormattingCandidate } => Boolean(item.candidate))
    .sort((a, b) => b.candidate.startLine - a.candidate.startLine);

  const used = new Set<string>();
  for (const { decision, candidate } of accepted) {
    if (used.has(candidate.id) || decision.action === "keep") continue;
    used.add(candidate.id);

    const current = lines.slice(candidate.startLine, candidate.endLine + 1).join("\n");
    if (candidate.type === "fenced-code") {
      if (decision.action !== "set-code-language") continue;
      const language = normalizeLanguage(decision.language);
      if (!language || current !== `\`\`\`${lines[candidate.startLine].replace(/^\s*```/, "").trim()}\n${candidate.content}\n\`\`\``) {
        continue;
      }
      lines[candidate.startLine] = `\`\`\`${language}`;
      continue;
    }

    if (current !== candidate.content) continue;
    if (candidate.type === "possible-code" && decision.action === "wrap-code") {
      const language = normalizeLanguage(decision.language);
      lines.splice(candidate.startLine, candidate.endLine - candidate.startLine + 1, `\`\`\`${language}`, current, "```");
      continue;
    }

    if (candidate.type === "possible-heading" && decision.action === "heading") {
      const level = decision.level === 3 || decision.level === 4 ? decision.level : 2;
      const heading = candidate.content
        .split("\n")
        .map((line) => line.trim().replace(/^\*\*(.+)\*\*$/, "$1"))
        .filter(Boolean)
        .join(" ");
      lines.splice(candidate.startLine, candidate.endLine - candidate.startLine + 1, `${"#".repeat(level)} ${heading}`);
    }
  }

  return lines.join("\n");
}

export function stripSequentialLineNumbers(body: string): string {
  const lines = body.split("\n");
  const numbered = lines
    .map((line, index) => {
      const match = /^(\s*)(\d+)(.*)$/.exec(line);
      return match ? { index, number: Number(match[2]), prefix: `${match[1]}${match[2]}`, rest: match[3] } : null;
    })
    .filter((item): item is { index: number; number: number; prefix: string; rest: string } => Boolean(item));

  if (numbered.length < 3) return body;
  if (numbered.some((item, index) => item.number !== numbered[0].number + index)) return body;
  if (numbered.every((item) => !item.rest)) return body;
  if (lines.some((line) => line.trim() && !/^\s*\d+/.test(line))) return body;

  const prefixes = new Map(numbered.map((item) => [item.index, item.prefix.length]));
  return lines.map((line, index) => {
    const length = prefixes.get(index);
    return length === undefined ? line : line.slice(length);
  }).join("\n");
}

function makeCandidate(
  index: number,
  type: FormattingCandidateType,
  startLine: number,
  endLine: number,
  content: string,
  lines: string[]
): FormattingCandidate {
  return {
    id: `format-${index + 1}`,
    type,
    startLine,
    endLine,
    content,
    before: nearestNonBlank(lines, startLine - 1, -1),
    after: nearestNonBlank(lines, endLine + 1, 1)
  };
}

function nearestNonBlank(lines: string[], start: number, step: -1 | 1): string {
  for (let index = start; index >= 0 && index < lines.length; index += step) {
    if (lines[index].trim()) return lines[index].trim().slice(0, 160);
  }
  return "";
}

function isProtectedMarkdownLine(line: string): boolean {
  const trimmed = line.trim();
  return /^(#{1,6}\s|>|!\[|\[!\[|[-*+]\s|\d+[.)]\s|\|)/.test(trimmed)
    || /^-{3,}$/.test(trimmed);
}

function looksLikeUnfencedCode(lines: string[], previousLine: string): boolean {
  const nonBlank = lines.filter((line) => line.trim());
  const codeLines = nonBlank.filter((line) =>
    /^\s*(import |from |def |class |const |let |var |function |export |async |SELECT\b|WITH\b|INSERT\b|UPDATE\b|DELETE\b|curl\b|sudo\b|git\b|npm\b|pnpm\b|yarn\b|docker\b|kubectl\b)/i.test(line)
    || /^\s*[\w.-]+\s*:\s*\S/.test(line)
    || /[{};]|=>/.test(line)
  ).length;
  const yamlLines = nonBlank.filter((line) => /^\s*[\w.-]+\s*:\s*(?:\S.*)?$/.test(line)).length;
  const contextSuggestsCode = /(代码|命令|配置|示例|执行|运行|安装|终端|输出)\s*[:：]?\s*$/.test(previousLine.trim());

  if (nonBlank.length >= 2 && (codeLines >= 2 || yamlLines >= 2)) return true;
  return nonBlank.length === 1 && contextSuggestsCode && codeLines === 1;
}

function isPossibleHeadingStart(lines: string[], index: number): boolean {
  const line = lines[index].trim();
  if (!line || line.length > 70 || isProtectedMarkdownLine(line)) return false;
  if (/^https?:\/\//i.test(line) || /[。！？；;]$/.test(line)) return false;

  const blankBefore = index === 0 || !lines[index - 1].trim();
  const blankAfter = index === lines.length - 1 || !lines[index + 1].trim();

  // 相邻短行合并为 multi-line 候选
  if (blankBefore && !blankAfter) {
    const next = lines[index + 1].trim();
    if (next && next.length <= 70 && !isProtectedMarkdownLine(lines[index + 1])
        && !/[。！？；;]$/.test(next) && !/^https?:\/\//i.test(next)) {
      const afterNext = index + 2 >= lines.length || !lines[index + 2].trim();
      if (afterNext) return true;
    }
  }

  return blankBefore && blankAfter;
}

function possibleHeadingRange(lines: string[], index: number): { start: number; end: number } {
  const current = lines[index].trim();

  // 数字前缀格式（如 "1. 标题" 或 "一、" 的变形）
  if (/^\d{1,2}[.)、]?$/.test(current)) {
    let next = index + 1;
    while (next < lines.length && !lines[next].trim()) next += 1;
    if (next < lines.length && lines[next].trim().length <= 70 && !isProtectedMarkdownLine(lines[next])) {
      return { start: index, end: next };
    }
  }

  // 相邻双行短文本合并
  const blankAfter = index === lines.length - 1 || !lines[index + 1].trim();
  if (!blankAfter) {
    const nextLine = lines[index + 1].trim();
    if (nextLine && nextLine.length <= 70 && !isProtectedMarkdownLine(lines[index + 1])
        && !/[。！？；;]$/.test(nextLine) && !/^https?:\/\//i.test(nextLine)) {
      const afterNext = index + 2 >= lines.length || !lines[index + 2].trim();
      if (afterNext) return { start: index, end: index + 1 };
    }
  }

  return { start: index, end: index };
}

function normalizeLanguage(value: string | undefined): string {
  const language = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9_+-]{1,24}$/.test(language) ? language : "";
}

export function collectHeadingCandidates(content: string): FormattingCandidate[] {
  const lines = content.split("\n");
  const candidates: FormattingCandidate[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!isPossibleHeadingStart(lines, index)) {
      index += 1;
      continue;
    }
    const range = possibleHeadingRange(lines, index);
    candidates.push(makeCandidate(
      candidates.length,
      "possible-heading",
      range.start,
      range.end,
      lines.slice(range.start, range.end + 1).join("\n"),
      lines
    ));
    index = range.end + 1;
  }
  return candidates;
}

export function collectCodeCandidates(content: string): {
  possibleCode: FormattingCandidate[];
  fencedCode: FormattingCandidate[];
} {
  const lines = content.split("\n");
  const occupied = new Set<number>();
  const fencedCode: FormattingCandidate[] = [];
  let inFence = false;
  let fenceStart = -1;
  let fenceLanguage = "";

  for (let i = 0; i < lines.length; i += 1) {
    const fence = /^\s*```([^\s`]*)/.exec(lines[i]);
    if (!fence) continue;
    if (!inFence) {
      inFence = true;
      fenceStart = i;
      fenceLanguage = fence[1].trim();
      continue;
    }
    for (let j = fenceStart; j <= i; j += 1) occupied.add(j);
    if (!fenceLanguage || fenceLanguage === "text" || fenceLanguage === "plain") {
      fencedCode.push(makeCandidate(
        fencedCode.length,
        "fenced-code",
        fenceStart,
        i,
        lines.slice(fenceStart + 1, i).join("\n"),
        lines
      ));
    }
    inFence = false;
    fenceStart = -1;
    fenceLanguage = "";
  }

  const possibleCode: FormattingCandidate[] = [];
  let index = 0;
  while (index < lines.length) {
    if (occupied.has(index) || !lines[index].trim() || isProtectedMarkdownLine(lines[index])) {
      index += 1;
      continue;
    }
    const start = index;
    while (
      index + 1 < lines.length
      && !occupied.has(index + 1)
      && lines[index + 1].trim()
      && !isProtectedMarkdownLine(lines[index + 1])
    ) {
      index += 1;
    }
    const end = index;
    const block = lines.slice(start, end + 1);
    if (looksLikeUnfencedCode(block, lines[start - 1] ?? "")) {
      possibleCode.push(makeCandidate(possibleCode.length, "possible-code", start, end, block.join("\n"), lines));
      for (let j = start; j <= end; j += 1) occupied.add(j);
    }
    index += 1;
  }

  return { possibleCode, fencedCode };
}

export function collectPossibleCodeCandidates(content: string): FormattingCandidate[] {
  return collectCodeCandidates(content).possibleCode;
}

export function collectFencedCodeCandidates(content: string): FormattingCandidate[] {
  return collectCodeCandidates(content).fencedCode;
}

/**
 * Fix the orphan bold triplet pattern:
 *   **\n**text**\n**  →  **text**
 * Common in clippings where bold-delimited headings get split across lines.
 */
export function normalizeOrphanBoldTriplet(content: string): string {
  return content.replace(
    /(^|\n)\*\*[ \t]*\n+(\*\*.+?\*\*)[ \t]*\n+\*\*[ \t]*(?=\n|$)/g,
    "$1$2"
  );
}

/**
 * Clean pure-number noise from existing heading markers.
 * Only removes numbering when the entire content after the marker is digits:
 *   "## 1. 01" → "## "    (all digits ✓)
 *   "## 1. 概述" → kept    (has text ✗)
 */
export function cleanHeadingNumberNoise(line: string): string {
  return line.replace(/^(#{1,6})\s+\d+[.\、\)]\s*\d+$/g, "$1 ");
}
