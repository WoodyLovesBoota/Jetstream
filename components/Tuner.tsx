"use client";

import { useEffect, useRef, useState } from "react";
import { SURGE_TUNING_DEFAULTS, type SurgeTuning } from "@/lib/jetstream/protocol";
import { sendSurgeTune, subscribeStream } from "@/lib/jetstream/useStreamWorker";
import { isPlainHotkey } from "@/lib/dom";
import styles from "./Tuner.module.css";

// Surge tuning panel — a hidden dev-mode-only panel. Toggled with the "t" key.
// Adjusted values go to the worker via postMessage(surgeTune) and are
// session-scoped (never persisted).
// It is a low-frequency control UI, so React state is fine here (the exception
// category in design §1.3).
// The "applied" line reports only the values the worker is actually using
// (surge.tuning from the snapshot).

interface FieldDef {
  key: keyof SurgeTuning;
  label: string;
  step: number;
  min: number;
}

const FIELDS: FieldDef[] = [
  { key: "alpha", label: "α (laplace, /min)", step: 0.5, min: 0.5 },
  { key: "minSupport", label: "min support (5m mentions)", step: 5, min: 0 },
  { key: "deadbandPct", label: "deadband (%)", step: 5, min: 0 },
  { key: "minDwellSec", label: "min dwell (s)", step: 5, min: 0 },
  { key: "enterMult", label: "enter threshold (×)", step: 0.1, min: 1 },
  { key: "exitMult", label: "exit threshold (×)", step: 0.1, min: 1 },
  { key: "resortSec", label: "resort interval (s)", step: 1, min: 1 },
];

export default function Tuner() {
  // The build-time constant guard must come **before** the hooks — put it after
  // and the "t" key listener gets registered in production too, and toggling
  // even opens a stream subscription while nothing is on screen (this actually
  // happened). It is a static import, so the code itself stays in the bundle —
  // what disappears is the execution, not the bytes.
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
    // While open, keep showing the values the worker actually applied — if they
    // diverge from the input (clamping and such), that fact has to be visible.
    // It is 10Hz text, so update the ref directly.
    return subscribeStream((s) => {
      const t = s.surge.tuning;
      if (!initialized.current) {
        // Only on the first open, seed the inputs from the worker's current values
        initialized.current = true;
        setValues({ ...t });
      }
      const el = appliedRef.current;
      if (el !== null) {
        const text =
          `α ${t.alpha} · support ${t.minSupport} · band ${t.deadbandPct}%` +
          ` · dwell ${t.minDwellSec}s · enter ×${t.enterMult.toFixed(1)}` +
          ` · exit ×${t.exitMult.toFixed(1)} · interval ${t.resortSec}s`;
        if (el.textContent !== text) el.textContent = text;
      }
    });
  }, [open]);

  // A build-time constant, so this whole component vanishes from the production bundle
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
        <span className={styles.hint}>press t to close · session only</span>
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
