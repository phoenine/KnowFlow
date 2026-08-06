import { setIcon } from "obsidian";
import type { ChatThread } from "../types";
import { attachPressFeedback, setStyles, text } from "./dom";

interface ChatHistoryViewProps {
  threads: ChatThread[];
  onClose: () => void;
  onOpen: (thread: ChatThread) => void;
}

export function renderChatHistoryPopover(root: HTMLElement, props: ChatHistoryViewProps): void {
  root.querySelector(".kf-chat-history-layer")?.remove();
  const composerHeight = root.querySelector<HTMLElement>(".kf-composer")?.offsetHeight ?? 150;
  const bottom = composerHeight + 16;
  const layer = root.createDiv({ cls: "kf-chat-history-layer" });
  setStyles(layer, {
    inset: "0",
    pointerEvents: "none",
    position: "absolute",
    zIndex: "20"
  });

  const popover = layer.createDiv({ cls: "kf-chat-history-popover" });
  setStyles(popover, {
    backgroundColor: "var(--background-primary)",
    border: "1px solid var(--background-modifier-border)",
    borderRadius: "12px",
    bottom: `${bottom}px`,
    boxShadow: "0 8px 28px rgba(0, 0, 0, 0.22)",
    display: "flex",
    flexDirection: "column",
    height: `min(440px, calc(100% - ${bottom + 10}px))`,
    maxHeight: "440px",
    overflow: "hidden",
    padding: "10px",
    pointerEvents: "auto",
    position: "absolute",
    right: "10px",
    width: "min(372px, calc(100% - 20px))"
  });
  const search = popover.createEl("input", {
    cls: "kf-chat-history-search",
    attr: { type: "search", placeholder: "Search...", "aria-label": "搜索历史对话" }
  });
  setStyles(search, {
    backgroundColor: "var(--background-primary)",
    border: "1px solid var(--background-modifier-border)",
    borderRadius: "8px",
    boxShadow: "none",
    fontSize: "13px",
    marginBottom: "8px",
    padding: "8px 10px",
    width: "100%"
  });
  const list = popover.createDiv({ cls: "kf-chat-history-list" });
  setStyles(list, { overflowY: "auto", padding: "0 2px" });

  const renderList = (query = ""): void => {
    list.empty();
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const visible = props.threads.filter((thread) =>
      !normalizedQuery
      || thread.contextLabel.toLocaleLowerCase().includes(normalizedQuery)
      || thread.messages.some((message) => message.content.toLocaleLowerCase().includes(normalizedQuery))
    );
    if (visible.length === 0) {
      text(list, "没有匹配的历史对话。", "kf-muted");
      return;
    }
    let previousGroup = "";
    for (const thread of visible) {
      const group = relativeDateGroup(thread.updatedAt);
      if (group !== previousGroup) {
        const heading = list.createDiv({ text: group, cls: "kf-chat-history-group" });
        setStyles(heading, {
          color: "var(--text-muted)",
          fontSize: "12px",
          fontWeight: "650",
          padding: previousGroup ? "12px 6px 5px" : "5px 6px"
        });
        previousGroup = group;
      }
      const card = list.createDiv({ cls: "kf-chat-history-item" });
      setStyles(card, {
        alignItems: "center",
        borderBottom: "1px solid var(--background-modifier-border)",
        cursor: "pointer",
        display: "flex",
        gap: "8px",
        minHeight: "34px",
        padding: "7px 6px"
      });
      const icon = card.createSpan();
      setIcon(icon, "message-circle");
      setStyles(icon, { color: "var(--text-muted)", display: "inline-flex", flex: "0 0 auto" });
      const title = card.createSpan({ text: thread.contextLabel || "Untitled conversation" });
      setStyles(title, {
        color: "var(--text-normal)",
        fontSize: "13px",
        fontWeight: "400",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      });
      card.tabIndex = 0;
      card.addEventListener("click", () => props.onOpen(thread));
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") props.onOpen(thread);
      });
      attachPressFeedback(card as unknown as HTMLButtonElement);
    }
  };
  search.addEventListener("input", () => renderList(search.value));
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") props.onClose();
  });
  renderList();
  window.requestAnimationFrame(() => search.focus());
}

function relativeDateGroup(value: string): string {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  const minutes = Math.max(1, Math.floor((now.getTime() - date.getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
