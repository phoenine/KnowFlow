import { requestUrl } from "obsidian";
import type { AiModelConfig, ChatMessage as StoredChatMessage, ChatUsage, KnowFlowSettings, NoteSummary, QuizQuestion } from "../types";
import { estimateChatUsage, parseChatStreamData } from "./chat-stream";
import { ARTICLE_CATEGORIES } from "./clipping-pipeline";
import { batchFormattingCandidates } from "./formatting-candidates";
import type { FormattingCandidate, FormattingDecision } from "./formatting-candidates";
import { batchQuizSections, getQuizFocusTargets, getQuizQuestionLimit, prepareQuizSections } from "./quiz-generation";
import type { QuizFocusType, QuizSourceSection } from "./quiz-generation";
import { batchTranslationCandidates } from "./translation-candidates";
import type { TranslationCandidate, TranslationDecision } from "./translation-candidates";

interface SummaryResponse {
  briefDescription: string;
  summary: string;
  readingValue: number;
  recommendedAction: NoteSummary["recommendedAction"];
  category: string;
  reason: string;
  tags: string[];
}

interface QuizBatchResponse {
  sections: Array<{
    sectionId: string;
    value: number;
    questions: Array<{
      focusType: QuizFocusType;
      sourceQuote: string;
      question: string;
      options: Array<{ key: string; content: string }>;
      answerKey: string;
      explanation: string;
      difficulty: number;
    }>;
  }>;
}

interface RatedQuizQuestion {
  focusType: QuizFocusType;
  sectionId: string;
  sectionValue: number;
  markedPriority: number;
  question: QuizQuestion;
}

interface FormattingResponse {
  decisions: FormattingDecision[];
}

interface TranslationResponse {
  translations: TranslationDecision[];
}

interface KnowledgeMapResponse {
  diagramType: "radar" | "timeline" | "mindmap";
  mermaid: string;
}

const REQUEST_TIMEOUT_MS = 360000;

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
          "tags 只给主题标签，不要给来源平台标签；不要编造文章没有覆盖的主题。",
          "tags 必须遵守 Obsidian 标签语法：每个标签内部不允许有空格，多词标签使用连字符连接。"
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

  async summarizeStream(
    filePath: string,
    title: string,
    content: string,
    fallbackCategory: string,
    onDelta: (fullText: string) => void
  ): Promise<NoteSummary> {
    const messages: ChatRequestMessage[] = [
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
          "tags 只给主题标签，不要给来源平台标签；不要编造文章没有覆盖的主题。",
          "tags 必须遵守 Obsidian 标签语法：每个标签内部不允许有空格，多词标签使用连字符连接。"
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
    ];

    let fullText = "";
    await this.requestTextStream(this.settings.summaryModel, messages, {
      onContent: (delta) => {
        fullText += delta;
        onDelta(fullText);
      },
      onReasoning: () => {},
      onUsage: () => {}
    });

    const payload = parseJsonResponse<SummaryResponse>(fullText);
    const normalized = normalizeSummaryResponse(payload, fallbackCategory);
    return {
      filePath,
      title,
      ...normalized
    };
  }

  async answerStream(
    contextLabel: string,
    articleContent: string,
    history: StoredChatMessage[],
    handlers: {
      onContent: (delta: string) => void;
      onReasoning: (delta: string) => void;
      onUsage: (usage: ChatUsage) => void;
    }
  ): Promise<ChatUsage> {
    const messages: ChatRequestMessage[] = [
      {
        role: "system",
        content: [
          "你是 KnowFlow 的 Obsidian 学习助手。围绕用户当前笔记回答，明确区分文章内容和你的推断。",
          `当前上下文：${contextLabel}`,
          `当前文章：\n${stripFrontmatter(articleContent).slice(0, 18000)}`
        ].join("\n\n")
      },
      ...history
        .filter((message) => message.role === "user" || (message.role === "assistant" && message.content))
        .map((message): ChatRequestMessage => ({ role: message.role, content: message.content }))
    ];
    let emitted = false;
    try {
      return await this.requestTextStream(this.settings.chatModel, messages, {
        onContent: (delta) => {
          emitted = true;
          handlers.onContent(delta);
        },
        onReasoning: (delta) => {
          emitted = true;
          handlers.onReasoning(delta);
        },
        onUsage: handlers.onUsage
      });
    } catch (error) {
      if (emitted) throw error;
      const answer = await this.requestText(this.settings.chatModel, messages);
      handlers.onContent(answer);
      const usage = estimateChatUsage(messages, answer);
      handlers.onUsage(usage);
      return usage;
    }
  }

  async generateQuiz(filePath: string, title: string, content: string, readingValue: number): Promise<QuizQuestion[]> {
    const sections = prepareQuizSections(content);
    if (sections.length === 0) return [];
    const batches = batchQuizSections(sections);
    const limit = getQuizQuestionLimit(readingValue);
    const focusTargets = getQuizFocusTargets(limit);
    const totalChars = sections.reduce((total, section) => total + section.content.length, 0) || 1;
    const rated: RatedQuizQuestion[] = [];

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const batchChars = batch.reduce((total, section) => total + section.content.length, 0);
      const batchQuestionLimit = Math.max(1, Math.ceil(limit * batchChars / totalChars) + 1);
      try {
        const payload = await this.requestJson<QuizBatchResponse>(
          this.settings.quizModel,
          buildQuizBatchMessages(title, readingValue, batch, batchQuestionLimit, focusTargets)
        );
        rated.push(...normalizeQuizBatchResponse(payload, batch, filePath));
      } catch (error) {
        throw new Error(
          `Quiz 章节批次 ${index + 1}/${batches.length} 处理失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return selectQuizQuestions(rated, limit, focusTargets);
  }

  async generateKnowledgeMap(title: string, content: string): Promise<string> {
    const payload = await this.requestJson<KnowledgeMapResponse>(this.settings.summaryModel, [
      {
        role: "system",
        content: [
          "你是 KnowFlow 的文章知识骨架设计器。完整理解文章后生成一张适合 Obsidian 的 Mermaid 图。",
          "自动选择图形：叙事、因果链、多线论述默认使用 radar；明确时间演进且只有 2-4 个短阶段时使用 timeline；纯分类或层级结构才使用 mindmap。",
          "radar 使用 graph LR 的 hub-and-spoke：中心节点必须使用显式 ID H((\"中心主题\"))，连接 3-4 个阶段节点，详情节点用虚线连接。",
          "radar 的阶段节点使用红、橙、紫、绿四色；详情节点使用同色系浅色。",
          "详情节点用有序短句和 <br/> 换行，数字后不能有空格，例如 1.发现；不要使用 HTML div。",
          "timeline 最多 4 段；4 段时每段不超过 15 个中文字符，3 段时不超过 25 个中文字符；不使用 <br/> 或内部箭头。",
          "mindmap 只保留清晰的分类层级，避免层级过深和长句。",
          "节点文字必须简洁；引号使用『』，括号使用「」；所有被连接或 style 引用的节点都必须有显式 ID。",
          "style 只能使用 fill、stroke、color、stroke-width、stroke-dasharray，禁止 text-align。",
          "只输出严格 JSON，不要输出 Markdown 围栏、标题或解释。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          title,
          article: stripKnowledgeMapSection(stripFrontmatter(content)),
          requiredJsonShape: {
            diagramType: "radar | timeline | mindmap",
            mermaid: "完整 Mermaid 源码，不含 ```mermaid 围栏"
          }
        })
      }
    ]);
    return normalizeKnowledgeMapResponse(payload);
  }

  async analyzeHeadingCandidates(title: string, candidates: FormattingCandidate[]): Promise<FormattingDecision[]> {
    if (candidates.length === 0) return [];
    const batches = batchFormattingCandidates(candidates);
    const decisions: FormattingDecision[] = [];
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      try {
        const payload = await this.requestJson<FormattingResponse>(this.settings.summaryModel, [
          {
            role: "system",
            content: [
              "你是 KnowFlow 的文章标题分类器。只判断候选文本是否为文章小节标题。",
              "不确定时返回 keep，不要强行标记。",
              "确认为标题时返回 heading + H2/H3/H4。",
              "要求输出严格 JSON。"
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              title,
              candidates: batch.map(({ id, content, before, after }) => ({ id, content, before, after })),
              requiredJsonShape: {
                decisions: [{ id: "候选 id", action: "keep | heading", level: "仅 heading：2 | 3 | 4" }]
              }
            })
          }
        ]);
        decisions.push(...normalizeFormattingDecisions(payload, batch));
      } catch (error) {
        throw new Error(
          `标题判断批次 ${index + 1}/${batches.length} 失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return decisions;
  }

  async analyzePossibleCodeCandidates(title: string, candidates: FormattingCandidate[]): Promise<FormattingDecision[]> {
    if (candidates.length === 0) return [];
    const batches = batchFormattingCandidates(candidates);
    const decisions: FormattingDecision[] = [];
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      try {
        const payload = await this.requestJson<FormattingResponse>(this.settings.summaryModel, [
          {
            role: "system",
            content: [
              "你是 KnowFlow 的代码块分类器。只判断候选文本是否为未围栏代码（无 ``` 包裹）。",
              "确认为代码时返回 wrap-code + 语言标识（如 python/typescript/bash）。",
              "不是代码时返回 keep。",
              "要求输出严格 JSON。"
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              title,
              candidates: batch.map(({ id, content, before, after }) => ({ id, content, before, after })),
              requiredJsonShape: {
                decisions: [{ id: "候选 id", action: "keep | wrap-code", language: "仅 wrap-code：编程语言" }]
              }
            })
          }
        ]);
        decisions.push(...normalizeFormattingDecisions(payload, batch));
      } catch (error) {
        throw new Error(
          `未围栏代码判断批次 ${index + 1}/${batches.length} 失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return decisions;
  }

  async analyzeFencedCodeCandidates(title: string, candidates: FormattingCandidate[]): Promise<FormattingDecision[]> {
    if (candidates.length === 0) return [];
    const batches = batchFormattingCandidates(candidates);
    const decisions: FormattingDecision[] = [];
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      try {
        const payload = await this.requestJson<FormattingResponse>(this.settings.summaryModel, [
          {
            role: "system",
            content: [
              "你是 KnowFlow 的代码语言分类器。只判断已有围栏（```）包裹的代码块的语言标识。",
              "返回 set-code-language + 准确语言（如 python/javascript/sql）。",
              "无法判断时返回 keep。",
              "要求输出严格 JSON。"
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              title,
              candidates: batch.map(({ id, content }) => ({ id, content })),
              requiredJsonShape: {
                decisions: [{ id: "候选 id", action: "keep | set-code-language", language: "编程语言标识" }]
              }
            })
          }
        ]);
        decisions.push(...normalizeFormattingDecisions(payload, batch));
      } catch (error) {
        throw new Error(
          `代码围栏语言判断批次 ${index + 1}/${batches.length} 失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return decisions;
  }

  async translateEnglishParagraphs(title: string, candidates: TranslationCandidate[]): Promise<TranslationDecision[]> {
    if (candidates.length === 0) return [];
    const batches = batchTranslationCandidates(candidates);
    const translations: TranslationDecision[] = [];
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      try {
        const payload = await this.requestJson<TranslationResponse>(this.settings.summaryModel, [
          {
            role: "system",
            content: [
              "你是专业的英译中编辑。把每个英文段落准确、自然地翻译成简体中文。",
              "必须完整保留原意、专有名词、数字、URL、Markdown 链接和行内代码，不添加解释、标题或“翻译”标签。",
              "每个输入 id 必须返回且只能返回一次；不得合并、拆分或遗漏段落。",
              "只输出严格 JSON，不要输出 Markdown 围栏。"
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              title,
              paragraphs: batch.map((candidate) => ({ id: candidate.id, text: candidate.content })),
              requiredJsonShape: {
                translations: [{ id: "translation-1", translation: "对应的简体中文翻译" }]
              }
            })
          }
        ]);
        const normalized = normalizeTranslationResponse(payload, batch);
        const returnedIds = new Set(normalized.map((translation) => translation.id));
        if (returnedIds.size !== batch.length || batch.some((candidate) => !returnedIds.has(candidate.id))) {
          throw new Error("模型未返回全部段落的有效中文翻译。");
        }
        translations.push(...normalized);
      } catch (error) {
        throw new Error(
          `英文翻译批次 ${index + 1}/${batches.length} 处理失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return translations;
  }

  private async requestJson<T>(config: AiModelConfig, messages: ChatRequestMessage[]): Promise<T> {
    const text = await this.requestText(config, messages, true);
    try {
      return parseJsonResponse<T>(text);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} Raw response: ${text.slice(0, 500)}`);
    }
  }

  private async requestText(config: AiModelConfig, messages: ChatRequestMessage[], json = false): Promise<string> {
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
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "response",
          strict: false,
          schema: { type: "object" }
        }
      };
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

  private async requestTextStream(
    config: AiModelConfig,
    messages: ChatRequestMessage[],
    handlers: {
      onContent: (delta: string) => void;
      onReasoning: (delta: string) => void;
      onUsage: (usage: ChatUsage) => void;
    }
  ): Promise<ChatUsage> {
    assertModelConfig(config);
    const baseUrl = config.apiBaseUrl.trim().replace(/\/+$/g, "");
    const controller = new AbortController();
    let timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const resetTimer = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    };
    if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.2,
          stream: true,
          stream_options: { include_usage: true }
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`AI stream failed: ${(await response.text()).slice(0, 220) || `HTTP ${response.status}`}`);
      }
      if (!response.body) throw new Error("AI stream did not return a response body.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      let usage: ChatUsage | null = null;
      let done = false;

      const consume = (data: string): void => {
        if (!data) return;
        const delta = parseChatStreamData(data);
        if (delta.done) done = true;
        if (delta.reasoning) handlers.onReasoning(delta.reasoning);
        if (delta.content) {
          answer += delta.content;
          handlers.onContent(delta.content);
        }
        if (delta.usage) {
          usage = delta.usage;
          handlers.onUsage(usage);
        }
      };

      while (!done) {
        const chunk = await reader.read();
        resetTimer();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of event.split("\n")) {
            if (line.startsWith("data:")) consume(line.slice(5).trim());
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          if (line.startsWith("data:")) consume(line.slice(5).trim());
        }
      }
      if (!answer.trim()) {
        throw new Error("AI stream completed without answer content.");
      }
      const finalUsage = usage ?? estimateChatUsage(messages, answer);
      handlers.onUsage(finalUsage);
      return finalUsage;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`AI stream timed out after ${REQUEST_TIMEOUT_MS / 1000}s without data.`);
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }
}

type ChatRequestMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function buildQuizBatchMessages(
  title: string,
  readingValue: number,
  sections: QuizSourceSection[],
  batchQuestionLimit: number,
  focusTargets: Record<QuizFocusType, number>
): ChatRequestMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是 KnowFlow 的学习测验出题器。逐章判断知识价值，只为有明确学习价值的章节出题；背景、宣传、重复内容和无可检验知识的章节必须返回 value=0、questions=[]。",
        "必须只根据提供的文章章节出题，不得引入文章外事实。",
        "优先从标记内容取材：bold 最高，highlight 和 underline 为高，italic 为中；标记不足时再从同章节正文补充。",
        "标记只是价值信号，不代表一定值得出题，仍需根据语义判断。",
        "focusType 只能是 concept、principle、comparison、application、pitfall。",
        "只生成单选题；每题必须有题干、A/B/C/D 四个选项、唯一答案和中文解析。",
        "sourceQuote 必须逐字引用对应章节中的原始依据，用于验证题目没有编造。",
        "错误选项要有迷惑性，但不能明显荒谬或包含文章未涉及的事实。",
        "输出严格 JSON，不要输出 Markdown。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        articleTitle: title,
        readingValue,
        batchQuestionLimit,
        articleFocusTargets: focusTargets,
        markerPriority: {
          bold: "最高",
          highlight: "高",
          underline: "高",
          italic: "中，仅在其他标记不足时使用"
        },
        sections: sections.map((section) => ({
          id: section.id,
          title: section.title,
          marked: section.marked,
          content: section.content
        })),
        requiredJsonShape: {
          sections: [
            {
              sectionId: "输入中的章节 id",
              value: "0-3 integer；0 表示不出题",
              questions: [
                {
                  focusType: "concept | principle | comparison | application | pitfall",
                  sourceQuote: "对应章节中的原文",
                  question: "题干",
                  options: [
                    { key: "A", content: "选项 A" },
                    { key: "B", content: "选项 B" },
                    { key: "C", content: "选项 C" },
                    { key: "D", content: "选项 D" }
                  ],
                  answerKey: "A | B | C | D",
                  explanation: "答案与错误选项解析",
                  difficulty: "1-5 integer"
                }
              ]
            }
          ]
        }
      })
    }
  ];
}

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
    tags: Array.isArray(value.tags)
      ? Array.from(new Set(value.tags.map(normalizeObsidianTag).filter(Boolean))).slice(0, 6)
      : []
  };
}

function normalizeObsidianTag(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^#+/, "").replace(/\s+/g, "-");
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

function normalizeKnowledgeMapResponse(value: KnowledgeMapResponse): string {
  if (typeof value.mermaid !== "string" || !value.mermaid.trim()) {
    throw new Error("AI did not return Mermaid source.");
  }
  const mermaid = value.mermaid
    .trim()
    .replace(/^```(?:mermaid)?\s*\n([\s\S]*?)\n```$/i, "$1")
    .trim();
  if (!/^(?:graph\s+(?:LR|TB)|timeline|mindmap)\b/.test(mermaid)) {
    throw new Error("AI returned an unsupported Mermaid diagram type.");
  }
  if (/<div\b|text-align\s*:/i.test(mermaid)) {
    throw new Error("AI returned Mermaid syntax that is unstable in Obsidian.");
  }
  return mermaid;
}

function stripKnowledgeMapSection(content: string): string {
  return content
    .replace(/^## (?:Knowledge Map|知识骨架)\s*\n[\s\S]*?(?=^##\s|(?![\s\S]))/gim, "")
    .trim();
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

function normalizeTranslationResponse(
  value: TranslationResponse,
  candidates: TranslationCandidate[]
): TranslationDecision[] {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const translations = Array.isArray(value.translations) ? value.translations : [];
  return translations.flatMap((translation) =>
    candidateIds.has(translation.id)
      && typeof translation.translation === "string"
      && /[\u3400-\u9fff]/.test(translation.translation)
      && !/```|~~~/.test(translation.translation)
      ? [{ id: translation.id, translation: translation.translation.trim() }]
      : []
  );
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

function normalizeQuizBatchResponse(
  value: QuizBatchResponse,
  sourceSections: QuizSourceSection[],
  filePath: string
): RatedQuizQuestion[] {
  const now = new Date().toISOString();
  const byId = new Map(sourceSections.map((section) => [section.id, section]));
  const sections = Array.isArray(value.sections) ? value.sections : [];
  const result: RatedQuizQuestion[] = [];

  for (const sectionResult of sections) {
    const source = byId.get(sectionResult.sectionId);
    if (!source) continue;
    const sectionValue = Number.isInteger(sectionResult.value)
      ? Math.min(3, Math.max(0, sectionResult.value))
      : 0;
    if (sectionValue === 0 || !Array.isArray(sectionResult.questions)) continue;

    for (const question of sectionResult.questions) {
      if (!isQuizFocusType(question.focusType)) continue;
      const sourceQuote = typeof question.sourceQuote === "string" ? question.sourceQuote.trim() : "";
      if (!sourceQuote || !sourceContainsQuote(source.content, sourceQuote)) continue;
      const options = Array.isArray(question.options)
        ? question.options
          .filter((option) => ["A", "B", "C", "D"].includes(option.key) && typeof option.content === "string" && option.content.trim())
          .slice(0, 4)
        : [];
      const optionKeys = new Set(options.map((option) => option.key));
      if (typeof question.question !== "string" || !question.question.trim()) continue;
      if (options.length !== 4 || !optionKeys.has(question.answerKey)) continue;

      const difficulty = Number.isInteger(question.difficulty)
        ? Math.min(5, Math.max(1, question.difficulty))
        : 3;

      result.push({
        focusType: question.focusType,
        sectionId: source.id,
        sectionValue,
        markedPriority: sourceQuoteMarkerPriority(source, sourceQuote),
        question: {
          id: `${Date.now()}-${result.length}-${Math.random().toString(36).slice(2, 8)}`,
          notePath: filePath,
          question: question.question.trim(),
          type: "single_choice",
          options: options.map((option) => ({ key: option.key, content: option.content.trim() })),
          answerKey: question.answerKey,
          explanation: typeof question.explanation === "string" ? question.explanation.trim() : "",
          difficulty,
          createdAt: now
        }
      });
    }
  }
  return result;
}

function selectQuizQuestions(
  rated: RatedQuizQuestion[],
  limit: number,
  targets: Record<QuizFocusType, number>
): QuizQuestion[] {
  const seen = new Set<string>();
  const unique = rated
    .filter((item) => {
      const key = item.question.question.replace(/\s+/g, "").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      b.sectionValue - a.sectionValue
      || a.markedPriority - b.markedPriority
      || a.sectionId.localeCompare(b.sectionId)
    );
  const selected: RatedQuizQuestion[] = [];
  const used = new Set<RatedQuizQuestion>();

  for (const type of Object.keys(targets) as QuizFocusType[]) {
    const matches = unique.filter((item) => item.focusType === type).slice(0, targets[type]);
    for (const item of matches) {
      selected.push(item);
      used.add(item);
    }
  }
  for (const item of unique) {
    if (selected.length >= limit) break;
    if (!used.has(item)) selected.push(item);
  }
  return selected.slice(0, limit).map((item) => item.question);
}

function isQuizFocusType(value: unknown): value is QuizFocusType {
  return ["concept", "principle", "comparison", "application", "pitfall"].includes(String(value));
}

function sourceContainsQuote(content: string, quote: string): boolean {
  if (content.includes(quote)) return true;
  return normalizeSourceText(content).includes(normalizeSourceText(quote));
}

function normalizeSourceText(value: string): string {
  return value
    .replace(/\*\*|==|<\/?u>|\*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceQuoteMarkerPriority(section: QuizSourceSection, quote: string): number {
  const normalizedQuote = normalizeSourceText(quote);
  const priorities = section.marked
    .filter((marked) => normalizedQuote.includes(normalizeSourceText(marked.text)))
    .map((marked) => marked.kind === "bold" ? 0 : marked.kind === "italic" ? 2 : 1);
  return priorities.length > 0 ? Math.min(...priorities) : 3;
}
