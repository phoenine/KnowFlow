import { setIcon } from "obsidian";
import { iconButton, setStyles, text } from "./dom";

export function renderShell(root: HTMLElement, title: string, status: string, onBack?: () => void): HTMLElement {
  const header = root.createDiv({ cls: "kf-header" });
  setStyles(header, {
    alignItems: "center",
    backgroundColor: "var(--background-primary)",
    borderBottom: "1px solid color-mix(in srgb, var(--interactive-accent) 18%, var(--background-modifier-border))",
    display: "flex",
    justifyContent: "space-between",
    padding: "16px 18px"
  });
  const left = header.createDiv({ cls: "kf-header-left" });
  setStyles(left, {
    alignItems: "center",
    display: "flex",
    gap: "10px",
    minWidth: "0"
  });
  if (onBack) {
    iconButton(left, "Back", "arrow-left", onBack);
  }
  if (title) {
    setStyles(left.createDiv({ text: title, cls: "kf-title" }), {
      color: "var(--text-normal)",
      fontSize: "20px",
      fontWeight: "650"
    });
  }
  setStyles(header.createDiv({ text: status, cls: "kf-status" }), {
    color: "var(--text-accent)",
    fontSize: "12px",
    fontWeight: "600"
  });
  return setStyles(root.createDiv({ cls: "kf-content" }), {
    display: "flex",
    flex: "1",
    flexDirection: "column",
    gap: "14px",
    overflowY: "auto",
    padding: "18px"
  });
}

export function renderBrandShell(root: HTMLElement, subtitle: string): HTMLElement {
  const header = root.createDiv({ cls: "kf-header kf-clipping-header" });
  setStyles(header, {
    alignItems: "center",
    backgroundColor: "var(--background-primary)",
    borderBottom: "1px solid color-mix(in srgb, var(--interactive-accent) 18%, var(--background-modifier-border))",
    display: "flex",
    justifyContent: "space-between",
    padding: "16px 18px 16px 13px"
  });

  const brand = header.createDiv();
  setStyles(brand, {
    alignItems: "center",
    display: "flex",
    gap: "12px",
    minWidth: "0"
  });
  const logo = brand.createSpan();
  setIcon(logo, "brain-circuit");
  setStyles(logo, {
    color: "var(--interactive-accent)",
    display: "inline-flex",
    flex: "0 0 auto"
  });
  const copy = brand.createDiv();
  text(copy, "KnowFlow", "kf-brand-title");
  text(copy, subtitle, "kf-muted");

  return setStyles(root.createDiv({ cls: "kf-content" }), {
    display: "flex",
    flex: "1",
    flexDirection: "column",
    gap: "14px",
    overflowY: "auto",
    padding: "14px"
  });
}
