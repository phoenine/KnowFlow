import type { ArticleStats } from "../types";
import { applyMetricsLayout, button, cardHeader, metric, row, section, setStyles, text } from "./dom";
import { renderBrandShell } from "./shell";

interface ArticlesOverviewViewProps {
  scopeLabel: string;
  stats: ArticleStats;
  clippingStats: { total: number; summarized: number; highValue: number };
  categoryStats: Array<{ name: string; total: number; learned: number }>;
  dailyNew: number;
  dailyReview: number;
  weeklyLearned: number;
  firstUnreadTitle: string;
  onStartDaily: () => void;
}

export function renderArticlesOverviewView(root: HTMLElement, props: ArticlesOverviewViewProps): void {
  const content = renderBrandShell(root, "Articles overview");

  const daily = section(content, "kf-daily");
  cardHeader(daily, "calendar-check", "Daily Learning", (header) => {
    text(header, "今日", "kf-pill");
  });
  const dailyMetrics = row(daily, "kf-metrics");
  applyMetricsLayout(dailyMetrics);
  metric(dailyMetrics, "新文章", String(props.dailyNew));
  metric(dailyMetrics, "复习", String(props.dailyReview));
  metric(dailyMetrics, "薄弱点", String(props.stats.weakPoints));
  taskRow(daily, "学习", props.firstUnreadTitle);
  taskRow(daily, "复习", props.stats.reviewDue > 0 ? "复习已学习文章" : "暂无到期复习");
  taskRow(daily, "薄弱点", props.stats.weakPoints > 0 ? "等待 Quiz 数据生成" : "暂无薄弱知识点");
  button(daily, "开始今日学习任务", props.onStartDaily, true);

  const progress = section(content, "kf-progress");
  cardHeader(progress, "trending-up", "学习进度");
  progressRow(progress, "本周阅读", `${props.weeklyLearned} 篇`, props.weeklyLearned > 0 ? "持续" : "待开始");
  progressRow(progress, "本周复习", `${props.dailyReview} 次`, props.dailyReview > 0 ? "待处理" : "无到期");
  progressRow(progress, "平均正确率", "--", "生成 Quiz 后统计");

  const clipping = section(content, "kf-clipping-stats");
  cardHeader(clipping, "inbox", "Clipping 统计");
  const clippingMetrics = row(clipping, "kf-metrics");
  applyMetricsLayout(clippingMetrics);
  metric(clippingMetrics, "待整理", String(props.clippingStats.total));
  metric(clippingMetrics, "已摘要", String(props.clippingStats.summarized));
  metric(clippingMetrics, "高价值", String(props.clippingStats.highValue));

  const articles = section(content, "kf-article-categories");
  cardHeader(articles, "folder-open", "Articles 分类统计", (header) => {
    text(header, props.scopeLabel, "kf-pill");
  });
  const articleMetrics = row(articles, "kf-metrics");
  applyMetricsLayout(articleMetrics);
  metric(articleMetrics, "文章", String(props.stats.total));
  metric(articleMetrics, "已学习", String(props.stats.learned));
  metric(articleMetrics, "待读", String(props.stats.unread));
  for (const category of props.categoryStats.slice(0, 6)) {
    categoryRow(articles, category.name, category.total, category.learned);
  }
}

function progressRow(parent: HTMLElement, label: string, value: string, trend: string): void {
  const item = row(parent, "kf-progress-row");
  setStyles(item, {
    justifyContent: "space-between",
    padding: "6px 0"
  });
  const left = item.createDiv();
  text(left, label, "kf-progress-label");
  text(left, trend, "kf-muted");
  text(item, value, "kf-progress-value");
}

function taskRow(parent: HTMLElement, type: string, title: string): void {
  const item = row(parent, "kf-task-row");
  setStyles(item, {
    backgroundColor: "color-mix(in srgb, var(--interactive-accent) 5%, var(--background-secondary))",
    border: "1px solid color-mix(in srgb, var(--interactive-accent) 10%, transparent)",
    borderRadius: "7px",
    gap: "9px",
    padding: "8px 9px"
  });
  const badge = item.createDiv({ text: type });
  setStyles(badge, {
    color: "var(--text-accent)",
    flex: "0 0 auto",
    fontSize: "12px",
    fontWeight: "600",
    whiteSpace: "nowrap"
  });
  const titleEl = text(item, title, "kf-muted");
  setStyles(titleEl, {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  });
}

function categoryRow(parent: HTMLElement, category: string, total: number, learned: number): void {
  const item = row(parent, "kf-category-row");
  setStyles(item, {
    justifyContent: "space-between",
    padding: "6px 0"
  });
  const left = item.createDiv();
  text(left, category, "kf-progress-label");
  text(left, `已学习 ${learned} / ${total}`, "kf-muted");
  text(item, `${Math.max(total - learned, 0)} 待读`, "kf-progress-value");
}
