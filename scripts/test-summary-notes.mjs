import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-summary-notes-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/summary-notes.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const { buildSummaryCallout, upsertSummaryCallout, parseSummaryCallout, findSummaryCalloutEndIndex } = await import(
  pathToFileURL(join(tempDir, "summary-notes.js")).href
);

const text = {
  summary: "核心观点\n- 第一条观点\n- 第二条观点\n\n章节梳理\n1. 第一章讲了什么\n2. 第二章讲了什么",
  reason: "文章有深度分析，值得深入学习。"
};

// buildSummaryCallout -> parseSummaryCallout should round-trip exactly,
// and the callout must not contain any marker comments — just the
// collapsible callout title itself.
{
  const callout = buildSummaryCallout(text);
  assert.ok(!callout.includes("<!--"), "no marker comments — the callout's own title line is enough to find it again");
  assert.ok(callout.includes("> [!summary]- AI 摘要"), "callout must be collapsible (the `-` suffix)");
  const parsed = parseSummaryCallout(callout);
  assert.ok(parsed);
  assert.equal(parsed.summary, text.summary);
  assert.equal(parsed.reason, text.reason);
}

// A summary with no reason should round-trip with an empty reason string,
// and must not emit a dangling "推荐理由" line.
{
  const callout = buildSummaryCallout({ summary: text.summary, reason: "" });
  assert.ok(!callout.includes("推荐理由"));
  const parsed = parseSummaryCallout(callout);
  assert.equal(parsed.summary, text.summary);
  assert.equal(parsed.reason, "");
}

// upsertSummaryCallout should insert right after frontmatter on a note
// that has never been summarized before.
{
  const note = "---\n分类: AI\n---\n\n## 正文标题\n\n这里是文章正文。\n";
  const withSummary = upsertSummaryCallout(note, text);
  assert.ok(withSummary.startsWith("---\n分类: AI\n---\n\n> [!summary]- AI 摘要"));
  assert.ok(withSummary.includes("## 正文标题"), "original body must be preserved");
  assert.ok(withSummary.trim().endsWith("这里是文章正文。"), "original body must be preserved");
}

// Re-summarizing must replace the existing callout in place, not stack a
// second one, and must not disturb the rest of the body.
{
  const note = "---\n分类: AI\n---\n\n## 正文标题\n\n这里是文章正文。\n";
  const first = upsertSummaryCallout(note, text);
  const second = upsertSummaryCallout(first, { summary: "更新后的摘要", reason: "更新后的理由" });
  assert.equal((second.match(/\[!summary\]/g) ?? []).length, 1, "must not duplicate the callout block");
  const parsed = parseSummaryCallout(second);
  assert.equal(parsed.summary, "更新后的摘要");
  assert.equal(parsed.reason, "更新后的理由");
  assert.ok(second.includes("## 正文标题"), "unrelated body content must survive re-summarization");
}

// A note with no frontmatter at all should still get the callout inserted
// at the very top, above the existing body.
{
  const note = "## 正文标题\n\n这里是文章正文。\n";
  const withSummary = upsertSummaryCallout(note, text);
  assert.ok(withSummary.startsWith("> [!summary]- AI 摘要"));
  assert.ok(withSummary.includes("## 正文标题"));
}

// A note that was never summarized should parse to null, not throw, and
// findSummaryCalloutEndIndex should likewise return null.
{
  assert.equal(parseSummaryCallout("## 正文标题\n\n这里是文章正文。\n"), null);
  assert.equal(findSummaryCalloutEndIndex("## 正文标题\n\n这里是文章正文。\n"), null);
}

// findSummaryCalloutEndIndex must point right after the callout's last
// quoted line, so other note-writing code (mermaid-service.ts) can splice
// content in immediately after the summary regardless of what follows it.
{
  const note = "---\n分类: AI\n---\n\n## 正文标题\n\n这里是文章正文。\n";
  const withSummary = upsertSummaryCallout(note, text);
  const endIndex = findSummaryCalloutEndIndex(withSummary);
  assert.ok(endIndex !== null);
  assert.equal(withSummary.slice(0, endIndex).trimEnd().endsWith(text.reason), true, "end index must land right after the callout's content");
  assert.ok(withSummary.slice(endIndex).includes("## 正文标题"), "everything after the callout must still be there");
}

await rm(tempDir, { recursive: true, force: true });
console.log("summary-notes tests passed");
