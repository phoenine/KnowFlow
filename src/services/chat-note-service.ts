import { normalizePath } from "obsidian";
import type { App } from "obsidian";
import type { ChatThread } from "../types";

export class ChatNoteService {
  constructor(private app: App, private folder: string) {}

  updateFolder(path: string): void {
    this.folder = path;
  }

  async saveThread(thread: ChatThread): Promise<string> {
    const folder = normalizePath(this.folder);
    if (!(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.createFolder(folder);
    }
    const timestamp = window.moment().format("YYYYMMDD_HHmmss");
    const base = sanitizeFileName(thread.contextLabel || "Chat");
    let path = normalizePath(`${folder}/${base}@${timestamp}.md`);
    let suffix = 2;
    while (await this.app.vault.adapter.exists(path)) {
      path = normalizePath(`${folder}/${base}@${timestamp}_${suffix}.md`);
      suffix += 1;
    }
    await this.app.vault.create(path, renderThread(thread));
    return path;
  }

  async listThreads(): Promise<ChatThread[]> {
    const folder = normalizePath(this.folder);
    const prefix = `${folder}/`;
    const threads: ChatThread[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(prefix)) continue;
      const thread = parseThread(await this.app.vault.cachedRead(file), file.path);
      if (thread) threads.push(thread);
    }
    return threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

export function renderThread(thread: ChatThread): string {
  const createdAt = new Date(thread.createdAt).getTime();
  const updatedAt = new Date(thread.updatedAt).getTime();
  const lines = [
    "---",
    `epoch: ${Number.isFinite(createdAt) ? createdAt : Date.now()}`,
    "modelKey: KnowFlow",
    `topic: ${yamlScalar(thread.contextLabel || "KnowFlow Chat")}`,
    "tags:",
    "  - copilot-conversation",
    `lastAccessedAt: ${Number.isFinite(updatedAt) ? updatedAt : Date.now()}`,
    "---",
    ""
  ];
  for (const message of thread.messages) {
    lines.push(`**${message.role === "user" ? "user" : "ai"}**: ${message.role === "user" ? message.content.trim() : ""}`);
    lines.push("");
    if (message.role === "assistant") {
      lines.push(message.content.trim());
      lines.push("");
    }
    if (thread.filePath) {
      lines.push(`[Context: Notes: ${thread.filePath}]`);
      lines.push("");
    }
    lines.push(`[Timestamp: ${formatTimestamp(message.completedAt ?? message.createdAt)}]`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function parseThread(markdown: string, sourcePath = ""): ChatThread | null {
  const frontmatter = parseSimpleFrontmatter(markdown);
  const topic = frontmatter.topic || sourcePath.split("/").at(-1)?.replace(/@\d{8}_\d{6}(?:_\d+)?\.md$/, "") || "";
  const epoch = toEpoch(frontmatter.epoch);
  const lastAccessedAt = toEpoch(frontmatter.lastAccessedAt);
  const messages = parseCopilotMessages(stripFrontmatter(markdown));
  if (!topic && messages.length === 0) return null;
  const createdAt = new Date(epoch ?? messageEpoch(messages[0]) ?? Date.now()).toISOString();
  const updatedAt = new Date(lastAccessedAt ?? messageEpoch(messages.at(-1)) ?? epoch ?? Date.now()).toISOString();
  const filePath = parseContextPath(markdown);
  return {
    id: sourcePath || `chat-${epoch ?? Date.now()}`,
    sourceMode: filePath ? "article-detail" : "empty",
    filePath,
    contextLabel: unquoteYaml(topic),
    messages,
    createdAt,
    updatedAt,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: true }
  };
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Chat";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  const pad = (number: number): string => String(number).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseCopilotMessages(body: string): ChatThread["messages"] {
  const marker = /^\*\*(user|ai)\*\*:\s*(.*)$/gm;
  const matches = Array.from(body.matchAll(marker));
  return matches.map((match, index) => {
    const role = match[1] === "user" ? "user" : "assistant";
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? body.length;
    const block = `${match[2]}\n${body.slice(start, end)}`;
    const timestamp = /\[Timestamp:\s*([^\]]+)\]/i.exec(block)?.[1]?.trim();
    const content = block
      .replace(/\n?\[Context:[^\]]*\]\s*/gi, "\n")
      .replace(/\n?\[Timestamp:[^\]]*\]\s*/gi, "\n")
      .trim();
    const createdAt = parseTimestamp(timestamp)?.toISOString() ?? new Date().toISOString();
    return {
      id: `message-${index}-${new Date(createdAt).getTime()}`,
      role,
      content,
      reasoning: "",
      createdAt,
      completedAt: role === "assistant" ? createdAt : undefined,
      status: "done"
    };
  });
}

function parseSimpleFrontmatter(markdown: string): Record<string, string> {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(markdown.replace(/\r\n/g, "\n"));
  if (!match) return {};
  const values: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) values[field[1]] = field[2].trim();
  }
  return values;
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
}

function parseContextPath(markdown: string): string | null {
  return /\[Context:\s*(?:Notes|Files):\s*([^\]]+?\.md)\s*\]/i.exec(markdown)?.[1]?.trim() ?? null;
}

function parseTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const normalized = value.replace(
    /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/,
    "$1-$2-$3T$4:$5:$6"
  );
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toEpoch(value: string | undefined): number | null {
  const epoch = Number(value);
  return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
}

function messageEpoch(message: ChatThread["messages"][number] | undefined): number | null {
  if (!message) return null;
  const epoch = new Date(message.completedAt ?? message.createdAt).getTime();
  return Number.isNaN(epoch) ? null : epoch;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function unquoteYaml(value: string): string {
  try {
    return value.startsWith('"') ? JSON.parse(value) as string : value;
  } catch {
    return value.replace(/^['"]|['"]$/g, "");
  }
}
