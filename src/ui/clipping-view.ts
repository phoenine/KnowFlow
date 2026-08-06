import { setIcon } from "obsidian";
import { ARTICLE_CATEGORIES } from "../services/clipping-pipeline";
import type { NoteSummary, PipelineStatus, PipelineUiState } from "../types";
import { applyActionLayout, applyMetricsLayout, attachPressFeedback, button, cardHeader, formatDate, iconSpan, metric, row, section, setStyles, text } from "./dom";
import { renderBrandShell } from "./shell";

const CLIPPING_PIPELINE_STEPS = [
  "整理 Markdown 样式",
  "格式化代码块",
  "AI 判断未围栏代码",
  "AI 判断代码语言",
  "AI 判断标题",
  "英文翻译（可选）",
  "补全 Frontmatter"
];

interface ClippingViewProps {
  title: string;
  summary: NoteSummary | null;
  summaryPending: boolean;
  summaryError: string | undefined;
  streamingText?: string;
  streamingReasoning?: string;
  analysisCost: number;
  pipelineState: PipelineUiState | undefined;
  persistedPipeline: PipelineStatus;
  selectedCategory: string;
  statusText: string;
  recommendedActionLabel: string;
  renderMarkdownSummary: (parent: HTMLElement, markdown: string) => void;
  onRefreshSummary: () => Promise<void>;
  onGenerateSummary: () => Promise<void>;
  onRunPipeline: () => Promise<void>;
  onSelectCategory: (category: string) => void;
  onMoveCategory: (category: string) => Promise<void>;
}

export function renderClippingView(root: HTMLElement, props: ClippingViewProps): void {
  const content = renderBrandShell(root, "Clipping assistant");

  const current = section(content, "kf-current");
  const titleRow = row(current);
  iconSpan(titleRow, "file-text");
  text(titleRow, props.title, "kf-card-title");
  const metrics = row(current, "kf-metrics");
  applyMetricsLayout(metrics);
  metric(metrics, "阅读价值", props.summary ? `${props.summary.readingValue}/5` : "--");
  metric(metrics, "推荐动作", props.summary ? props.recommendedActionLabel : "--");
  metric(metrics, "建议目录", props.summary?.category ?? "--");

  renderSummaryCard(content, props);
  renderPipelineCard(content, props);
  renderMoveCard(content, props);
}

function renderSummaryCard(content: HTMLElement, props: ClippingViewProps): void {
  const summary = section(content, "kf-summary");
  let refreshButton!: HTMLButtonElement;
  cardHeader(summary, "sparkles", "AI Summary", (header) => {
    refreshButton = unborderedIconButton(header, "Refresh summary", "refresh-cw", () => {
      if (!props.summaryPending) {
        void lockButton(refreshButton, props.onRefreshSummary);
      }
    });
  });
  if (!props.summary && !props.summaryError && !props.summaryPending) {
    refreshButton.style.display = "none";
  }
  if (props.summaryPending) {
    refreshButton.disabled = true;
    setStyles(refreshButton, {
      cursor: "default",
      opacity: "0.72"
    });
    refreshButton.animate(
      [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
      { duration: 900, iterations: Infinity }
    );
  }
  if (props.summary && !props.summaryPending) {
    props.renderMarkdownSummary(summary, `${props.summary.summary}${props.summary.reason ? `\n\n> ${props.summary.reason}` : ""}`);
  } else if (props.summaryPending && props.streamingText) {
    // 正式内容开始后完全替换 reasoning，避免两个信息层争夺注意力。
    const streamEl = summary.createDiv({ cls: "kf-streaming-text" });
    setStyles(streamEl, {
      color: "var(--text-muted)",
      fontSize: "13px",
      lineHeight: "1.5",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word"
    });
    streamEl.setText(props.streamingText);
  } else if (props.summaryPending && props.streamingReasoning) {
    const viewport = summary.createDiv({ cls: "kf-streaming-reasoning-viewport" });
    setStyles(viewport, {
      height: "90px",
      maskImage: "linear-gradient(to bottom, transparent 0%, black 30%, black 100%)",
      overflow: "hidden",
      position: "relative"
    });
    const flow = viewport.createDiv({ cls: "kf-streaming-reasoning-flow" });
    setStyles(flow, {
      fontSize: "12px",
      lineHeight: "1.5",
      minHeight: "100%",
      overflowWrap: "anywhere",
      whiteSpace: "pre-wrap"
    });
    const historyEl = flow.createSpan({ cls: "kf-streaming-reasoning-history" });
    setStyles(historyEl, { color: "var(--text-muted)" });
    const latestEl = flow.createSpan({ cls: "kf-streaming-reasoning-latest" });
    setStyles(latestEl, { color: "var(--text-normal)", fontWeight: "500" });
    updateStreamingReasoning(historyEl, latestEl, props.streamingReasoning);
    // 推理过程中仍显示提示文案和 token 预估
    const separator = summary.createDiv({ cls: "kf-reasoning-separator" });
    setStyles(separator, {
      borderTop: "1px solid var(--background-modifier-border)",
      margin: "8px 0"
    });
    text(summary, "正在根据当前 Clipping 生成摘要、阅读价值和分类建议。", "kf-muted");
    text(summary, `预计消耗：约 ${props.analysisCost}k tokens`, "kf-token-estimate");
  } else {
    text(
      summary,
      props.summaryPending
        ? "正在根据当前 Clipping 生成摘要、阅读价值和分类建议。"
        : props.summaryError
          ? `生成失败：${props.summaryError}`
          : "当前 Clipping 尚未分析。点击生成摘要后，会保存摘要、阅读价值、推荐动作和建议目录，不写入 Markdown 正文。",
      "kf-muted"
    );
    text(summary, `预计消耗：约 ${props.analysisCost}k tokens`, "kf-token-estimate");
    if (!props.summaryPending) {
      const summaryActions = row(summary, "kf-actions");
      applyActionLayout(summaryActions);
      const generateButton = button(summaryActions, props.summaryError ? "重新生成摘要" : "生成摘要", () => {
        void lockButton(generateButton, props.onGenerateSummary);
      }, true);
    }
  }
}

export function updateStreamingReasoning(
  historyEl: HTMLElement,
  latestEl: HTMLElement,
  reasoning: string
): void {
  const { history, latest } = splitReasoningFocus(reasoning);
  historyEl.setText(history);
  latestEl.setText(latest);
  const viewport = latestEl.closest<HTMLElement>(".kf-streaming-reasoning-viewport");
  window.requestAnimationFrame(() => {
    if (viewport?.isConnected) viewport.scrollTop = viewport.scrollHeight;
  });
}

function splitReasoningFocus(reasoning: string): { history: string; latest: string } {
  const focusLength = 120;
  if (reasoning.length <= focusLength) return { history: "", latest: reasoning };

  // 优先聚焦当前段落；段落过长时保留最后一小段，避免整屏一直保持高亮。
  const lastBreak = reasoning.lastIndexOf("\n", reasoning.length - 2);
  let splitAt = lastBreak >= reasoning.length - focusLength ? lastBreak + 1 : reasoning.length - focusLength;
  const nextWhitespace = reasoning.slice(splitAt, splitAt + 24).search(/\s/);
  if (lastBreak < reasoning.length - focusLength && nextWhitespace >= 0) {
    splitAt += nextWhitespace + 1;
  }
  return {
    history: reasoning.slice(0, splitAt),
    latest: reasoning.slice(splitAt)
  };
}

function renderPipelineCard(content: HTMLElement, props: ClippingViewProps): void {
  const pipeline = section(content, "kf-pipeline");
  setStyles(pipeline, {
    backgroundColor: "color-mix(in srgb, orange 7%, var(--background-primary))",
    borderColor: "color-mix(in srgb, orange 35%, var(--background-modifier-border))"
  });
  const pipelineHeader = cardHeader(pipeline, "list-checks", "Clipping Pipeline", (header) => {
    const raw = header.createDiv({ text: props.statusText });
    applyStatusPill(raw);
  });
  setStyles(pipelineHeader, { alignItems: "flex-start" });

  if (props.pipelineState?.visible) {
    renderPipelineProgress(pipeline, props.pipelineState);
  } else if (props.persistedPipeline.status === "processed") {
    text(pipeline, `上次整理：${props.persistedPipeline.updatedAt ? formatDate(props.persistedPipeline.updatedAt) : "--"}。可以再次点击整理当前文章进行二次整理。`, "kf-muted");
  } else if (props.persistedPipeline.status === "failed") {
    const persistedError = text(pipeline, `上次整理失败：${compactErrorMessage(props.persistedPipeline.error ?? "未知错误")}`, "kf-muted");
    setStyles(persistedError, {
      color: "var(--text-error)",
      fontSize: "12px"
    });
  } else {
    text(pipeline, "点击整理后显示处理进度。Pipeline 会先规则清理，再调用 Summary model 优化 Markdown 格式，最后补全 Frontmatter。", "kf-muted");
  }
  const actions = row(pipeline, "kf-actions");
  applyActionLayout(actions);
  const runButton = button(actions, props.pipelineState?.running ? "整理中..." : "整理当前文章", () => {
    void lockButton(runButton, props.onRunPipeline);
  }, true);
  if (props.pipelineState?.running) {
    runButton.disabled = true;
    setStyles(runButton, {
      cursor: "default",
      opacity: "0.72"
    });
  }
}

function renderMoveCard(content: HTMLElement, props: ClippingViewProps): void {
  const move = section(content, "kf-move");
  cardHeader(move, "folder-input", "分类与移动", (header) => {
    text(header, "用户确认", "kf-pill");
  });
  const categoryControl = row(move);
  setStyles(categoryControl, {
    justifyContent: "space-between",
    gap: "12px"
  });
  text(categoryControl, "移动到", "kf-muted");
  const select = categoryControl.createEl("select");
  setStyles(select, {
    backgroundColor: "var(--background-primary)",
    border: "1px solid color-mix(in srgb, var(--interactive-accent) 32%, var(--background-modifier-border))",
    borderRadius: "7px",
    color: "var(--text-normal)",
    flex: "0 0 150px",
    fontSize: "13px",
    minWidth: "0",
    padding: "5px 8px"
  });
  for (const category of ARTICLE_CATEGORIES) {
    select.createEl("option", { text: category, value: category });
  }
  select.value = props.selectedCategory;
  select.addEventListener("change", () => props.onSelectCategory(select.value));
  const moveActions = row(move, "kf-actions");
  applyActionLayout(moveActions);
  button(moveActions, "移动到分类", () => void props.onMoveCategory(select.value), true);
}

function renderPipelineProgress(parent: HTMLElement, state: PipelineUiState): void {
  const list = parent.createDiv({ cls: "kf-pipeline-progress" });
  setStyles(list, {
    display: "flex",
    flexDirection: "column",
    gap: "7px"
  });

  for (const step of CLIPPING_PIPELINE_STEPS) {
    const done = state.completed.includes(step);
    const skipped = state.skipped.includes(step);
    const active = state.currentStep === step;
    const failed = state.failedStep === step;
    const item = row(list, "kf-pipeline-step");
    setStyles(item, {
      justifyContent: "space-between",
      minHeight: "24px"
    });
    const left = row(item);
    setStyles(left, { gap: "7px", minWidth: "0" });
    const icon = left.createSpan();
    setIcon(icon, failed ? "circle-x" : done ? "check" : skipped ? "minus" : active ? "loader-2" : "circle");
    setStyles(icon, {
      color: failed
        ? "var(--text-error)"
        : done || active
          ? "var(--interactive-accent)"
          : "var(--text-faint)",
      display: "inline-flex",
      flex: "0 0 auto"
    });
    text(left, step, "kf-step");
    const status = item.createDiv({
      text: failed ? "失败" : done ? "完成" : skipped ? "跳过" : active ? "进行中" : "等待"
    });
    setStyles(status, {
      color: failed
        ? "var(--text-error)"
        : done || active
          ? "var(--text-accent)"
          : "var(--text-faint)",
      flex: "0 0 auto",
      fontSize: "12px",
      fontWeight: active ? "600" : "500",
      whiteSpace: "nowrap"
    });
  }

  if (state.error) {
    const errorBox = parent.createDiv({ cls: "kf-pipeline-error" });
    setStyles(errorBox, {
      backgroundColor: "color-mix(in srgb, var(--text-error) 8%, var(--background-primary))",
      border: "1px solid color-mix(in srgb, var(--text-error) 28%, var(--background-modifier-border))",
      borderRadius: "8px",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      padding: "8px 9px"
    });
    const title = text(errorBox, `失败：${state.failedStep ?? "未知步骤"}`, "kf-muted");
    setStyles(title, {
      color: "var(--text-error)",
      fontSize: "12px",
      fontWeight: "600"
    });
    const message = text(errorBox, compactErrorMessage(state.error), "kf-muted");
    setStyles(message, {
      color: "var(--text-error)",
      fontSize: "12px",
      lineHeight: "1.35"
    });
    const actions = row(errorBox);
    applyActionLayout(actions);
    const copy = button(actions, "复制完整错误", () => navigator.clipboard.writeText(`步骤：${state.failedStep ?? "未知步骤"}\n${state.error}`));
    setStyles(copy, {
      flex: "0 0 auto",
      fontSize: "12px",
      minHeight: "28px",
      padding: "5px 9px"
    });
  }
}

function applyStatusPill(el: HTMLElement): void {
  setStyles(el, {
    border: "1px solid color-mix(in srgb, var(--interactive-accent) 30%, var(--background-modifier-border))",
    borderRadius: "7px",
    color: "var(--text-accent)",
    flex: "0 0 auto",
    fontSize: "12px",
    fontWeight: "600",
    lineHeight: "1.2",
    maxWidth: "70px",
    padding: "5px 8px",
    textAlign: "center",
    whiteSpace: "nowrap"
  });
}

function unborderedIconButton(parent: HTMLElement, label: string, icon: string, onClick: () => void): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "kf-icon-button", attr: { "aria-label": label, title: label } });
  setStyles(button, {
    alignItems: "center",
    backgroundColor: "transparent",
    border: "0",
    borderRadius: "7px",
    color: "var(--text-muted)",
    cursor: "pointer",
    display: "inline-flex",
    height: "26px",
    justifyContent: "center",
    padding: "0",
    transition: "filter 120ms ease, opacity 120ms ease, transform 120ms ease",
    width: "26px"
  });
  setIcon(button, icon);
  attachPressFeedback(button);
  button.addEventListener("click", onClick);
  return button;
}

async function lockButton(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  if (button.disabled) return;
  button.disabled = true;
  setStyles(button, {
    cursor: "default",
    filter: "brightness(1.03)",
    opacity: "0.72"
  });
  try {
    await action();
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      setStyles(button, {
        cursor: "pointer",
        filter: "none",
        opacity: "1"
      });
    }
  }
}

function compactErrorMessage(error: string): string {
  const firstLine = error.split("\n").find((line) => line.trim())?.trim() ?? error.trim();
  return firstLine
    .replace(/\s*Raw response:.*$/s, "")
    .replace(/\s{2,}/g, " ")
    .slice(0, 120);
}
