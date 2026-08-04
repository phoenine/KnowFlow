import { Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { AiService } from "./services/ai-service";
import { ClippingPipeline } from "./services/clipping-pipeline";
import { MermaidService } from "./services/mermaid-service";
import { PathRouter } from "./services/path-router";
import { PluginDataManager } from "./services/plugin-data-manager";
import { QuizNoteService } from "./services/quiz-note-service";
import { KnowledgeStore } from "./services/store";
import { SummaryNoteService } from "./services/summary-note-service";
import { DEFAULT_SETTINGS, KnowFlowSettingTab } from "./settings";
import { KNOWFLOW_VIEW_TYPE, type AiModelConfig, type KnowFlowSettings } from "./types";
import { KnowFlowSidebarView } from "./ui/sidebar-view";

export default class KnowFlowPlugin extends Plugin {
  settings: KnowFlowSettings;
  store: KnowledgeStore;
  router: PathRouter;
  ai: AiService;
  mermaid: MermaidService;
  pipeline: ClippingPipeline;
  quizNotes: QuizNoteService;
  summaryNotes: SummaryNoteService;
  private dataManager: PluginDataManager;

  async onload(): Promise<void> {
    this.dataManager = new PluginDataManager(this);
    await this.loadSettings();

    this.store = new KnowledgeStore({
      loadData: async () => {
        const root = await this.dataManager.read();
        return root.store;
      },
      saveData: async (storeData: unknown) => {
        await this.dataManager.update((root) => ({ ...root, store: storeData }));
      }
    });
    await this.store.load();
    this.ai = new AiService(this.settings);
    this.mermaid = new MermaidService(this.app);
    this.router = new PathRouter(this.app, this.settings);
    this.pipeline = new ClippingPipeline(this.app, this.settings, this.store, this.ai);
    this.quizNotes = new QuizNoteService(this.app, this.settings, this.store);
    this.summaryNotes = new SummaryNoteService(this.app);
    await this.migrateLegacySummaryText();

    this.registerView(KNOWFLOW_VIEW_TYPE, (leaf) => new KnowFlowSidebarView(leaf, this));

    this.addRibbonIcon("brain", "Open KnowFlow", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-knowflow-sidebar",
      name: "Open sidebar",
      callback: () => void this.activateView()
    });

    this.addCommand({
      id: "process-current-clipping",
      name: "Process current clipping",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("No active file");
          return;
        }
        await this.pipeline.process(file);
        this.refreshView();
      }
    });

    this.addCommand({
      id: "generate-current-knowledge-map",
      name: "Generate current article knowledge map",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("No active file");
          return;
        }
        await this.mermaid.generateForFile(file);
        this.refreshView();
      }
    });

    this.addCommand({
      id: "refresh-knowflow",
      name: "Refresh sidebar",
      callback: () => this.refreshView()
    });

    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf?.view instanceof KnowFlowSidebarView) return;
      this.refreshView();
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshView()));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) {
        void this.store.migratePath(oldPath, file.path).then(() => this.refreshView());
        return;
      }
      if (file instanceof TFolder) {
        // Obsidian fires a single rename event for the folder itself; it does
        // not emit separate events for each descendant file, so any stored
        // summaries/quizzes/learning state keyed by those old file paths must
        // be migrated here or they become permanently orphaned.
        void this.store.migrateFolder(oldPath, file.path).then(() => this.refreshView());
        return;
      }
      this.refreshView();
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile) {
        void this.store.forgetPath(file.path).then(() => this.refreshView());
        return;
      }
      if (file instanceof TFolder) {
        // Same "single event for the folder itself" caveat as rename above:
        // clean up every stored record under the deleted folder in one pass.
        void this.store.forgetFolder(file.path).then(() => this.refreshView());
        return;
      }
      this.refreshView();
    }));

    this.addSettingTab(new KnowFlowSettingTab(this.app, this));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(KNOWFLOW_VIEW_TYPE);
  }

  /**
   * One-time upgrade path: older plugin versions stored the full AI
   * summary/reason text in data.json. That text now lives in each note's
   * own callout instead (see summary-notes.ts), so any such text found by
   * store.load() is written into its note here, rather than being
   * silently dropped the first time this version runs.
   */
  private async migrateLegacySummaryText(): Promise<void> {
    const legacy = this.store.takeLegacySummaryText();
    const paths = Object.keys(legacy);
    if (paths.length === 0) return;

    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.summaryNotes.applySummary(file, legacy[path]);
      }
    }
    // Persist now so the stripped-down summaries (without the migrated
    // text) are what's on disk, even if the user never saves anything else.
    await this.store.save();
  }

  async loadSettings(): Promise<void> {
    const root = await this.dataManager.read();
    const savedSettings = "settings" in root ? (root as { settings?: Partial<KnowFlowSettings> }).settings : root;
    this.settings = normalizeSettings(savedSettings);
  }

  async saveSettings(): Promise<void> {
    await this.dataManager.update((root) => ({ ...root, settings: this.settings }));
    this.router?.updateSettings(this.settings);
    this.ai?.updateSettings(this.settings);
    this.pipeline?.updateSettings(this.settings);
    this.quizNotes?.updateSettings(this.settings);
    this.refreshView();
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(KNOWFLOW_VIEW_TYPE)[0];
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      this.refreshView();
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false) as WorkspaceLeaf;
    await leaf.setViewState({ type: KNOWFLOW_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  refreshView(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(KNOWFLOW_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof KnowFlowSidebarView) {
        view.render();
      }
    }
  }
}

function normalizeSettings(savedSettings: unknown): KnowFlowSettings {
  const saved = savedSettings && typeof savedSettings === "object" ? savedSettings as Record<string, unknown> : {};
  const legacyRuntime = typeof saved.aiProvider === "string" ? saved.aiProvider : undefined;
  const legacyBaseUrl = typeof saved.apiBaseUrl === "string" ? saved.apiBaseUrl : undefined;
  const legacyApiKey = typeof saved.apiKey === "string" ? saved.apiKey : undefined;

  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    summaryModel: normalizeModelConfig(saved.summaryModel, DEFAULT_SETTINGS.summaryModel, legacyRuntime, legacyBaseUrl, legacyApiKey),
    chatModel: normalizeModelConfig(saved.chatModel, DEFAULT_SETTINGS.chatModel, legacyRuntime, legacyBaseUrl, legacyApiKey),
    quizModel: normalizeModelConfig(saved.quizModel, DEFAULT_SETTINGS.quizModel, legacyRuntime, legacyBaseUrl, legacyApiKey)
  };
}

function normalizeModelConfig(
  value: unknown,
  fallback: AiModelConfig,
  legacyRuntime?: string,
  legacyBaseUrl?: string,
  legacyApiKey?: string
): AiModelConfig {
  const runtime = normalizeRuntime(legacyRuntime) ?? fallback.runtime;
  if (typeof value === "string") {
    return {
      runtime,
      apiBaseUrl: legacyBaseUrl ?? fallback.apiBaseUrl,
      apiKey: legacyApiKey ?? fallback.apiKey,
      model: value || fallback.model
    };
  }
  if (value && typeof value === "object") {
    const candidate = value as Partial<AiModelConfig>;
    return {
      runtime: normalizeRuntime(candidate.runtime) ?? runtime,
      apiBaseUrl: typeof candidate.apiBaseUrl === "string" ? candidate.apiBaseUrl : legacyBaseUrl ?? fallback.apiBaseUrl,
      apiKey: typeof candidate.apiKey === "string" ? candidate.apiKey : legacyApiKey ?? fallback.apiKey,
      model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model : fallback.model
    };
  }
  return {
    ...fallback,
    runtime,
    apiBaseUrl: legacyBaseUrl ?? fallback.apiBaseUrl,
    apiKey: legacyApiKey ?? fallback.apiKey
  };
}

function normalizeRuntime(value: unknown): AiModelConfig["runtime"] | null {
  if (value === "openai-compatible" || value === "ollama" || value === "lm-studio" || value === "disabled") {
    return value;
  }
  if (value === "openai" || value === "deepseek") {
    return "openai-compatible";
  }
  return null;
}
