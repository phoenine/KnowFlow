import type { TFile } from "obsidian";

export const KNOWFLOW_VIEW_TYPE = "knowflow-sidebar";

export type KnowFlowMode =
  | "empty"
  | "clipping"
  | "articles-overview"
  | "article-detail"
  | "quiz-test"
  | "chat-result";

export type AiRuntime = "openai-compatible" | "ollama" | "lm-studio" | "disabled";

export interface AiModelConfig {
  runtime: AiRuntime;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}

export interface KnowFlowSettings {
  clippingFolder: string;
  articlesFolder: string;
  defaultArticleCategory: string;
  archiveFolder: string;
  templatePath: string;
  summaryModel: AiModelConfig;
  chatModel: AiModelConfig;
  quizModel: AiModelConfig;
  autoCreateCategoryFolders: boolean;
  confirmBeforeWrite: boolean;
  autoOrganize: boolean;
  autoGenerateSummary: boolean;
  autoGenerateQuiz: boolean;
  dailyNewArticleLimit: number;
  dailyReviewLimit: number;
}

export interface NoteSummary {
  filePath: string;
  title: string;
  briefDescription: string;
  summary: string;
  readingValue: number;
  recommendedAction: "skip" | "skim" | "deep_learn" | "keep_reference";
  category: string;
  reason: string;
  tags: string[];
}

export interface QuizStats {
  total: number;
  answered: number;
  accuracy: number | null;
  wrong: number;
}

export interface QuizOption {
  key: string;
  content: string;
}

export interface QuizQuestion {
  id: string;
  notePath: string;
  question: string;
  type: "single_choice";
  options: QuizOption[];
  answerKey: string;
  explanation: string;
  difficulty: number;
  createdAt: string;
}

export interface QuizSession {
  filePath: string;
  quizPath: string;
  title: string;
  questions: QuizQuestion[];
  index: number;
  selectedKey: string | null;
  submitted: boolean;
}

export interface PipelineStatus {
  path: string;
  status: "raw" | "processed" | "failed";
  updatedAt: string;
  error?: string;
}

export interface PipelineUiState {
  completed: string[];
  currentStep: string | null;
  error: string | null;
  failedStep: string | null;
  running: boolean;
  visible: boolean;
}

export interface ChatResult {
  sourceMode: KnowFlowMode;
  filePath: string | null;
  contextLabel: string;
  question: string;
  answer: string;
  createdAt: string;
}

export interface ViewContext {
  mode: KnowFlowMode;
  activeFile: TFile | null;
  selectedPath: string | null;
}

export interface ArticleStats {
  scopePath: string;
  total: number;
  learned: number;
  unread: number;
  reviewDue: number;
  weakPoints: number;
}
