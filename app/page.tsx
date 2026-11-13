import DeckStatus from "@/components/DeckStatus";
import Gauges from "@/components/Gauges";
import Hud from "@/components/Hud";
import Mix from "@/components/Mix";
import Panel from "@/components/Panel";
import Pulse from "@/components/Pulse";
import Shell from "@/components/swarm/Shell";
import SwarmCanvas from "@/components/swarm/SwarmCanvas";
import Tape from "@/components/Tape";
import styles from "./page.module.css";

// 배치: 다크 에디터 크롬(툴바) / 왼쪽 데이터 레일(항상 보임) — 지금 쌓이는 수집 데이터(Pulse·게이지·Tape·Mix) /
// 중앙 캔버스 — 커서가 레일의 새 글을 집어 와 카드를 그린다, 탭(이벤트·퍼지는 글) /
// 오른쪽 접는 진단 패널 — HUD(드랍·메모리·프레임) / 하단 HUD pill.
// 레일 시트는 canvas가 기록지 색 상수로 그려지므로 밝은 시트로 둔다(DECISIONS.md).

export default function Home() {
  return (
    <Shell
      canvas={<SwarmCanvas />}
      rail={
        <div className={styles.sheet}>
          <Panel name="수신량" note="최근 1분 평균 대비" className={styles.pulse} readouts={<Gauges />}>
            <Pulse />
          </Panel>
          <Panel name="새 글" note="표본" className={styles.tape}>
            <Tape />
          </Panel>
          <Panel name="언어" note="최근 60초" className={styles.mix}>
            <Mix />
          </Panel>
        </div>
      }
      inspector={
        <div className={styles.sheet}>
          <Hud />
        </div>
      }
      overlay={
        <>
          <DeckStatus />
        </>
      }
    />
  );
}
