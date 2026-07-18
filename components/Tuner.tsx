"use client";

import { useEffect, useRef, useState } from "react";
import { SURGE_TUNING_DEFAULTS, type SurgeTuning } from "@/lib/jetstream/protocol";
import { sendSurgeTune, subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { isPlainHotkey } from "@/lib/dom";
import styles from "./Tuner.module.css";

// Surge 튜닝 패널 — 개발 모드 전용 숨김 패널. 키보드 "t"로 토글한다.
// 조절값은 postMessage(surgeTune)로 워커에 가고 세션 한정이다(저장 안 함).
// 저빈도 컨트롤 UI라 React 상태를 써도 된다(설계 §1.3의 예외 범주).
// "적용" 줄은 워커가 실제로 쓰고 있는 값(스냅샷의 surge.tuning)만 말한다.

interface FieldDef {
  key: keyof SurgeTuning;
  label: string;
  step: number;
  min: number;
}

const FIELDS: FieldDef[] = [
  { key: "alpha", label: "α (라플라스, /분)", step: 0.5, min: 0.5 },
  { key: "minSupport", label: "최소 지지 (5분 언급)", step: 5, min: 0 },
  { key: "deadbandPct", label: "데드밴드 (%)", step: 5, min: 0 },
  { key: "minDwellSec", label: "최소 체류 (초)", step: 5, min: 0 },
  { key: "enterMult", label: "진입 문턱 (×)", step: 0.1, min: 1 },
  { key: "exitMult", label: "퇴출 문턱 (×)", step: 0.1, min: 1 },
  { key: "resortSec", label: "재정렬 주기 (초)", step: 1, min: 1 },
];

export default function Tuner() {
  // 빌드 타임 상수 가드는 훅 **앞**이어야 한다 — 뒤에 두면 프로덕션에서도 "t" 키
  // 리스너가 등록되고, 토글 시 화면에 없는 채로 스트림 구독까지 걸린다(실제로 그랬다).
  // 정적 import라 코드 자체는 번들에 남는다 — 사라지는 것은 실행이지 바이트가 아니다.
  if (process.env.NODE_ENV === "production") return null;
  return <TunerPanel />;
}

function TunerPanel() {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<SurgeTuning>({ ...SURGE_TUNING_DEFAULTS });
  const appliedRef = useRef<HTMLParagraphElement | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPlainHotkey(e, "t")) return;
      setOpen((prev) => !prev);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    // 열려 있는 동안 워커의 실제 적용값을 계속 보여준다 — 입력값과 어긋나면
    // (클램프 등) 그 사실이 눈에 보여야 한다. 10Hz 텍스트라 ref 직접 갱신.
    return subscribeStream((s) => {
      const t = s.surge.tuning;
      if (!initialized.current) {
        // 처음 열 때 한 번만 워커의 현재값으로 입력을 맞춘다
        initialized.current = true;
        setValues({ ...t });
      }
      const el = appliedRef.current;
      if (el !== null) {
        const text =
          `α ${t.alpha} · 지지 ${t.minSupport} · 밴드 ${t.deadbandPct}%` +
          ` · 체류 ${t.minDwellSec}s · 진입 ×${t.enterMult.toFixed(1)}` +
          ` · 퇴출 ×${t.exitMult.toFixed(1)} · 주기 ${t.resortSec}s`;
        if (el.textContent !== text) el.textContent = text;
      }
    });
  }, [open]);

  // 빌드 타임 상수라 프로덕션 번들에서는 이 컴포넌트가 통째로 사라진다
  if (process.env.NODE_ENV === "production") return null;
  if (!open) return null;

  function update(key: keyof SurgeTuning, raw: string): void {
    const num = Number(raw);
    if (!Number.isFinite(num)) return;
    setValues((prev) => ({ ...prev, [key]: num }));
    sendSurgeTune({ [key]: num });
  }

  return (
    <aside className={styles.tuner} aria-label="Surge tuner" data-open="true">
      <div className={styles.head}>
        <span className={styles.title}>SURGE TUNER</span>
        <span className={styles.hint}>t 키로 닫기 · 세션 한정</span>
      </div>
      <div className={styles.fields}>
        {FIELDS.map((f) => (
          <label key={f.key} className={styles.field}>
            <span className={styles.label}>{f.label}</span>
            <input
              className={styles.input}
              type="number"
              step={f.step}
              min={f.min}
              value={values[f.key]}
              onChange={(e) => update(f.key, e.target.value)}
            />
          </label>
        ))}
      </div>
      <p className={styles.applied} ref={appliedRef}>
        —
      </p>
    </aside>
  );
}
