import type { ChatUsage } from "../types";

export interface ChatStreamDelta {
  content: string;
  reasoning: string;
  usage: ChatUsage | null;
  done: boolean;
}

export function parseChatStreamData(data: string): ChatStreamDelta {
  if (data === "[DONE]") {
    return { content: "", reasoning: "", usage: null, done: true };
  }
  const payload = JSON.parse(data) as {
    choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const delta = payload.choices?.[0]?.delta;
  const promptTokens = payload.usage?.prompt_tokens ?? 0;
  const completionTokens = payload.usage?.completion_tokens ?? 0;
  return {
    content: delta?.content ?? "",
    reasoning: delta?.reasoning_content ?? delta?.reasoning ?? "",
    usage: payload.usage ? {
      promptTokens,
      completionTokens,
      totalTokens: payload.usage.total_tokens ?? promptTokens + completionTokens,
      estimated: false
    } : null,
    done: false
  };
}

export function estimateChatUsage(messages: Array<{ content: string }>, answer: string): ChatUsage {
  const promptTokens = Math.ceil(messages.reduce((total, message) => total + message.content.length, 0) / 3);
  const completionTokens = Math.ceil(answer.length / 3);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true
  };
}
