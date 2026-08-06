import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type KnowFlowPlugin from "../main";
import { ARTICLE_CATEGORIES } from "../services/clipping-pipeline";
import { insertBelowCursor } from "../services/editor-bridge";
import type { SummaryText } from "../services/summary-notes";
import { KNOWFLOW_VIEW_TYPE, type ArticleStats, type ChatMessage, type ChatThread, type ChatUsage, type NoteSummary, type PipelineUiState, type QuizSession, type QuizStats, type ViewContext } from "../types";
import { renderArticleDetailView } from "./article-detail-view";
import { renderArticlesOverviewView } from "./articles-overview-view";
import { renderChatComposer } from "./chat-composer";
import { renderChatHistoryPopover } from "./chat-history-view";
import { renderClippingView } from "./clipping-view";
import { applyActionLayout, button, formatDate, iconButton, row, section, setStyles, text } from "./dom";
import { renderQuizTestView } from "./quiz-test-view";
import { renderShell } from "./shell";

interface CachedSummaryText {
  mtime: number;
  text: SummaryText | null;
}

export class KnowFlowSidebarView extends ItemView {
  private activeChatThread: ChatThread | null = null;
  private streamingAnswerEl: HTMLElement | null = null;
  private streamingReasoningEl: HTMLElement | null = null;
  private streamingSummaryContentEl: HTMLElement | null = null;
  private streamingSummaryReasoningEl: HTMLElement | null = null;
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
  private summaryTextCache = new WeakMap<TFile, CachedSummaryText>();
  private summaryTextLoads = new WeakMap<TFile, Promise<SummaryText | null>>();
  private streamingSummaryTexts = new Map<string, string>();
  private streamingSummaryReasonings = new Map<string, string>();
  private clippingSummaryScanPending = false;

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
      height: "100%",
      position: "relative"
    });
    this.renderedContextKey = nextContextKey;

    if (this.activeChatThread) {
      this.renderChatThread(root, this.activeChatThread);
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
    const summary = this.getSummaryViewModel(file);
    const summaryPending = this.pendingSummaries.has(file.path);
    const summaryError = this.summaryErrors.get(file.path);
    const streamingText = this.streamingSummaryTexts.get(file.path);
    const streamingReasoning = this.streamingSummaryReasonings.get(file.path);
    const analysisCost = estimateClippingAnalysisTokens(file);
    const pipelineState = this.pipelineStates.get(file.path);
    const persistedPipeline = this.plugin.store.getPipelineStatus(file.path);
    // 重新生成时不展示旧摘要/指标，避免和流式过程叠在一起。
    const displaySummary = summaryPending ? null : summary;
    const selectedCategory = this.selectedCategories.get(file.path) ?? summary?.category ?? this.plugin.settings.defaultArticleCategory;

    renderClippingView(root, {
      title: file.basename,
      summary: displaySummary,
      summaryPending,
      summaryError,
      streamingText,
      streamingReasoning,
      analysisCost,
      pipelineState,
      persistedPipeline,
      selectedCategory,
      statusText: this.getPipelineStatusText(pipelineState, persistedPipeline.status),
      recommendedActionLabel: displaySummary ? this.recommendedActionLabel(displaySummary.recommendedAction) : "--",
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

    this.streamingSummaryContentEl = root.querySelector(".kf-streaming-text");
    this.streamingSummaryReasoningEl = root.querySelector(".kf-streaming-reasoning");
    this.renderComposer(root, context, file.basename, file);
  }

  private async ensureClippingSummary(file: TFile, force: boolean): Promise<void> {
    if (this.pendingSummaries.has(file.path)) return;
    if (!force && await this.readSummaryText(file)) return;
    this.pendingSummaries.add(file.path);
    this.summaryErrors.delete(file.path);
    this.clearStreamingSummary(file.path);
    if (this.plugin.router.getContext().activeFile?.path === file.path) {
      this.render();
    }
    try {
      const content = await this.app.vault.read(file);
      const summary = await this.plugin.ai.summarizeStream(
        file.path,
        file.basename,
        content,
        this.plugin.settings.defaultArticleCategory,
        ({ content: fullText, reasoning }) => {
          const visible = extractVisibleText(fullText);
          this.streamingSummaryTexts.set(file.path, visible);
          this.streamingSummaryReasonings.set(file.path, reasoning);
          if (this.plugin.router.getContext().activeFile?.path !== file.path) return;
          const needsContentEl = Boolean(visible) && !this.streamingSummaryContentEl;
          const needsReasoningEl = Boolean(reasoning) && !this.streamingSummaryReasoningEl;
          if (needsContentEl || needsReasoningEl) {
            this.render();
            return;
          }
          if (this.streamingSummaryReasoningEl) this.streamingSummaryReasoningEl.textContent = reasoning;
          if (this.streamingSummaryContentEl) this.streamingSummaryContentEl.textContent = visible;
        }
      );
      await this.plugin.summaryNotes.applySummary(
        file,
        { summary: summary.summary, reason: summary.reason },
        { description: summary.briefDescription, readingValue: summary.readingValue, category: summary.category, tags: summary.tags }
      );
      this.cacheSummaryText(file, { summary: summary.summary, reason: summary.reason });
      if (!this.manuallySelectedCategories.has(file.path)) {
        this.selectedCategories.set(file.path, summary.category);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.summaryErrors.set(file.path, message);
      new Notice(`KnowFlow summary failed: ${message}`, 8000);
    } finally {
      this.clearStreamingSummary(file.path);
      this.pendingSummaries.delete(file.path);
      if (this.plugin.router.getContext().activeFile?.path === file.path) {
        this.render();
      }
    }
  }

  private clearStreamingSummary(filePath: string): void {
    this.streamingSummaryTexts.delete(filePath);
    this.streamingSummaryReasonings.delete(filePath);
    this.streamingSummaryContentEl = null;
    this.streamingSummaryReasoningEl = null;
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

    const summary = this.getSummaryViewModel(file);
    const quiz = this.getQuizStats(file.path);
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const readingValue = this.getFrontmatterReadingValue(frontmatter) ?? (summary && summary.readingValue > 0 ? `${summary.readingValue}/5` : "--");
    const learningStatus = this.getFrontmatterLearningStatus(frontmatter) ?? (this.plugin.store.isLearned(file.path) ? "已学习" : "未学习");

    renderArticleDetailView(root, {
      title: file.basename,
      readingValue,
      learningStatus,
      summary,
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

  private renderChatThread(root: HTMLElement, thread: ChatThread): void {
    const content = renderShell(root, "", "Ready", () => {
      this.activeChatThread = null;
      this.render();
    });
    this.streamingAnswerEl = null;
    this.streamingReasoningEl = null;

    for (const message of thread.messages) {
      if (message.role === "user") {
        const question = section(content, "kf-question");
        setStyles(question, {
          alignSelf: "stretch",
          backgroundColor: "color-mix(in srgb, var(--interactive-accent) 15%, var(--background-primary))",
          border: "1px solid color-mix(in srgb, var(--interactive-accent) 38%, var(--background-modifier-border))",
          gap: "10px",
          padding: "12px",
          textAlign: "left",
          width: "100%"
        });
        const questionText = text(question, message.content, "kf-question-text");
        setStyles(questionText, { textAlign: "left", width: "100%" });
        const footer = row(question);
        setStyles(footer, { justifyContent: "space-between", width: "100%" });
        text(footer, formatDate(message.createdAt), "kf-token-estimate");
        const actions = row(footer);
        setStyles(actions, { gap: "2px", marginLeft: "auto" });
        const userAction = (label: string, icon: string, onClick: () => void): void => {
          const action = setStyles(iconButton(actions, label, icon, onClick), {
            backgroundColor: "transparent",
            border: "0",
            color: "var(--interactive-accent)",
            height: "22px",
            width: "22px"
          });
          const svg = action.querySelector<SVGSVGElement>("svg");
          if (svg) Object.assign(svg.style, { height: "14px", width: "14px" });
        };
        userAction("复制问题", "copy", () => navigator.clipboard.writeText(message.content));
        userAction("编辑并重新提问", "square-pen", () => {
          this.composerDraft = message.content;
          this.render();
          window.requestAnimationFrame(() => {
            const input = this.containerEl.querySelector<HTMLTextAreaElement>(".kf-input");
            input?.focus();
            input?.setSelectionRange(input.value.length, input.value.length);
          });
        });
        userAction("删除本轮对话", "trash-2", () => {
          this.deleteChatTurn(thread, message.id);
        });
        continue;
      }

      const assistant = content.createDiv({ cls: "kf-assistant-message" });
      setStyles(assistant, {
        display: "flex",
        flexDirection: "column",
        gap: "8px"
      });

      const reasoning = assistant.createEl("details", { cls: "kf-thinking" });
      setStyles(reasoning, {
        backgroundColor: "var(--background-secondary)",
        border: "1px solid color-mix(in srgb, var(--interactive-accent) 22%, var(--background-modifier-border))",
        borderRadius: "8px",
        display: message.reasoning ? "block" : "none",
        padding: "9px 11px"
      });
      reasoning.createEl("summary", { text: "Thought process" });
      const reasoningBody = reasoning.createDiv();
      setStyles(reasoningBody, { fontSize: "12px", lineHeight: "1.5", marginTop: "7px", whiteSpace: "pre-wrap" });
      reasoningBody.textContent = message.reasoning;

      const answer = assistant.createDiv({ cls: "kf-answer" });
      setStyles(answer, {
        color: "var(--text-normal)",
        fontSize: "13px",
        lineHeight: "1.5",
        minHeight: message.status === "pending" ? "24px" : "0",
        whiteSpace: message.status === "done" ? "normal" : "pre-wrap"
      });
      if (message.status === "done") {
        void this.renderMarkdownSummary(answer, message.content, thread.filePath ?? "");
      } else if (message.status === "error") {
        text(answer, `生成失败：${message.error ?? "未知错误"}`, "kf-muted");
      } else {
        answer.textContent = message.content || "正在等待模型响应…";
      }

      if (message.status === "pending" || message.status === "streaming") {
        this.streamingAnswerEl = answer;
        this.streamingReasoningEl = reasoningBody;
      }

      if (message.completedAt) {
        const footer = row(assistant);
        setStyles(footer, { justifyContent: "space-between", width: "100%" });
        text(footer, formatDate(message.completedAt), "kf-muted");
        const actions = row(footer);
        setStyles(actions, { gap: "2px", marginLeft: "auto" });
        const chatAction = (label: string, icon: string, onClick: () => void): void => {
          const action = setStyles(iconButton(actions, label, icon, onClick), {
            backgroundColor: "transparent",
            border: "0",
            height: "22px",
            width: "22px"
          });
          const svg = action.querySelector<SVGSVGElement>("svg");
          if (svg) Object.assign(svg.style, { height: "14px", width: "14px" });
        };
        chatAction("插入到光标下一行", "text-cursor-input", () => {
          if (!insertBelowCursor(this.app, thread.filePath, message.content)) {
            new Notice("未找到关联文章的编辑视图，请先打开关联文章。");
          }
        });
        chatAction("复制回答", "copy", () => navigator.clipboard.writeText(message.content));
        chatAction("重新生成", "refresh-cw", () => {
          const previous = this.findPreviousUserMessage(thread, message.id);
          if (previous) void this.submitChat(previous.content);
        });
        chatAction("存为摘要", "save", () => void this.saveAssistantAsSummary(thread, message));
      }
    }

    const context = this.plugin.router.getContext();
    const file = thread.filePath ? this.app.vault.getAbstractFileByPath(thread.filePath) : null;
    this.renderComposer(root, context, thread.contextLabel, file instanceof TFile ? file : null);
  }

  private renderComposer(root: HTMLElement, context: ViewContext, label: string, file: TFile | null): void {
    const usage = this.activeChatThread?.usage ?? emptyChatUsage();
    const sending = this.activeChatThread?.messages.some((message) =>
      message.role === "assistant" && (message.status === "pending" || message.status === "streaming")
    ) ?? false;
    renderChatComposer(root, {
      contextLabel: label,
      modelName: this.plugin.settings.chatModel.model,
      draft: this.composerDraft,
      focusDraft: this.pendingComposerFocus,
      tokenCount: usage.totalTokens,
      tokenEstimated: usage.estimated,
      sending,
      onDraftChange: (value) => {
        this.composerDraft = value;
      },
      onSubmit: (question) => void this.submitChat(question, context, file),
      onSaveNote: () => void this.saveActiveChatToNote(),
      onOpenHistory: () => void this.openChatHistory()
    });
  }

  private async submitChat(question: string, context = this.plugin.router.getContext(), file: TFile | null = context.activeFile): Promise<void> {
    if (!question) {
      new Notice("Enter a question first");
      return;
    }
    const now = new Date().toISOString();
    const thread = this.activeChatThread ?? createChatThread(context, file, now);
    const userMessage = createChatMessage("user", question, now, "done");
    const assistantMessage = createChatMessage("assistant", "", now, "pending");
    thread.messages.push(userMessage, assistantMessage);
    thread.updatedAt = now;
    this.activeChatThread = thread;
    this.composerDraft = "";
    this.render();

    const content = file ? await this.app.vault.read(file) : "";
    let requestUsage = emptyChatUsage();
    try {
      assistantMessage.status = "streaming";
      requestUsage = await this.plugin.ai.answerStream(
        thread.contextLabel,
        content,
        thread.messages.filter((message) => message.id !== assistantMessage.id),
        {
          onContent: (delta) => {
            assistantMessage.content += delta;
            assistantMessage.status = "streaming";
            if (this.streamingAnswerEl) this.streamingAnswerEl.textContent = assistantMessage.content;
          },
          onReasoning: (delta) => {
            assistantMessage.reasoning += delta;
            if (this.streamingReasoningEl) {
              const details = this.streamingReasoningEl.closest("details") as HTMLElement | null;
              if (details) details.style.display = "block";
              this.streamingReasoningEl.textContent = assistantMessage.reasoning;
            }
          },
          onUsage: (usage) => {
            requestUsage = usage;
          }
        }
      );
      assistantMessage.status = "done";
      assistantMessage.completedAt = new Date().toISOString();
      thread.usage = addChatUsage(thread.usage, requestUsage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assistantMessage.status = "error";
      assistantMessage.error = message;
      assistantMessage.completedAt = new Date().toISOString();
      new Notice(`KnowFlow chat failed: ${message}`, 8000);
    }
    if (file) {
      thread.filePath = file.path;
      thread.contextLabel = file.basename;
    }
    thread.updatedAt = assistantMessage.completedAt ?? new Date().toISOString();
    this.render();
  }

  private findPreviousUserMessage(thread: ChatThread, assistantId: string): ChatMessage | null {
    const index = thread.messages.findIndex((message) => message.id === assistantId);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (thread.messages[cursor].role === "user") return thread.messages[cursor];
    }
    return null;
  }

  private deleteChatTurn(thread: ChatThread, userMessageId: string): void {
    const index = thread.messages.findIndex((message) => message.id === userMessageId);
    if (index < 0) return;
    const count = thread.messages[index + 1]?.role === "assistant" ? 2 : 1;
    thread.messages.splice(index, count);
    thread.updatedAt = new Date().toISOString();
    this.render();
  }

  private async saveAssistantAsSummary(thread: ChatThread, message: ChatMessage): Promise<void> {
    if (!thread.filePath) return;
    const target = this.app.vault.getAbstractFileByPath(thread.filePath);
    if (!(target instanceof TFile)) {
      new Notice("关联文章不存在。");
      return;
    }
    const summary: NoteSummary = {
      filePath: thread.filePath,
      title: thread.contextLabel,
      briefDescription: message.content.replace(/\s+/g, " ").slice(0, 160),
      summary: message.content,
      readingValue: 3,
      recommendedAction: "skim",
      category: this.plugin.settings.defaultArticleCategory,
      reason: "用户从 Chat 手动保存为摘要。",
      tags: []
    };
    await this.plugin.summaryNotes.applySummary(
      target,
      { summary: summary.summary, reason: summary.reason },
      { description: summary.briefDescription, readingValue: summary.readingValue, category: summary.category, tags: summary.tags }
    );
    this.cacheSummaryText(target, { summary: summary.summary, reason: summary.reason });
    new Notice("Saved as AI Summary");
  }

  private async saveActiveChatToNote(): Promise<void> {
    if (!this.activeChatThread || this.activeChatThread.messages.length === 0) {
      new Notice("当前没有可保存的对话。");
      return;
    }
    const path = await this.plugin.chatNotes.saveThread(this.activeChatThread);
    new Notice(`Chat 已保存到 ${path}`);
  }

  private async openChatHistory(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    const existing = root.querySelector(".kf-chat-history-layer");
    if (existing) {
      existing.remove();
      return;
    }
    const threads = await this.plugin.chatNotes.listThreads();
    renderChatHistoryPopover(root, {
      threads,
      onClose: () => root.querySelector(".kf-chat-history-layer")?.remove(),
      onOpen: (thread) => {
        this.activeChatThread = thread;
        this.render();
      }
    });
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
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const category = this.getFrontmatterCategory(frontmatter);
      if (category && !this.manuallySelectedCategories.has(file.path)) {
        this.selectedCategories.set(file.path, category);
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
      const questions = await this.plugin.ai.generateQuiz(file.path, file.basename, content, readingValue);
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

  private getSummaryViewModel(file: TFile): NoteSummary | null {
    const text = this.loadSummaryText(file);
    if (text === null) return null;
    return {
      ...this.getSummaryMeta(file),
      filePath: file.path,
      title: file.basename,
      summary: text?.summary ?? "正在读取摘要正文...",
      reason: text?.reason ?? ""
    };
  }

  private loadSummaryText(file: TFile): SummaryText | null | undefined {
    const cached = this.getCachedSummaryText(file);
    if (cached !== undefined) return cached;
    void this.refreshSummaryText(file);
    return undefined;
  }

  private async refreshSummaryText(file: TFile): Promise<void> {
    await this.readSummaryText(file);
    if (this.plugin.router.getContext().activeFile === file) {
      this.render();
    }
  }

  private getCachedSummaryText(file: TFile): SummaryText | null | undefined {
    const cached = this.summaryTextCache.get(file);
    return cached?.mtime === file.stat.mtime ? cached.text : undefined;
  }

  private cacheSummaryText(file: TFile, text: SummaryText | null): void {
    this.summaryTextCache.set(file, { mtime: file.stat.mtime, text });
  }

  private readSummaryText(file: TFile): Promise<SummaryText | null> {
    const cached = this.getCachedSummaryText(file);
    if (cached !== undefined) return Promise.resolve(cached);

    const pending = this.summaryTextLoads.get(file);
    if (pending) return pending;

    const mtime = file.stat.mtime;
    const load = this.plugin.summaryNotes.loadSummaryText(file)
      .then((text) => {
        this.summaryTextCache.set(file, { mtime, text });
        return text;
      })
      .finally(() => this.summaryTextLoads.delete(file));
    this.summaryTextLoads.set(file, load);
    return load;
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
    const uncached = files.some((file) => this.getCachedSummaryText(file) === undefined);
    if (uncached && !this.clippingSummaryScanPending) {
      void this.refreshClippingSummaryStats(files);
    }
    const summarized = files.filter((file) => this.getCachedSummaryText(file) !== null && this.getCachedSummaryText(file) !== undefined);
    return {
      total: files.length,
      summarized: summarized.length,
      highValue: summarized.filter((file) => this.getArticleReadingValue(file) >= 4).length
    };
  }

  private async refreshClippingSummaryStats(files: TFile[]): Promise<void> {
    this.clippingSummaryScanPending = true;
    try {
      await Promise.all(files.map((file) => this.readSummaryText(file)));
      if (this.plugin.router.getContext().mode === "articles-overview") {
        this.render();
      }
    } finally {
      this.clippingSummaryScanPending = false;
    }
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

  private getSummaryMeta(file: TFile): Omit<NoteSummary, "filePath" | "title" | "summary" | "reason"> {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const readingValue = this.getFrontmatterReadingValueNumber(frontmatter) ?? 0;
    return {
      briefDescription: this.getFrontmatterBriefDescription(frontmatter) ?? "",
      readingValue,
      category: this.getFrontmatterCategory(frontmatter) ?? this.plugin.settings.defaultArticleCategory,
      tags: this.getFrontmatterTags(frontmatter) ?? [],
      recommendedAction: this.recommendedActionFromReadingValue(readingValue)
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

  private recommendedActionFromReadingValue(value: number): NoteSummary["recommendedAction"] {
    if (value <= 1) return "skip";
    if (value >= 5) return "keep_reference";
    if (value >= 4) return "deep_learn";
    return "skim";
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
    if (this.activeChatThread) return `chat:${this.activeChatThread.id}`;
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

function createChatThread(context: ViewContext, file: TFile | null, now: string): ChatThread {
  return {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourceMode: context.mode,
    filePath: file?.path ?? null,
    contextLabel: file?.basename ?? "Current",
    messages: [],
    createdAt: now,
    updatedAt: now,
    usage: emptyChatUsage()
  };
}

function createChatMessage(
  role: ChatMessage["role"],
  content: string,
  createdAt: string,
  status: ChatMessage["status"]
): ChatMessage {
  return {
    id: `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    reasoning: "",
    createdAt,
    status
  };
}

function emptyChatUsage(): ChatUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false };
}

function addChatUsage(current: ChatUsage, next: ChatUsage): ChatUsage {
  return {
    promptTokens: current.promptTokens + next.promptTokens,
    completionTokens: current.completionTokens + next.completionTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    estimated: current.estimated || next.estimated
  };
}

/**
 * During streaming, just strip JSON structural noise so the user sees
 * text appearing progressively. Don't try to extract specific fields
 * until the full JSON is complete.
 */
function extractVisibleText(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/[{}\[\]]/g, "\n")
    .replace(/"\w+":\s*"/g, "")
    .replace(/",?\s*$/gm, "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
