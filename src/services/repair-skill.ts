const BUILTIN_SKILL = [
  "你是 KnowFlow 的 Clipping Repair 助手。",
  "目标: 恢复网页剪藏 Markdown 结构。",
  "",
  "允许:",
  "- 修复标题层级 (H2/H3/H4)",
  "- 包裹代码块并标注语言",
  "- 删除网页噪声",
  "- 修复列表格式",
  "",
  "禁止:",
  "- 改写正文内容",
  "- 总结或评论文章",
  "- 修改事实、数据、代码逻辑",
  "- 添加原文没有的内容",
  "",
  "输出: 严格 JSON，只包含 action 和必要字段。不确定时返回 keep。"
].join("\n");

/**
 * Two-layer skill system:
 * - Builtin rules (hardcoded, user cannot override)
 * - User rules (loaded from vault skills/clipping-repair.md, append-only)
 */
export function loadSkill(userSkillContent?: string): string {
  if (!userSkillContent?.trim()) return BUILTIN_SKILL;

  // Only extract "允许" and "禁止" sections from user file to prevent
  // overriding core constraints
  const allowMatch = /^允许\s*:\s*\n([\s\S]*?)(?=^禁止\s*:\s*\n|\n\n|$)/m.exec(userSkillContent);
  const forbidMatch = /^禁止\s*:\s*\n([\s\S]*?)(?=\n\n|$)/m.exec(userSkillContent);

  const userAllow = allowMatch ? allowMatch[1].trim() : "";
  const userForbid = forbidMatch ? forbidMatch[1].trim() : "";

  const parts = [BUILTIN_SKILL];
  if (userAllow) parts.push(`\n用户补充 — 允许:\n${userAllow}`);
  if (userForbid) parts.push(`\n用户补充 — 禁止:\n${userForbid}`);

  return parts.join("\n");
}

/**
 * Load user skill file from vault (if it exists), return content or null.
 */
export async function loadUserSkillFile(vaultAdapter: { exists(path: string): Promise<boolean>; read(path: string): Promise<string> }): Promise<string | null> {
  const path = "skills/clipping-repair.md";
  if (await vaultAdapter.exists(path)) {
    return vaultAdapter.read(path);
  }
  return null;
}
