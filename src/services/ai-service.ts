import { requestUrl } from "obsidian";
import type { AiModelConfig, ChatResult, KnowFlowMode, KnowFlowSettings, NoteSummary, QuizQuestion } from "../types";
import { ARTICLE_CATEGORIES } from "./clipping-pipeline";
import type { FormattingCandidate, FormattingDecision } from "./formatting-candidates";

interface SummaryResponse {
  briefDescription: string;
  summary: string;
  readingValue: number;
  recommendedAction: NoteSummary["recommendedAction"];
  category: string;
  reason: string;
  tags: string[];
}

interface QuizResponse {
  questions: Array<{
    question: string;
    options: Array<{ key: string; content: string }>;
    answerKey: string;
    explanation: string;
    difficulty: number;
  }>;
}

interface FormattingResponse {
  decisions: FormattingDecision[];
}

const REQUEST_TIMEOUT_MS = 60000;

export class AiService {
  constructor(private settings: KnowFlowSettings) {}

  updateSettings(settings: KnowFlowSettings): void {
    this.settings = settings;
  }

  async summarize(filePath: string, title: string, content: string, fallbackCategory: string): Promise<NoteSummary> {
    const payload = await this.requestJson<SummaryResponse>(this.settings.summaryModel, [
      {
        role: "system",
        content: [
          "你是 KnowFlow 的 Obsidian Clipping 分析器。",
          "必须基于文章语义判断，不允许用文章长度或关键词粗略猜测。",
          "KnowFlow 的目标不是把所有文章都变成学习材料，而是帮助用户决定是否值得投入学习时间。",
          "你需要输出严格 JSON，不要输出 markdown。",
          "阅读价值必须是 1-5 的整数：1=低价值或广告，2=浅层资讯，3=普通教程/观点，4=深入技术文章/系统分析，5=长期参考资料。",
          "阅读价值 1：过时教程、纯广告、无实质内容新闻、低质量项目列表、当前环境无法复用的材料。",
          "阅读价值 2：浅层功能介绍、营销软文、资讯合集、每个条目只有短介绍的周刊/月刊。",
          "阅读价值 3：有实操细节的教程，或有观点但深度一般的分析。",
          "阅读价值 4：有原理解释、工程经验、代码示例或可复现方法的深度文章。",
          "阅读价值 5：系统性知识、长期参考、可反复查阅的高密度资料。",
          "推荐动作只能是 skip、skim、deep_learn、keep_reference。",
          "推荐动作含义：skip=不建议学习；skim=快速阅读即可；deep_learn=值得深入学习并出题；keep_reference=长期保存为参考资料。",
          `建议目录必须从这些目录中选择：${ARTICLE_CATEGORIES.join("、")}。不确定时选择 ${fallbackCategory}。`,
          "`briefDescription` 用于写入 Frontmatter 的简要描述，只能是 1 到 2 句文章概括。",
          "`summary` 用于侧边栏 AI Summary，必须是结构化 Markdown 文本，不要写成和 briefDescription 一样的一段话。",
          "`summary` 必须包含两个小节：`核心观点` 和 `章节梳理`。",
          "`核心观点` 使用 2 到 4 条无序列表；`章节梳理` 使用有序列表，逐条说明文章各章节或主要部分讲了什么。",
          "`summary` 总长度建议 180 到 360 个中文字符，便于右侧栏快速扫描。",
          "tags 只给主题标签，不要给来源平台标签；不要编造文章没有覆盖的主题。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          title,
          fallbackCategory,
          article: buildAnalysisExcerpt(content),
          requiredJsonShape: {
            briefDescription: "1 到 2 句文章概括，用于 Frontmatter 简要描述",
            summary: "结构化 Markdown：包含 核心观点 bullet list 和 章节梳理 ordered list",
            readingValue: "1-5 integer",
            recommendedAction: "skip | skim | deep_learn | keep_reference",
            category: ARTICLE_CATEGORIES,
            reason: "一句话说明阅读价值和推荐动作的理由",
            tags: ["2-6 个中文或英文主题标签"]
          }
        })
      }
    ]);

    const normalized = normalizeSummaryResponse(payload, fallbackCategory);
    return {
      filePath,
      title,
      ...normalized
    };
  }

  async answer(mode: KnowFlowMode, filePath: string | null, contextLabel: string, question: string, content: string): Promise<ChatResult> {
    const answer = await this.requestText(this.settings.chatModel, [
      {
        role: "system",
        content: "你是 KnowFlow 的 Obsidian 学习助手。围绕用户当前笔记回答，明确区分文章内容和你的推断。"
      },
      {
        role: "user",
        content: JSON.stringify({
          contextLabel,
          question,
          article: stripFrontmatter(content).slice(0, 18000)
        })
      }
    ]);

    return {
      sourceMode: mode,
      filePath,
      contextLabel,
      question,
      createdAt: new Date().toISOString(),
      answer
    };
  }

  async generateQuiz(filePath: string, title: string, content: string, count: number): Promise<QuizQuestion[]> {
    const payload = await this.requestJson<QuizResponse>(this.settings.quizModel, [
      {
        role: "system",
        content: [
          "你是 KnowFlow 的学习测验出题器。",
          "必须只根据当前 Obsidian 文章出题，不要引入文章外事实。",
          "题目用于检验用户是否理解文章中的核心概念、因果关系、实现细节和实践价值。",
          "输出严格 JSON，不要输出 markdown。",
          "只生成单选题，每题 4 个选项，选项 key 必须是 A、B、C、D。",
          "错误选项要有迷惑性，但不能包含明显荒谬或文章未涉及的内容。",
          "explanation 用中文说明正确答案为什么成立，并指出错误选项的主要问题。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          title,
          count,
          article: stripFrontmatter(content).slice(0, 22000),
          requiredJsonShape: {
            questions: [
              {
                question: "题干",
                options: [
                  { key: "A", content: "选项 A" },
                  { key: "B", content: "选项 B" },
                  { key: "C", content: "选项 C" },
                  { key: "D", content: "选项 D" }
                ],
                answerKey: "A | B | C | D",
                explanation: "答案解析",
                difficulty: "1-5 integer"
              }
            ]
          }
        })
      }
    ]);

    return normalizeQuizResponse(payload, filePath, Math.max(1, Math.min(12, count)));
  }

  async analyzeFormattingCandidates(title: string, candidates: FormattingCandidate[]): Promise<FormattingDecision[]> {
    if (candidates.length === 0) return [];
    const payload = await this.requestJson<FormattingResponse>(this.settings.summaryModel, [
      {
        role: "system",
        content: [
          "你是 KnowFlow 的 Obsidian Markdown 格式候选分类器。",
          "只判断候选是否为标题或代码，不改写、不补充、不删除候选内容。",
          "possible-heading 只能返回 keep 或 heading；heading 的 level 只能为 2、3、4。",
          "possible-code 只能返回 keep 或 wrap-code；如果是代码，返回准确 language。",
          "fenced-code 只能返回 keep 或 set-code-language；仅判断代码围栏语言。",
          "普通短段落不是标题，不确定时返回 keep。",
          "必须为每个候选返回一条 decision，并输出严格 JSON。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          title,
          candidates: candidates.map(({ id, type, content, before, after }) => ({
            id,
            type,
            content,
            before,
            after
          })),
          requiredJsonShape: {
            decisions: [
              {
                id: "候选 id",
                action: "keep | heading | wrap-code | set-code-language",
                level: "仅 heading：2 | 3 | 4",
                language: "仅代码操作：语言标识"
              }
            ]
          }
        })
      }
    ]);
    return normalizeFormattingDecisions(payload, candidates);
  }

  private async requestJson<T>(config: AiModelConfig, messages: ChatMessage[]): Promise<T> {
    const text = await this.requestText(config, messages, true);
    try {
      return parseJsonResponse<T>(text);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} Raw response: ${text.slice(0, 500)}`);
    }
  }

  private async requestText(config: AiModelConfig, messages: ChatMessage[], json = false): Promise<string> {
    assertModelConfig(config);
    const baseUrl = config.apiBaseUrl.trim().replace(/\/+$/g, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    if (config.apiKey.trim()) {
      headers.Authorization = `Bearer ${config.apiKey.trim()}`;
    }

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: 0.2
    };
    if (json) {
      body.response_format = { type: "json_object" };
    }

    const response = await withTimeout(
      requestUrl({
        url: `${baseUrl}/chat/completions`,
        method: "POST",
        headers,
        body: JSON.stringify(body),
        throw: false
      }),
      REQUEST_TIMEOUT_MS,
      `AI request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Check that ${baseUrl} is reachable.`
    );

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`AI request failed: ${response.text?.slice(0, 220) || `HTTP ${response.status}`}`);
    }

    const content = response.json?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("AI response did not contain message content.");
    }
    return content.trim();
  }
}

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function assertModelConfig(config: AiModelConfig): void {
  if (config.runtime === "disabled") {
    throw new Error("AI model is disabled. Configure the model in KnowFlow settings.");
  }
  if (!config.apiBaseUrl.trim()) {
    throw new Error("AI Base URL is missing. Configure the model in KnowFlow settings.");
  }
  if (!config.model.trim()) {
    throw new Error("AI Model ID is missing. Configure the model in KnowFlow settings.");
  }
  if (config.runtime === "openai-compatible" && !config.apiKey.trim()) {
    throw new Error("API Key is missing for Cloud runtime.");
  }
}

function normalizeSummaryResponse(value: SummaryResponse, fallbackCategory: string): Omit<NoteSummary, "filePath" | "title"> {
  const readingValue = Number.isInteger(value.readingValue)
    ? Math.min(5, Math.max(1, value.readingValue))
    : 3;
  const category = ARTICLE_CATEGORIES.includes(value.category) ? value.category : fallbackCategory;
  const recommendedAction = ["skip", "skim", "deep_learn", "keep_reference"].includes(value.recommendedAction)
    ? value.recommendedAction
    : readingValue >= 4 ? "deep_learn" : readingValue >= 3 ? "skim" : "skip";

  const summary = normalizeStructuredSummary(value.summary);

  return {
    briefDescription: typeof value.briefDescription === "string" && value.briefDescription.trim()
      ? value.briefDescription.replace(/\n/g, " ").trim()
      : deriveBriefDescription(summary),
    summary,
    readingValue,
    recommendedAction,
    category,
    reason: typeof value.reason === "string" ? value.reason.trim() : "",
    tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === "string" && tag.trim()).slice(0, 6) : []
  };
}

function normalizeStructuredSummary(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "AI 未返回有效摘要。";
  const normalized = value.trim();
  if (/核心观点|章节梳理|^\s*[-*]\s+|^\s*\d+\.\s+/m.test(normalized)) return normalized;
  return `核心观点\n- ${normalized}\n\n章节梳理\n1. 文章围绕主题展开，当前模型未返回分章节结构。`;
}

function deriveBriefDescription(summary: string): string {
  return summary
    .replace(/^#+\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "AI 未返回简要描述。";
}

function normalizeFormattingDecisions(
  value: FormattingResponse,
  candidates: FormattingCandidate[]
): FormattingDecision[] {
  const candidateTypes = new Map(candidates.map((candidate) => [candidate.id, candidate.type]));
  const decisions = Array.isArray(value.decisions) ? value.decisions : [];
  return decisions.flatMap((decision): FormattingDecision[] => {
    const type = candidateTypes.get(decision.id);
    if (!type || typeof decision.action !== "string") return [];
    if (decision.action === "keep") return [{ id: decision.id, action: "keep" }];
    if (type === "possible-heading" && decision.action === "heading") {
      const level = decision.level === 3 || decision.level === 4 ? decision.level : 2;
      return [{ id: decision.id, action: "heading", level }];
    }
    if (type === "possible-code" && decision.action === "wrap-code") {
      return [{ id: decision.id, action: "wrap-code", language: normalizeLanguageName(decision.language) }];
    }
    if (type === "fenced-code" && decision.action === "set-code-language") {
      return [{ id: decision.id, action: "set-code-language", language: normalizeLanguageName(decision.language) }];
    }
    return [];
  });
}

function normalizeLanguageName(value: unknown): string {
  if (typeof value !== "string") return "";
  const language = value.trim().toLowerCase();
  return /^[a-z0-9_+-]{1,24}$/.test(language) ? language : "";
}

function parseJsonResponse<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const raw = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    }
    throw new Error("AI response was not valid JSON.");
  }
}

/**
 * Obsidian's `requestUrl` has no AbortSignal/timeout option, so a hung AI
 * endpoint would otherwise leave the UI (e.g. "generating summary...",
 * disabled buttons) stuck indefinitely with no way to recover short of
 * reloading the plugin. This races the request against a timer so callers
 * always get a rejection to react to; it does not cancel the underlying
 * network request, it just stops waiting on it.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function buildAnalysisExcerpt(content: string): string {
  const article = stripFrontmatter(content);
  if (article.length <= 9000) return article;

  const headings = article
    .split("\n")
    .filter((line) => /^#{2,4}\s+\S/.test(line.trim()))
    .slice(0, 40)
    .join("\n");
  const sections = article
    .split(/\n(?=#{2,3}\s+)/)
    .slice(0, 8)
    .map((section) => section.trim().slice(0, 650))
    .join("\n\n");

  return [
    article.slice(0, 2800),
    headings ? `\n\n## 文章标题骨架\n${headings}` : "",
    sections ? `\n\n## 章节抽样\n${sections}` : "",
    `\n\n## 文章结尾\n${article.slice(-1600)}`
  ].join("").slice(0, 11000);
}

function normalizeQuizResponse(value: QuizResponse, filePath: string, count: number): QuizQuestion[] {
  const now = new Date().toISOString();
  const questions = Array.isArray(value.questions) ? value.questions : [];
  return questions
    .map((question, index): QuizQuestion | null => {
      const options = Array.isArray(question.options)
        ? question.options
          .filter((option) => ["A", "B", "C", "D"].includes(option.key) && typeof option.content === "string" && option.content.trim())
          .slice(0, 4)
        : [];
      const optionKeys = new Set(options.map((option) => option.key));
      if (typeof question.question !== "string" || !question.question.trim()) return null;
      if (options.length !== 4 || !optionKeys.has(question.answerKey)) return null;

      const difficulty = Number.isInteger(question.difficulty)
        ? Math.min(5, Math.max(1, question.difficulty))
        : 3;

      return {
        id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        notePath: filePath,
        question: question.question.trim(),
        type: "single_choice",
        options: options.map((option) => ({ key: option.key, content: option.content.trim() })),
        answerKey: question.answerKey,
        explanation: typeof question.explanation === "string" ? question.explanation.trim() : "",
        difficulty,
        createdAt: now
      };
    })
    .filter((question): question is QuizQuestion => Boolean(question))
    .slice(0, count);
}
