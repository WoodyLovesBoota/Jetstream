"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TAPE_MAX_ROWS, type StreamSnapshot, type TapeRow } from "@/lib/jetstream/protocol";
import { isRenderPaused } from "@/lib/jetstream/renderGate";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { setText } from "@/lib/dom";
import styles from "./Tape.module.css";

// Tape는 워커가 이미 목표 append율(초당 15행)로 down-sample한 결과만 받는다.
// TanStack Virtual이 리스트 상태 갱신마다 리렌더를 요구하므로(그 자체가 실제
// DOM 노드 수를 뷰포트+overscan 크기로 고정하는 장치), 다른 패널과 달리 이
// 컴포넌트만 rows를 React state로 들고 있다 — append 빈도가 낮아(≤10Hz 스냅샷
// 배치) 설계 §1.3의 "데이터 경로 리렌더 금지"가 노리는 초당 수천 건 리렌더와는
// 무관하다. 상태줄(showing/sampled/skipped)은 그 원칙대로 ref+textContent로 갱신.

/** 세로 테이프 행: 메타 한 줄 + 본문 2줄 말줄임 — Tape.module.css의 .row와 맞물린 값 */
const ROW_HEIGHT = 56;
/** 이 거리(px) 안이면 "꼭대기"로 간주 — 프로그램적 스크롤도 여기 걸려야 자동스크롤이 안 끊긴다 */
const TOP_THRESHOLD_PX = 48;

interface Row extends TapeRow {
  id: number;
}

function formatTimeUs(timeUs: number): string {
  const d = new Date(timeUs / 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export default function Tape() {
  const [rows, setRows] = useState<Row[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollRef = useRef(true);
  const nextId = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLSpanElement | null>(null);
  /** 직전 렌더 이후 위쪽에 끼워 넣은 행 수 — 수동 스크롤 중 읽던 위치를 붙잡아 두는 데 쓴다 */
  const prependedRef = useRef(0);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  useEffect(() => {
    return subscribeStream((snapshot: StreamSnapshot) => {
      // Pause 중에는 이 배치를 통째로 버린다. 쌓아뒀다 재개 시 쏟아내면 그게 바로
      // "밀린 프레임 따라 그리기"라, 정지가 길수록 재개가 무거워진다 — 여기서 버려야
      // 재개 비용이 정지 길이와 무관해진다. 버린 규모는 HUD의 buffering 카운터가 센다.
      if (isRenderPaused()) return;

      const t = snapshot.tapeStats;
      if (statusRef.current) {
        setText(
          statusRef.current,
          `showing 1 in ${t.strideN} · sampled ${t.sampledPerSec}/s · skipped ${t.skippedPerSec}/s`,
        );
      }

      if (snapshot.tapeRows.length === 0) return;
      // 최신이 위 — 배치 안에서도 시간 역순이 되도록 뒤집어서 앞에 붙인다.
      // id 발급과 카운트는 updater 밖에서 한다: StrictMode가 updater를 두 번 호출하므로
      // 그 안에서 ref를 건드리면 보정량이 두 배로 부풀어 스크롤이 미끄러진다.
      const incoming = snapshot.tapeRows.map((r) => ({ ...r, id: nextId.current++ })).reverse();
      prependedRef.current += incoming.length;
      setRows((prev) => {
        const merged = incoming.concat(prev);
        // 링버퍼: 상한을 넘으면 오래된 행(=아래쪽)부터 폐기 — 이미 화면에 보여준 행이라 조용한 손실이 아니다
        if (merged.length > TAPE_MAX_ROWS) merged.length = TAPE_MAX_ROWS;
        return merged;
      });
    });
  }, []);

  useLayoutEffect(() => {
    const prepended = prependedRef.current;
    prependedRef.current = 0;
    if (rows.length === 0) return;
    if (autoScrollRef.current) {
      rowVirtualizer.scrollToIndex(0, { align: "start" });
    } else if (prepended > 0 && scrollRef.current !== null) {
      // 위쪽에 행이 끼어들면 보고 있던 행이 그만큼 아래로 밀린다 — 스크롤로 상쇄해 제자리에 붙잡는다
      scrollRef.current.scrollTop += prepended * ROW_HEIGHT;
    }
  }, [rows, rowVirtualizer]);

  function handleScroll() {
    const el = scrollRef.current;
    if (el === null) return;
    const atTop = el.scrollTop < TOP_THRESHOLD_PX;
    if (atTop !== autoScrollRef.current) {
      autoScrollRef.current = atTop;
      setAutoScroll(atTop);
    }
  }

  function jumpToLive() {
    autoScrollRef.current = true;
    setAutoScroll(true);
    if (rows.length > 0) {
      rowVirtualizer.scrollToIndex(0, { align: "start" });
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.statusBar}>
        <span ref={statusRef} className={styles.status}>
          showing 1 in 1 · sampled 0/s · skipped 0/s
        </span>
        {!autoScroll && (
          <button type="button" className={styles.jumpBtn} onClick={jumpToLive}>
            jump to live
          </button>
        )}
      </div>
      {/* data-rows: 메인 스레드 테이프 링의 현재 행 수 — TAPE_MAX_ROWS(2000) 상한이
          실제로 멈추는지 검증하는 관측점. 렌더 시점에 이미 있는 값이라 비용 없음. */}
      <div
        className={styles.scrollArea}
        ref={scrollRef}
        onScroll={handleScroll}
        data-rows={rows.length}
      >
        {rows.length === 0 ? (
          <p className={styles.empty}>awaiting samples…</p>
        ) : (
          <div className={styles.spacer} style={{ height: rowVirtualizer.getTotalSize() }}>
            {rowVirtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              return (
                <div
                  key={row.id}
                  className={styles.row}
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  <div className={styles.meta}>
                    <span className={styles.time}>{formatTimeUs(row.timeUs)}</span>
                    <span className={styles.did}>{row.did}</span>
                    <span className={styles.langs}>{row.langs.join(",") || "—"}</span>
                  </div>
                  <p className={styles.text}>{row.text}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
