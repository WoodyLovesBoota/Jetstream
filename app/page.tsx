import Header from "@/components/Header";
import Hud from "@/components/Hud";
import Mix from "@/components/Mix";
import Panel from "@/components/Panel";
import Pulse from "@/components/Pulse";
import Surge from "@/components/Surge";
import Tape from "@/components/Tape";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.deck}>
      <Header />
      <main className={styles.grid}>
        <Panel name="Pulse" note="throughput · events/sec" className={styles.pulse}>
          <Pulse />
        </Panel>
        <Panel name="Tape" note="app.bsky.feed.post sample" className={styles.tape}>
          <Tape />
        </Panel>
        <Panel name="Surge" note="token bursts · z-score" className={styles.surge}>
          <Surge />
        </Panel>
        <Panel name="Mix" note="language share · 60s" className={styles.mix}>
          <Mix />
        </Panel>
      </main>
      <Hud />
    </div>
  );
}
