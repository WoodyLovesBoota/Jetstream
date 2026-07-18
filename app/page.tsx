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

// 배치(위 → 아래): 헤더 / 타입별 게이지 스트립 / 전폭 스루풋 밴드(Pulse) /
// 메인 그리드 — 좌 62% Surge(주인공), 우 38% 컬럼에 Tape · Mix · HUD.

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
      {/* 연결 전(빈 상태)·지속 장애(에러 상태)를 계기판 언어로 덮는 앰비언트 레이어 */}
      <DeckStatus />
      {/* 개발 전용 Surge 튜닝 패널 — "t" 키로 토글, 프로덕션에선 렌더되지 않는다 */}
      <Tuner />
    </div>
  );
}
