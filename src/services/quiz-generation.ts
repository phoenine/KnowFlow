export type QuizMarkerKind = "bold" | "highlight" | "underline" | "italic";
export type QuizFocusType = "concept" | "principle" | "comparison" | "application" | "pitfall";

export interface QuizMarkedExcerpt {
  kind: QuizMarkerKind;
  text: string;
}

export interface QuizSourceSection {
  id: string;
  title: string;
  content: string;
  marked: QuizMarkedExcerpt[];
}

const SECTION_CHARS = 12000;
const BATCH_CHARS = 16000;

export function prepareQuizSections(content: string): QuizSourceSection[] {
  const body = removeManagedCallouts(stripFrontmatter(content));
  const logicalSections = splitByH2(body)
    .filter((section) => !/^(?:Knowledge Map|知识骨架)$/i.test(section.title.trim()));
  const chunks = logicalSections.flatMap((section) => splitLargeSection(section));
  return chunks.map((section, index) => ({
    id: `section-${index + 1}`,
    title: section.title,
    content: section.content,
    marked: extractMarkedExcerpts(section.content)
  }));
}

export function batchQuizSections(sections: QuizSourceSection[]): QuizSourceSection[][] {
  const batches: QuizSourceSection[][] = [];
  let batch: QuizSourceSection[] = [];
  let chars = 0;

  for (const section of sections) {
    const sectionChars = section.title.length + section.content.length
      + section.marked.reduce((total, marked) => total + marked.text.length, 0);
    if (batch.length > 0 && chars + sectionChars > BATCH_CHARS) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(section);
    chars += sectionChars;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function getQuizQuestionLimit(readingValue: number): number {
  if (readingValue <= 1) return 4;
  if (readingValue === 2) return 4;
  if (readingValue === 3) return 8;
  if (readingValue === 4) return 10;
  return 12;
}

export function getQuizFocusTargets(count: number): Record<QuizFocusType, number> {
  const weights: Array<[QuizFocusType, number]> = [
    ["concept", 0.25],
    ["principle", 0.3],
    ["comparison", 0.15],
    ["application", 0.15],
    ["pitfall", 0.15]
  ];
  const targets = Object.fromEntries(
    weights.map(([type, weight]) => [type, Math.floor(count * weight)])
  ) as Record<QuizFocusType, number>;
  let remaining = count - Object.values(targets).reduce((total, value) => total + value, 0);
  const ranked = weights
    .map(([type, weight], index) => ({ type, index, remainder: count * weight - Math.floor(count * weight) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; remaining > 0; index = (index + 1) % ranked.length) {
    targets[ranked[index].type] += 1;
    remaining -= 1;
  }
  return targets;
}

function stripFrontmatter(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function removeManagedCallouts(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (/^> \[!(?:summary|question)\][+-]?\s+(?:AI 摘要|Quiz)\s*$/.test(lines[index])) {
      index += 1;
      while (index < lines.length && /^\s*>/.test(lines[index])) index += 1;
      continue;
    }
    result.push(lines[index]);
    index += 1;
  }
  return result.join("\n");
}

function splitByH2(content: string): Array<{ title: string; content: string }> {
  const sections: Array<{ title: string; content: string }> = [];
  let title = "导语";
  let lines: string[] = [];
  let inFence = false;
  const flush = (): void => {
    const body = lines.join("\n").trim();
    if (body) sections.push({ title, content: body });
    lines = [];
  };

  for (const line of content.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (heading) {
      flush();
      title = heading[1].trim();
      continue;
    }
    lines.push(line);
  }
  flush();
  return sections;
}

function splitLargeSection(section: { title: string; content: string }): Array<{ title: string; content: string }> {
  if (section.content.length <= SECTION_CHARS) return [section];
  const paragraphs = section.content.split(/\n{2,}/);
  const chunks: Array<{ title: string; content: string }> = [];
  let current: string[] = [];
  let chars = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push({
      title: chunks.length === 0 ? section.title : `${section.title}（续）`,
      content: current.join("\n\n")
    });
    current = [];
    chars = 0;
  };

  for (const paragraph of paragraphs) {
    if (current.length > 0 && chars + paragraph.length > SECTION_CHARS) flush();
    current.push(paragraph);
    chars += paragraph.length;
  }
  flush();
  return chunks;
}

function extractMarkedExcerpts(content: string): QuizMarkedExcerpt[] {
  const source = removeCodeForMarkerScan(content);
  const values = new Map<string, QuizMarkerKind>();
  const add = (kind: QuizMarkerKind, value: string): void => {
    const text = value.replace(/\s+/g, " ").trim();
    if (!text) return;
    const existing = values.get(text);
    if (!existing || markerPriority(kind) < markerPriority(existing)) values.set(text, kind);
  };

  for (const match of source.matchAll(/\*\*([^*\n]+)\*\*/g)) add("bold", match[1]);
  for (const match of source.matchAll(/==([^=\n]+)==/g)) add("highlight", match[1]);
  for (const match of source.matchAll(/<u>([\s\S]*?)<\/u>/gi)) add("underline", match[1]);
  for (const match of source.matchAll(/(^|[^*])\*([^*\n]+)\*(?!\*)/g)) add("italic", match[2]);

  return Array.from(values, ([text, kind]) => ({ kind, text }))
    .sort((a, b) => markerPriority(a.kind) - markerPriority(b.kind));
}

function removeCodeForMarkerScan(content: string): string {
  let inFence = false;
  return content
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line.replace(/`[^`\n]*`/g, "");
    })
    .join("\n");
}

function markerPriority(kind: QuizMarkerKind): number {
  if (kind === "bold") return 0;
  if (kind === "highlight" || kind === "underline") return 1;
  return 2;
}
