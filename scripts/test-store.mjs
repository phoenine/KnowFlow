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

// briefDescription/readingValue/category/tags live in the note's own
// frontmatter (written by applySummaryFrontmatter the moment a summary is
// generated) — data.json never caches them, not even transiently. This
// helper builds a full NoteSummary (what setSummary's callers pass) so
// each test below only has to state what actually matters for it.
function noteSummary(overrides) {
  return {
    filePath: "Articles/AI/one.md",
    title: "one",
    briefDescription: "d",
    summary: "s",
    readingValue: 4,
    recommendedAction: "deep_learn",
    category: "AI",
    reason: "r",
    tags: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

// setSummary must persist only recommendedAction/updatedAt — everything
// else either lives in the note's own frontmatter/callout already, or is
// derived from the file (filePath/title), so storing it again in
// data.json would just be a second, staleness-prone copy.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setSummary(noteSummary({
    filePath: "Articles/AI/one.md",
    briefDescription: "这段简要描述不该落地到 data.json。",
    summary: "这是一段不该落地到 data.json 的摘要全文。",
    reason: "这句理由也不该落地。",
    category: "AI",
    readingValue: 4,
    tags: ["Agent"]
  }));

  const stored = store.getSummary("Articles/AI/one.md");
  assert.ok(stored);
  assert.deepEqual(Object.keys(stored).sort(), ["recommendedAction", "updatedAt"]);
  assert.equal(stored.recommendedAction, "deep_learn");
  assert.equal(stored.updatedAt, "2026-01-01T00:00:00.000Z");
}

// migrateFolder should move every record (summary/status/quizNotePath/
// learned) whose path lives under the old folder, and should not touch
// records outside of it.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setSummary(noteSummary({ filePath: "Articles/AI/one.md" }));
  await store.setSummary(noteSummary({ filePath: "Articles/Other/two.md", recommendedAction: "skim" }));
  await store.setQuizNotePath("Articles/AI/one.md", "Archives/one Quiz.md");
  await store.markLearned("Articles/AI/one.md");

  await store.migrateFolder("Articles/AI", "Articles/人工智能");

  assert.equal(store.getSummary("Articles/AI/one.md"), null);
  const moved = store.getSummary("Articles/人工智能/one.md");
  assert.ok(moved);
  assert.equal(moved.recommendedAction, "deep_learn");

  assert.ok(store.getSummary("Articles/Other/two.md"), "unrelated folder must stay untouched");

  // Only the index entry moves; the quiz note file itself keeps its
  // original path on disk (quiz-note-service.ts owns that file move, if any).
  assert.equal(store.getQuizNotePath("Articles/人工智能/one.md"), "Archives/one Quiz.md");
  assert.equal(store.getQuizNotePath("Articles/AI/one.md"), null);

  assert.ok(store.isLearned("Articles/人工智能/one.md"));
  assert.ok(!store.isLearned("Articles/AI/one.md"));
}

// A folder rename should not accidentally match a sibling folder that
// merely shares a name prefix (e.g. "Articles/AI" vs "Articles/AI2").
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setSummary(noteSummary({ filePath: "Articles/AI2/three.md", recommendedAction: "skim" }));

  await store.migrateFolder("Articles/AI", "Articles/人工智能");

  assert.ok(store.getSummary("Articles/AI2/three.md"), "sibling folder with shared prefix must not be migrated");
}

// recordPipelineSuccess should persist the pipeline status.
// pipelineResults (a capped history log whose title/category/readingValue
// duplicated frontmatter and whose only reader was itself dead code) was
// removed entirely — see PipelineStatus/StoredSummaryMeta in types.ts.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();
  const before = host.saveCount;

  await store.recordPipelineSuccess({ path: "Clippings/one.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });

  assert.equal(host.saveCount - before, 1, "recordPipelineSuccess must only save once");
  assert.equal(store.getPipelineStatus("Clippings/one.md").status, "processed");
}

// recordCategoryMove should migrate the stored path in a single save. The
// category itself is never cached in data.json (it's a frontmatter-only
// field, kept current by moveToCategory's own updateFrontmatterCategory()
// call), so recordCategoryMove has nothing to do beyond migrating the key.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setSummary(noteSummary({ filePath: "Clippings/two.md", recommendedAction: "skim" }));
  const before = host.saveCount;

  await store.recordCategoryMove({ oldPath: "Clippings/two.md", newPath: "Articles/AI/two.md" });

  assert.equal(host.saveCount - before, 1, "recordCategoryMove must only save once");
  assert.equal(store.getSummary("Clippings/two.md"), null);
  const moved = store.getSummary("Articles/AI/two.md");
  assert.ok(moved);
  assert.equal(moved.recommendedAction, "skim");
}

// forgetPath should remove every record for a single deleted file, and
// leave unrelated files untouched.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setSummary(noteSummary({ filePath: "Articles/AI/one.md" }));
  await store.setQuizNotePath("Articles/AI/one.md", "Archives/one Quiz.md");
  await store.markLearned("Articles/AI/one.md");
  await store.setPipelineStatus({ path: "Articles/AI/one.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.setSummary(noteSummary({ filePath: "Articles/AI/other.md", recommendedAction: "skim" }));

  await store.forgetPath("Articles/AI/one.md");

  assert.equal(store.getSummary("Articles/AI/one.md"), null);
  assert.equal(store.getQuizNotePath("Articles/AI/one.md"), null);
  assert.ok(!store.isLearned("Articles/AI/one.md"));
  assert.equal(store.getPipelineStatus("Articles/AI/one.md").status, "raw");
  assert.ok(store.getSummary("Articles/AI/other.md"), "unrelated file must stay untouched");
}

// forgetFolder should sweep every record under a deleted folder in one
// pass, mirroring migrateFolder's single-event handling.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setSummary(noteSummary({ filePath: "Articles/AI/one.md" }));
  await store.setSummary(noteSummary({ filePath: "Articles/AI/two.md", recommendedAction: "skim" }));
  await store.setSummary(noteSummary({ filePath: "Articles/AI2/three.md", recommendedAction: "skim" }));

  await store.forgetFolder("Articles/AI");

  assert.equal(store.getSummary("Articles/AI/one.md"), null);
  assert.equal(store.getSummary("Articles/AI/two.md"), null);
  assert.ok(store.getSummary("Articles/AI2/three.md"), "sibling folder with shared prefix must not be swept");
}

// load() should surface any legacy full-text summary/reason it finds (from
// data written by older plugin versions) via takeLegacySummaryText, while
// still stripping it — along with the equally legacy briefDescription/
// readingValue/category/tags/filePath/title fields — from the in-memory
// summaries themselves. Calling it a second time must return nothing,
// since it's a one-shot drain.
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
    quizNotePaths: {},
    learnedPaths: []
  });
  const store = new KnowledgeStore(host);
  await store.load();

  const legacy = store.takeLegacySummaryText();
  assert.deepEqual(legacy, {
    "Articles/AI/legacy.md": { summary: "旧版本遗留的摘要全文", reason: "旧版本遗留的理由" }
  });
  assert.equal(Object.keys(store.takeLegacySummaryText()).length, 0, "must only drain once");

  const stored = store.getSummary("Articles/AI/legacy.md");
  assert.deepEqual(Object.keys(stored).sort(), ["recommendedAction", "updatedAt"], "every legacy field except recommendedAction/updatedAt must be stripped");
  assert.equal("pipelineResults" in store.exportData(), false, "the legacy pipelineResults array must be dropped entirely");
}

await rm(tempDir, { recursive: true, force: true });
console.log("store tests passed");
