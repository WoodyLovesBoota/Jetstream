// Helpers for direct DOM updates on the main thread — shared by the panels whose rAF loops touch
// textContent/dataset/attributes. All they do is keep the change guard that avoids reassigning the
// same value in one place.

export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setData(el: HTMLElement, key: string, value: string): void {
  if (el.dataset[key] !== value) el.dataset[key] = value;
}

export function setAttr(el: HTMLElement, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/**
 * Whether this is a single-character hotkey with no modifier keys. If an input field
 * (input/textarea/contentEditable) has focus, it is treated as typing and ignored — shared by
 * Hud ("m") and Tuner ("t").
 */
export function isPlainHotkey(e: KeyboardEvent, key: string): boolean {
  if (e.key !== key || e.metaKey || e.ctrlKey || e.altKey) return false;
  const t = e.target as HTMLElement | null;
  if (t !== null && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))
    return false;
  return true;
}
