export interface FrontmatterUpdateData {
  title: string;
  today: string;
}

export interface SummaryFrontmatterData {
  description: string;
  readingValue: number;
  category: string;
  tags: string[];
}

const KNOWFLOW_FIELD_ORDER = [
  "创建日期",
  "简要描述",
  "阅读价值",
  "文章作者",
  "分类",
  "tags",
  "网址",
  "学习日期",
  "学习状态",
  "状态"
];

export function applyArticleFrontmatter(content: string, originalContent: string, templateContent: string, data: FrontmatterUpdateData): string {
  const body = stripFrontmatter(content).trim();
  const original = splitFrontmatter(originalContent);
  const template = splitFrontmatter(templateContent);
  const frontmatter = original.frontmatter ?? template.frontmatter ?? "";
  const templateKeys = extractTopLevelKeys(template.frontmatter ?? "");
  const existingKeys = new Set(extractTopLevelKeys(frontmatter));
  const fields = new Map<string, string | string[]>();

  fields.set("创建日期", normalizeCreationDate(getFieldValue(frontmatter, "创建日期"), data.today));
  const author = getFieldValue(frontmatter, "文章作者");
  if (author !== undefined) fields.set("文章作者", normalizeAuthor(author));
  // 简要描述/阅读价值/分类/tags are deliberately NOT set here — they're owned
  // by applySummaryFrontmatter below, called the moment a summary is
  // generated. Re-running the pipeline just leaves whatever's already
  // there (or the template's blank placeholder, via the missing-keys pass
  // further down) instead of overwriting it with stale/default values.
  fields.set("学习日期", normalizeLearningDate(getFieldValue(frontmatter, "学习日期")));
  fields.set("学习状态", normalizeLearningStatus(getFieldBlock(frontmatter, "学习状态")));
  fields.set("状态", "true");

  let nextFrontmatter = frontmatter;
  for (const [key, value] of fields) {
    nextFrontmatter = upsertFrontmatterField(nextFrontmatter, key, value, false);
  }

  for (const key of orderedMissingKeys(templateKeys)) {
    if (!existingKeys.has(key) && !fields.has(key)) {
      const value = getFieldBlock(template.frontmatter ?? "", key);
      nextFrontmatter = upsertFrontmatterField(nextFrontmatter, key, value ?? "", true);
    }
  }

  for (const key of KNOWFLOW_FIELD_ORDER) {
    if (!hasTopLevelKey(nextFrontmatter, key) && !fields.has(key)) {
      nextFrontmatter = upsertFrontmatterField(nextFrontmatter, key, "", true);
    }
  }

  return `---\n${nextFrontmatter.trim()}\n---\n\n${body}\n`;
}

/**
 * Called the moment an AI summary is generated — before "整理"
 * (ClippingPipeline.process()) ever runs — so frontmatter becomes the
 * source of truth for these four fields immediately. Deliberately narrow:
 * it only
 * touches 简要描述/阅读价值/分类/tags, leaving 创建日期/学习日期/学习状态/状态/
 * 文章作者 and the body completely alone — that's applyArticleFrontmatter's
 * job instead.
 */
export function applySummaryFrontmatter(content: string, data: SummaryFrontmatterData): string {
  const { frontmatter, body } = splitFrontmatter(content);
  let next = frontmatter ?? "";
  next = upsertFrontmatterField(next, "简要描述", quoteYamlString(data.description.replace(/\n/g, " ").slice(0, 180)), false);
  next = upsertFrontmatterField(next, "阅读价值", data.readingValue > 0 ? String(data.readingValue) : "", false);
  next = upsertFrontmatterField(next, "分类", data.category, false);
  next = upsertFrontmatterField(next, "tags", formatTagsList(data.tags), false);
  return `---\n${next.trim()}\n---\n${body}`;
}

export function updateFrontmatterCategory(content: string, category: string): string {
  const parsed = splitFrontmatter(content);
  if (parsed.frontmatter === null) return content;
  const nextFrontmatter = upsertFrontmatterField(parsed.frontmatter, "分类", category, false);
  return `---\n${nextFrontmatter.trim()}\n---\n${parsed.body}`;
}

export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  // The `\n?` before the closing fence (rather than a required `\n`) matters
  // for genuinely empty frontmatter blocks like "---\n---\n": there is only
  // one newline between the two fences, already consumed by the opening
  // match, so a mandatory extra `\n` before the close would never match and
  // the whole block would be silently treated as body text instead.
  const match = /^---\n([\s\S]*?)\n?---\n?/.exec(normalized);
  if (!match) return { frontmatter: null, body: normalized };
  return {
    frontmatter: match[1],
    body: normalized.slice(match[0].length)
  };
}

function stripFrontmatter(content: string): string {
  return splitFrontmatter(content).body;
}

/**
 * This module intentionally parses frontmatter with regex/line-scanning
 * instead of a real YAML library, so it can round-trip a file while only
 * touching the specific fields KnowFlow owns — preserving field order,
 * comments and non-standard Templater expressions (e.g.
 * `<% tp.date.now("YYYY-MM-DD") %>`) that a YAML parser would either choke
 * on or silently reformat away. The trade-off is that it only understands a
 * conventional subset of YAML:
 * - A top-level key must start at column 0 with no leading whitespace.
 * - Continuation/block-scalar lines belonging to a key must be indented
 *   (space or tab; both count as "not a new key" here).
 * - Duplicate top-level keys are not supported: only the first occurrence
 *   is read/updated, matching normal YAML semantics loosely but without
 *   validation.
 * - A key line's own value is treated as an opaque string; multi-line
 *   block scalars (`|`, `>`, ...) and inline flow values (`[a, b]`) are
 *   preserved verbatim rather than being parsed into structured data,
 *   except for the specific fields KnowFlow rewrites itself.
 */
function extractTopLevelKeys(frontmatter: string): string[] {
  return frontmatter
    .split("\n")
    .map((line) => /^([^:#\s][^:]*):(?:\s.*)?$/.exec(line)?.[1]?.trim())
    .filter((key): key is string => Boolean(key));
}

function orderedMissingKeys(templateKeys: string[]): string[] {
  const ordered = [...templateKeys].sort((a, b) => {
    const left = KNOWFLOW_FIELD_ORDER.indexOf(a);
    const right = KNOWFLOW_FIELD_ORDER.indexOf(b);
    if (left === -1 && right === -1) return 0;
    if (left === -1) return 1;
    if (right === -1) return -1;
    return left - right;
  });
  return Array.from(new Set(ordered));
}

function upsertFrontmatterField(frontmatter: string, key: string, value: string | string[], appendOnly: boolean): string {
  const lines = frontmatter ? frontmatter.split("\n") : [];
  const range = findFieldRange(lines, key);
  const replacement = formatFrontmatterField(key, value);
  if (range && !appendOnly) {
    return [
      ...lines.slice(0, range.start),
      ...replacement,
      ...lines.slice(range.end)
    ].join("\n");
  }
  if (range) return frontmatter;
  return [...lines, ...replacement].filter((line, index) => line !== "" || index < lines.length).join("\n");
}

function findFieldRange(lines: string[], key: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => new RegExp(`^${escapeRegExp(key)}:\\s*`).test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^[^:#\s][^:]*:\s*/.test(lines[end])) {
    end += 1;
  }
  return { start, end };
}

function hasTopLevelKey(frontmatter: string, key: string): boolean {
  return findFieldRange(frontmatter.split("\n"), key) !== null;
}

function getFieldValue(frontmatter: string, key: string): string | undefined {
  const block = getFieldBlock(frontmatter, key);
  if (Array.isArray(block)) return block.join("\n");
  return block;
}

function getFieldBlock(frontmatter: string, key: string): string | string[] | undefined {
  const lines = frontmatter.split("\n");
  const range = findFieldRange(lines, key);
  if (!range) return undefined;
  const [first, ...rest] = lines.slice(range.start, range.end);
  const value = first.replace(new RegExp(`^${escapeRegExp(key)}:\\s*`), "");
  return rest.length > 0 ? [value, ...rest] : value;
}

function formatFrontmatterField(key: string, value: string | string[]): string[] {
  if (Array.isArray(value)) {
    const [first = "", ...rest] = value;
    return [`${key}:${first ? ` ${first}` : ""}`, ...rest];
  }
  if (key === "tags" && !value.trim()) return ["tags:"];
  return [value.trim() ? `${key}: ${value}` : `${key}:`];
}

function normalizeCreationDate(value: string | undefined, today: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed.includes("<%")) return today;
  return trimmed;
}

function normalizeAuthor(value: string): string {
  const trimmed = value.trim();
  const scalar = (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  const wikilink = /^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]$/.exec(scalar);
  return wikilink ? (wikilink[2] ?? wikilink[1]).trim() : trimmed;
}

/**
 * Replaces the frontmatter `tags` list with the AI's topic tags every time
 * the pipeline runs, fully overriding the "clippings" placeholder the
 * template seeds new notes with — otherwise those AI-generated tags never
 * end up anywhere Obsidian's own tag search/graph view can see them.
 */
function formatTagsList(tags: string[]): string[] {
  const normalized = Array.from(new Set(tags.map(normalizeObsidianTag).filter(Boolean)));
  const list = normalized.length > 0 ? normalized : ["clippings"];
  return ["", ...list.map((tag) => `  - ${tag}`)];
}

function normalizeObsidianTag(value: string): string {
  return value.trim().replace(/^#+/, "").replace(/\s+/g, "-");
}

function normalizeLearningStatus(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const [, ...rest] = value;
    if (rest.some((line) => line.trim())) return ["", ...rest];
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (text) return ["", `  - ${text.replace(/^-\s*/, "")}`];
  return ["", "  - 未学习"];
}

function normalizeLearningDate(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed.includes("<%")) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : "";
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
