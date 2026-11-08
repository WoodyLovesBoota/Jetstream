"use client";

import { useEffect, useRef } from "react";
import {
  MIX_TOP_N,
  MIX_WINDOW_SEC,
  type SecondBucket,
  type StreamSnapshot,
} from "@/lib/jetstream/protocol";
import { isRenderPaused } from "@/lib/jetstream/renderGate";
import { subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { setAttr, setText } from "@/lib/dom";
import styles from "./Mix.module.css";

// Mix는 React를 고정 MIX_TOP_N+1개 막대 행의 마운트에만 쓴다. 이후 갱신은 rAF 루프가
// textContent·style.width를 직접 만진다 — 데이터 경로 리렌더 금지(설계 §1.3).
//
// 집계는 워커가 이미 1초 버킷에 넣어둔 langs/noLangs를 최근 MIX_WINDOW_SEC개만큼
// 훑어 합산하는 것이 전부다. 별도 파이프라인도, 스냅샷 전용 필드도 없다.

/** 상위 언어 + other 잔여 한 줄 */
const ROW_COUNT = MIX_TOP_N + 1;
const OTHER_ROW = MIX_TOP_N;

interface RowEls {
  root: HTMLLIElement;
  label: HTMLElement;
  fill: HTMLElement;
  pct: HTMLElement;
}

interface Slice {
  lang: string;
  count: number;
}

function formatPct(count: number, total: number): string {
  return `${((count / total) * 100).toFixed(1)}%`;
}

/**
 * 최근 MIX_WINDOW_SEC개 버킷의 언어 카운트를 합산한다. 버킷 배열은 항상 오래된 것 →
 * 최신 순이고 마지막 칸은 진행 중인 부분 카운트다 — 그대로 포함해야 라이브로 움직인다.
 */
function collect(
  buckets: SecondBucket[],
  into: Map<string, number>,
): { total: number; noLangs: number } {
  into.clear();
  let total = 0;
  let noLangs = 0;
  for (let i = Math.max(0, buckets.length - MIX_WINDOW_SEC); i < buckets.length; i++) {
    const b = buckets[i];
    noLangs += b.noLangs;
    for (const lang in b.langs) {
      const v = b.langs[lang];
      into.set(lang, (into.get(lang) ?? 0) + v);
      total += v;
    }
  }
  return { total, noLangs };
}

/**
 * 상위 MIX_TOP_N개 + 잔여 합산 other. other는 뺄셈으로 구하므로 화면에 세운 막대의
 * 합은 항상 total과 정확히 같다 — 완료 기준(합계 = 표본 수)이 성립하는 지점.
 *
 * 언어 수가 MIX_TOP_N 이하면 상위가 곧 전부라 잔여가 0이고 other 줄은 생기지 않는다.
 * 따라서 other가 붙는 경우 그 자리는 언제나 마지막 칸(OTHER_ROW)이다.
 */
function rank(counts: Map<string, number>, total: number): Slice[] {
  const sorted: Slice[] = [];
  for (const [lang, count] of counts) sorted.push({ lang, count });
  // 동률일 때 코드순으로 고정 — 안 그러면 같은 값끼리 매 틱 자리를 바꿔 깜빡인다
  sorted.sort((a, b) => b.count - a.count || (a.lang < b.lang ? -1 : 1));

  const top = sorted.slice(0, MIX_TOP_N);
  let shown = 0;
  for (const s of top) shown += s.count;
  const other = total - shown;
  if (other > 0) top.push({ lang: "other", count: other });
  return top;
}

export default function Mix() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const totalRef = useRef<HTMLSpanElement | null>(null);
  const langsRef = useRef<HTMLSpanElement | null>(null);
  const noLangRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const list = listRef.current;
    const totalEl = totalRef.current;
    const langsEl = langsRef.current;
    const noLangEl = noLangRef.current;
    if (root === null || list === null || totalEl === null || langsEl === null || noLangEl === null)
      return;

    const rows: RowEls[] = [];
    for (const li of list.querySelectorAll<HTMLLIElement>("li")) {
      rows.push({
        root: li,
        label: li.querySelector('[data-cell="label"]') as HTMLElement,
        fill: li.querySelector('[data-cell="fill"]') as HTMLElement,
        pct: li.querySelector('[data-cell="pct"]') as HTMLElement,
      });
    }

    // "en" → "English". 미지원 환경이나 모르는 코드면 코드를 그대로 보여준다.
    let displayNames: Intl.DisplayNames | null = null;
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    } catch {
      displayNames = null;
    }
    const nameCache = new Map<string, string>();
    function nameOf(lang: string): string {
      let name = nameCache.get(lang);
      if (name === undefined) {
        name = displayNames?.of(lang) ?? lang;
        nameCache.set(lang, name);
      }
      return name;
    }

    let snapshot: StreamSnapshot | null = null;
    const unsubscribe = subscribeStream((s) => {
      snapshot = s;
    });

    // 틱마다 재사용 — 10Hz로 Map을 새로 만들지 않는다
    const counts = new Map<string, number>();

    function paint(s: StreamSnapshot): void {
      const { total, noLangs } = collect(s.buckets, counts);
      const empty = total === 0;
      if (root!.dataset.empty !== String(empty)) root!.dataset.empty = String(empty);

      setText(totalEl!, `게시물 ${total.toLocaleString("en-US")}건`);
      setText(langsEl!, `${counts.size.toLocaleString("en-US")}개 언어`);
      setText(noLangEl!, `언어 표기 없음 ${noLangs.toLocaleString("en-US")}건`);
      // 표본 수를 DOM에도 실어둔다 — 막대 합계와의 일치를 밖에서 검산할 수 있게
      setAttr(root!, "data-total", String(total));

      if (empty) {
        for (const row of rows) {
          if (row.root.dataset.filled !== "false") row.root.dataset.filled = "false";
        }
        return;
      }

      const slices = rank(counts, total);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const slice = slices[i];
        if (slice === undefined) {
          if (row.root.dataset.filled !== "false") row.root.dataset.filled = "false";
          continue;
        }

        row.root.dataset.filled = "true";
        row.root.dataset.lang = slice.lang;
        setAttr(row.root, "data-count", String(slice.count));
        setText(row.label, slice.lang === "other" ? "기타" : slice.lang);
        setText(row.pct, formatPct(slice.count, total));

        // 막대 길이 = 전체 표본 대비 점유율. %와 같은 수를 말한다.
        const width = `${((slice.count / total) * 100).toFixed(2)}%`;
        if (row.fill.style.width !== width) row.fill.style.width = width;

        const posts = `${slice.count.toLocaleString("en-US")} posts`;
        setAttr(
          row.root,
          "title",
          i === OTHER_ROW
            ? `${(counts.size - MIX_TOP_N).toLocaleString("en-US")} more languages · ${posts}`
            : `${nameOf(slice.lang)} · ${posts}`,
        );
      }
    }

    let lastSnapshot: StreamSnapshot | null = null;
    let raf = requestAnimationFrame(function tick() {
      // Pause 중에는 페인트를 건너뛴다 — 재개 시 최신 스냅샷 한 장으로 점프한다
      if (isRenderPaused()) {
        raf = requestAnimationFrame(tick);
        return;
      }

      // 스냅샷은 10Hz — 그 외 프레임은 참조 비교 한 번으로 끝난다
      if (snapshot !== lastSnapshot && snapshot !== null) {
        lastSnapshot = snapshot;
        paint(snapshot);
      }
      raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, []);

  return (
    <div className={styles.root} ref={rootRef} data-empty="true" data-total="0">
      <p className={styles.status}>
        <span ref={totalRef}>게시물 0건</span>
        <span ref={langsRef}>0개 언어</span>
        <span ref={noLangRef}>언어 표기 없음 0건</span>
      </p>
      <div className={styles.listWrap}>
        <ul className={styles.list} ref={listRef}>
          {Array.from({ length: ROW_COUNT }, (_, i) => (
            <li key={i} className={styles.row} data-filled="false">
              <span className={styles.label} data-cell="label" />
              {/* 막대는 보조 채널 — 수치는 오른쪽 %가 이미 전달한다 */}
              <span className={styles.track} aria-hidden="true">
                <span className={styles.fill} data-cell="fill" style={{ width: "0%" }} />
              </span>
              <span className={styles.pct} data-cell="pct" />
            </li>
          ))}
        </ul>
        <p className={styles.empty}>게시물을 기다리는 중</p>
      </div>
    </div>
  );
}
