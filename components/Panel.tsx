import type { ReactNode } from "react";
import styles from "./Panel.module.css";

type PanelProps = {
  name: string;
  note: string;
  className?: string;
  /** 머리줄 오른쪽에 얹는 패널 고유 계기(예: Pulse의 펜 리드아웃) */
  readouts?: ReactNode;
  children?: ReactNode;
};

export default function Panel({ name, note, className, readouts, children }: PanelProps) {
  return (
    <section className={`${styles.panel} ${className ?? ""}`} aria-label={name}>
      <header className={styles.head} data-readouts={readouts !== undefined}>
        <div className={styles.titles}>
          <h2 className={styles.name}>{name}</h2>
          <p className={styles.note}>{note}</p>
        </div>
        {readouts}
      </header>
      <div className={styles.body}>
        {children ?? <p className={styles.empty}>Stream not connected</p>}
      </div>
    </section>
  );
}
