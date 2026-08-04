import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

// This suite documents the known boundaries of the hand-rolled, line-based
// frontmatter parser in frontmatter-rules.ts. It is not a real YAML parser:
// it deliberately preserves raw formatting (field order, comments, Templater
// tags like <% tp.date.now(...) %>) instead of re-serializing through a YAML
// library, which would normalize/lose that formatting. These tests lock in
// what currently works and make the remaining sharp edges explicit so future
// changes don't regress them silently.

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-frontmatter-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/frontmatter-rules.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const { applyArticleFrontmatter, applySummaryFrontmatter, updateFrontmatterCategory } = await import(
  pathToFileURL(join(tempDir, "frontmatter-rules.js")).href
);

const baseData = { title: "标题", today: "2026-08-04" };

// Genuinely empty frontmatter ("---\n---\n") must still be recognized as
// frontmatter (not folded into the body) and get KnowFlow's fields filled in.
{
  const original = "---\n---\n正文内容";
  const result = applyArticleFrontmatter("正文内容", original, "", baseData);
  assert.ok(result.startsWith("---\n"), "must still detect the empty frontmatter block");
  assert.ok(result.includes("分类:\n"), "分类 must get a blank placeholder when there's no template and no AI summary yet");
  assert.ok(result.includes("正文内容"));
  assert.ok(!result.includes("---\n正文内容---"), "body must not get swallowed into the frontmatter");
}

// A note with no frontmatter at all must be left as plain content passed
// through updateFrontmatterCategory (nothing to update, no crash).
{
  const noFrontmatter = "# 标题\n\n正文";
  assert.equal(updateFrontmatterCategory(noFrontmatter, "AI"), noFrontmatter);
}

// CRLF line endings in the original file must not break field detection or
// produce mixed line-ending output.
{
  const crlfOriginal = ["---", "分类: 旧分类", "状态: false", "---", "正文"].join("\r\n");
  const result = applyArticleFrontmatter("正文", crlfOriginal, "", baseData);
  assert.ok(result.includes("分类: 旧分类"), "applyArticleFrontmatter no longer touches 分类 — it must be preserved as-is");
  assert.ok(!result.includes("\r"), "output should be normalized to \\n only");
}

// Tab-indented continuation lines under a block field must still be treated
// as part of that field's value, not mistaken for a new top-level key.
{
  const tabIndented = [
    "---",
    "学习状态:",
    "\t- 学习中",
    "分类: 旧分类",
    "---",
    "正文"
  ].join("\n");
  const result = applyArticleFrontmatter("正文", tabIndented, "", baseData);
  assert.ok(result.includes("分类: 旧分类"), "分类 must still be found intact after a tab-indented block");
  assert.ok(result.includes("学习中"), "tab-indented continuation content must be preserved, not dropped");
}

// applySummaryFrontmatter (called the moment a summary is generated) is
// what actually owns 简要描述/阅读价值/分类/tags. Inline flow-style tags
// (e.g. `tags: [a, b, c]`) must still be detected as the `tags` key and
// fully replaced with the AI's tags — KnowFlow intentionally overwrites
// the placeholder/old tags every time a summary is (re)generated (see
// formatTagsList in frontmatter-rules.ts) so Obsidian's own tag
// search/graph reflects the latest AI analysis.
{
  const inlineArray = [
    "---",
    "tags: [foo, bar, baz]",
    "分类: 旧分类",
    "---",
    "正文"
  ].join("\n");
  const result = applySummaryFrontmatter(inlineArray, { description: "描述", readingValue: 3, category: "AI", tags: ["AI", "效率"] });
  assert.ok(!result.includes("[foo, bar, baz]"), "old inline tags must be replaced, not preserved");
  assert.ok(result.includes("  - AI") && result.includes("  - 效率"), "AI tags must be written as a YAML list");
  assert.ok(result.includes("分类: AI"), "applySummaryFrontmatter does overwrite 分类 with the AI's suggestion");
}

// When the AI returns no tags, fall back to the "clippings" placeholder
// instead of leaving an empty tags field behind.
{
  const original = "---\n---\n正文";
  const result = applySummaryFrontmatter(original, { description: "描述", readingValue: 3, category: "AI", tags: [] });
  assert.ok(result.includes("  - clippings"), "must fall back to the clippings placeholder when there are no AI tags");
}

// applySummaryFrontmatter must never touch the body, even when there's no
// frontmatter block yet to begin with.
{
  const noFrontmatter = "# 标题\n\n正文内容保持不变";
  const result = applySummaryFrontmatter(noFrontmatter, { description: "描述", readingValue: 3, category: "AI", tags: [] });
  assert.ok(result.includes("# 标题\n\n正文内容保持不变"), "body must be untouched even when frontmatter had to be created");
}

// updateFrontmatterCategory (used by moveToCategory) must be a pure,
// single-field patch that leaves every other line untouched, including
// Templater expressions that are not valid standalone YAML scalars.
{
  const withTemplater = [
    "---",
    "创建日期: <% tp.date.now(\"YYYY-MM-DD\") %>",
    "分类: 旧分类",
    "---",
    "正文"
  ].join("\n");
  const result = updateFrontmatterCategory(withTemplater, "新分类");
  assert.ok(result.includes("创建日期: <% tp.date.now(\"YYYY-MM-DD\") %>"), "Templater tag must be untouched");
  assert.ok(result.includes("分类: 新分类"));
}

await rm(tempDir, { recursive: true, force: true });
console.log("frontmatter edge case tests passed");
