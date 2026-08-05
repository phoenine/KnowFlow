import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-quiz-notes-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/quiz-notes.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const { buildQuizCallout, buildQuizNoteContent, parseQuizCallout, parseQuizNote, computeQuizStats, applyQuizAnswer, setExamPassed, sanitizeQuizFileName, updateQuizSourcePath, upsertQuizCallout } = await import(
  pathToFileURL(join(tempDir, "quiz-notes.js")).href
);

const notePath = "Articles/AI/示例文章.md";
const questions = [
  {
    id: "ignored-on-build",
    notePath,
    question: "第一题：Nano-vLLM 的 Scheduler 采用什么模式？",
    type: "single_choice",
    options: [
      { key: "A", content: "生产者-消费者" },
      { key: "B", content: "发布-订阅" },
      { key: "C", content: "单例" },
      { key: "D", content: "观察者" }
    ],
    answerKey: "A",
    explanation: "文章第二段说明 Scheduler 用生产者-消费者模式。\n第二行解析，测试多行折叠为单行。",
    difficulty: 4,
    createdAt: "2026-08-01T00:00:00.000Z"
  },
  {
    id: "ignored-on-build-2",
    notePath,
    question: "第二题：以下哪个不属于 KV Cache 的作用？",
    type: "single_choice",
    options: [
      { key: "A", content: "加速推理" },
      { key: "B", content: "降低显存占用" },
      { key: "C", content: "避免重复计算" },
      { key: "D", content: "支持前缀缓存" }
    ],
    answerKey: "B",
    explanation: "KV Cache 用显存换计算，本身会增加显存占用，不会降低。",
    difficulty: 3,
    createdAt: "2026-08-01T00:00:00.000Z"
  }
];

const meta = { sourcePath: notePath, category: "AI", createdAt: "2026-08-01T00:00:00.000Z" };

// The note must follow the vault's pre-existing study-quiz convention
// (frontmatter fields, <!-- study-quiz:start/end --> markers, ```Answer
// fold``` blocks) so it stays readable by that skill and by the Daily-Quiz
// Templater script that already scans Archives/ for this exact shape.
let content = buildQuizNoteContent(meta, questions);
assert.ok(content.startsWith("---\n"));
assert.ok(content.includes("考试日期: 2026-08-01"));
assert.ok(content.includes("分类:\n  - AI"));
assert.ok(content.includes('原文: "[[Articles/AI/示例文章]]"'));
assert.ok(content.includes("考试结果: false"));
assert.ok(content.includes("<!-- study-quiz:start -->"));
assert.ok(content.includes("<!-- study-quiz:end -->"));
assert.ok(content.includes("```Answer fold"));
assert.ok(content.includes("- 答案：A"));
assert.ok(content.includes("- 难度：4/5"));
// Multi-line explanations must collapse to a single line, matching the
// "- 解析：..." single-line convention the Templater script parses.
assert.ok(content.includes("- 解析：文章第二段说明 Scheduler 用生产者-消费者模式。 第二行解析，测试多行折叠为单行。"));

// The source article owns the Quiz index as one managed callout at its end.
{
  const source = "---\n分类: AI\n---\n\n## 正文\n\n文章内容。\n";
  const withQuiz = upsertQuizCallout(source, "Archives/2026-08-05_示例文章_Quiz.md");
  assert.ok(withQuiz.endsWith(`${buildQuizCallout("Archives/2026-08-05_示例文章_Quiz.md")}\n`));
  assert.equal(parseQuizCallout(withQuiz), "Archives/2026-08-05_示例文章_Quiz.md");

  const refreshed = upsertQuizCallout(withQuiz, "Archives/2026-08-06_新试题_Quiz.md");
  assert.equal(parseQuizCallout(refreshed), "Archives/2026-08-06_新试题_Quiz.md");
  assert.equal((refreshed.match(/> \[!question\][+-]? Quiz$/gm) ?? []).length, 1);
  assert.ok(!refreshed.includes("2026-08-05_示例文章_Quiz"));

  const unrelated = "> [!question]- 复习问题\n> 用户自己的内容。\n";
  assert.equal(parseQuizCallout(unrelated), null);
}

// Renaming the source article must update only the quiz note's 原文 wikilink.
{
  const renamed = updateQuizSourcePath(content, "Articles/AI/重命名后的文章.md");
  assert.ok(renamed.includes('原文: "[[Articles/AI/重命名后的文章]]"'));
  assert.ok(!renamed.includes('原文: "[[Articles/AI/示例文章]]"'));
  assert.ok(renamed.includes("<!-- study-quiz:start -->"), "quiz body must survive source-link updates");
  assert.equal(updateQuizSourcePath("# 普通笔记", "Articles/AI/新文章.md"), "# 普通笔记");
}

let parsed = parseQuizNote(content, notePath);
assert.equal(parsed.length, 2);
assert.equal(parsed[0].id, "q1");
assert.equal(parsed[0].question, "第一题：Nano-vLLM 的 Scheduler 采用什么模式？");
assert.deepEqual(parsed[0].options.map((o) => o.key), ["A", "B", "C", "D"]);
assert.equal(parsed[0].answerKey, "A");
assert.equal(parsed[0].difficulty, 4);
assert.equal(parsed[1].answerKey, "B");
assert.equal(parsed[1].explanation, "KV Cache 用显存换计算，本身会增加显存占用，不会降低。");
assert.equal(parsed[0].createdAt, "2026-08-01");

// Before any answer, stats must report "not started" (accuracy null).
let stats = computeQuizStats(content);
assert.equal(stats.total, 2);
assert.equal(stats.answered, 0);
assert.equal(stats.accuracy, null);
assert.equal(stats.wrong, 0);

// Answering question 1 correctly (A) must only touch question 1's lines.
content = applyQuizAnswer(content, 1, "A", true, "2026-08-04");
assert.ok(content.includes("- [x] A. 生产者-消费者 ✅ 2026-08-04"));
assert.ok(content.includes("- [ ] B. 发布-订阅"));
// Question 2 must be untouched.
assert.ok(content.includes("- [ ] A. 加速推理"));
assert.ok(content.includes("- [ ] B. 降低显存占用"));

stats = computeQuizStats(content);
assert.equal(stats.total, 2);
assert.equal(stats.answered, 1);
assert.equal(stats.accuracy, 100);
assert.equal(stats.wrong, 0);

// Answering question 2 incorrectly (A, correct is B) must mark it wrong and
// bring the aggregate accuracy down without disturbing question 1's answer.
content = applyQuizAnswer(content, 2, "A", false, "2026-08-04");
assert.ok(content.includes("- [x] A. 加速推理 ❌ 2026-08-04"));
assert.ok(content.includes("- [x] A. 生产者-消费者 ✅ 2026-08-04"), "question 1's answer must survive patching question 2");

stats = computeQuizStats(content);
assert.equal(stats.total, 2);
assert.equal(stats.answered, 2);
assert.equal(stats.accuracy, 50);
assert.equal(stats.wrong, 1);

// Re-answering question 2 (changing the pick) must clear the old mark, not
// append a second one.
content = applyQuizAnswer(content, 2, "B", true, "2026-08-05");
assert.ok(content.includes("- [x] B. 降低显存占用 ✅ 2026-08-05"));
assert.ok(!content.includes("❌"), "the stale wrong-answer mark must be cleared on re-answer");
assert.equal(content.match(/\[x\]/g)?.length, 2, "exactly one option per question should remain checked");

stats = computeQuizStats(content);
assert.equal(stats.answered, 2);
assert.equal(stats.accuracy, 100);

// Re-parsing after answers were recorded must still reproduce the same
// question bank (answers live in checkbox state, not in the parsed fields).
parsed = parseQuizNote(content, notePath);
assert.equal(parsed.length, 2);
assert.equal(parsed[1].answerKey, "B");

// setExamPassed patches only the "考试结果" line, in place.
content = setExamPassed(content, true);
assert.ok(content.includes("考试结果: true"));
assert.ok(!content.includes("考试结果: false"));
assert.ok(content.includes("分类:\n  - AI"), "unrelated frontmatter fields must survive setExamPassed");

// A note with no quiz markers at all (e.g. the user's own note) must not crash.
assert.deepEqual(parseQuizNote("# 普通笔记\n\n没有 quiz。", notePath), []);
assert.deepEqual(computeQuizStats("# 普通笔记"), { total: 0, answered: 0, accuracy: null, wrong: 0 });

// Filenames must strip filesystem-unsafe characters.
assert.equal(sanitizeQuizFileName('A/B: "C" <D>|E?'), "A-B- -C- -D--E-");
assert.equal(sanitizeQuizFileName("   "), "Untitled");

await rm(tempDir, { recursive: true, force: true });
console.log("quiz-notes tests passed");
