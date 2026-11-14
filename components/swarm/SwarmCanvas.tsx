"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { TapeRow, TrendEvent, TrendSnapshot } from "@/lib/jetstream/protocol";
import { subscribeRenderPause, isRenderPaused } from "@/lib/jetstream/renderGate";
import { latestTrend, subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { Hydrator } from "@/src/trend/hydrate";
import { postTitlePlaceholder } from "@/src/trend/types";
import { SwarmController } from "./controller";
import { langName, oneLine } from "./labels";
import EventDrawer from "./EventDrawer";
import HudPill from "./HudPill";
import { publishRoster } from "./rosterBus";
import { renderSpreading } from "./spreading";

// 중앙 캔버스 — 이벤트 카드 + 스웜 커서(컨트롤러가 DOM을 직접 그림), '퍼지는 글' 탭,
// 카드 상세 서랍, 커서 미리보기. React 상태는 저빈도 UI(탭·열린 카드·미리보기)뿐이다.

type Tab = "events" | "spreading";

/** 커서 원점 rect 캐시 수명 — 10Hz 배치 하나를 덮을 만큼만 */
const ORIGIN_CACHE_MS = 80;

interface Preview {
  row: TapeRow;
  color: string;
  x: number;
  y: number;
}


export default function SwarmCanvas() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const spreadRef = useRef<HTMLOListElement>(null);
  const emptyRef = useRef<HTMLParagraphElement>(null);
  const [tab, setTab] = useState<Tab>("events");
  // 열린 카드 — null이면 서랍이 닫혀 있다. 트렌드 틱마다 같은 id의 최신 값으로 갈아 끼운다
  const [openEv, setOpenEv] = useState<TrendEvent | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  // 탭 전환을 마운트 effect 안의 컨트롤러에 전한다 — 카드 탭이 안 보이면 스웜을 멈춘다
  const tabRef = useRef<Tab>("events");
  const syncPauseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const board = boardRef.current;
    const spreadEl = spreadRef.current;
    if (viewport === null || board === null || spreadEl === null) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // 원점 기하 캐시 — 커서 하나 띄울 때마다 rect를 다시 재면 직전 커서의 DOM 쓰기와 맞물려
    // 강제 레이아웃이 행마다 난다. 한 배치(spawnRows·topUp) 안에서는 같은 값을 쓴다
    let geom: { s: DOMRect; v: DOMRect; scrollTop: number } | null = null;
    let geomAt = -Infinity;
    const originGeom = (): typeof geom => {
      const now = performance.now();
      if (now - geomAt < ORIGIN_CACHE_MS) return geom;
      geomAt = now;
      const src = document.querySelector<HTMLElement>("[data-swarm-origin]");
      geom =
        src === null || src.offsetParent === null
          ? null
          : { s: src.getBoundingClientRect(), v: viewport.getBoundingClientRect(), scrollTop: viewport.scrollTop };
      return geom;
    };
    const ctl = new SwarmController(
      viewport,
      board,
      {
        onRoster: publishRoster,
        onOpenCard: (ev) => {
          setOpenEv(ev);
          setPreview(null);
        },
        onOpenCursor: (row, color, x, y) => setPreview({ row, color, x, y }),
        // 데이터 레일 Tape의 맨 위 행들(새 글이 들어오는 자리)에서 집어 온다 — 보드 좌표로.
        // 레이어가 레일까지 덮으므로 x는 음수(레일 안)여도 보인다
        origin: () => {
          const g = originGeom();
          if (g === null) return null;
          const { s, v, scrollTop } = g;
          const x = s.left + s.width * (0.45 + Math.random() * 0.45);
          const y = s.top + 44 + Math.random() * Math.min(150, Math.max(20, s.height - 60));
          return { x: x - v.left, y: y - v.top + scrollTop };
        },
      },
      reduced,
      viewport.closest<HTMLElement>(".shell-body"),
    );
    board.dataset.reduced = String(reduced);
    const syncPause = (): void => {
      const away = tabRef.current !== "events";
      ctl.setPaused(isRenderPaused() || away);
      ctl.setLayerHidden(away);
    };
    syncPauseRef.current = syncPause;
    syncPause();
    const offPause = subscribeRenderPause(syncPause);

    // 퍼지는 글 본문 하이드레이션 — 메인 스레드 비동기, 실패 내성(src/trend/hydrate.ts)
    const fixture = new URLSearchParams(location.search).get("fixture") !== null;
    // 언마운트 뒤에 끝난 하이드레이션 tick이 destroy된 컨트롤러·상태를 건드리지 않게 막는다
    let alive = true;
    const hydrator = fixture
      ? null // 픽스처 URI는 실제 글이 아니다 — 네트워크를 타지 않는다
      : new Hydrator({ fetch: (u, i) => fetch(u, i), now: () => Date.now(), onUpdate: () => { if (alive) onHydrated(); } });
    // 엔진이 본문을 못 본 글 카드는 제목이 `Post <rkey>` — 하이드레이션된 본문으로 갈아 끼운다
    const withPostTitles = (trend: TrendSnapshot): TrendSnapshot => {
      if (hydrator === null) return trend;
      let changed = false;
      const events = trend.events.map((e) => {
        if (e.postUri === null || e.title !== postTitlePlaceholder(e.postUri)) return e;
        const text = oneLine(hydrator.get(e.postUri)?.text ?? "");
        if (text === "") return e;
        changed = true;
        return { ...e, title: text.slice(0, 80) };
      });
      return changed ? { ...trend, events } : trend;
    };
    const applyTrend = (raw: TrendSnapshot): void => {
      const trend = withPostTitles(raw);
      ctl.setTrend(trend);
      // 열린 카드는 최신 값으로
      setOpenEv((cur) => (cur === null ? cur : (trend.events.find((e) => e.id === cur.id) ?? cur)));
    };
    const onHydrated = (): void => {
      redrawSpreading();
      const t = latestTrend();
      if (t !== null) applyTrend(t);
    };
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
        applyTrend(s.trend);
        redrawSpreading();
        const active = s.trend.events.filter((e) => e.state !== "past").length;
        board.dataset.events = String(active);
        const empty = emptyRef.current;
        if (empty !== null) {
          empty.hidden = s.trend.events.length > 0;
          const lang = s.trend.lang;
          empty.textContent = s.trend.learning.active
            ? `Learning the baseline — ${s.trend.learning.minutes} of 10 min. After that, anything rising faster than its usual level gets drawn here as a card.`
            : lang !== null
              ? `Nothing in ${langName(lang)} is rising above its usual level right now. Cards show up here as soon as something does — or pick All languages.`
              : "Collecting what people are saying right now. In a few seconds, cursors leave the live feed on the left and start drawing cards.";
        }
        // 카드 제목이 걸린 글이 먼저 — want()는 상위 20개만 본다
        hydrator?.want([...s.trend.events.flatMap((e) => (e.postUri !== null ? [e.postUri] : [])), ...s.trend.spreading.map((p) => p.uri)]);
      }
      if (s.tapeRows.length > 0) ctl.spawnRows(s.tapeRows);
      if (s.pings.length > 0) ctl.pingEngagements(s.pings);
    });

    // 탭이 백그라운드면 rAF가 멈춘다 — 돌아오면 그동안 쌓인 건 버리고 이어간다(워커 집계는 계속)
    return () => {
      alive = false;
      syncPauseRef.current = null;
      unsub();
      offPause();
      window.clearInterval(hydTimer);
      ctl.destroy();
      delete (globalThis as Record<string, unknown>).__swarm;
    };
  }, []);

  useEffect(() => {
    tabRef.current = tab;
    syncPauseRef.current?.();
  }, [tab]);

  // 미리보기는 바깥 클릭·Esc로 닫는다
  const drawerOpen = openEv !== null;
  useEffect(() => {
    if (preview === null && !drawerOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setPreview(null);
        setOpenEv(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, drawerOpen]);

  // 탭 목록 화살표 이동 — 선택된 탭만 Tab 순서에 들어간다(roving tabIndex)
  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const order: Tab[] = ["events", "spreading"];
    const i = order.indexOf(tab);
    const next =
      e.key === "Home" ? order[0] : e.key === "End" ? order[order.length - 1] : order[(i + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  const ev = openEv;

  return (
    <section className="sw-canvas" aria-label="Trend canvas">
      <div className="sw-tabs" role="tablist" aria-label="View" onKeyDown={onTabKey}>
        <button type="button" role="tab" id="tab-events" aria-controls="panel-events" aria-selected={tab === "events"} tabIndex={tab === "events" ? 0 : -1} onClick={() => setTab("events")}>
          Trend cards
        </button>
        <button type="button" role="tab" id="tab-spreading" aria-controls="panel-spreading" aria-selected={tab === "spreading"} tabIndex={tab === "spreading" ? 0 : -1} onClick={() => setTab("spreading")}>
          Hot posts
        </button>
      </div>

      <div id="panel-events" role="tabpanel" aria-labelledby="tab-events" className="sw-viewport" ref={viewportRef} hidden={tab !== "events"}>
        <p className="sw-empty" ref={emptyRef}>
          Connecting to the stream…
        </p>
        <div className="sw-board" ref={boardRef} onClick={() => setPreview(null)} />
        {preview !== null && (
          <div
            className="sw-preview"
            role="dialog"
            aria-label="Post preview"
            style={{ transform: `translate3d(${Math.round(preview.x + 14)}px, ${Math.round(preview.y + 14)}px, 0)`, borderColor: preview.color }}
            onClick={(e) => e.stopPropagation()}
          >
            <b style={{ background: preview.color }}>{preview.row.tag}</b>
            <p>{preview.row.text || "(no text)"}</p>
            <div className="sw-preview-meta">
              <span>{preview.row.did}</span>
              {preview.row.rkey !== "" && preview.row.fullDid !== "" && (
                <a href={`https://bsky.app/profile/${preview.row.fullDid}/post/${preview.row.rkey}`} target="_blank" rel="noopener noreferrer">
                  View on bsky.app
                </a>
              )}
            </div>
          </div>
        )}
      </div>

      <HudPill />

      <div id="panel-spreading" role="tabpanel" aria-labelledby="tab-spreading" className="sw-spreading" hidden={tab !== "spreading"}>
        <p className="sp-note">Posts drawing the most likes and reposts in the last 5 minutes, ranked by volume and growth</p>
        <ol ref={spreadRef} aria-label="Hot posts" />
      </div>

      {ev !== null && <div className="sw-scrim" onClick={() => setOpenEv(null)} aria-hidden />}
      {ev !== null && <EventDrawer ev={ev} onClose={() => setOpenEv(null)} />}
    </section>
  );
}
