"use client";

import { useState, type ReactNode } from "react";
import Toolbar from "./Toolbar";

// 셸 — 툴바 + 왼쪽 데이터 레일(항상) + 중앙 캔버스 + 접는 진단 패널. 패널 열림만 React 상태(저빈도).
// ≤900px에선 CSS가 레일·패널을 숨긴다.
export default function Shell({ canvas, rail, inspector, overlay }: { canvas: ReactNode; rail: ReactNode; inspector: ReactNode; overlay: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="shell" data-panel={open ? "open" : "closed"}>
      <Toolbar panelOpen={open} onTogglePanel={() => setOpen((v) => !v)} />
      <div className="shell-body">
        <aside className="rail" aria-label="Live data">
          {rail}
        </aside>
        <main className="shell-canvas">{canvas}</main>
        <aside id="inspector" className="inspector" aria-label="Diagnostics" hidden={!open}>
          {inspector}
        </aside>
      </div>
      {overlay}
    </div>
  );
}
