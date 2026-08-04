import { applyActionLayout, button, row, section, setStyles, text } from "./dom";
import { renderShell } from "./shell";
import type { QuizSession } from "../types";

interface QuizTestViewProps {
  session: QuizSession;
  onBack: () => void;
  onSelect: (key: string) => void;
  onSubmit: () => Promise<void>;
  onNext: () => void;
  onFinish: () => void;
}

export function renderQuizTestView(root: HTMLElement, props: QuizTestViewProps): void {
  const { session } = props;
  const content = renderShell(root, "Quiz", `${session.index + 1}/${session.questions.length}`, props.onBack);
  const question = session.questions[session.index];
  const card = section(content, "kf-quiz-test");
  const head = row(card);
  setStyles(head, { justifyContent: "space-between" });
  text(head, question.question, "kf-card-title");
  text(head, `难度 ${question.difficulty}/5`, "kf-pill");

  const options = card.createDiv({ cls: "kf-quiz-options" });
  setStyles(options, {
    display: "flex",
    flexDirection: "column",
    gap: "8px"
  });
  for (const option of question.options) {
    const selected = session.selectedKey === option.key;
    const isCorrect = session.submitted && option.key === question.answerKey;
    const isWrong = session.submitted && selected && option.key !== question.answerKey;
    const optionButton = options.createEl("button", { text: `${option.key}. ${option.content}` });
    setStyles(optionButton, {
      alignItems: "flex-start",
      backgroundColor: isCorrect
        ? "color-mix(in srgb, var(--interactive-accent) 18%, var(--background-primary))"
        : isWrong
          ? "color-mix(in srgb, var(--text-error) 12%, var(--background-primary))"
          : selected
            ? "color-mix(in srgb, var(--interactive-accent) 10%, var(--background-primary))"
            : "var(--background-primary)",
      border: `1px solid ${isCorrect ? "var(--interactive-accent)" : "color-mix(in srgb, var(--interactive-accent) 22%, var(--background-modifier-border))"}`,
      borderRadius: "8px",
      color: "var(--text-normal)",
      cursor: session.submitted ? "default" : "pointer",
      display: "flex",
      fontSize: "13px",
      height: "auto",
      justifyContent: "flex-start",
      lineHeight: "1.45",
      padding: "9px 10px",
      textAlign: "left",
      whiteSpace: "normal",
      width: "100%",
      wordBreak: "break-word"
    });
    optionButton.disabled = session.submitted;
    optionButton.addEventListener("click", () => props.onSelect(option.key));
  }

  if (session.submitted) {
    const isCorrect = session.selectedKey === question.answerKey;
    const correctOption = question.options.find((option) => option.key === question.answerKey);
    const accentColor = isCorrect ? "var(--interactive-accent)" : "var(--text-error)";

    const explanation = card.createDiv({ cls: "kf-quiz-explanation" });
    setStyles(explanation, {
      backgroundColor: `color-mix(in srgb, ${accentColor} 8%, var(--background-secondary))`,
      border: `1px solid color-mix(in srgb, ${accentColor} 22%, var(--background-modifier-border))`,
      borderRadius: "8px",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      padding: "10px 12px"
    });
    setStyles(explanation.createDiv({ text: `${isCorrect ? "✓" : "✗"} 正确答案：${question.answerKey}. ${correctOption?.content ?? ""}` }), {
      color: accentColor,
      fontSize: "13px",
      fontWeight: "650",
      lineHeight: "1.45"
    });
    if (question.explanation) {
      text(explanation, question.explanation, "kf-muted");
    }
  }

  const actions = row(card, "kf-actions");
  applyActionLayout(actions);
  if (!session.submitted) {
    button(actions, "提交答案", props.onSubmit, true);
  } else if (session.index < session.questions.length - 1) {
    button(actions, "下一题", props.onNext, true);
  } else {
    button(actions, "完成测试", props.onFinish, true);
  }
}
