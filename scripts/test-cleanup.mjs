import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-cleanup-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/cleanup-rules.ts", "src/services/frontmatter-rules.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const { cleanupPromotionalNoise } = await import(pathToFileURL(join(tempDir, "cleanup-rules.js")).href);
const { applyArticleFrontmatter, updateFrontmatterCategory } = await import(pathToFileURL(join(tempDir, "frontmatter-rules.js")).href);

const articleWithRealRecommendation = [
  "## 背景",
  "这是一篇正常正文。",
  "",
  "## 推荐阅读",
  "这里推荐继续阅读原文中提到的论文和实现细节。",
  "这仍然是正文的一部分。",
  "",
  "## 总结",
  "文章结论需要保留。"
].join("\n");

assert.equal(cleanupPromotionalNoise(articleWithRealRecommendation), articleWithRealRecommendation);

const articleWithFooter = [
  "## 背景",
  ...Array.from({ length: 30 }, (_, index) => `正文段落 ${index + 1}`),
  "",
  "推荐阅读",
  "扫码关注公众号",
  "![二维码](assets/qr.png)",
  "阅读原文"
].join("\n");

const cleanedFooter = cleanupPromotionalNoise(articleWithFooter);
assert.ok(cleanedFooter.includes("正文段落 30"));
assert.ok(!cleanedFooter.includes("推荐阅读"));
assert.ok(!cleanedFooter.includes("二维码"));

const template = [
  "---",
  "创建日期: <% tp.date.now(\"YYYY-MM-DD\") %>",
  "简要描述:",
  "阅读价值:",
  "文章作者:",
  "分类:",
  "tags:",
  "网址:",
  "学习日期: <% tp.date.now(\"YYYY-MM-DD\") %>",
  "学习状态:",
  "  - 未学习",
  "状态: false",
  "---"
].join("\n");

const originalWithComplexFrontmatter = [
  "---",
  "aliases:",
  "  - 原别名",
  "custom:",
  "  nested: value:with:colon",
  "description: |",
  "  第一行",
  "  第二行",
  "分类: 旧分类",
  "学习日期: <% tp.date.now(\"YYYY-MM-DD\") %>",
  "学习状态:",
  "  - 学习中",
  "状态: false",
  "---",
  "# 原文标题",
  "正文"
].join("\n");

const frontmatterUpdated = applyArticleFrontmatter("正文", originalWithComplexFrontmatter, template, {
  title: "标题",
  description: "新的描述: 保留冒号",
  readingValue: 4,
  category: "系统架构",
  today: "2026-08-04"
});

assert.ok(frontmatterUpdated.includes("aliases:\n  - 原别名"));
assert.ok(frontmatterUpdated.includes("custom:\n  nested: value:with:colon"));
assert.ok(frontmatterUpdated.includes("description: |\n  第一行\n  第二行"));
assert.ok(frontmatterUpdated.includes("简要描述: \"新的描述: 保留冒号\""));
assert.ok(frontmatterUpdated.includes("阅读价值: 4"));
assert.ok(frontmatterUpdated.includes("分类: 系统架构"));
assert.ok(frontmatterUpdated.includes("学习日期:\n"));
assert.ok(frontmatterUpdated.includes("学习状态:\n  - 学习中"));
assert.ok(frontmatterUpdated.includes("状态: true"));
assert.ok(frontmatterUpdated.includes("\n正文\n"));

const movedCategory = updateFrontmatterCategory(frontmatterUpdated, "知识积累");
assert.ok(movedCategory.includes("分类: 知识积累"));
assert.ok(movedCategory.includes("description: |\n  第一行\n  第二行"));

await rm(tempDir, { recursive: true, force: true });
console.log("cleanup tests passed");
