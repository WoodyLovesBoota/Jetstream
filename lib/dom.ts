// 메인 스레드 DOM 직접 갱신 헬퍼 — rAF 루프가 textContent·dataset·속성을 만지는
// 패널들이 공유한다. 같은 값 재대입을 막는 변경 가드를 한 곳에 두는 것이 전부다.

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
 * 수식키 없는 단일 문자 단축키인지. 입력 필드(input/textarea/contentEditable)에
 * 포커스가 있으면 타이핑으로 취급해 무시한다 — Hud("m")·Tuner("t")가 공유한다.
 */
export function isPlainHotkey(e: KeyboardEvent, key: string): boolean {
  if (e.key !== key || e.metaKey || e.ctrlKey || e.altKey) return false;
  const t = e.target as HTMLElement | null;
  if (t !== null && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))
    return false;
  return true;
}
