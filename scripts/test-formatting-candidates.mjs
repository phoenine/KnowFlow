import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-formatting-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/formatting-candidates.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const {
  applyFormattingDecisions,
  batchFormattingCandidates,
  collectFormattingCandidates,
  collectHeadingCandidates,
  collectCodeCandidates,
  hasSameNonWhitespaceContent,
  needsCodeReformat,
  preferTextLanguage,
  stripSequentialLineNumbers,
  trimCodeFenceBody
} = await import(pathToFileURL(join(tempDir, "formatting-candidates.js")).href);

{
  const article = [
    "正文介绍。",
    "",
    "产品经理不该按人头配齐",
    "",
    "这里解释产品经理的职责。"
  ].join("\n");
  const candidates = collectFormattingCandidates(article);
  const heading = candidates.find((candidate) => candidate.type === "possible-heading");
  assert.ok(heading);
  const formatted = applyFormattingDecisions(article, candidates, [
    { id: heading.id, action: "heading", level: 2 }
  ]);
  assert.ok(formatted.includes("## 产品经理不该按人头配齐"));
}

{
  const article = [
    "上一段正文。",
    "",
    "**人可以懒到什么地步**",
    "",
    "这里解释全自动工作流。"
  ].join("\n");
  const candidates = collectHeadingCandidates(article);
  const heading = candidates.find((candidate) => candidate.type === "possible-heading");
  assert.ok(heading);
  assert.equal(heading.content, "**人可以懒到什么地步**");
  assert.equal(heading.analysisContent, "人可以懒到什么地步");

  const formatted = applyFormattingDecisions(article, candidates, [
    { id: heading.id, action: "heading", level: 2 }
  ]);
  assert.ok(formatted.includes("## 人可以懒到什么地步"));

  const changedArticle = article.replace("**人可以懒到什么地步**", "**已被用户修改**");
  assert.equal(
    applyFormattingDecisions(changedArticle, candidates, [{ id: heading.id, action: "heading", level: 2 }]),
    changedArticle,
    "stale heading candidates must not modify changed source"
  );
}

{
  const article = [
    "## 1. 产品经理不该按人头配齐",
    "",
    "正文保持不变。"
  ].join("\n");
  const candidates = collectFormattingCandidates(article);
  assert.equal(applyFormattingDecisions(article, candidates, []), article);
  assert.ok(article.startsWith("## 1. "));
}

{
  const article = [
    "配置如下：",
    "",
    "apiVersion: v1",
    "kind: Pod",
    "metadata:",
    "  name: nginx",
    "",
    "配置结束。"
  ].join("\n");
  const candidates = collectFormattingCandidates(article);
  const code = candidates.find((candidate) => candidate.type === "possible-code");
  assert.ok(code);
  const formatted = applyFormattingDecisions(article, candidates, [
    { id: code.id, action: "wrap-code", language: "yaml" }
  ]);
  assert.ok(formatted.includes("```yaml\napiVersion: v1\nkind: Pod\nmetadata:\n  name: nginx\n```"));
}

{
  const article = [
    "> [!summary]- AI 摘要",
    "> 核心观点",
    "> - 保留摘要内容",
    "",
    "> [!question]- Quiz",
    "> [[Quiz/测试题]]"
  ].join("\n");
  const candidates = collectFormattingCandidates(article);
  assert.equal(applyFormattingDecisions(article, candidates, []), article);
}

assert.equal(
  stripSequentialLineNumbers("1type: Metric\n2title: Revenue\n3description: 收入"),
  "type: Metric\ntitle: Revenue\ndescription: 收入"
);
assert.equal(
  stripSequentialLineNumbers("1company-knowledge/\n2├── index.md\n3└── log.md"),
  "company-knowledge/\n├── index.md\n└── log.md"
);
assert.equal(
  stripSequentialLineNumbers("2024\n2025\n2026"),
  "2024\n2025\n2026",
  "non-sequential numeric content must be preserved"
);

assert.equal(
  preferTextLanguage("观测 → 轨迹 → 挖掘 → 经验 → 召回 → 运行 → 再观测"),
  true,
  "arrow-chain prose must prefer text language"
);
assert.equal(
  preferTextLanguage("const value = 1;\nexport function run() {}"),
  false,
  "real code must not prefer text language"
);
assert.equal(
  preferTextLanguage("# 中文标题\n正文内容"),
  false,
  "Chinese Markdown must remain eligible for language classification"
);
assert.equal(
  preferTextLanguage("标题: 中文\n描述: 内容"),
  false,
  "Chinese YAML must remain eligible for language classification"
);
assert.equal(
  hasSameNonWhitespaceContent("const value=1;", "const value = 1;"),
  true,
  "whitespace-only formatting must be accepted"
);
assert.equal(
  hasSameNonWhitespaceContent("const value=1;", "const value = 2;"),
  false,
  "token changes must be rejected"
);
assert.equal(
  needsCodeReformat('node scripts/search.js search \\  --query "foo" \\  --confirm'),
  true,
  "mashed backslash continuations need AI reformat"
);
assert.equal(
  needsCodeReformat("const ok = 1;\nconst also = 2;"),
  false,
  "normal indented code should not need reformat"
);
assert.equal(
  trimCodeFenceBody("\n    line1\n    line2\n"),
  "    line1\n    line2",
  "trim must preserve relative indentation"
);

{
  const article = [
    "流程如下：",
    "",
    "```js",
    "观测 → 轨迹 → 挖掘 → 经验 → 召回 → 运行 → 再观测",
    "```",
    "",
    "命令：",
    "",
    "```shell",
    'node .skills/demo/scripts/search.js search \\  --query "排查超时" \\  --confirm-outbound',
    "```"
  ].join("\n");
  const { fencedCode } = collectCodeCandidates(article);
  assert.equal(
    fencedCode.some((candidate) => candidate.content.includes("观测 →")),
    false,
    "plain-text fence must skip LLM language classification"
  );
  const mangled = fencedCode.find((candidate) => candidate.needsReformat);
  assert.ok(mangled, "mashed shell fence must be collected for AI reformat");
  assert.equal(mangled.fenceLanguage, "shell");

  const reformatted = applyFormattingDecisions(article, fencedCode, [{
    id: mangled.id,
    action: "reformat-code",
    language: "shell",
    content: [
      "node .skills/demo/scripts/search.js search \\",
      '  --query "排查超时" \\',
      "  --confirm-outbound"
    ].join("\n")
  }]);
  assert.ok(reformatted.includes("```shell\nnode .skills/demo/scripts/search.js search \\\n  --query \"排查超时\" \\\n  --confirm-outbound\n```"));

  const changedLogic = applyFormattingDecisions(article, fencedCode, [{
    id: mangled.id,
    action: "reformat-code",
    language: "shell",
    content: [
      "node .skills/demo/scripts/search.js search \\",
      '  --query "其他内容" \\',
      "  --confirm-outbound"
    ].join("\n")
  }]);
  assert.equal(changedLogic, article, "AI output that changes code content must be rejected");
}

{
  const article = [
    "```text",
    "# 中文标题",
    "正文内容",
    "```",
    "",
    "```text",
    "标题: 中文",
    "描述: 内容",
    "```"
  ].join("\n");
  const { fencedCode } = collectCodeCandidates(article);
  assert.equal(fencedCode.length, 2, "Chinese Markdown and YAML must be sent for AI classification");
}

{
  const longArticle = Array.from({ length: 80 }, (_, index) => [
    "```",
    `const value${index} = ${index};`,
    "```",
    "",
    `正文段落 ${index}，用于构成长文章。`
  ].join("\n")).join("\n\n");
  const candidates = collectFormattingCandidates(longArticle);
  assert.equal(candidates.filter((candidate) => candidate.type === "fenced-code").length, 80);
  assert.ok(candidates.some((candidate) => candidate.content.includes("value79")), "late candidates must not be truncated");
}

{
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    id: `long-${index}`,
    type: "possible-heading",
    startLine: index,
    endLine: index,
    content: `${index}-${"候选内容".repeat(180)}`,
    before: "",
    after: ""
  }));
  const batches = batchFormattingCandidates(candidates);
  assert.ok(batches.length > 1, "long candidate sets must be split into multiple requests");
  assert.deepEqual(
    batches.flat().map((candidate) => candidate.id),
    candidates.map((candidate) => candidate.id),
    "batching must preserve every candidate in order"
  );
}

await rm(tempDir, { recursive: true, force: true });
console.log("formatting candidate tests passed");
