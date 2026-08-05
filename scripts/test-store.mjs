import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-store-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/store.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const { KnowledgeStore } = await import(pathToFileURL(join(tempDir, "store.js")).href);

function createHost(initial) {
  let saved = initial;
  const host = {
    saveCount: 0,
    loadData: async () => saved,
    saveData: async (data) => {
      host.saveCount += 1;
      saved = data;
    }
  };
  return { host };
}

// migrateFolder should move every path-keyed status/learned record whose
// path lives under the old folder, and should not touch
// records outside of it.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setPipelineStatus({ path: "Articles/AI/one.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.setPipelineStatus({ path: "Articles/Other/two.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.markLearned("Articles/AI/one.md");

  await store.migrateFolder("Articles/AI", "Articles/人工智能");

  assert.equal(store.getPipelineStatus("Articles/AI/one.md").status, "raw");
  assert.equal(store.getPipelineStatus("Articles/人工智能/one.md").status, "processed");
  assert.equal(store.getPipelineStatus("Articles/Other/two.md").status, "processed", "unrelated folder must stay untouched");

  assert.ok(store.isLearned("Articles/人工智能/one.md"));
  assert.ok(!store.isLearned("Articles/AI/one.md"));
}

// A folder rename should not accidentally match a sibling folder that
// merely shares a name prefix (e.g. "Articles/AI" vs "Articles/AI2").
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setPipelineStatus({ path: "Articles/AI2/three.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });

  await store.migrateFolder("Articles/AI", "Articles/人工智能");

  assert.equal(store.getPipelineStatus("Articles/AI2/three.md").status, "processed", "sibling folder with shared prefix must not be migrated");
}

// recordPipelineSuccess should persist the pipeline status.
// pipelineResults (a capped history log whose title/category/readingValue
// duplicated frontmatter and whose only reader was itself dead code) was
// removed entirely.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();
  const before = host.saveCount;

  await store.recordPipelineSuccess({ path: "Clippings/one.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });

  assert.equal(host.saveCount - before, 1, "recordPipelineSuccess must only save once");
  assert.equal(store.getPipelineStatus("Clippings/one.md").status, "processed");
}

// A category move should retain non-pipeline state but delete pipeline
// status from both the old clipping path and the new article path.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setPipelineStatus({ path: "Clippings/two.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.markLearned("Clippings/two.md");
  const before = host.saveCount;

  await store.recordCategoryMove({ oldPath: "Clippings/two.md", newPath: "Articles/AI/two.md" });

  assert.equal(host.saveCount - before, 1, "recordCategoryMove must only save once");
  assert.equal(store.getPipelineStatus("Clippings/two.md").status, "raw");
  assert.equal(store.getPipelineStatus("Articles/AI/two.md").status, "raw");
  assert.ok(store.isLearned("Articles/AI/two.md"));
}

// The result must be the same when Obsidian's rename event migrated state
// before recordCategoryMove runs.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();
  await store.setPipelineStatus({ path: "Clippings/race.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.migratePath("Clippings/race.md", "Articles/AI/race.md");
  const before = host.saveCount;

  await store.recordCategoryMove({ oldPath: "Clippings/race.md", newPath: "Articles/AI/race.md" });

  assert.equal(host.saveCount - before, 1);
  assert.equal(store.getPipelineStatus("Clippings/race.md").status, "raw");
  assert.equal(store.getPipelineStatus("Articles/AI/race.md").status, "raw");
}

// forgetPath should remove every record for a single deleted file, and
// leave unrelated files untouched.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.markLearned("Articles/AI/one.md");
  await store.setPipelineStatus({ path: "Articles/AI/one.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.setPipelineStatus({ path: "Articles/AI/other.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });

  await store.forgetPath("Articles/AI/one.md");

  assert.ok(!store.isLearned("Articles/AI/one.md"));
  assert.equal(store.getPipelineStatus("Articles/AI/one.md").status, "raw");
  assert.equal(store.getPipelineStatus("Articles/AI/other.md").status, "processed", "unrelated file must stay untouched");
}

// forgetFolder should sweep every record under a deleted folder in one
// pass, mirroring migrateFolder's single-event handling.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setPipelineStatus({ path: "Articles/AI/one.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.setPipelineStatus({ path: "Articles/AI/two.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.setPipelineStatus({ path: "Articles/AI2/three.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });

  await store.forgetFolder("Articles/AI");

  assert.equal(store.getPipelineStatus("Articles/AI/one.md").status, "raw");
  assert.equal(store.getPipelineStatus("Articles/AI/two.md").status, "raw");
  assert.equal(store.getPipelineStatus("Articles/AI2/three.md").status, "processed", "sibling folder with shared prefix must not be swept");
}

// load() should discard the obsolete summaries index without migrating it.
{
  const { host } = createHost({
    summaries: {
      "Articles/AI/legacy.md": {
        filePath: "Articles/AI/legacy.md",
        title: "legacy",
        briefDescription: "d",
        summary: "旧版本遗留的摘要全文",
        readingValue: 3,
        recommendedAction: "skim",
        category: "AI",
        reason: "旧版本遗留的理由",
        tags: [],
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    },
    // A leftover pipelineResults array from an older plugin version — load()
    // must drop it outright, the same way it already drops quizzes/
    // quizAttempts/quizStats (see load() in store.ts).
    pipelineResults: [{ sourcePath: "a.md", targetPath: "a.md", title: "a", category: "AI", readingValue: 3, updatedAt: "2026-01-01T00:00:00.000Z" }],
    pipelineStatuses: {},
    quizNotePaths: { "Articles/AI/legacy.md": "Archives/legacy Quiz.md" },
    learnedPaths: []
  });
  const store = new KnowledgeStore(host);
  await store.load();

  assert.equal("summaries" in store.exportData(), false, "the obsolete summaries index must be dropped entirely");
  assert.equal("quizNotePaths" in store.exportData(), false, "the obsolete quizNotePaths index must be dropped entirely");
  assert.equal("pipelineResults" in store.exportData(), false, "the legacy pipelineResults array must be dropped entirely");
}

await rm(tempDir, { recursive: true, force: true });
console.log("store tests passed");
