// 스웜 컨트롤러 → 툴바 아바타 스택. 저빈도(2Hz) DOM 갱신용 단일 구독 채널.

export interface RosterEntry {
  tag: string;
  color: string;
}

type Listener = (list: RosterEntry[], total: number) => void;
const listeners = new Set<Listener>();

export function publishRoster(list: RosterEntry[], total: number): void {
  for (const l of listeners) l(list, total);
}

export function subscribeRoster(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
