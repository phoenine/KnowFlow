import { setIcon } from "obsidian";

export function section(parent: HTMLElement, className: string): HTMLElement {
  return setStyles(parent.createDiv({ cls: `kf-card ${className}` }), {
    backgroundColor: "var(--background-primary)",
    border: "1px solid color-mix(in srgb, var(--interactive-accent) 28%, var(--background-modifier-border))",
    borderRadius: "10px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "14px"
  });
}

export function row(parent: HTMLElement, className = ""): HTMLElement {
  return setStyles(parent.createDiv({ cls: `kf-row ${className}`.trim() }), {
    alignItems: "center",
    display: "flex",
    gap: "10px"
  });
}

export function iconSpan(parent: HTMLElement, icon: string): HTMLSpanElement {
  const span = parent.createSpan();
  setIcon(span, icon);
  return setStyles(span, {
    color: "var(--interactive-accent)",
    display: "inline-flex",
    flex: "0 0 auto"
  });
}

/**
 * The "icon + card title (+ optional trailing pill/button/status)" header
 * pattern repeated across every card in clipping-view.ts, article-detail-view.ts,
 * articles-overview-view.ts and sidebar-view.ts. Pass `trailing` to render a
 * pill, button or status element on the right side of the header row.
 */
export function cardHeader(
  parent: HTMLElement,
  icon: string,
  title: string,
  trailing?: (header: HTMLElement) => void
): HTMLElement {
  const header = row(parent);
  if (trailing) {
    setStyles(header, { justifyContent: "space-between" });
    const titleRow = row(header);
    setStyles(titleRow, { gap: "8px", minWidth: "0" });
    iconSpan(titleRow, icon);
    text(titleRow, title, "kf-card-title");
    trailing(header);
  } else {
    setStyles(header, { gap: "8px" });
    iconSpan(header, icon);
    text(header, title, "kf-card-title");
  }
  return header;
}

export function text(parent: HTMLElement, content: string, className = ""): HTMLElement {
  const el = parent.createDiv({ text: content, cls: className });
  if (className.includes("kf-brand-title")) {
    return setStyles(el, {
      color: "var(--text-normal)",
      fontSize: "18px",
      fontWeight: "700",
      lineHeight: "1.1"
    });
  }
  if (className.includes("kf-card-title")) {
    return setStyles(el, {
      color: "var(--text-normal)",
      flex: "1",
      fontSize: "15px",
      fontWeight: "650",
      lineHeight: "1.35"
    });
  }
  if (className.includes("kf-muted") || className.includes("kf-step")) {
    return setStyles(el, {
      color: "var(--text-muted)",
      fontSize: "13px",
      fontWeight: "450",
      lineHeight: "1.45"
    });
  }
  if (className.includes("kf-token-estimate")) {
    return setStyles(el, {
      color: "var(--text-muted)",
      fontSize: "12px",
      fontWeight: "500",
      lineHeight: "1.35"
    });
  }
  if (className.includes("kf-pill")) {
    return setStyles(el, {
      color: "var(--text-accent)",
      fontSize: "12px",
      fontWeight: "600"
    });
  }
  if (className.includes("kf-question-text")) {
    return setStyles(el, {
      color: "var(--text-normal)",
      fontSize: "13px",
      fontWeight: "500",
      lineHeight: "1.5",
      whiteSpace: "pre-wrap"
    });
  }
  if (className.includes("kf-answer-paragraph")) {
    return setStyles(el, {
      color: "var(--text-normal)",
      fontSize: "13px",
      fontWeight: "450",
      lineHeight: "1.6",
      whiteSpace: "pre-wrap"
    });
  }
  if (className.includes("kf-progress-value")) {
    return setStyles(el, {
      color: "var(--text-accent)",
      fontWeight: "600"
    });
  }
  if (className.includes("kf-progress-label")) {
    return setStyles(el, {
      color: "var(--text-normal)",
      fontWeight: "600"
    });
  }
  return el;
}

export function iconButton(parent: HTMLElement, label: string, icon: string, onClick: () => void): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "kf-icon-button", attr: { "aria-label": label, title: label } });
  setStyles(button, {
    alignItems: "center",
    backgroundColor: "var(--background-primary)",
    border: "1px solid color-mix(in srgb, var(--interactive-accent) 24%, var(--background-modifier-border))",
    borderRadius: "8px",
    color: "var(--text-muted)",
    cursor: "pointer",
    display: "inline-flex",
    height: "28px",
    justifyContent: "center",
    padding: "0",
    transition: "filter 120ms ease, opacity 120ms ease, transform 120ms ease",
    width: "28px"
  });
  setIcon(button, icon);
  attachPressFeedback(button);
  button.addEventListener("click", onClick);
  return button;
}

export function button(parent: HTMLElement, label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const el = parent.createEl("button", { text: label, cls: primary ? "kf-button kf-button-primary" : "kf-button" });
  setStyles(el, {
    alignItems: "center",
    backgroundColor: primary ? "var(--interactive-accent)" : "var(--background-primary)",
    border: primary ? "1px solid var(--interactive-accent)" : "1px solid color-mix(in srgb, var(--interactive-accent) 28%, var(--background-modifier-border))",
    borderRadius: "8px",
    color: primary ? "var(--text-on-accent)" : "var(--text-normal)",
    cursor: "pointer",
    display: "inline-flex",
    flex: "1",
    fontSize: "13px",
    fontWeight: "600",
    justifyContent: "center",
    minHeight: "34px",
    padding: "7px 10px",
    transition: "filter 120ms ease, opacity 120ms ease, transform 120ms ease"
  });
  attachPressFeedback(el);
  el.addEventListener("click", onClick);
  return el;
}

export function metric(parent: HTMLElement, label: string, value: string): HTMLElement {
  const el = setStyles(parent.createDiv({ cls: "kf-metric" }), {
    backgroundColor: "color-mix(in srgb, var(--interactive-accent) 5%, var(--background-secondary))",
    border: "1px solid color-mix(in srgb, var(--interactive-accent) 10%, transparent)",
    borderRadius: "7px",
    minWidth: "0",
    padding: "8px 9px"
  });
  setStyles(el.createDiv({ text: label, cls: "kf-metric-label" }), {
    color: "var(--text-muted)",
    fontSize: "10.5px",
    fontWeight: "500",
    lineHeight: "1.25",
    whiteSpace: "nowrap"
  });
  setStyles(el.createDiv({ text: value, cls: "kf-metric-value" }), {
    borderTop: "1px solid color-mix(in srgb, var(--interactive-accent) 12%, var(--background-modifier-border))",
    color: "var(--text-normal)",
    fontSize: "13px",
    fontWeight: "600",
    lineHeight: "1.25",
    marginTop: "5px",
    overflow: "hidden",
    paddingTop: "5px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  });
  return el;
}

export function applyMetricsLayout(el: HTMLElement): void {
  setStyles(el, {
    alignItems: "stretch",
    display: "grid",
    gap: "6px",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))"
  });
}

export function applyActionLayout(el: HTMLElement): void {
  setStyles(el, {
    alignItems: "center",
    display: "flex",
    gap: "10px"
  });
}

export function setStyles<T extends HTMLElement>(el: T, styles: Partial<CSSStyleDeclaration>): T {
  Object.assign(el.style, styles);
  return el;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

export function attachPressFeedback(button: HTMLButtonElement): void {
  button.addEventListener("pointerdown", () => {
    if (button.disabled) return;
    setStyles(button, {
      filter: "brightness(0.96)",
      transform: "scale(0.985)"
    });
  });
  const reset = () => {
    if (button.disabled) return;
    setStyles(button, {
      filter: "none",
      transform: "scale(1)"
    });
  };
  button.addEventListener("pointerup", reset);
  button.addEventListener("pointerleave", reset);
  button.addEventListener("click", () => {
    if (button.disabled) return;
    button.animate(
      [
        { transform: "scale(0.985)", filter: "brightness(0.96)" },
        { transform: "scale(1.01)", filter: "brightness(1.04)" },
        { transform: "scale(1)", filter: "brightness(1)" }
      ],
      { duration: 140, easing: "ease-out" }
    );
  });
}
