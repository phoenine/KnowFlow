import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-translation-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/translation-candidates.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const {
  applyTranslationDecisions,
  batchTranslationCandidates,
  collectTranslationCandidates,
  isPredominantlyEnglishArticle
} = await import(pathToFileURL(join(tempDir, "translation-candidates.js")).href);

const english = [
  "# Reliable distributed systems",
  "",
  "Distributed systems are difficult because independent components can fail in many different ways.",
  "",
  "A good design makes failure explicit and keeps recovery operations safe to repeat.",
  "",
  "```ts",
  "const message = 'do not translate code';",
  "```",
  "",
  "> [!note] Keep this callout unchanged",
  "> This content is managed as an Obsidian structure."
].join("\n");

assert.equal(isPredominantlyEnglishArticle(english), true);
assert.equal(
  isPredominantlyEnglishArticle(`${english}\n\n分布式系统必须明确处理失败，并保证恢复操作可以安全重试。`),
  false,
  "bilingual content must not be translated again"
);

const candidates = collectTranslationCandidates(english);
assert.equal(candidates.length, 2);
assert.ok(candidates.every((candidate) => !candidate.content.includes("do not translate code")));
assert.ok(candidates.every((candidate) => !candidate.content.includes("callout")));

const translated = applyTranslationDecisions(english, candidates, [
  { id: candidates[0].id, translation: "分布式系统很困难，因为独立组件可能以多种不同方式发生故障。" },
  { id: candidates[1].id, translation: "良好的设计会明确呈现故障，并确保恢复操作可以安全地重复执行。" }
]);
assert.ok(translated.includes(`${candidates[0].content}\n\n分布式系统很困难`));
assert.ok(translated.includes("```ts\nconst message = 'do not translate code';\n```"));
assert.ok(translated.includes("> [!note] Keep this callout unchanged"));

assert.deepEqual(
  batchTranslationCandidates(Array.from({ length: 30 }, (_, index) => ({
    id: `translation-${index}`,
    startLine: index,
    endLine: index,
    content: "A".repeat(1000)
  }))).flat().map((candidate) => candidate.id),
  Array.from({ length: 30 }, (_, index) => `translation-${index}`)
);

await rm(tempDir, { recursive: true, force: true });
console.log("translation candidate tests passed");
