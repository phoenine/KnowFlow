import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-chat-"));
await esbuild.build({
  bundle: true,
  entryPoints: [
    "src/services/chat-stream.ts",
    "src/services/chat-note-service.ts",
    "src/services/editor-bridge.ts"
  ],
  format: "esm",
  outdir: tempDir,
  platform: "node",
  plugins: [{
    name: "stub-obsidian",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub-obsidian" }));
      build.onLoad({ filter: /.*/, namespace: "stub-obsidian" }, () => ({
        contents: "export class MarkdownView {}\nexport const normalizePath = (value) => value;",
        loader: "js"
      }));
    }
  }]
});

const { estimateChatUsage, parseChatStreamData } = await import(
  pathToFileURL(join(tempDir, "chat-stream.js")).href
);
const { ChatNoteService, parseThread, renderThread } = await import(pathToFileURL(join(tempDir, "chat-note-service.js")).href);
const { insertBelowCursor } = await import(pathToFileURL(join(tempDir, "editor-bridge.js")).href);

assert.deepEqual(
  parseChatStreamData('{"choices":[{"delta":{"reasoning_content":"思考","content":"答案"}}]}'),
  { reasoning: "思考", content: "答案", usage: null, done: false }
);
assert.deepEqual(parseChatStreamData("[DONE]"), {
  reasoning: "",
  content: "",
  usage: null,
  done: true
});
assert.deepEqual(
  parseChatStreamData('{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}').usage,
  { promptTokens: 10, completionTokens: 4, totalTokens: 14, estimated: false }
);
assert.equal(estimateChatUsage([{ content: "123456" }], "123").totalTokens, 3);

const thread = {
  id: "chat-1",
  sourceMode: "article-detail",
  filePath: "Articles/Test.md",
  contextLabel: "测试文章",
  createdAt: "2026-08-05T10:00:00.000Z",
  updatedAt: "2026-08-05T10:01:00.000Z",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: false },
  messages: [
    { id: "u", role: "user", content: "问题", reasoning: "", createdAt: "2026-08-05T10:00:00.000Z", status: "done" },
    { id: "a", role: "assistant", content: "**回答**", reasoning: "", createdAt: "2026-08-05T10:00:01.000Z", completedAt: "2026-08-05T10:00:02.000Z", status: "done" }
  ]
};
const note = renderThread(thread);
assert.ok(note.includes("topic: \"测试文章\""));
assert.ok(note.includes("  - copilot-conversation"));
assert.ok(note.includes("**user**: 问题"));
assert.ok(note.includes("[Context: Notes: Articles/Test.md]"));
assert.ok(note.includes("**ai**:"));
assert.ok(note.includes("**回答**"));
const parsedSaved = parseThread(note, "copilot-conversations/测试文章@20260805_180000.md");
assert.equal(parsedSaved.contextLabel, "测试文章");
assert.equal(parsedSaved.filePath, "Articles/Test.md");
assert.deepEqual(parsedSaved.messages.map(({ role, content }) => ({ role, content })), [
  { role: "user", content: "问题" },
  { role: "assistant", content: "**回答**" }
]);

const copilotNote = `---
epoch: 1777368022799
modelKey: Qwen/QwQ-32B|3rd party (openai-format)
topic: Karatsuba快速乘法算法
tags:
  - copilot-conversation
lastAccessedAt: 1785911495328
---

**user**: 描述卡拉苏巴算法

[Context: Notes: Articles/算法分析/乘法.md]

[Timestamp: 2026/04/28 17:20:22]

**ai**:

这是回答。

[Timestamp: 2026/04/28 17:21:13]
`;
const parsedCopilot = parseThread(copilotNote, "copilot-conversations/Karatsuba快速乘法算法@20260428_172022.md");
assert.equal(parsedCopilot.contextLabel, "Karatsuba快速乘法算法");
assert.equal(parsedCopilot.filePath, "Articles/算法分析/乘法.md");
assert.equal(parsedCopilot.messages.length, 2);
assert.equal(parsedCopilot.messages[1].content, "这是回答。");
assert.equal(new Date(parsedCopilot.updatedAt).getTime(), 1785911495328);

{
  const inside = { path: "copilot-conversations/chat.md" };
  const outside = { path: "Notes/chat.md" };
  const service = new ChatNoteService({
    vault: {
      getMarkdownFiles: () => [inside, outside],
      cachedRead: async (file) => file === inside ? copilotNote : "not a chat"
    }
  }, "copilot-conversations");
  const history = await service.listThreads();
  assert.equal(history.length, 1);
  assert.equal(history[0].id, inside.path);
}

{
  const calls = [];
  const editor = {
    getCursor: () => ({ line: 2, ch: 3 }),
    getLine: () => "当前正文",
    replaceRange: (value, at) => calls.push(["replace", value, at]),
    setCursor: (cursor) => calls.push(["cursor", cursor]),
    focus: () => calls.push(["focus"])
  };
  const app = {
    workspace: {
      getActiveViewOfType: () => ({ file: { path: "Articles/Test.md" }, editor }),
      getLeavesOfType: () => []
    }
  };
  assert.equal(insertBelowCursor(app, "Articles/Test.md", "插入内容"), true);
  assert.deepEqual(calls[0], ["replace", "\n插入内容", { line: 2, ch: 4 }]);
  assert.equal(insertBelowCursor(app, "Articles/Other.md", "不应插入"), false);
}

// Clicking the sidebar makes it active, but insertion must still use the
// associated Markdown leaf's retained cursor.
{
  const calls = [];
  const editor = {
    getCursor: () => ({ line: 0, ch: 0 }),
    getLine: () => "正文",
    replaceRange: (value) => calls.push(value),
    setCursor: () => {},
    focus: () => {}
  };
  // The bundled Obsidian stub class is internal, so use the active-view
  // fallback in the main test above; this assertion covers the sidebar state
  // contract without coupling to that private constructor.
  const app = {
    workspace: {
      getActiveViewOfType: () => null,
      getLeavesOfType: () => [{
        view: { getViewType: () => "markdown", file: { path: "Articles/Test.md" }, editor }
      }]
    }
  };
  assert.equal(insertBelowCursor(app, "Articles/Test.md", "插入"), true);
  assert.deepEqual(calls, ["\n插入"]);
}

await rm(tempDir, { recursive: true, force: true });
console.log("chat tests passed");
