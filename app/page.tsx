import DeckStatus from "@/components/DeckStatus";
import Gauges from "@/components/Gauges";
import Header from "@/components/Header";
import Tuner from "@/components/Tuner";
import Hud from "@/components/Hud";
import Mix from "@/components/Mix";
import Panel from "@/components/Panel";
import Pulse from "@/components/Pulse";
import Surge from "@/components/Surge";
import Tape from "@/components/Tape";
import styles from "./page.module.css";

// Layout (top → bottom): header / per-type gauge strip / full-width throughput band (Pulse) /
// main grid — 62% left for Surge (the lead), Tape · Mix · HUD in the 38% right column.

export default function Home() {
  return (
    <div className={styles.deck}>
      <Header />
      <Gauges />
      <Panel name="Pulse" note="throughput · events/sec" className={styles.pulse}>
        <Pulse />
      </Panel>
      <main className={styles.grid}>
        <Panel name="Surge" note="token trends · burst ×" className={styles.surge}>
          <Surge />
        </Panel>
        <div className={styles.side}>
          <Panel name="Tape" note="app.bsky.feed.post sample" className={styles.tape}>
            <Tape />
          </Panel>
          <Panel name="Mix" note="language share · 60s" className={styles.mix}>
            <Mix />
          </Panel>
          <Hud />
        </div>
      </main>
      {/* Ambient layer that covers pre-connection (empty state) and sustained failure (error state) in instrument-panel language */}
      <DeckStatus />
      {/* Dev-only Surge tuning panel — toggled with the "t" key, never rendered in production */}
      <Tuner />
    </div>
  );
}
