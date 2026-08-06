# Obsidian Clipping Repair Agent

> 设计文档 · 2026-08-06 · 尚未实现

## 目标

核心原则：**规则负责发现 → Skill 负责约束 → LLM 负责判断 → 程序负责修改**

三个组件：

1. **Markdown Block Parser** — 将 Markdown 切为带类型的块，标记保护区域
2. **规则 + LLM 分层处理** — 标题/代码候选收集，置信度分级，LLM 只判类型
3. **Clipping Repair Skill** — 外置约束文件，代替硬编码 system prompt
4. **验证层** — 文档保护（hash）、编辑有效性、Markdown 结构完整性

---

## 1. Markdown Block Parser

### 1.1 数据结构

```typescript
type BlockType =
  | "heading"         // # 开头（或已检测到的标题）
  | "paragraph"       // 普通段落
  | "code"            // ``` 包围的代码块
  | "callout"         // > [!type] 开头的 Obsidian Callout
  | "table"           // | 分隔的表格
  | "math"            // $$ 包围的数学公式
  | "list"            // -/* 或 1. 开头的列表
  | "quote"           // > 开头（非 callout）
  | "thematic-break"  // --- 或 ***
  | "empty";          // 空白行

interface MarkdownBlock {
  type: BlockType;
  startLine: number;   // 0-indexed, inclusive
  endLine: number;     // 0-indexed, inclusive
  lines: string[];     // 原始行（不修改）
  parentType?: BlockType;  // 所在父块类型（如 callout 内的 paragraph）
  metadata?: {
    level?: number;        // heading: 1-6
    language?: string;     // code: 语言标识
    calloutType?: string;  // callout: note/warning/tip/abstract 等
    foldState?: "+" | "-"; // callout: 折叠状态
    listMarker?: string;   // list: "-" / "*" / "1."
  };
}
```

### 1.2 解析策略

从第一行开始，逐行扫描，维持一个状态机：

```
状态                触发条件
──────────────────────────────────────────
IN_PARAGRAPH        非空、非特殊标记的行
IN_CODE_FENCE       遇到 ``` → 直到下一个 ```
IN_CALLOUT          > [! 开头 → 直到空行或非 > 行
IN_TABLE            | 开头 → 直到非 | 的非空行
IN_MATH             $$ 开头 → 直到下一个 $$
IN_LIST             -/* 或 数字. 开头 → 直到空行
IN_QUOTE            > 开头（非 callout）→ 直到空行
IN_HEADING          # 开头，单行即结束
IN_EMPTY            空行，直到下一个非空行
IN_THEMATIC_BREAK   --- 或 *** 独占一行
```

**嵌套处理**（MVP 阶段可选）：callout 内部可能包含代码块、列表。用栈追踪。例如：

```
> [!note]              ← callout 开始
> 这是说明              ← callout 内的 paragraph
> ```python             ← callout 内的 code fence 开始
> print("hello")        ← code 内容
> ```                   ← code fence 结束
> 继续说明              ← callout 内的 paragraph
                        ← callout 结束（空行）
```

### 1.3 输出示例

输入：

```markdown
## 端到端交付2.0

本文介绍端到端交付的概念。

| 阶段 | 说明 |
|------|------|
| 分析 | 需求分析 |
| 设计 | 架构设计 |

> [!warning]
> 注意版本兼容性。

```yaml
apiVersion: v1
kind: Deployment
```

以上是主要内容。

$$E = mc^2$$

作者 | 张三
```

输出：

```json
[
  { "type": "heading",  "startLine": 0, "endLine": 0, "metadata": { "level": 2 } },
  { "type": "empty",   "startLine": 1, "endLine": 1 },
  { "type": "paragraph","startLine": 2, "endLine": 2 },
  { "type": "empty",   "startLine": 3, "endLine": 3 },
  { "type": "table",   "startLine": 4, "endLine": 7 },
  { "type": "empty",   "startLine": 8, "endLine": 8 },
  { "type": "callout", "startLine": 9, "endLine": 10, "metadata": { "calloutType": "warning" } },
  { "type": "empty",   "startLine": 11, "endLine": 11 },
  { "type": "code",    "startLine": 12, "endLine": 15, "metadata": { "language": "yaml" } },
  { "type": "empty",   "startLine": 16, "endLine": 16 },
  { "type": "paragraph","startLine": 17, "endLine": 17 },
  { "type": "empty",   "startLine": 18, "endLine": 18 },
  { "type": "math",    "startLine": 19, "endLine": 21 },
  { "type": "empty",   "startLine": 22, "endLine": 22 },
  { "type": "paragraph","startLine": 23, "endLine": 23 }
]
```

### 1.4 在 Pipeline 中的应用

有了块类型后，候选收集的逻辑大幅简化：

| 操作 | 当前 | 改用 Block Parser 后 |
|------|------|---------------------|
| heading 候选 | 扫描全文，用 `isPossibleHeadingStart` 启发式 | 只看 `paragraph` 和 `list` 块中的单行短文本 |
| possible-code 候选 | 扫描全文，标记 occupied | 只看 `paragraph` 块，跳过 `code`/`callout`/`math`/`table` |
| fenced-code 候选 | 扫描全文围栏检测 | 直接从 `code` 块中取 `language` 为空/"text"/"plain" 的 |
| 受保护区域 | `occupied` Set + `isProtectedMarkdownLine` 正则 | 块类型天然区分，`code`/`math`/`callout` 块永远不会被送进 LLM |

---

## 2. 标题格式化增强

当前实现已做到「LLM 只判类型、程序执行修复」，但存在三个未覆盖的边缘情况。

### 2.1 多行标题候选合并

**当前行为**：`isPossibleHeadingStart` 要求前后都是空行。相邻的短行（如标题 + 副标题）不会被识别为候选。

```
                  ← 空行 ✓
端到端交付2.0       ← 70 字符以内 ✓
像工业流水线一样的...  ← 下一行不是空行 ✗ → 两个都不被识别
                  ← 空行
```

只有 `1. 标题文本` 这类数字前缀格式被 `possibleHeadingRange` 特殊处理。

**新增逻辑**：

```typescript
function isPossibleHeadingStart(lines: string[], index: number): boolean {
  const line = lines[index].trim();
  if (!line || line.length > 70 || isProtectedMarkdownLine(line)) return false;
  if (/^https?:\/\//i.test(line) || /[。！？；;]$/.test(line)) return false;

  const blankBefore = index === 0 || !lines[index - 1].trim();
  const blankAfter = index === lines.length - 1 || !lines[index + 1].trim();

  // 新增：相邻短行合并为 multi-line 候选
  if (blankBefore && !blankAfter) {
    // 看下一行是否也是 70 字符以内的短文本
    const next = lines[index + 1].trim();
    if (next && next.length <= 70 && !isProtectedMarkdownLine(lines[index + 1])
        && !/[。！？；;]$/.test(next) && !/^https?:\/\//i.test(next)) {
      // 再看下一行之后是不是空行
      const afterNext = index + 2 >= lines.length || !lines[index + 2].trim();
      if (afterNext) return true;  // 两行联合作为候选
    }
  }

  return blankBefore && blankAfter;
}

function possibleHeadingRange(lines: string[], index: number): { start: number; end: number } {
  const current = lines[index].trim();

  // 原有：数字前缀格式（如 "1. 标题" 或 "一、标题" 的变形）
  if (/^\d{1,2}[.)、]?$/.test(current)) {
    let next = index + 1;
    while (next < lines.length && !lines[next].trim()) next += 1;
    if (next < lines.length && lines[next].trim().length <= 70 && !isProtectedMarkdownLine(lines[next])) {
      return { start: index, end: next };
    }
  }

  // 新增：相邻双行短文本
  const blankAfter = index === lines.length - 1 || !lines[index + 1].trim();
  if (!blankAfter) {
    const nextLine = lines[index + 1].trim();
    if (nextLine && nextLine.length <= 70 && !isProtectedMarkdownLine(lines[index + 1])
        && !/[。！？；;]$/.test(nextLine)) {
      const afterNext = index + 2 >= lines.length || !lines[index + 2].trim();
      if (afterNext) return { start: index, end: index + 1 };
    }
  }

  return { start: index, end: index };
}
```

LLM 看到两行作为 `content`，`applyFormattingDecisions` 已支持多行合并：

```typescript
// 现有逻辑（不变）
const heading = candidate.content
  .split("\n")
  .map((line) => line.trim().replace(/^\*\*(.+)\*\*$/, "$1"))
  .filter(Boolean)
  .join(" ");  // "端到端交付2.0 像工业流水线一样的生产和交付需求"
lines.splice(candidate.startLine, candidate.endLine - candidate.startLine + 1,
             `${"#".repeat(level)} ${heading}`);
```

**建议**：LLM 可以返回一个可选 `separator` 字段（默认为空格）：

```json
{ "id": "fmt-7", "action": "heading", "level": 2, "separator": "：" }
// → "## 端到端交付2.0：像工业流水线一样的生产和交付需求"
```

### 2.2 已有标题的编号噪音清理

**当前行为**：`## 1.  01` 因为已经是 `#` 行，被 `isProtectedMarkdownLine` 保护，永远不会进 LLM。

**方案**：纯规则清理，在 `organizeMarkdownStyle` 中增加一步。但只处理**编号后完全是数字**的情况，不碰有意义的章节标题：

```typescript
// 只清理编号后内容全是数字的噪音标题
// "## 1. 01" → "## "          (纯数字 ✓)
// "## 3、 02" → "## "         (纯数字 ✓)  
// "## 1. 概述" → 不动         (有文字 ✗)
// "## 1.1 版本历史" → 不动    (章节编号 ✗)
next = next.replace(/^(#{1,6})\s+\d+[\.\、\)]\s*\d+\s*$/g, "$1 ");
```

| 输入 | 输出 | 是否处理 |
|------|------|---------|
| `## 1. 01` | `## ` | ✓ 内容全是数字 |
| `## 3、 02` | `## ` | ✓ 内容全是数字 |
| `## 1. 概述` | 不动 | ✗ 后面有文字 |
| `## 1.1 版本` | 不动 | ✗ 章节编号 |
| `### 2) 安装说明` | 不动 | ✗ 后面有文字 |

### 2.3 孤儿加粗分隔符修复

**问题模板**：

```markdown

**

**第一个项目叫 Scroll-world**

**
```

当前 `stripOrphanBoldDelimiters` 的正则：

```
/(^|\n)\*\*[ \t]*\n+([^\n*][^\n]*?)\n+\*\*/
```

中间行 `**第一个项目叫 Scroll-world**` 以 `*` 开头 → `[^\n*]` 匹配失败 → 不处理。

**修复**：在 `stripOrphanBoldDelimiters` 中增加变体模式，或新增一个预处理步骤：

```typescript
function normalizeOrphanBoldTriplet(content: string): string {
  // 模式: **\n  **text**  \n**  →  **text**
  return content.replace(
    /(^|\n)\*\*[ \t]*\n+(\*\*.+?\*\*)[ \t]*\n+\*\*[ \t]*(?=\n|$)/g,
    "$1$2"
  );
}
```

调用顺序：先跑新版 `normalizeOrphanBoldTriplet`，再跑原有的 `stripOrphanBoldDelimiters`。

效果：

```
输入:  **\n**第一个项目叫 Scroll-world**\n**\n
输出: **第一个项目叫 Scroll-world**
```

修好后该行自然成为 `isPossibleHeadingStart` 的候选（单行、<70 字符、前后空行），最终由 LLM 判断为标题 → `### 第一个项目叫 Scroll-world`。

### 2.4 上下文截断优化

当前 `before`/`after` 各截断 160 字符。对于标题判断，前一行/后一行各 40 字符足够。改为可配置或在 `makeCandidate` 中按类型设置不同截断长度：

```typescript
function nearestNonBlank(lines: string[], start: number, step: -1 | 1, maxChars = 160): string {
  for (let index = start; index >= 0 && index < lines.length; index += step) {
    if (lines[index].trim()) return lines[index].trim().slice(0, maxChars);
  }
  return "";
}

// 标题候选：40 字符
// 代码候选：160 字符（保持）
```

---

## 3. 置信度代码检测

### 3.1 数据结构

```typescript
type CodeConfidence = "high" | "medium" | "unknown";

interface UnfencedCodeAssessment {
  confidence: CodeConfidence;
  suggestedLanguage: string;
  reason: string; // 调试用，说明判断依据
}
```

### 3.2 分级规则

#### HIGH（直接包围栏，不调 LLM）

满足以下任一条件：

- **YAML/JSON 结构明显**：多行缩进 + key:value 模式占比 > 60%
- **编程语言关键词密集**：连续 3 行以上包含 `def`/`import`/`const`/`function`/`class`/`export` 等
- **Shell 命令**：以 `$` 或 `#` 开头的命令序列（至少 2 行）
- **明确上下文提示**：前一行包含「代码」「配置」「命令」「示例」+ 当前块缩进一致

→ `suggestedLanguage` 用启发式推断（`normalizeCodeLanguage` 逻辑）

#### MEDIUM（发给 LLM 判断）

- 有一些代码特征但不够确定
- 单行代码片段（如 `docker run ...`）
- 混合内容（文本 + 代码混排）
- 上下文提示但不完全匹配

→ 送 LLM，走 `analyzePossibleCodeCandidates`

#### UNKNOWN（跳过，保持原样）

- 普通文本段落
- 项目要点列表
- 短句集合
- 信息不足无法判断（如 `docker run nginx` 单行）
- 注意：UNKNOWN ≠ "确定不是代码"，只是信息不足以决策

### 3.3 语言启发式（用于 HIGH 置信度）

```typescript
function detectLanguage(lines: string[]): string {
  const joined = lines.join("\n");
  const first = lines[0]?.trim() ?? "";

  if (/^(apiVersion|kind|metadata|spec):/m.test(joined)) return "yaml";
  if (/^\s*[{[]/.test(first) || /"\w+":/.test(joined)) return "json";
  if (/^(import |from |def |class |@)/m.test(joined)) return "python";
  if (/^(const |let |var |function |export |import.*from)/m.test(joined)) return "typescript";
  if (/^(curl|sudo|git|npm|docker|kubectl|cd|mkdir)\b/m.test(joined)) return "bash";
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE)\b/im.test(joined)) return "sql";
  if (/^<\w+/.test(first)) return "html";
  if (/^---\s*$/.test(lines[0])) return "yaml"; // YAML document start
  return "";
}
```

---

## 4. 整合到 Pipeline

### 4.1 改造后的流程

```
Step 1: Block Parser
  输入: 正文内容
  输出: MarkdownBlock[]
  作用: 一次性切块、标记保护区域

Step 2: 整理 Markdown 样式
  在非 code/math/callout 块上应用规则变换
  （和当前一样，但能利用块类型跳过受保护内容）

Step 3: 标题候选收集
  扫描 type=paragraph 的块
  → 短文本（<70 字符）、前后有空行 → 标题候选
  → type=list 的短行也考虑（可能是畸形标题被识别为列表）
  → 发送到 analyzeHeadingCandidates（不变）

Step 4: 代码块格式化
  对 type=code 的块:
    - 删行号、删水印（不变）
    - 语言为空/plain/text → 加入 fenced-code 候选
  对 type=paragraph 的块:
    - 运行 assessUnfencedCode()
    - HIGH → 直接包围栏
    - MEDIUM → 加入 possible-code 候选
    - LOW → 跳过

Step 5: 代码 LLM（可能跳过）
  如果 MEDIUM possible-code 候选为空 → 跳过此步
  如果 fenced-code 候选为空 → 跳过此步
  否则 → Promise.all 并行调用两个 LLM

Step 6: 英文翻译（不变）

Step 7: 补全 Frontmatter（不变）
```

### 4.2 LLM 调用次数变化

| 场景 | 当前 | 改造后 |
|------|------|--------|
| 标题候选 > 0 | 1 次 | 1 次 |
| 标题候选 = 0 | 1 次（空 → 立即返回） | 0 次（跳过） |
| 代码 MEDIUM + fenced-code | 2 次 | 最多 2 次（并行） |
| 代码只有 HIGH | 2 次 | 0 次 |
| 代码 HIGH + MEDIUM + fenced | 2 次 | 最多 2 次（并行） |
| 文章无任何代码 | 2 次 | 0 次 |
| 文章只有标题 | 1 次 | 1 次 |
| 文章无任何候选 | 1 次（浪费） | 0 次 |

### 4.3 关键设计决策

**读写模式：一次读取，一次写入**

```
vault.read(file)        ← 只读一次
  ↓
Block Parser + 规则变换  ← 内存操作
  ↓
收集全部 candidates
  ↓
LLM 并行调用（标题 + 代码） ← 不改文件
  ↓
收集全部 edits
  ↓
validateMarkdownIntegrity
  ↓
vault.read(file)        ← 再读一次做 hash 比对
  ↓
before ≠ current? → 报错停止
  ↓
vault.modify(file)      ← 只写一次
```

不做 per-phase 写入——中间写盘会触发 N 次 Obsidian 文件变更事件、污染撤销栈、增加并发风险。

**LLM 不变**
- LLM 仍然只看到候选片段（content + before + after），永不看全文
- `applyFormattingDecisions` 仍然做纯代码的局部行替换

---

## 5. Clipping Repair Skill

当前 system prompt 硬编码在 `ai-service.ts` 各方法内。改为外置 skill 文件，用户可编辑、可热更新。

### 5.1 Skill 文件

`skills/clipping-repair.md`：

```markdown
# Clipping Repair Skill

目标:
恢复网页剪藏 Markdown 结构。

允许:
- 修复标题层级 (H2/H3/H4)
- 包裹代码块并标注语言
- 删除网页噪声
- 修复列表格式

禁止:
- 改写正文内容
- 总结或评论文章
- 修改事实、数据、代码逻辑
- 添加原文没有的内容

输出:
严格 JSON，只包含 action 和必要字段
```

### 5.2 加载机制

两层设计，用户只能追加、不能覆盖内置规则：

```
内置默认 skill（打包在插件里）
  +
用户追加规则（从 vault skills/ 读取）
```

```typescript
class SkillLoader {
  async load(): Promise<string> {
    const builtin = this.getBuiltinSkill();  // 硬编码的约束

    const userPath = normalizePath("skills/clipping-repair.md");
    let userAppend = "";
    if (await this.app.vault.adapter.exists(userPath)) {
      userAppend = await this.app.vault.adapter.read(userPath);
      // 只取「允许」和「禁止」段，不覆盖核心约束
      userAppend = extractRules(userAppend);
    }

    return `${builtin}

用户补充规则：
${userAppend}`;
  }
}
```

用户文件格式（可选，不存在则只用内置）：

```markdown
# 用户自定义规则

允许:
- 修复中文标点

禁止:
- 修改代码块内容
```

这样用户改不坏核心的「不改正文」约束。

### 5.3 调用方式

每次 LLM 调用时拼接：

```
[System] 内置角色描述（1-2 句）
[System] Clipping Repair Skill（从 skills/ 文件加载）
[System] 具体任务约束（当前 candidate 类型的规则）
[User]   candidates JSON
```

**收益**：
- Skill 文件在用户 vault 里，重启插件即生效，不需要重新构建
- 多语言用户可自行翻译 skill 文件
- 调试时直接改 vault 里的 md 文件比改 TS 源码再编译快得多

---

## 6. 验证层

当前 pipeline 没有验证机制——LLM 调用期间用户在编辑器里改了文件会静默丢数据。

### 6.1 文档保护（字符串比较）

Obsidian 文章一般几十 KB，直接用 `===` 比较，不需要 hash：

```typescript
async function guardedRepair(file: TFile): Promise<void> {
  const before = await this.app.vault.read(file);

  // ... Block Parser + 规则变换 + LLM + 生成全部 edits ...

  const current = await this.app.vault.read(file);
  if (before !== current) {
    throw new Error("文章在修复期间被用户修改，请重新执行。");
  }

  const modified = applyEdits(before, edits);
  validateMarkdownIntegrity(modified);  // throws on failure
  await this.app.vault.modify(file, modified);
}
```

### 6.2 编辑有效性

`applyFormattingDecisions` 执行后检查：

```typescript
function validateEdits(lines: string[], edits: Edit[]): EditValidation {
  for (const edit of edits) {
    // start/end 仍在 lines 范围内
    if (edit.start < 0 || edit.end >= lines.length) {
      return { valid: false, error: `Line ${edit.start}-${edit.end} out of range` };
    }
  }
  return { valid: true };
}
```

### 6.3 Markdown 结构检查

写入前快速扫描：

```typescript
function validateMarkdownIntegrity(content: string): MarkdownValidation {
  // Fence 闭合
  let inFence = false;
  for (const line of content.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
  }
  if (inFence) return { valid: false, error: "Unclosed code fence" };

  // Frontmatter 完整性
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
  if (fmMatch) {
    const fmLines = fmMatch[1].split("\n");
    for (const line of fmLines) {
      if (line.trim() && !/^[\w\u4e00-\u9fff]+\s*:/.test(line) && !/^\s+-/.test(line) && !/^\s*$/.test(line)) {
        return { valid: false, error: `Invalid frontmatter line: ${line.slice(0, 60)}` };
      }
    }
  }

  // Callout 完整性
  const calloutOpens = (content.match(/^>\s*\[!(\w+)\][+-]?\s*$/gm) || []).length;
  // 近似：检查 callout 后面是否有空行结束
  // 完整实现需要 Block Parser 输出

  return { valid: true };
}
```

### 6.4 在 Pipeline 中的位置

```
Phase 1: 规则修复
Phase 2: Heading Repair  ─┐
Phase 3: Code Repair      ├─ 各 phase 内部用 guardedModify
Phase 4: 验证层  ←───────┘  (validateEdits + validateMarkdownIntegrity)
Phase 5: 写回 (vault.modify)
```

---

## 7. 实现文件

| 文件 | 内容 |
|------|------|
| `src/services/block-parser.ts` | `parseBlocks(content: string): MarkdownBlock[]` |
| `src/services/code-confidence.ts` | `assessUnfencedCode(lines: string[], previousLine: string): UnfencedCodeAssessment` |
| `src/services/repair-skill.ts` | `SkillLoader` + 内置默认 skill 回退 |
| `src/services/repair-validator.ts` | `guardedModify` + `validateEdits` + `validateMarkdownIntegrity` |
| `skills/clipping-repair.md` | 外置 skill 文件（用户 vault 内可编辑） |
| `src/services/clipping-pipeline.ts` | 接入 Block Parser + 置信度 + Skill + 验证层 |
| `src/services/formatting-candidates.ts` | 候选收集改为基于 Block Parser 输出 |
| `src/services/ai-service.ts` | system prompt 改为拼接 Skill 内容 |

---

## 8. 测试用例

### 8.1 Block Parser

```
输入: 空字符串 → []
输入: 纯英文段落 → [paragraph]
输入: ## Heading\n\nText → [heading, empty, paragraph]
输入: ```python\ncode\n```\nText → [code, empty, paragraph]
输入: > [!note]\n> Text\n\nNormal → [callout, empty, paragraph]
输入: | A | B |\n|---|---|\n| 1 | 2 | → [table]
输入: $$x=y$$\n → [math]
输入: 混合多类型 → 验证没有交叉边界错误
```

### 8.2 置信度代码检测

```
输入: YAML Deployment → HIGH, yaml
输入: Python 函数定义 → HIGH, python  
输入: 单行 docker run → MEDIUM, bash
输入: "今天天气不错，我们去散步吧" → LOW, ""
输入: "@Component public class..." → HIGH, java
输入: "{'key': 'value'}" → MEDIUM, ""（JSON-like 但单行不确定）
```

---

---

## 9. 不做的

- ❌ 嵌套 block 的完整 AST（MVP 用 `parentType` 提示就够了）
- ❌ inline 元素解析（bold/italic/link/code span）
- ❌ Preview diff UI
- ❌ AI 重写代码、修复 YAML、格式化代码（只包围栏 + 删噪声）
- ❌ V1 不做 Skill Loader、不做复杂 Validator

---

## 10. 版本路线

按 Reviewer 建议拆分为三阶段，控制单次交付复杂度。

### V1（核心路径）

```
Block Parser
  ↓
整理 Markdown 样式（规则清理）
  ↓
标题候选收集 + LLM 判断 + apply
  ↓
代码块格式化（规则 + HIGH 置信直接包围栏）
  ↓
代码 MEDIUM 候选 + fenced-code 候选 → LLM（并行）
  ↓
字符串比对 + validateMarkdownIntegrity
  ↓
vault.modify（一次写入）
```

**不包含**：Skill loader、完整 validated、UNKNOWN 置信度体系

### V1.5

增加：Code Confidence 完整体系（HIGH/MEDIUM/UNKNOWN）、孤儿 Bold 修复、多行标题合并

### V2

增加：Skill 双层系统、Validator 完整实现、编号噪音清理
