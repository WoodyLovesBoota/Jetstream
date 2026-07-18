import type { ReactNode } from "react";
import styles from "./Panel.module.css";

type PanelProps = {
  name: string;
  note: string;
  className?: string;
  children?: ReactNode;
};

export default function Panel({ name, note, className, children }: PanelProps) {
  return (
    <section className={`${styles.panel} ${className ?? ""}`} aria-label={name}>
      <header className={styles.head}>
        <h2 className={styles.name}>{name}</h2>
        <span className={styles.note}>{note}</span>
      </header>
      <div className={styles.body}>
        {children ?? <p className={styles.empty}>stream offline</p>}
      </div>
    </section>
  );
}
