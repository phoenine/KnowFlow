import { setIcon } from "obsidian";
import { attachPressFeedback, iconButton, row, setStyles } from "./dom";

interface ChatComposerProps {
  contextLabel: string;
  modelName: string;
  draft: string;
  focusDraft: boolean;
  tokenCount: number;
  tokenEstimated: boolean;
  sending: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (question: string) => void;
  onSaveNote: () => void;
  onOpenHistory: () => void;
}

export function renderChatComposer(root: HTMLElement, props: ChatComposerProps): void {
  const composer = root.createDiv({ cls: "kf-composer" });
  setStyles(composer, {
    backgroundColor: "var(--background-primary)",
    borderTop: "1px solid color-mix(in srgb, var(--interactive-accent) 18%, var(--background-modifier-border))",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "10px 12px"
  });

  const toolbar = row(composer, "kf-composer-toolbar");
  setStyles(toolbar, {
    justifyContent: "space-between",
    minHeight: "24px"
  });
  const mode = row(toolbar);
  setStyles(mode, { gap: "8px" });
  setStyles(mode.createDiv({ text: "chat (free)" }), {
    color: "var(--text-normal)",
    fontSize: "13px",
    fontWeight: "600"
  });
  const chevron = mode.createSpan();
  setIcon(chevron, "chevron-down");
  setStyles(chevron, {
    color: "var(--text-muted)",
    display: "inline-flex"
  });
  setStyles(mode.createDiv({
    text: `${props.tokenEstimated ? "~" : ""}${formatTokenCount(props.tokenCount)}`,
    cls: "kf-chat-tokens"
  }), {
    color: "var(--text-muted)",
    fontSize: "12px",
    fontWeight: "600"
  });
  const tools = row(toolbar);
  setStyles(tools, { gap: "2px" });
  const tool = (label: string, icon: string, onClick: () => void): void => {
    setStyles(iconButton(tools, label, icon, onClick), {
      backgroundColor: "transparent",
      border: "0",
      height: "26px",
      width: "26px"
    });
  };
  tool("保存到 Note", "download", props.onSaveNote);
  tool("历史对话", "history", props.onOpenHistory);

  const panel = composer.createDiv({ cls: "kf-composer-panel" });
  setStyles(panel, {
    backgroundColor: "var(--background-primary)",
    border: "1px solid color-mix(in srgb, var(--interactive-accent) 42%, var(--background-modifier-border))",
    borderRadius: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "7px",
    padding: "8px"
  });

  const contextRow = row(panel);
  setStyles(contextRow, {
    gap: "6px",
    minWidth: "0"
  });
  const at = contextRow.createDiv({ text: "@" });
  setStyles(at, {
    alignItems: "center",
    border: "1px solid color-mix(in srgb, var(--interactive-accent) 35%, var(--background-modifier-border))",
    borderRadius: "6px",
    color: "var(--text-accent)",
    display: "inline-flex",
    fontSize: "14px",
    fontWeight: "600",
    height: "26px",
    justifyContent: "center",
    width: "26px"
  });
  const chip = contextRow.createDiv({ cls: "kf-context-chip" });
  applyChipStyle(chip);
  const chipText = chip.createSpan({ text: props.contextLabel || "Current" });
  setStyles(chipText, {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  });
  const input = panel.createEl("textarea", {
    cls: "kf-input",
    attr: { placeholder: "Your AI assistant for Obsidian · @ to add context · / for prompts" }
  });
  setStyles(input, {
    backgroundColor: "transparent",
    border: "0",
    borderRadius: "0",
    boxShadow: "none",
    color: "var(--text-normal)",
    fontSize: "13px",
    lineHeight: "1.45",
    minHeight: "48px",
    outline: "none",
    padding: "0",
    resize: "none",
    width: "100%"
  });
  input.value = props.draft;
  input.addEventListener("input", () => props.onDraftChange(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!props.sending) props.onSubmit(input.value.trim());
  });
  input.addEventListener("focus", () => {
    setStyles(panel, {
      borderColor: "var(--interactive-accent)",
      boxShadow: "0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent)"
    });
  });
  input.addEventListener("blur", () => {
    setStyles(panel, {
      borderColor: "color-mix(in srgb, var(--interactive-accent) 42%, var(--background-modifier-border))",
      boxShadow: "none"
    });
  });
  if (props.focusDraft) {
    // Restores focus/cursor after a background re-render (e.g. pipeline
    // progress ticks) tore down and recreated this textarea, so the user
    // doesn't lose their place mid-sentence.
    window.requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
  const footer = row(panel, "kf-composer-footer");
  setStyles(footer, {
    alignItems: "center",
    display: "flex",
    gap: "10px",
    justifyContent: "space-between"
  });
  setStyles(footer.createDiv({ text: props.modelName, cls: "kf-model" }), {
    color: "var(--text-normal)",
    fontSize: "13px",
    fontWeight: "600"
  });
  const sendTools = row(footer);
  setStyles(sendTools, {
    gap: "16px",
    marginLeft: "auto"
  });
  const image = sendTools.createSpan();
  setIcon(image, "image");
  setStyles(image, {
    alignItems: "center",
    color: "var(--text-muted)",
    display: "inline-flex",
    height: "28px"
  });
  const send = sendTools.createEl("button");
  send.setAttribute("aria-label", "发送");
  send.setAttribute("title", "发送");
  setStyles(send, {
    alignItems: "center",
    backgroundColor: "transparent",
    border: "0",
    borderRadius: "6px",
    color: "var(--text-accent)",
    cursor: "pointer",
    display: "inline-flex",
    justifyContent: "center",
    lineHeight: "1",
    height: "28px",
    padding: "4px",
    width: "28px"
  });
  const sendIcon = send.createSpan();
  setIcon(sendIcon, "send-horizontal");
  setStyles(sendIcon, { display: "inline-flex" });
  send.disabled = props.sending;
  if (props.sending) setStyles(send, { cursor: "default", opacity: "0.55" });
  attachPressFeedback(send);
  send.addEventListener("click", () => {
    if (!props.sending) props.onSubmit(input.value.trim());
  });
}

function formatTokenCount(value: number): string {
  if (value < 1000) return `${value} tokens`;
  const rounded = value >= 10000 ? Math.round(value / 1000) : Math.round(value / 100) / 10;
  return `${rounded}k tokens`;
}

export function applyChipStyle(el: HTMLElement): void {
  setStyles(el, {
    alignSelf: "flex-start",
    border: "1px solid var(--background-modifier-border)",
    borderRadius: "7px",
    color: "var(--text-normal)",
    display: "inline-flex",
    fontSize: "12px",
    fontWeight: "500",
    gap: "6px",
    maxWidth: "calc(100% - 34px)",
    minWidth: "0",
    padding: "4px 8px",
    whiteSpace: "nowrap"
  });
}
