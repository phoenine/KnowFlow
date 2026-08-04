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
  return {
    saves: 0,
    host: {
      loadData: async () => saved,
      saveData: async (data) => {
        saved = data;
      }
    },
    get data() {
      return saved;
    }
  };
}

// migrateFolder should move every record (summary/status/quiz/attempts/
// learned/pipeline history) whose path lives under the old folder, and
// should not touch records outside of it.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setSummary({
    filePath: "Articles/AI/one.md",
    title: "one",
    briefDescription: "d",
    summary: "s",
    readingValue: 4,
    recommendedAction: "deep_learn",
    category: "AI",
    reason: "r",
    tags: [],
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  await store.setSummary({
    filePath: "Articles/Other/two.md",
    title: "two",
    briefDescription: "d",
    summary: "s",
    readingValue: 2,
    recommendedAction: "skim",
    category: "Other",
    reason: "r",
    tags: [],
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  await store.setQuizzes("Articles/AI/one.md", [
    {
      id: "q1",
      notePath: "Articles/AI/one.md",
      question: "?",
      type: "single_choice",
      options: [
        { key: "A", content: "a" },
        { key: "B", content: "b" },
        { key: "C", content: "c" },
        { key: "D", content: "d" }
      ],
      answerKey: "A",
      explanation: "",
      difficulty: 3,
      createdAt: "2026-01-01T00:00:00.000Z"
    }
  ]);
  await store.addQuizAttempt({
    id: "a1",
    quizId: "q1",
    notePath: "Articles/AI/one.md",
    answerKey: "A",
    correct: true,
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  await store.markLearned("Articles/AI/one.md");

  await store.migrateFolder("Articles/AI", "Articles/人工智能");

  assert.equal(store.getSummary("Articles/AI/one.md"), null);
  const moved = store.getSummary("Articles/人工智能/one.md");
  assert.ok(moved);
  assert.equal(moved.filePath, "Articles/人工智能/one.md");

  assert.ok(store.getSummary("Articles/Other/two.md"), "unrelated folder must stay untouched");

  const movedQuizzes = store.getQuizzes("Articles/人工智能/one.md");
  assert.equal(movedQuizzes.length, 1);
  assert.equal(movedQuizzes[0].notePath, "Articles/人工智能/one.md");
  assert.equal(store.getQuizzes("Articles/AI/one.md").length, 0);

  const movedAttempts = store.getQuizAttempts("Articles/人工智能/one.md");
  assert.equal(movedAttempts.length, 1);

  assert.ok(store.isLearned("Articles/人工智能/one.md"));
  assert.ok(!store.isLearned("Articles/AI/one.md"));
}

// A folder rename should not accidentally match a sibling folder that
// merely shares a name prefix (e.g. "Articles/AI" vs "Articles/AI2").
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setSummary({
    filePath: "Articles/AI2/three.md",
    title: "three",
    briefDescription: "d",
    summary: "s",
    readingValue: 3,
    recommendedAction: "skim",
    category: "AI2",
    reason: "",
    tags: [],
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  await store.migrateFolder("Articles/AI", "Articles/人工智能");

  assert.ok(store.getSummary("Articles/AI2/three.md"), "sibling folder with shared prefix must not be migrated");
}

await rm(tempDir, { recursive: true, force: true });
console.log("store tests passed");
