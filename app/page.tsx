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

// 배치(위 → 아래): 헤더 / 기록계(Pulse — 머리줄에 타입별 펜 리드아웃, 아래로 모눈
// 스트립 차트) / 메인 그리드 — 좌 Surge(주인공), 우 Tape · Mix / 하단 진단 줄(HUD).
// 전부 한 장의 기록지 위 구획이고, 구획 사이는 괘선 하나로만 갈린다.

export default function Home() {
  return (
    <div className={styles.deck}>
      <Header />
      <Panel
        name="Pulse"
        note="초당 이벤트 수. 증감은 1분 평균 대비"
        className={styles.pulse}
        readouts={<Gauges />}
      >
        <Pulse />
      </Panel>
      <main className={styles.grid}>
        <Panel name="Surge" note="평소보다 갑자기 많이 쓰이는 단어" className={styles.surge}>
          <Surge />
        </Panel>
        <div className={styles.side}>
          <Panel name="Tape" note="새 게시물 표본" className={styles.tape}>
            <Tape />
          </Panel>
          <Panel name="Mix" note="게시물 언어 비율, 최근 60초" className={styles.mix}>
            <Mix />
          </Panel>
        </div>
      </main>
      <Hud />
      {/* 연결 전(빈 상태)·지속 장애(에러 상태)를 덮는 앰비언트 레이어 */}
      <DeckStatus />
      {/* 개발 전용 Surge 튜닝 패널 — "t" 키로 토글, 프로덕션에선 렌더되지 않는다 */}
      <Tuner />
    </div>
  );
}
