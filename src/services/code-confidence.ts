export type CodeConfidence = "high" | "medium" | "unknown";

export interface UnfencedCodeAssessment {
  confidence: CodeConfidence;
  suggestedLanguage: string;
  reason: string;
}

export function assessUnfencedCode(lines: string[], previousLine: string): UnfencedCodeAssessment {
  const joined = lines.join("\n");
  const first = lines[0]?.trim() ?? "";

  // YAML: apiVersion/kind/metadata pattern or document start ---
  if (/^(apiVersion|kind|metadata|spec|items|selector|template):/m.test(joined) || lines.length > 1 && /^---\s*$/.test(lines[0].trim())) {
    return { confidence: "high", suggestedLanguage: "yaml", reason: "Kubernetes/YAML key:value structure" };
  }

  // JSON: bracket or "key": pattern
  if (/^\s*[{[]/.test(first) && /["']\w+["']\s*:/.test(joined)) {
    return { confidence: "high", suggestedLanguage: "json", reason: "JSON bracket + key:value pattern" };
  }

  // Python: import/def/class with consistent indentation
  const pythonLines = lines.filter((l) => /^\s*(import\s+|from\s+\w+\s+import|def\s+|class\s+|@\w+)/.test(l.trim()));
  if (pythonLines.length >= 2) {
    return { confidence: "high", suggestedLanguage: "python", reason: "Python import/def/class keywords" };
  }

  // TypeScript/JavaScript
  const jsLines = lines.filter((l) => /^\s*(const\s+|let\s+|var\s+|function\s+|export\s+|import\s+.*from)/.test(l.trim()));
  if (jsLines.length >= 2) {
    return { confidence: "high", suggestedLanguage: "typescript", reason: "JS/TS variable/function declarations" };
  }

  // SQL
  const sqlLines = lines.filter((l) => /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+)/i.test(l.trim()));
  if (sqlLines.length >= 2) {
    return { confidence: "high", suggestedLanguage: "sql", reason: "SQL DML/DDL keywords" };
  }

  // Shell
  const shellLines = lines.filter((l) => /^\s*(curl\b|sudo\b|git\b|npm\b|docker\b|kubectl\b|cd\b|mkdir\b|apt\b|brew\b)/.test(l.trim()));
  if (shellLines.length >= 2) {
    return { confidence: "high", suggestedLanguage: "bash", reason: "Shell command patterns" };
  }

  // HTML
  if (/^\s*<\w+[>\s]/.test(first) && lines.length >= 2) {
    return { confidence: "high", suggestedLanguage: "html", reason: "HTML tag pattern" };
  }

  // Medium: some code indicators but not enough for HIGH
  const codeIndicators = lines.filter((l) =>
    /[{};]/.test(l) || /=>/.test(l) || /^\s*[\w-]+\s*:\s*\S/.test(l) || /^(curl|sudo|docker|kubectl|git|npm)\b/.test(l.trim())
  ).length;

  const contextSuggestsCode = /(代码|命令|配置|示例|执行|运行|安装|终端|输出)\s*[:：]?\s*$/.test(previousLine.trim());

  if (codeIndicators >= 2 || (codeIndicators === 1 && contextSuggestsCode && lines.length >= 2)) {
    return { confidence: "medium", suggestedLanguage: "", reason: "Code indicators present but language unclear" };
  }

  return { confidence: "unknown", suggestedLanguage: "", reason: "Not enough code signals" };
}

/**
 * Wrap unfenced code lines in a markdown code fence.
 * Used when assessUnfencedCode returns HIGH confidence.
 */
export function wrapCodeFence(lines: string[], language: string): string[] {
  if (!language) return lines;
  return [`\`\`\`${language}`, ...lines, "```"];
}
