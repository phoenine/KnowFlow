export interface FrontmatterUpdateData {
  title: string;
  description: string;
  readingValue: number;
  category: string;
  today: string;
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
  fields.set("简要描述", quoteYamlString(data.description.replace(/\n/g, " ").slice(0, 180)));
  fields.set("阅读价值", data.readingValue > 0 ? String(data.readingValue) : "");
  fields.set("分类", data.category);
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

  return `---\n${nextFrontmatter.trim()}\n---\n\n${body.replace(/^#\s+/gm, "## ")}\n`;
}

export function updateFrontmatterCategory(content: string, category: string): string {
  const parsed = splitFrontmatter(content);
  if (parsed.frontmatter === null) return content;
  const nextFrontmatter = upsertFrontmatterField(parsed.frontmatter, "分类", category, false);
  return `---\n${nextFrontmatter.trim()}\n---\n${parsed.body}`;
}

function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { frontmatter: null, body: normalized };
  return {
    frontmatter: match[1],
    body: normalized.slice(match[0].length)
  };
}

function stripFrontmatter(content: string): string {
  return splitFrontmatter(content).body;
}

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
