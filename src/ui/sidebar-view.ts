import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type KnowFlowPlugin from "../main";
import { ARTICLE_CATEGORIES } from "../services/clipping-pipeline";
import type { SummaryText } from "../services/summary-notes";
import { KNOWFLOW_VIEW_TYPE, type ArticleStats, type ChatResult, type NoteSummary, type PipelineUiState, type QuizSession, type QuizStats, type ViewContext } from "../types";
import { renderArticleDetailView } from "./article-detail-view";
import { renderArticlesOverviewView } from "./articles-overview-view";
import { renderChatComposer, applyChipStyle } from "./chat-composer";
import { renderClippingView } from "./clipping-view";
import { applyActionLayout, button, formatDate, iconButton, row, section, setStyles, text } from "./dom";
import { renderQuizTestView } from "./quiz-test-view";
import { renderShell } from "./shell";

export class KnowFlowSidebarView extends ItemView {
  private chatResult: ChatResult | null = null;
  private quizSession: QuizSession | null = null;
  private pendingSummaries = new Set<string>();
  private summaryErrors = new Map<string, string>();
  private pipelineStates = new Map<string, PipelineUiState>();
  private selectedCategories = new Map<string, string>();
  private manuallySelectedCategories = new Set<string>();
  private renderedContextKey: string | null = null;
  private composerDraft = "";
  private pendingComposerFocus = false;
  private quizStatsCache = new Map<string, QuizStats>();
  private quizStatsPending = new Set<string>();
  private summaryTextCache = new Map<string, SummaryText | null>();
  private summaryTextPending = new Set<string>();

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: KnowFlowPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return KNOWFLOW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "KnowFlow";
  }

  getIcon(): string {
    return "brain";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    const nextContextKey = this.getRenderContextKey();
    const currentScroll = root.querySelector<HTMLElement>(".kf-content")?.scrollTop ?? 0;
    const shouldRestoreScroll = this.renderedContextKey === nextContextKey;
    this.pendingComposerFocus = shouldRestoreScroll && root.querySelector(".kf-input") === document.activeElement;
    if (!shouldRestoreScroll) {
      this.composerDraft = "";
    }
    root.empty();
    root.addClass("knowflow-view");
    setStyles(root, {
      backgroundColor: "color-mix(in srgb, var(--interactive-accent) 3%, var(--background-primary))",
      color: "var(--text-normal)",
      display: "flex",
      flexDirection: "column",
      fontSize: "13px",
      height: "100%"
    });
    this.renderedContextKey = nextContextKey;

    if (this.chatResult) {
      this.renderChatResult(root, this.chatResult);
      this.restoreScroll(currentScroll, shouldRestoreScroll);
      return;
    }

    if (this.quizSession) {
      this.renderQuizTest(root, this.quizSession);
      this.restoreScroll(currentScroll, shouldRestoreScroll);
      return;
    }

    const context = this.plugin.router.getContext();

    if (context.mode === "clipping") {
      this.renderClipping(root, context);
      this.restoreScroll(currentScroll, shouldRestoreScroll);
      return;
    }

    if (context.mode === "articles-overview") {
      this.renderArticlesOverview(root, context);
      this.restoreScroll(currentScroll, shouldRestoreScroll);
      return;
    }

    if (context.mode === "article-detail") {
      this.renderArticleDetail(root, context);
      this.restoreScroll(currentScroll, shouldRestoreScroll);
      return;
    }

    this.renderEmpty(root);
    this.restoreScroll(currentScroll, shouldRestoreScroll);
  }

  private renderClipping(root: HTMLElement, context: ViewContext): void {
    const file = context.activeFile;
    if (!file) return this.renderEmpty(root);
    const summaryMeta = this.getSummaryMeta(file);
    const summary = this.getSummaryViewModel(file);
    const summaryPending = this.pendingSummaries.has(file.path);
    const summaryError = this.summaryErrors.get(file.path);
    const analysisCost = estimateClippingAnalysisTokens(file);
    const pipelineState = this.pipelineStates.get(file.path);
    const persistedPipeline = this.plugin.store.getPipelineStatus(file.path);
    const selectedCategory = this.selectedCategories.get(file.path) ?? summaryMeta?.category ?? this.plugin.settings.defaultArticleCategory;

    renderClippingView(root, {
      title: file.basename,
      summary,
      summaryPending,
      summaryError,
      analysisCost,
      pipelineState,
      persistedPipeline,
      selectedCategory,
      statusText: this.getPipelineStatusText(pipelineState, persistedPipeline.status),
      recommendedActionLabel: summaryMeta ? this.recommendedActionLabel(summaryMeta.recommendedAction) : "--",
      renderMarkdownSummary: (parent, markdown) => void this.renderMarkdownSummary(parent, markdown, file.path),
      onRefreshSummary: () => this.ensureClippingSummary(file, true),
      onGenerateSummary: () => this.ensureClippingSummary(file, true),
      onRunPipeline: async () => {
        await this.runPipeline(file);
      },
      onSelectCategory: (category) => {
        this.selectedCategories.set(file.path, category);
        this.manuallySelectedCategories.add(file.path);
      },
      onMoveCategory: async (category) => {
        await this.moveToCategory(file, category);
      }
    });

    this.renderComposer(root, context, file.basename, file);
  }

  private async ensureClippingSummary(file: TFile, force: boolean): Promise<void> {
    if (this.pendingSummaries.has(file.path) || (!force && this.plugin.store.getSummary(file.path))) return;
    this.pendingSummaries.add(file.path);
    this.summaryErrors.delete(file.path);
    if (this.plugin.router.getContext().activeFile?.path === file.path) {
      this.render();
    }
    try {
      const content = await this.app.vault.read(file);
      const summary = await this.plugin.ai.summarize(file.path, file.basename, content, this.plugin.settings.defaultArticleCategory);
      await this.plugin.summaryNotes.applySummary(
        file,
        { summary: summary.summary, reason: summary.reason },
        { description: summary.briefDescription, readingValue: summary.readingValue, category: summary.category, tags: summary.tags }
      );
      await this.plugin.store.setSummary(summary);
      this.summaryTextCache.set(file.path, { summary: summary.summary, reason: summary.reason });
      if (!this.manuallySelectedCategories.has(file.path)) {
        this.selectedCategories.set(file.path, summary.category);
      }
      if (this.plugin.router.getContext().activeFile?.path === file.path) {
        this.render();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.summaryErrors.set(file.path, message);
      new Notice(`KnowFlow summary failed: ${message}`, 8000);
    } finally {
      this.pendingSummaries.delete(file.path);
      if (this.plugin.router.getContext().activeFile?.path === file.path) {
        this.render();
      }
    }
  }

  private renderArticlesOverview(root: HTMLElement, context: ViewContext): void {
    const selectedPath = context.selectedPath ?? this.plugin.settings.articlesFolder;
    const scope = selectedPath.startsWith(this.plugin.settings.articlesFolder) ? selectedPath : this.plugin.settings.articlesFolder;
    const stats = this.getArticleStats(scope);
    const clippingStats = this.getClippingStats();
    const categoryStats = this.getArticleCategoryStats();
    const scopeLabel = scope.replace(`${this.plugin.settings.articlesFolder}/`, "") || "全部文章";
    const dailyNew = Math.min(stats.unread, this.plugin.settings.dailyNewArticleLimit);
    const dailyReview = Math.min(stats.reviewDue, this.plugin.settings.dailyReviewLimit);
    const weeklyLearned = this.getWeeklyLearnedCount(scope);
    renderArticlesOverviewView(root, {
      scopeLabel,
      stats,
      clippingStats,
      categoryStats,
      dailyNew,
      dailyReview,
      weeklyLearned,
      firstUnreadTitle: this.findFirstUnreadArticle(scope)?.basename ?? "暂无待学习文章",
      onStartDaily: () => new Notice("Daily Learning will be implemented in V0.2")
    });
  }

  private renderArticleDetail(root: HTMLElement, context: ViewContext): void {
    const file = context.activeFile;
    if (!file) return this.renderEmpty(root);

    const summaryMeta = this.getSummaryMeta(file);
    const quiz = this.getQuizStats(file.path);
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const readingValue = this.getFrontmatterReadingValue(frontmatter) ?? (summaryMeta ? `${summaryMeta.readingValue}/5` : "--");
    const learningStatus = this.getFrontmatterLearningStatus(frontmatter) ?? (this.plugin.store.isLearned(file.path) ? "已学习" : "未学习");

    renderArticleDetailView(root, {
      title: file.basename,
      readingValue,
      learningStatus,
      summary: this.getSummaryViewModel(file),
      quiz,
      renderMarkdownSummary: (parent, markdown) => void this.renderMarkdownSummary(parent, markdown, file.path),
      onGenerateKnowledgeMap: () => void this.generateKnowledgeMap(file),
      onShowKnowledgePoints: () => new Notice("Knowledge Points will be implemented in V0.2"),
      onGenerateQuiz: () => void this.generateQuiz(file),
      onStartQuiz: () => void this.startQuiz(file)
    });

    this.renderComposer(root, context, file.basename, file);
  }

  private renderQuizTest(root: HTMLElement, session: QuizSession): void {
    renderQuizTestView(root, {
      session,
      onBack: () => {
        this.quizSession = null;
        this.render();
      },
      onSelect: (key) => {
        session.selectedKey = key;
        this.render();
      },
      onSubmit: async () => {
        await this.submitQuizAnswer(session);
      },
      onNext: () => {
        session.index += 1;
        session.selectedKey = null;
        session.submitted = false;
        this.render();
      },
      onFinish: () => {
        this.quizSession = null;
        this.render();
      }
    });
  }

  private renderEmpty(root: HTMLElement): void {
    const content = renderShell(root, "KnowFlow", "No context");
    const card = section(content, "kf-empty");
    text(card, "选择一个 KnowFlow 上下文", "kf-card-title");
    text(card, "打开 Clippings 中的文章会进入整理模式；选中 Articles 文件夹会显示学习总览；打开 Articles 中的具体文章会显示文章详情。", "kf-muted");
    const actions = row(card, "kf-actions");
    applyActionLayout(actions);
    button(actions, "刷新", () => this.render(), true);
  }

  private renderChatResult(root: HTMLElement, result: ChatResult): void {
    const content = renderShell(root, "Chat Result", "Ready", () => {
      this.chatResult = null;
      this.render();
    });

    const question = section(content, "kf-question");
    setStyles(question, { backgroundColor: "var(--background-secondary)" });
    const chip = question.createDiv({ cls: "kf-context-chip" });
    applyChipStyle(chip);
    chip.createSpan({ text: result.contextLabel });
    text(question, result.question, "kf-question-text");
    const footer = row(question);
    setStyles(footer, { justifyContent: "space-between" });
    text(footer, formatDate(result.createdAt), "kf-muted");
    const tools = footer.createDiv({ cls: "kf-card-tools" });
    setStyles(tools, {
      display: "flex",
      gap: "8px",
      marginLeft: "auto"
    });
    iconButton(tools, "Copy", "copy", () => navigator.clipboard.writeText(result.question));
    iconButton(tools, "Edit", "pencil", () => new Notice("Edit question comes next."));
    iconButton(tools, "Delete", "trash-2", () => {
      this.chatResult = null;
      this.render();
    });

    const thinking = section(content, "kf-thinking");
    setStyles(thinking, { backgroundColor: "var(--background-secondary)" });
    text(thinking, "▸ Thought for a while", "kf-thinking-text");

    const answer = content.createDiv({ cls: "kf-answer" });
    setStyles(answer, {
      display: "flex",
      flexDirection: "column",
      gap: "14px",
      padding: "10px 0"
    });
    result.answer.split("\n\n").forEach((paragraph) => {
      text(answer, paragraph, "kf-answer-paragraph");
    });

    const actions = row(content, "kf-actions");
    applyActionLayout(actions);
    button(actions, "复制", () => navigator.clipboard.writeText(result.answer));
    button(actions, "重新生成", () => this.submitChat(result.question));
    button(actions, "存为摘要", async () => {
      if (!result.filePath) return;
      const target = this.app.vault.getAbstractFileByPath(result.filePath);
      if (!(target instanceof TFile)) {
        new Notice("关联文章不存在。");
        return;
      }
      const summary: NoteSummary = {
        filePath: result.filePath,
        title: result.contextLabel,
        briefDescription: result.answer.replace(/\s+/g, " ").slice(0, 160),
        summary: result.answer,
        readingValue: 3,
        recommendedAction: "skim",
        category: this.plugin.settings.defaultArticleCategory,
        reason: "用户从 Chat Result 手动保存为摘要。",
        tags: [],
        updatedAt: new Date().toISOString()
      };
      await this.plugin.summaryNotes.applySummary(
        target,
        { summary: summary.summary, reason: summary.reason },
        { description: summary.briefDescription, readingValue: summary.readingValue, category: summary.category, tags: summary.tags }
      );
      await this.plugin.store.setSummary(summary);
      this.summaryTextCache.set(result.filePath, { summary: summary.summary, reason: summary.reason });
      new Notice("Saved as AI Summary");
    });
    button(actions, "生成 Quiz", async () => {
      if (!result.filePath) {
        new Notice("当前回答没有关联文章。");
        return;
      }
      const target = this.app.vault.getAbstractFileByPath(result.filePath);
      if (!(target instanceof TFile)) {
        new Notice("关联文章不存在。");
        return;
      }
      await this.generateQuiz(target);
    });

    this.renderComposer(root, this.plugin.router.getContext(), result.contextLabel, result.filePath ? this.app.vault.getAbstractFileByPath(result.filePath) as TFile : null);
  }

  private renderComposer(root: HTMLElement, context: ViewContext, label: string, file: TFile | null): void {
    renderChatComposer(root, {
      contextLabel: label,
      modelName: this.plugin.settings.chatModel.model,
      draft: this.composerDraft,
      focusDraft: this.pendingComposerFocus,
      onDraftChange: (value) => {
        this.composerDraft = value;
      },
      onSubmit: (question) => void this.submitChat(question, context, file)
    });
  }

  private async submitChat(question: string, context = this.plugin.router.getContext(), file: TFile | null = context.activeFile): Promise<void> {
    if (!question) {
      new Notice("Enter a question first");
      return;
    }
    const content = file ? await this.app.vault.read(file) : "";
    try {
      this.chatResult = await this.plugin.ai.answer(context.mode, file?.path ?? null, file?.basename ?? "Current", question, content);
    } catch (error) {
      new Notice(`KnowFlow chat failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
      return;
    }
    this.composerDraft = "";
    this.render();
  }

  private async runPipeline(file: TFile): Promise<void> {
    if (this.pipelineStates.get(file.path)?.running) return;
    this.pipelineStates.set(file.path, {
      completed: [],
      currentStep: null,
      error: null,
      failedStep: null,
      running: true,
      visible: true
    });
    this.render();
    try {
      await this.plugin.pipeline.process(file, (step) => {
        const state = this.pipelineStates.get(file.path);
        if (!state) return;
        if (state.currentStep && !state.completed.includes(state.currentStep)) {
          state.completed.push(state.currentStep);
        }
        state.currentStep = step;
        state.running = true;
        state.visible = true;
        this.pipelineStates.set(file.path, state);
        this.render();
      });
      const state = this.pipelineStates.get(file.path);
      if (state) {
        if (state.currentStep && !state.completed.includes(state.currentStep)) {
          state.completed.push(state.currentStep);
        }
        state.currentStep = null;
        state.running = false;
        this.pipelineStates.set(file.path, state);
      }
      const summaryMeta = this.getSummaryMeta(file);
      if (summaryMeta && !this.manuallySelectedCategories.has(file.path)) {
        this.selectedCategories.set(file.path, summaryMeta.category);
      }
      this.render();
    } catch (error) {
      const state = this.pipelineStates.get(file.path);
      if (state) {
        state.failedStep = state.currentStep;
        state.error = error instanceof Error ? error.message : String(error);
        state.running = false;
        state.visible = true;
        this.pipelineStates.set(file.path, state);
      }
      this.render();
      new Notice(`KnowFlow failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async moveToCategory(file: TFile, category: string): Promise<void> {
    try {
      await this.plugin.pipeline.moveToCategory(file, category);
      this.selectedCategories.delete(file.path);
      this.manuallySelectedCategories.delete(file.path);
      this.render();
    } catch (error) {
      new Notice(`KnowFlow move failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async generateKnowledgeMap(file: TFile): Promise<void> {
    try {
      await this.plugin.mermaid.generateForFile(file);
      this.render();
    } catch (error) {
      new Notice(`KnowFlow Mermaid failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async generateQuiz(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      const readingValue = this.getArticleReadingValue(file) || 3;
      const count = readingValue >= 4 ? 8 : readingValue >= 2 ? 5 : 3;
      const questions = await this.plugin.ai.generateQuiz(file.path, file.basename, content, count);
      if (questions.length === 0) {
        throw new Error("Quiz model did not return valid questions.");
      }
      const category = this.getSummaryMeta(file)?.category ?? this.plugin.settings.defaultArticleCategory;
      await this.plugin.quizNotes.saveQuiz(file, category, questions);
      this.quizStatsCache.delete(file.path);
      new Notice(`KnowFlow: generated ${questions.length} quiz questions`);
      this.render();
    } catch (error) {
      new Notice(`KnowFlow quiz failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
    }
  }

  private async startQuiz(file: TFile): Promise<void> {
    const loaded = await this.plugin.quizNotes.loadQuestions(file.path);
    if (!loaded || loaded.questions.length === 0) {
      new Notice("请先生成试题。");
      return;
    }
    this.quizSession = {
      filePath: file.path,
      quizPath: loaded.quizPath,
      title: file.basename,
      questions: loaded.questions,
      index: 0,
      selectedKey: null,
      submitted: false
    };
    this.render();
  }

  private async submitQuizAnswer(session: QuizSession): Promise<void> {
    const question = session.questions[session.index];
    if (!session.selectedKey) {
      new Notice("请选择一个答案。");
      return;
    }
    // The question's position within the note (1-based) doubles as its
    // identity for patching — quiz notes don't need separate stable IDs
    // since regenerating a quiz always rewrites the whole file anyway.
    await this.plugin.quizNotes.recordAnswer(session.quizPath, session.index + 1, session.selectedKey, question.answerKey);
    this.quizStatsCache.delete(session.filePath);
    session.submitted = true;
    this.render();
  }

  private getQuizStats(path: string): QuizStats {
    const cached = this.quizStatsCache.get(path);
    if (cached) return cached;
    void this.refreshQuizStats(path);
    return { total: 0, answered: 0, accuracy: null, wrong: 0 };
  }

  private async refreshQuizStats(path: string): Promise<void> {
    if (this.quizStatsPending.has(path)) return;
    this.quizStatsPending.add(path);
    try {
      const stats = await this.plugin.quizNotes.getStats(path);
      this.quizStatsCache.set(path, stats);
      if (this.plugin.router.getContext().activeFile?.path === path) {
        this.render();
      }
    } finally {
      this.quizStatsPending.delete(path);
    }
  }

  /**
   * Merges the small metadata cached in data.json with the long-form
   * summary/reason text, which lives in the note's own callout (see
   * summary-notes.ts) and is only loaded on demand for whichever single
   * note is currently open — never for bulk list views.
   */
  private getSummaryViewModel(file: TFile): NoteSummary | null {
    const meta = this.getSummaryMeta(file);
    if (!meta) return null;
    const text = this.loadSummaryText(file);
    return {
      ...meta,
      filePath: file.path,
      title: file.basename,
      summary: text?.summary ?? "正在读取摘要正文...",
      reason: text?.reason ?? ""
    };
  }

  private loadSummaryText(file: TFile): SummaryText | null {
    if (this.summaryTextCache.has(file.path)) return this.summaryTextCache.get(file.path) ?? null;
    void this.refreshSummaryText(file);
    return null;
  }

  private async refreshSummaryText(file: TFile): Promise<void> {
    if (this.summaryTextPending.has(file.path)) return;
    this.summaryTextPending.add(file.path);
    try {
      const text = await this.plugin.summaryNotes.loadSummaryText(file);
      this.summaryTextCache.set(file.path, text);
      if (this.plugin.router.getContext().activeFile?.path === file.path) {
        this.render();
      }
    } finally {
      this.summaryTextPending.delete(file.path);
    }
  }

  private getArticleStats(scopePath: string): ArticleStats {
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(scopePath));
    const learned = files.filter((file) => this.isArticleLearned(file)).length;
    return {
      scopePath,
      total: files.length,
      learned,
      unread: Math.max(files.length - learned, 0),
      reviewDue: Math.min(3, files.length),
      weakPoints: files.length > 0 ? 2 : 0
    };
  }

  private getClippingStats(): { total: number; summarized: number; highValue: number } {
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${this.plugin.settings.clippingFolder}/`));
    // "summarized" only needs a stored record to exist (it always keeps
    // recommendedAction/updatedAt even once the other fields have moved to
    // frontmatter), but readingValue itself has to go through the merged
    // getter — a clipping can already be pipeline-processed (and so have
    // its readingValue stripped from data.json) while still physically
    // sitting in the clippings folder, since moving it out is a separate step.
    const summarized = files.filter((file) => this.plugin.store.getSummary(file.path) !== null);
    return {
      total: files.length,
      summarized: summarized.length,
      highValue: summarized.filter((file) => this.getArticleReadingValue(file) >= 4).length
    };
  }

  private getArticleCategoryStats(): Array<{ name: string; total: number; learned: number }> {
    return ARTICLE_CATEGORIES.map((category) => {
      const prefix = `${this.plugin.settings.articlesFolder}/${category}/`;
      const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(prefix));
      return {
        name: category,
        total: files.length,
        learned: files.filter((file) => this.isArticleLearned(file)).length
      };
    }).filter((category) => category.total > 0);
  }

  private findFirstUnreadArticle(scopePath: string): TFile | null {
    return this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(scopePath))
      .sort((a, b) => this.getArticleReadingValue(b) - this.getArticleReadingValue(a))
      .find((file) => !this.isArticleLearned(file)) ?? null;
  }

  private getWeeklyLearnedCount(scopePath: string): number {
    const weekStart = startOfLocalWeek(new Date());
    return this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(scopePath))
      .filter((file) => {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const date = this.getFrontmatterLearningDate(frontmatter);
        return date ? date >= weekStart : false;
      }).length;
  }

  private isArticleLearned(file: TFile): boolean {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const status = this.getFrontmatterLearningStatus(frontmatter);
    if (status) return !/未学习|待学习|未读|pending/i.test(status);
    return this.plugin.store.isLearned(file.path);
  }

  private getArticleReadingValue(file: TFile): number {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return this.getFrontmatterReadingValueNumber(frontmatter) ?? 0;
  }

  private getFrontmatterReadingValueNumber(frontmatter: Record<string, unknown> | undefined): number | null {
    const value = frontmatter?.["阅读价值"];
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private getFrontmatterCategory(frontmatter: Record<string, unknown> | undefined): string | null {
    const value = frontmatter?.["分类"];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getFrontmatterBriefDescription(frontmatter: Record<string, unknown> | undefined): string | null {
    const value = frontmatter?.["简要描述"];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getFrontmatterTags(frontmatter: Record<string, unknown> | undefined): string[] | null {
    const value = frontmatter?.tags;
    if (Array.isArray(value)) {
      const tags = value.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
      return tags.length > 0 ? tags : null;
    }
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return null;
  }

  /**
   * briefDescription/readingValue/category/tags are read straight from
   * the note's own frontmatter — never from data.json, which doesn't
   * cache them at all (see StoredSummaryMeta) since applySummaryFrontmatter
   * writes them there the moment a summary is generated. Only
   * recommendedAction/updatedAt come from the store, since frontmatter has
   * nowhere to hold those. Returns null if the note has never been
   * summarized at all.
   */
  private getSummaryMeta(file: TFile): (Omit<NoteSummary, "filePath" | "title" | "summary" | "reason">) | null {
    const stored = this.plugin.store.getSummary(file.path);
    if (!stored) return null;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return {
      briefDescription: this.getFrontmatterBriefDescription(frontmatter) ?? "",
      readingValue: this.getFrontmatterReadingValueNumber(frontmatter) ?? 0,
      category: this.getFrontmatterCategory(frontmatter) ?? this.plugin.settings.defaultArticleCategory,
      tags: this.getFrontmatterTags(frontmatter) ?? [],
      recommendedAction: stored.recommendedAction,
      updatedAt: stored.updatedAt
    };
  }

  private getFrontmatterLearningDate(frontmatter: Record<string, unknown> | undefined): Date | null {
    const value = frontmatter?.["学习日期"];
    if (typeof value !== "string" && typeof value !== "number") return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private getFrontmatterReadingValue(frontmatter: Record<string, unknown> | undefined): string | null {
    const value = frontmatter?.["阅读价值"];
    if (typeof value === "number") return `${value}/5`;
    if (typeof value === "string" && value.trim()) {
      const normalized = value.trim();
      return normalized.includes("/") ? normalized : `${normalized}/5`;
    }
    return null;
  }

  private getFrontmatterLearningStatus(frontmatter: Record<string, unknown> | undefined): string | null {
    const value = frontmatter?.["学习状态"];
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === "string" && item.trim());
      return typeof first === "string" ? first.trim() : null;
    }
    if (typeof value === "string" && value.trim()) return value.trim();
    return null;
  }

  private recommendedActionLabel(action: string): string {
    if (action === "skip") return "跳过";
    if (action === "skim") return "快速阅读";
    if (action === "deep_learn") return "深入学习";
    if (action === "keep_reference") return "长期参考";
    return "--";
  }

  private getPipelineStatusText(state: PipelineUiState | undefined, persistedStatus: string): string {
    if (state?.error) return "失败";
    if (state?.running) return "整理中";
    if (state?.visible && state.completed.length > 0) return "已整理";
    if (persistedStatus === "processed") return "已整理";
    if (persistedStatus === "failed") return "失败";
    return "待整理";
  }

  private getRenderContextKey(): string {
    if (this.chatResult) return `chat:${this.chatResult.filePath ?? this.chatResult.contextLabel}`;
    if (this.quizSession) return `quiz:${this.quizSession.filePath}`;
    const context = this.plugin.router.getContext();
    return `${context.mode}:${context.activeFile?.path ?? context.selectedPath ?? ""}`;
  }

  private restoreScroll(scrollTop: number, shouldRestore: boolean): void {
    if (!shouldRestore || scrollTop <= 0) return;
    window.requestAnimationFrame(() => {
      const content = this.containerEl.querySelector<HTMLElement>(".kf-content");
      if (content) content.scrollTop = scrollTop;
    });
  }

  private async renderMarkdownSummary(parent: HTMLElement, markdown: string, sourcePath: string): Promise<void> {
    const container = parent.createDiv({ cls: "kf-markdown-summary markdown-rendered" });
    setStyles(container, {
      color: "var(--text-muted)",
      fontSize: "13px",
      lineHeight: "1.5"
    });
    await MarkdownRenderer.render(this.app, markdown, container, sourcePath, this);
    container.querySelectorAll("p").forEach((el) => {
      setStyles(el as HTMLElement, { margin: "0 0 6px" });
    });
    container.querySelectorAll("ul, ol").forEach((el) => {
      setStyles(el as HTMLElement, {
        margin: "2px 0 8px",
        paddingLeft: "18px"
      });
    });
    container.querySelectorAll("li").forEach((el) => {
      setStyles(el as HTMLElement, { margin: "2px 0" });
    });
    container.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((el) => {
      setStyles(el as HTMLElement, {
        color: "var(--text-normal)",
        fontSize: "13px",
        fontWeight: "650",
        margin: "8px 0 4px"
      });
    });
  }

}

function estimateClippingAnalysisTokens(file: TFile): number {
  const byteSize = file.stat.size;
  const sampledChars = Math.min(byteSize, byteSize <= 9000 ? byteSize : 11000);
  const estimated = Math.ceil((sampledChars + 1800) / 1800);
  return Math.max(1, estimated);
}

function startOfLocalWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = start.getDay();
  const diff = day === 0 ? 6 : day - 1;
  start.setDate(start.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  return start;
}
