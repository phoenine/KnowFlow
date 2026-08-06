import { MarkdownView } from "obsidian";
import type { App } from "obsidian";

export function insertBelowCursor(app: App, expectedPath: string | null, markdown: string): boolean {
  const activeView = app.workspace.getActiveViewOfType(MarkdownView);
  const view = activeView && (!expectedPath || activeView.file?.path === expectedPath)
    ? activeView
    : app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find((candidate) =>
        candidate.getViewType() === "markdown"
        && (!expectedPath || (candidate as MarkdownView).file?.path === expectedPath)
      ) as MarkdownView | undefined;
  if (!view || !markdown.trim()) return false;

  const editor = view.editor;
  const cursor = editor.getCursor("head");
  const insertAt = { line: cursor.line, ch: editor.getLine(cursor.line).length };
  const value = `\n${markdown.trim()}`;
  editor.replaceRange(value, insertAt);
  const insertedLines = value.split("\n");
  editor.setCursor({
    line: insertAt.line + insertedLines.length - 1,
    ch: insertedLines.at(-1)?.length ?? 0
  });
  editor.focus();
  return true;
}
