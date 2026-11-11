// '퍼지는 글' 탭 렌더 — 5초 트렌드 스냅샷과 하이드레이션 결과로 목록 DOM을 다시 그린다.
// 사용자 문자열은 전부 textContent로만 넣는다.

import type { SpreadingPost } from "@/lib/jetstream/protocol";
import type { Hydrator } from "@/src/trend/hydrate";
import { eventColor } from "./cursors";

const LIFE_KO: Record<string, string> = { rising: "떠오름", peak: "정점", fading: "식는 중" };

function shortUri(uri: string): string {
  const m = /^at:\/\/did:([^:]+):([^/]+)\/app\.bsky\.feed\.post\/(.+)$/.exec(uri);
  return m === null ? uri : `${m[2].slice(0, 6)}…/${m[3]}`;
}

export function renderSpreading(
  list: HTMLOListElement,
  posts: readonly SpreadingPost[],
  hydrator: Hydrator | null,
  colorOf: (eventId: number) => number | null,
): void {
  if (posts.length === 0) {
    const li = document.createElement("li");
    li.className = "sp-empty";
    li.textContent = "아직 5분 안에 좋아요·리포스트가 몰리는 글이 없습니다";
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...posts.map((p, i) => {
      const hyd = hydrator?.get(p.uri);
      const li = document.createElement("li");
      li.className = "sp-row";
      li.dataset.uri = p.uri;
      li.dataset.life = p.lifecycle;
      const rank = document.createElement("span");
      rank.className = "sp-rank";
      rank.textContent = String(i + 1);
      const body = document.createElement("div");
      body.className = "sp-body";
      const text = document.createElement("p");
      text.className = "sp-text";
      text.textContent = hyd?.text || p.text || "본문을 불러오지 못했습니다 — 원문 링크로 확인하세요";
      if (hyd === undefined && p.text === null) text.dataset.missing = "true";
      const meta = document.createElement("div");
      meta.className = "sp-meta";
      const who = document.createElement("span");
      who.textContent = hyd !== undefined && hyd.handle !== "" ? `@${hyd.handle}` : shortUri(p.uri);
      const nums = document.createElement("span");
      nums.textContent = `5분 ${p.p5}명 · 30분 ${p.p30}명 · ${LIFE_KO[p.lifecycle]}`;
      meta.append(who, nums);
      if (p.eventId !== null) {
        const ci = colorOf(p.eventId);
        if (ci !== null) {
          const dot = document.createElement("i");
          dot.className = "sp-dot";
          dot.style.background = eventColor(ci);
          dot.title = "이벤트에 속한 글";
          meta.prepend(dot);
        }
      }
      body.append(text, meta);
      li.append(rank, body);
      if (p.url !== null) {
        const a = document.createElement("a");
        a.className = "sp-link";
        a.href = p.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "원문";
        li.append(a);
      }
      return li;
    }),
  );
}
