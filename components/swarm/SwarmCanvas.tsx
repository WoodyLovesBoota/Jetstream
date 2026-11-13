"use client";

import { useEffect, useRef, useState } from "react";
import type { TapeRow, TrendEvent } from "@/lib/jetstream/protocol";
import { subscribeRenderPause, isRenderPaused } from "@/lib/jetstream/renderGate";
import { latestTrend, subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { Hydrator } from "@/src/trend/hydrate";
import { SwarmController } from "./controller";
import { cardColor } from "./cursors";
import HudPill from "./HudPill";
import { publishRoster } from "./rosterBus";
import { renderSpreading } from "./spreading";

// 중앙 캔버스 — 이벤트 카드 + 스웜 커서(컨트롤러가 DOM을 직접 그림), '퍼지는 글' 탭,
// 카드 상세 서랍, 커서 미리보기. React 상태는 저빈도 UI(탭·열린 카드·미리보기)뿐이다.

type Tab = "events" | "spreading";

interface Preview {
  row: TapeRow;
  color: string;
  x: number;
  y: number;
}

const LIFE_KO: Record<string, string> = { rising: "떠오름", peak: "정점", fading: "식는 중" };

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}초 전` : `${Math.round(s / 60)}분 전`;
}

export default function SwarmCanvas() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const spreadRef = useRef<HTMLOListElement>(null);
  const emptyRef = useRef<HTMLParagraphElement>(null);
  const [tab, setTab] = useState<Tab>("events");
  const [openId, setOpenId] = useState<number | null>(null);
  const [openEv, setOpenEv] = useState<TrendEvent | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const board = boardRef.current;
    const spreadEl = spreadRef.current;
    if (viewport === null || board === null || spreadEl === null) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctl = new SwarmController(
      viewport,
      board,
      {
        onRoster: publishRoster,
        onOpenCard: (ev) => {
          setOpenId(ev.id);
          setOpenEv(ev);
          setPreview(null);
        },
        onOpenCursor: (row, color, x, y) => setPreview({ row, color, x, y }),
        // 데이터 레일 Tape의 맨 위 행들(새 글이 들어오는 자리)에서 집어 온다 — 보드 좌표로.
        // 레이어가 레일까지 덮으므로 x는 음수(레일 안)여도 보인다
        origin: () => {
          const src = document.querySelector<HTMLElement>("[data-swarm-origin]");
          if (src === null || src.offsetParent === null) return null;
          const s = src.getBoundingClientRect();
          const v = viewport.getBoundingClientRect();
          const x = s.left + s.width * (0.45 + Math.random() * 0.45);
          const y = s.top + 44 + Math.random() * Math.min(150, Math.max(20, s.height - 60));
          return { x: x - v.left, y: y - v.top + viewport.scrollTop };
        },
      },
      reduced,
      viewport.closest<HTMLElement>(".shell-body"),
    );
    board.dataset.reduced = String(reduced);
    ctl.setPaused(isRenderPaused());
    const offPause = subscribeRenderPause(() => ctl.setPaused(isRenderPaused()));

    // 퍼지는 글 본문 하이드레이션 — 메인 스레드 비동기, 실패 내성(src/trend/hydrate.ts)
    const fixture = new URLSearchParams(location.search).get("fixture") !== null;
    const hydrator = fixture
      ? null // 픽스처 URI는 실제 글이 아니다 — 네트워크를 타지 않는다
      : new Hydrator({ fetch: (u, i) => fetch(u, i), now: () => Date.now(), onUpdate: () => redrawSpreading() });
    const colorOf = (id: number): number | null => latestTrend()?.events.find((e) => e.id === id)?.colorIdx ?? null;
    const redrawSpreading = (): void => {
      const t = latestTrend();
      if (t !== null) renderSpreading(spreadEl, t.spreading, hydrator, colorOf);
    };
    const hydTimer = window.setInterval(() => void hydrator?.tick(), 1_000);

    // e2e·디버그 관찰 핸들 — 프로덕션에서도 읽기 전용 통계만
    let lastStatus: unknown = null;
    (globalThis as Record<string, unknown>).__swarm = {
      stats: () => ctl.stats(),
      status: () => ({ trend: lastStatus, learning: latestTrend()?.learning ?? null }),
    };

    const unsub = subscribeStream((s) => {
      lastStatus = s.trendStatus;
      if (s.trend !== null) {
        ctl.setTrend(s.trend);
        redrawSpreading();
        const active = s.trend.events.filter((e) => e.state !== "past").length;
        board.dataset.events = String(active);
        const empty = emptyRef.current;
        if (empty !== null) {
          empty.hidden = s.trend.events.length > 0;
          empty.textContent = s.trend.learning.active
            ? `평소를 배우는 중입니다 — ${s.trend.learning.minutes}분 / 10분. 학습이 끝나면 평소보다 설명되지 않게 늘어나는 것이 여기 카드로 그려집니다.`
            : "지금 많이 나오는 말을 모으는 중입니다. 몇 초 뒤 커서가 왼쪽 새 글에서 출발해 카드를 그립니다.";
        }
        hydrator?.want([...s.trend.spreading.map((p) => p.uri), ...s.trend.events.flatMap((e) => (e.postUri !== null ? [e.postUri] : []))]);
        // 열린 카드는 최신 값으로
        setOpenEv((cur) => (cur === null ? cur : (s.trend?.events.find((e) => e.id === cur.id) ?? cur)));
      }
      if (s.tapeRows.length > 0) ctl.spawnRows(s.tapeRows);
      if (s.pings.length > 0) ctl.pingEngagements(s.pings);
    });

    // 탭이 백그라운드면 rAF가 멈춘다 — 돌아오면 그동안 쌓인 건 버리고 이어간다(워커 집계는 계속)
    return () => {
      unsub();
      offPause();
      window.clearInterval(hydTimer);
      ctl.destroy();
      delete (globalThis as Record<string, unknown>).__swarm;
    };
  }, []);

  // 미리보기는 바깥 클릭·Esc로 닫는다
  useEffect(() => {
    if (preview === null && openId === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setPreview(null);
        setOpenId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, openId]);

  const ev = openId !== null ? openEv : null;

  return (
    <section className="sw-canvas" aria-label="트렌드 캔버스">
      <div className="sw-tabs" role="tablist" aria-label="보기">
        <button type="button" role="tab" id="tab-events" aria-controls="panel-events" aria-selected={tab === "events"} onClick={() => setTab("events")}>
          트렌드 카드
        </button>
        <button type="button" role="tab" id="tab-spreading" aria-controls="panel-spreading" aria-selected={tab === "spreading"} onClick={() => setTab("spreading")}>
          반응 몰리는 글
        </button>
      </div>

      <div id="panel-events" role="tabpanel" aria-labelledby="tab-events" className="sw-viewport" ref={viewportRef} hidden={tab !== "events"}>
        <p className="sw-empty" ref={emptyRef}>
          스트림에 연결하는 중입니다…
        </p>
        <div className="sw-board" ref={boardRef} onClick={() => setPreview(null)} />
        {preview !== null && (
          <div
            className="sw-preview"
            role="dialog"
            aria-label="글 미리보기"
            style={{ transform: `translate3d(${Math.round(preview.x + 14)}px, ${Math.round(preview.y + 14)}px, 0)`, borderColor: preview.color }}
            onClick={(e) => e.stopPropagation()}
          >
            <b style={{ background: preview.color }}>{preview.row.tag}</b>
            <p>{preview.row.text || "(본문 없음)"}</p>
            <div className="sw-preview-meta">
              <span>{preview.row.did}</span>
              {preview.row.rkey !== "" && preview.row.fullDid !== "" && (
                <a href={`https://bsky.app/profile/${preview.row.fullDid}/post/${preview.row.rkey}`} target="_blank" rel="noopener noreferrer">
                  bsky.app에서 보기
                </a>
              )}
            </div>
          </div>
        )}
      </div>

      <HudPill />

      <div id="panel-spreading" role="tabpanel" aria-labelledby="tab-spreading" className="sw-spreading" hidden={tab !== "spreading"}>
        <p className="sp-note">5분 안에 좋아요·리포스트가 몰리는 글 — 많이 몰리고 빨리 늘어나는 순</p>
        <ol ref={spreadRef} aria-label="퍼지는 글 목록" />
      </div>

      {ev !== null && <div className="sw-scrim" onClick={() => setOpenId(null)} aria-hidden />}
      {ev !== null && (
        <aside className="sw-drawer" aria-label={`이벤트 상세: ${ev.title}`} style={{ ["--ev" as string]: cardColor(ev) }}>
          <header>
            <span className="sw-drawer-kind">
              {ev.state === "past" ? "지나간 트렌드" : ev.state === "watch" ? "관찰 중 · 아직 트렌드 판정 전" : `트렌드 · ${LIFE_KO[ev.lifecycle] ?? ev.lifecycle}`}
            </span>
            <h2>{ev.title}</h2>
            <button type="button" onClick={() => setOpenId(null)} aria-label="닫기">
              ×
            </button>
          </header>
          <dl className="sw-drawer-stats">
            <div>
              <dt>평소 대비</dt>
              <dd>
                <span className="sw-num">×{ev.stats.mult >= 10 ? Math.round(ev.stats.mult) : ev.stats.mult.toFixed(1)}</span>
              </dd>
            </div>
            <div>
              <dt>5분 작성자</dt>
              <dd>
                <span className="sw-num">{ev.stats.u}</span>명
              </dd>
            </div>
            <div>
              <dt>새로 합류</dt>
              <dd>
                <span className="sw-num">{Math.round(ev.stats.newRatio * 100)}</span>%
              </dd>
            </div>
            <div>
              <dt>점수</dt>
              <dd>
                <span className="sw-num">{ev.score.toFixed(1)}</span>
              </dd>
            </div>
            <div>
              <dt>처음 잡힌 시각</dt>
              <dd>
                <span className="sw-num">{new Date(ev.enteredAt).toTimeString().slice(0, 8)}</span>
              </dd>
            </div>
          </dl>
          <section>
            <h3>최근 15분</h3>
            <svg className="sw-drawer-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="최근 15분 언급 추이">
              <polyline
                points={ev.spark
                  .map((v, i) => `${((i / Math.max(1, ev.spark.length - 1)) * 100).toFixed(1)},${(28 - (v / Math.max(1, ...ev.spark)) * 26).toFixed(1)}`)
                  .join(" ")}
              />
            </svg>
            <div className="sw-drawer-axis">
              <span>
                −<span className="sw-num">15</span>분
              </span>
              <span>지금</span>
            </div>
          </section>
          <section>
            <h3>
              대표 글 <span className="sw-drawer-count sw-num">{ev.representativePosts.length}</span>
            </h3>
            {ev.representativePosts.length > 0 ? (
              <ul className="sw-drawer-posts">
                {ev.representativePosts.map((p) => (
                  <li key={`${p.did}/${p.rkey}`}>
                    <a href={p.url} target="_blank" rel="noopener noreferrer">
                      <p>{p.text || "(본문 없음)"}</p>
                      <span>{ago(p.timeMs)} · bsky.app</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sw-drawer-langs" style={{ padding: 0 }}>
                —
              </p>
            )}
          </section>
          {ev.related.length > 0 && (
            <section>
              <h3>관련 단어</h3>
              <ul className="sw-drawer-related">
                {ev.related.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3>링크</h3>
            {ev.link !== null ? (
              <a className="sw-drawer-link" href={`https://${ev.link.url}`} target="_blank" rel="noopener noreferrer">
                {ev.link.url}
              </a>
            ) : (
              <span className="sw-drawer-langs" style={{ padding: 0 }}>
                —
              </span>
            )}
          </section>
          {ev.langs.length > 0 && <p className="sw-drawer-langs">언어 {ev.langs.join(" · ")}</p>}
        </aside>
      )}
    </section>
  );
}
