import { setIcon } from "obsidian";
import type { NoteSummary, QuizStats } from "../types";
import { applyActionLayout, applyMetricsLayout, button, metric, row, section, setStyles, text } from "./dom";
import { renderBrandShell } from "./shell";

interface ArticleDetailViewProps {
  title: string;
  readingValue: string;
  learningStatus: string;
  summary: NoteSummary | null;
  quiz: QuizStats;
  renderMarkdownSummary: (parent: HTMLElement, markdown: string) => void;
  onGenerateKnowledgeMap: () => void;
  onShowKnowledgePoints: () => void;
  onGenerateQuiz: () => void;
  onStartQuiz: () => void;
}

export function renderArticleDetailView(root: HTMLElement, props: ArticleDetailViewProps): void {
  const content = renderBrandShell(root, "Article assistant");

  const article = section(content, "kf-current");
  text(article, props.title, "kf-card-title");
  const metrics = row(article, "kf-metrics");
  applyMetricsLayout(metrics);
  metric(metrics, "阅读价值", props.readingValue);
  metric(metrics, "状态", props.learningStatus);
  metric(metrics, "知识点", "V0.2");

  const summary = section(content, "kf-summary");
  const summaryHead = row(summary);
  setStyles(summaryHead, { justifyContent: "space-between" });
  const summaryTitle = row(summaryHead);
  setStyles(summaryTitle, { gap: "8px", minWidth: "0" });
  const summaryIcon = summaryTitle.createSpan();
  setIcon(summaryIcon, "sparkles");
  setStyles(summaryIcon, {
    color: "var(--interactive-accent)",
    display: "inline-flex",
    flex: "0 0 auto"
  });
  text(summaryTitle, "AI Summary", "kf-card-title");
  if (props.summary) {
    props.renderMarkdownSummary(summary, props.summary.summary);
  } else {
    text(summary, "当前文章还没有摘要。可以通过 Clipping 页面生成分析后移动到 Articles。", "kf-muted");
  }

  const mapCard = section(content, "kf-knowledge-map");
  const mapHead = row(mapCard);
  setStyles(mapHead, { justifyContent: "space-between" });
  const mapTitle = row(mapHead);
  setStyles(mapTitle, { gap: "8px", minWidth: "0" });
  const mapIcon = mapTitle.createSpan();
  setIcon(mapIcon, "git-fork");
  setStyles(mapIcon, {
    color: "var(--interactive-accent)",
    display: "inline-flex",
    flex: "0 0 auto"
  });
  text(mapTitle, "Knowledge Map", "kf-card-title");
  text(mapHead, "Mermaid", "kf-pill");
  text(mapCard, "将当前文章的概念结构生成 Mermaid，并插入原文的 ## Knowledge Map 区块。", "kf-muted");
  const mapActions = row(mapCard, "kf-actions");
  applyActionLayout(mapActions);
  button(mapActions, "生成 Mermaid", props.onGenerateKnowledgeMap, true);
  button(mapActions, "查看知识点", props.onShowKnowledgePoints);

  const quizCard = section(content, "kf-quiz");
  const quizHead = row(quizCard);
  setStyles(quizHead, { gap: "8px" });
  const quizIcon = quizHead.createSpan();
  setIcon(quizIcon, "list-checks");
  setStyles(quizIcon, {
    color: "var(--interactive-accent)",
    display: "inline-flex",
    flex: "0 0 auto"
  });
  text(quizHead, "Quiz", "kf-card-title");
  const quizMetrics = row(quizCard, "kf-metrics");
  applyMetricsLayout(quizMetrics);
  metric(quizMetrics, "题目", String(props.quiz.total));
  metric(quizMetrics, "正确率", props.quiz.accuracy === null ? "--" : `${props.quiz.accuracy}%`);
  metric(quizMetrics, "错题", String(props.quiz.wrong));
  const actions = row(quizCard, "kf-actions");
  applyActionLayout(actions);
  button(actions, "生成试题", props.onGenerateQuiz, true);
  button(actions, "开始测试", props.onStartQuiz);
}
