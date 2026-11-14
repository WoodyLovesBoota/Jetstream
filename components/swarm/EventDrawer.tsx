"use client";

import { useEffect, useRef } from "react";
import type { TrendEvent } from "@/lib/jetstream/protocol";
import { cardColor } from "./cursors";
import { capitalize, fmtMult, sparkPoints, stateLabel } from "./labels";

// 카드 상세 서랍 — 카드를 열면 뜨고(마운트) 닫으면 사라진다. 열려 있는 동안 ev는 트렌드 틱마다 최신 값으로 바뀐다.

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

export default function EventDrawer({ ev, onClose }: { ev: TrendEvent; onClose: () => void }) {
  // 열리면 닫기 버튼으로 포커스를 옮기고, 닫히면 열기 전 자리(카드)로 되돌린다
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      if (back !== null && back.isConnected) back.focus();
    };
  }, []);

  return (
  <aside className="sw-drawer" role="dialog" aria-modal="true" aria-label={`Event details: ${ev.title}`} style={{ ["--ev" as string]: cardColor(ev) }}>
    <header>
      <span className="sw-drawer-kind">
        {ev.state === "active" ? `Trend · ${capitalize(stateLabel(ev))}` : ev.state === "watch" ? "Watching · not a trend yet" : capitalize(stateLabel(ev))}
      </span>
      <h2>{ev.title}</h2>
      <button type="button" ref={closeRef} onClick={() => onClose()} aria-label="Close">
        ×
      </button>
    </header>
    <dl className="sw-drawer-stats">
      <div>
        <dt>Vs. usual</dt>
        <dd>
          <span className="sw-num">×{fmtMult(ev.stats.mult)}</span>
        </dd>
      </div>
      <div>
        <dt>Authors (5m)</dt>
        <dd>
          <span className="sw-num">{ev.stats.u}</span>
        </dd>
      </div>
      <div>
        <dt>Newcomers</dt>
        <dd>
          <span className="sw-num">{Math.round(ev.stats.newRatio * 100)}</span>%
        </dd>
      </div>
      <div>
        <dt>Score</dt>
        <dd>
          <span className="sw-num">{ev.score.toFixed(1)}</span>
        </dd>
      </div>
      <div>
        <dt>First seen</dt>
        <dd>
          <span className="sw-num">{new Date(ev.enteredAt).toTimeString().slice(0, 8)}</span>
        </dd>
      </div>
    </dl>
    <section>
      <h3>Last 15 minutes</h3>
      <svg className="sw-drawer-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Mentions over the last 15 minutes">
        <polyline
          points={sparkPoints(ev.spark, 100, 28, 26)}
        />
      </svg>
      <div className="sw-drawer-axis">
        <span>
          −<span className="sw-num">15</span>m
        </span>
        <span>now</span>
      </div>
    </section>
    <section>
      <h3>
        Top posts <span className="sw-drawer-count sw-num">{ev.representativePosts.length}</span>
      </h3>
      {ev.representativePosts.length > 0 ? (
        <ul className="sw-drawer-posts">
          {ev.representativePosts.map((p) => (
            <li key={`${p.did}/${p.rkey}`}>
              <a href={p.url} target="_blank" rel="noopener noreferrer">
                <p>{p.text || "(no text)"}</p>
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
        <h3>Related</h3>
        <ul className="sw-drawer-related">
          {ev.related.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>
    )}
    <section>
      <h3>Link</h3>
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
    {ev.langs.length > 0 && <p className="sw-drawer-langs">Languages {ev.langs.join(" · ")}</p>}
  </aside>
  );
}
