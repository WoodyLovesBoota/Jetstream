"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import type { GaugeKind, StreamSnapshot } from "@/lib/jetstream/protocol";
import { isRenderPaused } from "@/lib/jetstream/renderGate";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { setText } from "@/lib/dom";
import { TYPE_COLORS } from "@/lib/palette";
import styles from "./Gauges.module.css";

// 이벤트 타입별 게이지 스트립. React는 4개 셀의 마운트에만 쓰고, 이후 갱신은
// rAF 루프가 transform·textContent를 직접 만진다 — 데이터 경로 리렌더 금지(설계 §1.3).
//
// 셀 구성 (값은 전부 워커 실측 — GaugesSnapshot):
//  (a) 배경 채움: 진행 중 1초의 부분 카운트 / 최근 60초 p95. transform: scaleY만
//      만지므로 리플로우가 없다. 1초 경계에서 80ms 플러시(비움) 후 재충전.
//  (b) 큰 숫자: 3초 EMA rate — 워커 계산값을 그대로 표시.
//  (c) 델타: EMA vs 최근 1분 평균의 % 차이. |3%| 이내는 화살표 없이 "안정".

const KINDS: GaugeKind[] = ["post", "like", "repost", "follow"];

/** 1초 경계에서 채움을 비우는 플러시 시간(ms) */
const FLUSH_MS = 80;
/** 델타 절대값이 이 미만이면 방향 화살표 없이 "안정" */
const DELTA_STABLE_PCT = 3;

interface CellEls {
  fill: HTMLElement;
  value: HTMLElement;
  delta: HTMLElement;
}

/** 셀별 채움 상태 — 표시 중 스케일과 플러시 진행을 프레임 사이에 들고 간다 */
interface FillState {
  scale: number;
  flushFrom: number;
  flushAtMs: number;
}

/** EMA rate 표시 — 100 미만은 소수 1자리, 그 위는 정수(자리 요동 방지) */
function formatRate(ema: number): string {
  return ema >= 100 ? String(Math.round(ema)) : ema.toFixed(1);
}

export default function Gauges() {
  const stripRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null) return;

    const cells: CellEls[] = KINDS.map((k) => {
      const root = strip.querySelector(`[data-type="${k}"]`) as HTMLElement;
      return {
        fill: root.querySelector('[data-cell="fill"]') as HTMLElement,
        value: root.querySelector('[data-cell="value"]') as HTMLElement,
        delta: root.querySelector('[data-cell="delta"]') as HTMLElement,
      };
    });

    let snapshot: StreamSnapshot | null = null;
    const unsubscribe = subscribeStream((s) => {
      snapshot = s;
    });

    const fills: FillState[] = KINDS.map(() => ({
      scale: 0,
      flushFrom: 0,
      flushAtMs: Number.NEGATIVE_INFINITY,
    }));
    let lastSec = -1;
    let lastSnapshot: StreamSnapshot | null = null;

    let raf = requestAnimationFrame(function tick(now) {
      // Pause 중에는 채움·숫자 모두 얼린다 — 재개 시 최신 스냅샷으로 점프
      if (isRenderPaused()) {
        raf = requestAnimationFrame(tick);
        return;
      }

      const s = snapshot;
      if (s !== null) {
        const g = s.gauges;

        // 1초 경계 감지 — 채워진 만큼을 80ms에 비우고 새 초의 부분 카운트로 재충전.
        // 첫 스냅샷은 경계가 아니라 기준선이다.
        if (g.sec !== lastSec) {
          if (lastSec !== -1) {
            for (const f of fills) {
              f.flushFrom = f.scale;
              f.flushAtMs = now;
            }
          }
          lastSec = g.sec;
        }

        // 숫자·델타는 10Hz 스냅샷이 바뀔 때만 — 나머지 프레임은 참조 비교로 끝
        if (s !== lastSnapshot) {
          lastSnapshot = s;
          for (let i = 0; i < KINDS.length; i++) {
            const stat = g.stats[KINDS[i]];
            const cell = cells[i];
            setText(cell.value, formatRate(stat.ema));

            if (stat.avg60 <= 0) {
              // 1분 평균이 아직 없다 — 델타를 지어내지 않는다
              setText(cell.delta, "—");
              if (cell.delta.dataset.dir !== "flat") cell.delta.dataset.dir = "flat";
            } else {
              const pct = ((stat.ema - stat.avg60) / stat.avg60) * 100;
              const dir = Math.abs(pct) < DELTA_STABLE_PCT ? "flat" : pct > 0 ? "up" : "down";
              setText(
                cell.delta,
                dir === "flat"
                  ? "안정"
                  : `${dir === "up" ? "▲" : "▼"} ${Math.abs(pct).toFixed(0)}% vs 1m`,
              );
              if (cell.delta.dataset.dir !== dir) cell.delta.dataset.dir = dir;
            }
          }
        }

        // 채움은 매 프레임 — 플러시 애니메이션은 스냅샷 사이에서도 진행돼야 한다.
        // 수면은 translateY로 끌어올린다: next=1이면 translateY(0%)로 가득, next=0이면
        // translateY(100%)로 카드 아래로 밀려 비워진다. transform만 만지므로 리플로우가
        // 없다(§1.3) — 물탱크 파도(자식 원)도 수면을 따라 함께 움직인다.
        for (let i = 0; i < KINDS.length; i++) {
          const f = fills[i];
          const stat = g.stats[KINDS[i]];
          const target = Math.min(1, stat.partial / Math.max(stat.p95, 1));
          const flushT = (now - f.flushAtMs) / FLUSH_MS;
          const next = flushT < 1 ? f.flushFrom * (1 - flushT) : target;
          if (Math.abs(next - f.scale) > 0.001) {
            f.scale = next;
            cells[i].fill.style.transform = `translateY(${((1 - next) * 100).toFixed(2)}%)`;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, []);

  return (
    <section className={styles.strip} aria-label="Gauges" ref={stripRef}>
      {KINDS.map((k) => (
        <div
          key={k}
          className={styles.cell}
          data-type={k}
          style={{ "--type-color": TYPE_COLORS[k] } as CSSProperties}
        >
          {/* 물탱크 수면 — 보조 채널이다(수치는 큰 숫자가 이미 전달한다). rAF가
              translateY로 수위를 끌어올리고, 안쪽 두 원이 회전해 파도를 만든다. */}
          <div className={styles.water} data-cell="fill" aria-hidden="true">
            <span className={styles.waveA} />
            <span className={styles.waveB} />
          </div>
          <div className={styles.content}>
            <div className={styles.head}>
              <span className={styles.labelWrap}>
                <span className={styles.swatch} />
                <span className={styles.label}>{k}</span>
              </span>
              <span className={styles.delta} data-cell="delta" data-dir="flat">
                —
              </span>
            </div>
            <div className={styles.num}>
              <span className={styles.value} data-cell="value">
                —
              </span>
              <span className={styles.unit}>/s</span>
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}
