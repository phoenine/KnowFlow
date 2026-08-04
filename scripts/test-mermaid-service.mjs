import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

// mermaid-service.ts imports the "obsidian" package, which only exists
// inside the Obsidian runtime — stub it out so the module can be bundled
// and exercised here like the other pure-logic services.
const obsidianStub = "export class Notice {}\nexport class TFile {}\n";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-mermaid-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/mermaid-service.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node",
  plugins: [
    {
      name: "stub-obsidian",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub-obsidian" }));
        build.onLoad({ filter: /.*/, namespace: "stub-obsidian" }, () => ({ contents: obsidianStub, loader: "js" }));
      }
    }
  ]
});
const { MermaidService } = await import(pathToFileURL(join(tempDir, "mermaid-service.js")).href);

// When the note already has an AI summary callout, the Knowledge Map must
// be inserted immediately after it — not just appended to the end of the
// file — so it always reads "AI summary, then knowledge map" regardless
// of what other content follows the summary.
{
  const note = [
    "---",
    "分类: AI",
    "---",
    "",
    "> [!summary]- AI 摘要",
    "> 这是摘要正文。",
    ">",
    "> **推荐理由**：值得深入学习。",
    "",
    "## 正文标题",
    "",
    "这里是文章正文，摘要生成之后才会出现的内容。"
  ].join("\n");

  const result = await callUpsertKnowledgeMap(note);

  const summaryEnd = result.indexOf("## Knowledge Map");
  const bodyStart = result.indexOf("## 正文标题");
  assert.ok(summaryEnd > 0, "Knowledge Map block must be present");
  assert.ok(summaryEnd < bodyStart, "Knowledge Map must sit between the AI summary and the rest of the body");
  assert.ok(result.indexOf("**推荐理由**") < summaryEnd, "Knowledge Map must come after the summary, not before it");
}

// With no summary callout, fall back to appending at the very end (the
// pre-existing behavior for notes that were never AI-summarized).
{
  const note = "## 正文标题\n\n这里是文章正文。";
  const result = await callUpsertKnowledgeMap(note);
  assert.ok(result.trimEnd().endsWith("```"), "Knowledge Map must be appended at the end when there's no summary");
  assert.ok(result.indexOf("## 正文标题") < result.indexOf("## Knowledge Map"));
}

// Re-running generateForFile on a note that already has a Knowledge Map
// must replace it in place, not duplicate it, regardless of where it sits.
{
  const note = [
    "> [!summary]- AI 摘要",
    "> 摘要正文。",
    "",
    "## Knowledge Map",
    "",
    "```mermaid",
    "mindmap",
    "  root((旧的))",
    "```",
    "",
    "## 正文标题",
    "",
    "正文。"
  ].join("\n");
  const result = await callUpsertKnowledgeMap(note);
  assert.equal((result.match(/## Knowledge Map/g) ?? []).length, 1, "must not duplicate the section");
  assert.ok(!result.includes("root((旧的))"), "old mermaid content must be replaced");
}

async function callUpsertKnowledgeMap(content) {
  // Exercise the same code path generateForFile() uses, via a throwaway
  // TFile-like object and a vault stub that just records the write.
  let written = null;
  const app = {
    vault: {
      read: async () => content,
      modify: async (_file, next) => {
        written = next;
      }
    }
  };
  const svc = new MermaidService(app);
  await svc.generateForFile({ basename: "标题" });
  return written;
}

await rm(tempDir, { recursive: true, force: true });
console.log("mermaid-service tests passed");
