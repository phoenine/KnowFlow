import { App, Modal, Notice, PluginSettingTab, Setting, TextComponent, normalizePath, requestUrl } from "obsidian";
import type KnowFlowPlugin from "./main";
import { withTimeout } from "./services/ai-service";
import type { AiModelConfig, AiRuntime, KnowFlowSettings } from "./types";

type ModelConfigKey = "summaryModel" | "chatModel" | "quizModel";
type SettingsTabKey = "basic" | "ai-models" | "pipeline" | "learning" | "data";

const DEFAULT_MODEL_CONFIG: AiModelConfig = {
  runtime: "openai-compatible",
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini"
};

const RUNTIME_DEFAULT_BASE_URL: Record<AiRuntime, string> = {
  "openai-compatible": "https://api.openai.com/v1",
  "ollama": "http://localhost:11434/v1",
  "lm-studio": "http://localhost:1234/v1",
  "disabled": ""
};

export const DEFAULT_SETTINGS: KnowFlowSettings = {
  clippingFolder: "Clippings",
  articlesFolder: "Articles",
  defaultArticleCategory: "知识积累",
  archiveFolder: "Archives",
  templatePath: "Template/article.md",
  summaryModel: { ...DEFAULT_MODEL_CONFIG },
  chatModel: { ...DEFAULT_MODEL_CONFIG },
  quizModel: { ...DEFAULT_MODEL_CONFIG },
  confirmBeforeWrite: false,
  autoOrganize: false,
  autoGenerateSummary: false,
  autoGenerateQuiz: false,
  dailyNewArticleLimit: 1,
  dailyReviewLimit: 3,
  autoCreateCategoryFolders: false
};

export class KnowFlowSettingTab extends PluginSettingTab {
  plugin: KnowFlowPlugin;
  private activeTab: SettingsTabKey = "basic";

  constructor(app: App, plugin: KnowFlowPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "KnowFlow Settings" });
    this.renderTabs(containerEl);

    if (this.activeTab === "basic") {
      this.displayBasic(containerEl);
    } else if (this.activeTab === "ai-models") {
      this.displayAiModels(containerEl);
    } else if (this.activeTab === "pipeline") {
      this.displayPipeline(containerEl);
    } else if (this.activeTab === "learning") {
      this.displayLearning(containerEl);
    } else {
      this.displayData(containerEl);
    }
  }

  private displayBasic(containerEl: HTMLElement): void {
    const vault = this.createGroup(containerEl, "Vault 路径", `${this.plugin.settings.clippingFolder} -> ${this.plugin.settings.articlesFolder}`, true);

    new Setting(vault)
      .setName("Clipping folder")
      .setDesc("Folder where Obsidian Web Clipper saves new articles.")
      .addText((text) =>
        text
          .setPlaceholder("Clippings")
          .setValue(this.plugin.settings.clippingFolder)
          .onChange(async (value) => {
            this.plugin.settings.clippingFolder = value.trim() || DEFAULT_SETTINGS.clippingFolder;
            await this.plugin.saveSettings();
          })
      );

    new Setting(vault)
      .setName("Articles folder")
      .setDesc("Long-term article library root.")
      .addText((text) =>
        text
          .setPlaceholder("Articles")
          .setValue(this.plugin.settings.articlesFolder)
          .onChange(async (value) => {
            this.plugin.settings.articlesFolder = value.trim() || DEFAULT_SETTINGS.articlesFolder;
            await this.plugin.saveSettings();
          })
      );

    new Setting(vault)
      .setName("Default article category")
      .setDesc("Fallback category when classification confidence is low.")
      .addText((text) =>
        text
          .setPlaceholder("知识积累")
          .setValue(this.plugin.settings.defaultArticleCategory)
          .onChange(async (value) => {
            this.plugin.settings.defaultArticleCategory = value.trim() || DEFAULT_SETTINGS.defaultArticleCategory;
            await this.plugin.saveSettings();
          })
      );

    new Setting(vault)
      .setName("Archive folder")
      .setDesc("Used for exported reports and compatibility output.")
      .addText((text) =>
        text
          .setPlaceholder("Archives")
          .setValue(this.plugin.settings.archiveFolder)
          .onChange(async (value) => {
            this.plugin.settings.archiveFolder = value.trim() || DEFAULT_SETTINGS.archiveFolder;
            await this.plugin.saveSettings();
          })
      );

    new Setting(vault)
      .setName("Article template")
      .setDesc("Frontmatter field reference. Defaults to your current Template/article.md.")
      .addText((text) =>
        text
          .setPlaceholder("Template/article.md")
          .setValue(this.plugin.settings.templatePath)
          .onChange(async (value) => {
            this.plugin.settings.templatePath = value.trim() || DEFAULT_SETTINGS.templatePath;
            await this.plugin.saveSettings();
          })
      );

    new Setting(vault)
      .setName("Auto-create category folders")
      .setDesc("Built-in categories are always auto-created. Off by default; enable to also auto-create folders for custom (non-built-in) categories.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoCreateCategoryFolders)
          .onChange(async (value) => {
            this.plugin.settings.autoCreateCategoryFolders = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(vault)
      .setName("Validate paths")
      .setDesc("Check whether the configured folders and article template exist in the current vault.")
      .addButton((button) =>
        button
          .setButtonText("Validate")
          .onClick(async () => {
            await this.validateBasicPaths();
          })
      );
  }

  private displayAiModels(containerEl: HTMLElement): void {
    const ai = this.createGroup(containerEl, "AI 模型", this.aiSummary(), true);

    this.createModelEntry(ai, "Summary model", "Used for Clipping pipeline Markdown polishing, summary, reading value and classification.", "summaryModel");
    this.createModelEntry(ai, "Chat model", "Used by the sidebar chat composer.", "chatModel");
    this.createModelEntry(ai, "Quiz model", "Used for database-backed quiz generation.", "quizModel");

    const runtime = this.createGroup(containerEl, "Runtime support", "Cloud · Ollama · LM Studio");
    runtime.createEl("p", {
      text: "Each model has its own runtime, base URL, API key and model ID. Cloud uses OpenAI-compatible endpoints. Local runtimes support Ollama and LM Studio.",
      cls: "setting-item-description"
    });
  }

  private displayPipeline(containerEl: HTMLElement): void {
    const pipeline = this.createGroup(containerEl, "Pipeline", this.plugin.settings.confirmBeforeWrite ? "confirm before write" : "direct apply");

    new Setting(pipeline)
      .setName("Confirm before write")
      .setDesc("When enabled, file modifications require manual confirmation.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.confirmBeforeWrite)
          .onChange(async (value) => {
            this.plugin.settings.confirmBeforeWrite = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(pipeline)
      .setName("Auto organize")
      .setDesc("V0.2. Automatically process new clippings.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoOrganize)
          .onChange(async (value) => {
            this.plugin.settings.autoOrganize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(pipeline)
      .setName("Auto generate summary")
      .setDesc("V0.2. Generate summaries after pipeline processing.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoGenerateSummary)
          .onChange(async (value) => {
            this.plugin.settings.autoGenerateSummary = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(pipeline)
      .setName("Auto generate quiz")
      .setDesc("V0.2. Generate database-backed quiz after article processing.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoGenerateQuiz)
          .onChange(async (value) => {
            this.plugin.settings.autoGenerateQuiz = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private displayLearning(containerEl: HTMLElement): void {
    const learning = this.createGroup(containerEl, "Learning", `${this.plugin.settings.dailyNewArticleLimit} new · ${this.plugin.settings.dailyReviewLimit} review`);

    new Setting(learning)
      .setName("Daily new article limit")
      .setDesc("Maximum new articles in Daily Learning.")
      .addText((text) =>
        text
          .setPlaceholder("1")
          .setValue(String(this.plugin.settings.dailyNewArticleLimit))
          .onChange(async (value) => {
            this.plugin.settings.dailyNewArticleLimit = toPositiveInt(value, DEFAULT_SETTINGS.dailyNewArticleLimit);
            await this.plugin.saveSettings();
          })
      );

    new Setting(learning)
      .setName("Daily review limit")
      .setDesc("Maximum review tasks in Daily Learning.")
      .addText((text) =>
        text
          .setPlaceholder("3")
          .setValue(String(this.plugin.settings.dailyReviewLimit))
          .onChange(async (value) => {
            this.plugin.settings.dailyReviewLimit = toPositiveInt(value, DEFAULT_SETTINGS.dailyReviewLimit);
            await this.plugin.saveSettings();
          })
      );
  }

  private displayData(containerEl: HTMLElement): void {
    const privacy = this.createGroup(containerEl, "Data & Privacy", "local settings");
    privacy.createEl("p", {
      text: "KnowFlow stores settings and learning state in local Obsidian plugin data. API requests should only send the current note or selected context.",
      cls: "setting-item-description"
    });
    const apiKeyWarning = privacy.createEl("p", {
      text: "Warning: AI model API keys are stored in plain text inside this vault's plugin data file (.obsidian/plugins/knowflow/data.json). If this vault is synced via Git or a cloud service, exclude that file or your keys may be exposed.",
      cls: "setting-item-description"
    });
    Object.assign(apiKeyWarning.style, { color: "var(--text-warning)" });

    new Setting(privacy)
      .setName("Export data")
      .setDesc("Data export will include notes, summaries, quizzes, attempts and review tasks.")
      .addButton((button) =>
        button
          .setButtonText("Export")
          .onClick(() => this.exportData())
      );

    new Setting(privacy)
      .setName("Clear AI task history")
      .setDesc("Clear AI task logs after the AI adapter and task queue are implemented.")
      .addButton((button) => button.setButtonText("Clear").setDisabled(true));
  }

  private renderTabs(containerEl: HTMLElement): void {
    const tabs = containerEl.createDiv();
    Object.assign(tabs.style, {
      borderBottom: "1px solid var(--background-modifier-border)",
      display: "flex",
      flexWrap: "wrap",
      gap: "4px",
      marginBottom: "12px"
    });

    const items: Array<[SettingsTabKey, string]> = [
      ["basic", "Basic"],
      ["ai-models", "AI Models"],
      ["pipeline", "Pipeline"],
      ["learning", "Learning"],
      ["data", "Data"]
    ];

    for (const [key, label] of items) {
      const button = tabs.createEl("button", { text: label });
      const active = this.activeTab === key;
      Object.assign(button.style, {
        background: active ? "var(--interactive-accent)" : "var(--background-primary)",
        border: "1px solid var(--background-modifier-border)",
        borderBottom: active ? "1px solid var(--interactive-accent)" : "1px solid var(--background-modifier-border)",
        borderRadius: "6px 6px 0 0",
        color: active ? "var(--text-on-accent)" : "var(--text-normal)",
        cursor: "pointer",
        fontWeight: active ? "700" : "500",
        padding: "6px 12px"
      });
      button.addEventListener("click", () => {
        this.activeTab = key;
        this.display();
      });
    }
  }

  private createGroup(containerEl: HTMLElement, title: string, subtitle: string, open = false): HTMLElement {
    const details = containerEl.createEl("details");
    details.open = open;
    Object.assign(details.style, {
      border: "1px solid var(--background-modifier-border)",
      borderRadius: "8px",
      margin: "12px 0",
      padding: "0"
    });

    const summary = details.createEl("summary");
    Object.assign(summary.style, {
      alignItems: "center",
      cursor: "pointer",
      display: "flex",
      gap: "8px",
      justifyContent: "space-between",
      padding: "12px 14px"
    });
    summary.createEl("strong", { text: title });
    const desc = summary.createSpan({ text: subtitle });
    Object.assign(desc.style, {
      color: "var(--text-muted)",
      fontSize: "12px"
    });

    const body = details.createDiv();
    Object.assign(body.style, {
      borderTop: "1px solid var(--background-modifier-border)",
      padding: "0 14px 8px"
    });
    return body;
  }

  private createModelEntry(containerEl: HTMLElement, name: string, desc: string, key: ModelConfigKey): void {
    const config = this.plugin.settings[key];
    new Setting(containerEl)
      .setName(name)
      .setDesc(`${desc} Current: ${runtimeLabel(config.runtime)} / ${config.model}`)
      .addButton((button) =>
        button
          .setButtonText("Configure")
          .onClick(() => new ModelConfigModal(this.app, this.plugin, key, name, () => this.display()).open())
      );
  }

  private aiSummary(): string {
    const { summaryModel, chatModel, quizModel } = this.plugin.settings;
    return `S ${summaryModel.model} · C ${chatModel.model} · Q ${quizModel.model}`;
  }

  private async validateBasicPaths(): Promise<void> {
    const checks: Array<[string, string]> = [
      ["Clipping folder", this.plugin.settings.clippingFolder],
      ["Articles folder", this.plugin.settings.articlesFolder],
      ["Archive folder", this.plugin.settings.archiveFolder],
      ["Article template", this.plugin.settings.templatePath]
    ];
    const missing: string[] = [];

    for (const [label, path] of checks) {
      const exists = await this.app.vault.adapter.exists(normalizePath(path));
      if (!exists) missing.push(`${label}: ${path}`);
    }

    if (missing.length === 0) {
      new Notice("KnowFlow paths are valid.");
      return;
    }

    new Notice(`KnowFlow missing paths:\n${missing.join("\n")}`, 8000);
  }

  private exportData(): void {
    const payload = {
      exportedAt: new Date().toISOString(),
      settings: this.plugin.settings,
      store: this.plugin.store.exportData()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `knowflow-export-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    new Notice("KnowFlow data exported.");
  }
}

function toPositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runtimeLabel(runtime: AiRuntime): string {
  if (runtime === "openai-compatible") return "Cloud";
  if (runtime === "ollama") return "Ollama";
  if (runtime === "lm-studio") return "LM Studio";
  return "Disabled";
}

async function testModelConnection(config: AiModelConfig): Promise<void> {
  if (config.runtime === "disabled") {
    throw new Error("AI Runtime is disabled.");
  }

  const baseUrl = config.apiBaseUrl.trim().replace(/\/+$/g, "");
  if (!baseUrl) {
    throw new Error("API Base URL is required.");
  }

  const headers: Record<string, string> = {
    Accept: "application/json"
  };
  if (config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }

  const response = await withTimeout(
    requestUrl({
      url: `${baseUrl}/models`,
      method: "GET",
      headers,
      throw: false
    }),
    15000,
    `Connection test timed out after 15s. Check that ${baseUrl} is reachable.`
  );

  if (response.status < 200 || response.status >= 300) {
    const message = response.text?.slice(0, 160) || `HTTP ${response.status}`;
    throw new Error(`Connection failed: ${message}`);
  }

  const models = Array.isArray(response.json?.data) ? response.json.data : [];
  if (config.model && models.length > 0) {
    const found = models.some((model: unknown) => {
      if (!model || typeof model !== "object") return false;
      return (model as { id?: unknown }).id === config.model;
    });
    if (!found) {
      new Notice(`Connection succeeded, but model "${config.model}" was not found in /models.`, 8000);
    }
  }
}

class ModelConfigModal extends Modal {
  constructor(
    app: App,
    private plugin: KnowFlowPlugin,
    private key: ModelConfigKey,
    private title: string,
    private onSave: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const config = this.plugin.settings[this.key];
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("p", {
      text: "Configure this model independently. Cloud uses an OpenAI-compatible endpoint. Local runtimes support Ollama and LM Studio.",
      cls: "setting-item-description"
    });

    let baseUrlInput: TextComponent | undefined;

    new Setting(contentEl)
      .setName("AI Runtime")
      .setDesc("Cloud uses OpenAI-compatible API. Local supports Ollama and LM Studio.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("openai-compatible", "Cloud")
          .addOption("ollama", "Ollama")
          .addOption("lm-studio", "LM Studio")
          .addOption("disabled", "Disabled")
          .setValue(config.runtime)
          .onChange(async (value) => {
            const previousBaseUrl = config.apiBaseUrl;
            config.runtime = value as AiRuntime;
            if (!previousBaseUrl || Object.values(RUNTIME_DEFAULT_BASE_URL).includes(previousBaseUrl)) {
              config.apiBaseUrl = RUNTIME_DEFAULT_BASE_URL[config.runtime];
              // The base URL field below was already rendered with the old
              // value; without this it would keep showing a stale URL even
              // though the new default was already saved.
              baseUrlInput?.setValue(config.apiBaseUrl);
            }
            await this.plugin.saveSettings();
          })
      );

    new Setting(contentEl)
      .setName("API Base URL")
      .setDesc("Cloud: OpenAI-compatible endpoint. Ollama and LM Studio use local v1-compatible endpoints.")
      .addText((text) => {
        baseUrlInput = text;
        text
          .setPlaceholder(RUNTIME_DEFAULT_BASE_URL[config.runtime])
          .setValue(config.apiBaseUrl)
          .onChange(async (value) => {
            config.apiBaseUrl = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(contentEl)
      .setName("API Key")
      .setDesc("Required for Cloud. Usually empty for local Ollama and LM Studio.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(config.apiKey)
          .onChange(async (value) => {
            config.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(contentEl)
      .setName("Model ID")
      .setDesc("The exact model name exposed by this runtime.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS[this.key].model)
          .setValue(config.model)
          .onChange(async (value) => {
            config.model = value.trim() || DEFAULT_SETTINGS[this.key].model;
            await this.plugin.saveSettings();
          })
      );

    new Setting(contentEl)
      .setName("Test connection")
      .setDesc("Calls the runtime /models endpoint using the current base URL and API key.")
      .addButton((button) =>
        button
          .setButtonText("Test")
          .onClick(async () => {
            button.setButtonText("Testing...");
            button.setDisabled(true);
            try {
              await testModelConnection(config);
              new Notice(`${this.title}: connection succeeded.`);
            } catch (error) {
              new Notice(`${this.title}: ${error instanceof Error ? error.message : String(error)}`, 8000);
            } finally {
              button.setButtonText("Test");
              button.setDisabled(false);
            }
          })
      );

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Save")
          .setCta()
          .onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.onSave();
  }
}
