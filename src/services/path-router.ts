import { TFolder } from "obsidian";
import type { App, TFile } from "obsidian";
import type { KnowFlowSettings, ViewContext } from "../types";

function normalize(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function isUnder(path: string, folder: string): boolean {
  const cleanFolder = normalize(folder);
  return path === cleanFolder || path.startsWith(`${cleanFolder}/`);
}

export class PathRouter {
  constructor(
    private app: App,
    private settings: KnowFlowSettings
  ) {}

  updateSettings(settings: KnowFlowSettings): void {
    this.settings = settings;
  }

  getContext(): ViewContext {
    const activeFile = this.app.workspace.getActiveFile();
    const selectedPath = this.getSelectedPath();
    const selectedItem = selectedPath ? this.app.vault.getAbstractFileByPath(selectedPath) : null;

    if (selectedPath && selectedItem instanceof TFolder && isUnder(selectedPath, this.settings.articlesFolder)) {
      return { mode: "articles-overview", activeFile: null, selectedPath };
    }

    if (activeFile) {
      if (isUnder(activeFile.path, this.settings.clippingFolder)) {
        return { mode: "clipping", activeFile, selectedPath };
      }

      if (isUnder(activeFile.path, this.settings.articlesFolder)) {
        return { mode: "article-detail", activeFile, selectedPath };
      }
    }

    if (selectedPath && isUnder(selectedPath, this.settings.articlesFolder)) {
      return { mode: "articles-overview", activeFile: null, selectedPath };
    }

    return { mode: "articles-overview", activeFile: null, selectedPath: this.settings.articlesFolder };
  }

  private getSelectedPath(): string | null {
    // `fileItems`/`selfEl` are undocumented internals of Obsidian's built-in
    // file-explorer view, not part of the public Obsidian API. They can
    // change or disappear across Obsidian versions, or simply be unavailable
    // if the core file-explorer plugin is disabled. All lookups below are
    // defensive (optional chaining, null fallback) so a breakage here just
    // degrades to "no explorer selection detected" instead of throwing.
    const fileExplorer = this.app.workspace.getLeavesOfType("file-explorer")[0];
    const view = fileExplorer?.view as unknown as { fileItems?: Record<string, { selfEl?: HTMLElement }> };
    const fileItems = view?.fileItems;
    if (!fileItems) return null;

    for (const [path, item] of Object.entries(fileItems)) {
      if (item.selfEl?.hasClass("is-active")) {
        return path;
      }
    }

    return null;
  }
}
