import { TFile } from "obsidian";
import type { App } from "obsidian";

/**
 * Basic markdown structure validation. Returns { valid: false, error }
 * on the first problem found, or { valid: true } on success.
 */
export function validateMarkdownIntegrity(content: string): { valid: boolean; error?: string } {
  // Check fence closure
  let inFence = false;
  let fenceLine = 0;
  for (const line of content.split("\n")) {
    fenceLine += 1;
    if (/^\s*```/.test(line)) inFence = !inFence;
  }
  if (inFence) return { valid: false, error: `Unclosed code fence (last open near line ${fenceLine})` };

  // Check math block closure
  let inMath = false;
  for (const line of content.split("\n")) {
    if (/^\$\$/.test(line)) inMath = !inMath;
  }
  if (inMath) return { valid: false, error: "Unclosed math block ($$)" };

  return { valid: true };
}

/**
 * Read → operate → compare → write guard.
 * If the file was modified by the user during the repair, aborts instead
 * of silently overwriting their changes.
 */
export async function guardedRepair(
  app: App,
  file: TFile,
  repair: (content: string) => string | Error
): Promise<void> {
  const before = await app.vault.read(file);

  const result = repair(before);
  if (result instanceof Error) throw result;

  const current = await app.vault.read(file);
  if (before !== current) {
    throw new Error("文章在修复期间被用户修改，请重新执行。");
  }

  const integrity = validateMarkdownIntegrity(result);
  if (!integrity.valid) {
    throw new Error(`修复后 Markdown 结构异常：${integrity.error}`);
  }

  await app.vault.modify(file, result);
}
