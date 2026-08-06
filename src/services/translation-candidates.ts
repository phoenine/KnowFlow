export interface TranslationCandidate {
  id: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface TranslationDecision {
  id: string;
  translation: string;
}

const TRANSLATION_BATCH_CHARS = 12000;

export function isPredominantlyEnglishArticle(content: string): boolean {
  const prose = linesOutsideFences(content)
    .filter((line) => !/^\s*(?:>|```|~~~|\|)/.test(line))
    .join("\n")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`[^`]*`/g, "");
  const latin = prose.match(/[A-Za-z]/g)?.length ?? 0;
  const cjk = prose.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  return latin >= 80 && cjk / Math.max(1, latin + cjk) <= 0.02;
}

export function collectTranslationCandidates(content: string): TranslationCandidate[] {
  const lines = content.split("\n");
  const candidates: TranslationCandidate[] = [];
  let inFence = false;
  let inMath = false;
  let index = 0;

  while (index < lines.length) {
    if (/^\s*(?:```|~~~)/.test(lines[index])) {
      inFence = !inFence;
      index += 1;
      continue;
    }
    if (/^\s*\$\$\s*$/.test(lines[index])) {
      inMath = !inMath;
      index += 1;
      continue;
    }
    if (inFence || inMath || !isPlainParagraphLine(lines[index])) {
      index += 1;
      continue;
    }
    if (/^\s*(?:={3,}|-{3,})\s*$/.test(lines[index + 1] ?? "")) {
      index += 1;
      continue;
    }

    const startLine = index;
    while (index + 1 < lines.length && isPlainParagraphLine(lines[index + 1])) index += 1;
    const endLine = index;
    const paragraph = lines.slice(startLine, endLine + 1).join("\n").trim();
    const latin = paragraph.match(/[A-Za-z]/g)?.length ?? 0;
    const cjk = paragraph.match(/[\u3400-\u9fff]/g)?.length ?? 0;
    if (latin >= 20 && cjk === 0 && !isMostlyUrl(paragraph)) {
      candidates.push({
        id: `translation-${candidates.length + 1}`,
        startLine,
        endLine,
        content: paragraph
      });
    }
    index += 1;
  }
  return candidates;
}

export function batchTranslationCandidates(candidates: TranslationCandidate[]): TranslationCandidate[][] {
  const batches: TranslationCandidate[][] = [];
  let batch: TranslationCandidate[] = [];
  let chars = 0;
  for (const candidate of candidates) {
    if (batch.length > 0 && chars + candidate.content.length > TRANSLATION_BATCH_CHARS) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(candidate);
    chars += candidate.content.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function applyTranslationDecisions(
  content: string,
  candidates: TranslationCandidate[],
  decisions: TranslationDecision[]
): string {
  const lines = content.split("\n");
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const accepted = decisions
    .map((decision) => ({ decision, candidate: byId.get(decision.id) }))
    .filter((item): item is { decision: TranslationDecision; candidate: TranslationCandidate } =>
      Boolean(item.candidate) && isValidTranslation(item.decision.translation)
    )
    .sort((a, b) => b.candidate.startLine - a.candidate.startLine);

  const used = new Set<string>();
  for (const { decision, candidate } of accepted) {
    if (used.has(candidate.id)) continue;
    used.add(candidate.id);
    const current = lines.slice(candidate.startLine, candidate.endLine + 1).join("\n").trim();
    if (current !== candidate.content) continue;
    lines.splice(candidate.endLine + 1, 0, "", decision.translation.trim());
  }
  return lines.join("\n");
}

function linesOutsideFences(content: string): string[] {
  let inFence = false;
  return content.split("\n").map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line;
  });
}

function isPlainParagraphLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return !/^(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\||!\[|\[\[|<|---+$|\$\$)/.test(trimmed);
}

function isMostlyUrl(value: string): boolean {
  const withoutUrls = value.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, "");
  return withoutUrls.length < 20;
}

function isValidTranslation(value: string): boolean {
  if (typeof value !== "string") return false;
  const translation = value.trim();
  return translation.length > 0
    && translation.length <= 12000
    && /[\u3400-\u9fff]/.test(translation)
    && !/```|~~~/.test(translation);
}
