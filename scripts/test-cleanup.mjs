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
const { cleanupPromotionalNoise, removeCodeWatermarkLines } = await import(
  pathToFileURL(join(tempDir, "cleanup-rules.js")).href
);
const { applyArticleFrontmatter, applySummaryFrontmatter, updateFrontmatterCategory } = await import(
  pathToFileURL(join(tempDir, "frontmatter-rules.js")).href
);

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
assert.ok(cleanedFooter.includes("推荐阅读"), "footer headings and surrounding content must not be truncated");
assert.ok(cleanedFooter.includes("![二维码](assets/qr.png)"), "non-exact content must be preserved");
assert.ok(!cleanedFooter.includes("扫码关注公众号"));
assert.ok(!cleanedFooter.includes("阅读原文"));
assert.equal(cleanupPromotionalNoise("二维码技术原理\n广告行业分析"), "二维码技术原理\n广告行业分析");
assert.equal(cleanupPromotionalNoise("复制代码\n正文"), "复制代码\n正文", "code watermarks are not advertising");
assert.equal(removeCodeWatermarkLines("复制代码\nconst value = 1;"), "const value = 1;");
assert.equal(removeCodeWatermarkLines("这里讨论“复制代码”的功能"), "这里讨论“复制代码”的功能");

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

// applyArticleFrontmatter ("整理") deliberately does NOT touch
// 简要描述/阅读价值/分类/tags any more — those are owned exclusively by
// applySummaryFrontmatter, called the moment a summary is generated (see
// SummaryNoteService.applySummary). Re-running the pipeline must preserve
// whatever's already there (or the template's blank default if a summary
// was never generated) instead of overwriting it with stale/fallback data.
const frontmatterUpdated = applyArticleFrontmatter("正文", originalWithComplexFrontmatter, template, {
  title: "标题",
  today: "2026-08-04"
});

assert.ok(frontmatterUpdated.includes("aliases:\n  - 原别名"));
assert.ok(frontmatterUpdated.includes("custom:\n  nested: value:with:colon"));
assert.ok(frontmatterUpdated.includes("description: |\n  第一行\n  第二行"));
assert.ok(frontmatterUpdated.includes("分类: 旧分类"), "an existing 分类 must be preserved, not overwritten");
assert.ok(frontmatterUpdated.includes("简要描述:\n"), "a never-generated 简要描述 falls back to the template's blank placeholder");
assert.ok(frontmatterUpdated.includes("tags:\n"), "a never-generated tags falls back to the template's blank placeholder");
assert.ok(frontmatterUpdated.includes("学习日期:\n"));
assert.ok(frontmatterUpdated.includes("学习状态:\n  - 学习中"));
assert.ok(frontmatterUpdated.includes("状态: true"));
assert.ok(frontmatterUpdated.includes("\n正文\n"));

const preservedH1 = applyArticleFrontmatter("# 原始一级标题\n\n正文", originalWithComplexFrontmatter, template, {
  title: "标题",
  today: "2026-08-04"
});
assert.ok(preservedH1.includes("\n# 原始一级标题\n"), "article frontmatter updates must not rewrite body headings");

const movedCategory = updateFrontmatterCategory(frontmatterUpdated, "知识积累");
assert.ok(movedCategory.includes("分类: 知识积累"));
assert.ok(movedCategory.includes("description: |\n  第一行\n  第二行"));

// applySummaryFrontmatter is what actually writes the AI's analysis into
// frontmatter, the moment a summary is generated — before "整理" ever
// runs. It must only touch these four keys, leaving everything else
// (including the body) completely alone.
{
  const original = [
    "---",
    "创建日期: 2026-08-01",
    "分类: 旧分类",
    "学习状态:",
    "  - 学习中",
    "---",
    "# 原文标题",
    "正文内容"
  ].join("\n");

  const withSummary = applySummaryFrontmatter(original, {
    description: "新的描述: 保留冒号",
    readingValue: 4,
    category: "系统架构",
    tags: ["架构", "系统设计"]
  });

  assert.ok(withSummary.includes("简要描述: \"新的描述: 保留冒号\""));
  assert.ok(withSummary.includes("阅读价值: 4"));
  assert.ok(withSummary.includes("分类: 系统架构"), "applySummaryFrontmatter overwrites 分类 with the AI's suggestion");
  assert.ok(withSummary.includes("tags:\n  - 架构\n  - 系统设计"));
  assert.ok(withSummary.includes("创建日期: 2026-08-01"), "fields it doesn't own must be untouched");
  assert.ok(withSummary.includes("学习状态:\n  - 学习中"), "fields it doesn't own must be untouched");
  assert.ok(withSummary.includes("# 原文标题\n正文内容"), "the body must be completely untouched");
}

{
  const withTags = applySummaryFrontmatter("---\n分类: 测试\n---\n正文", {
    description: "测试",
    readingValue: 3,
    category: "知识积累",
    tags: ["product management", "#AI tools", "AI tools"]
  });
  assert.ok(withTags.includes("  - product-management"));
  assert.ok(withTags.includes("  - AI-tools"));
  assert.equal((withTags.match(/  - AI-tools/g) ?? []).length, 1);
  assert.ok(!withTags.includes("product management"));
}

await rm(tempDir, { recursive: true, force: true });
console.log("cleanup tests passed");
