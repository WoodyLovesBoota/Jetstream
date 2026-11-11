import DeckStatus from "@/components/DeckStatus";
import Gauges from "@/components/Gauges";
import Hud from "@/components/Hud";
import Mix from "@/components/Mix";
import Panel from "@/components/Panel";
import Pulse from "@/components/Pulse";
import HudPill from "@/components/swarm/HudPill";
import Shell from "@/components/swarm/Shell";
import SwarmCanvas from "@/components/swarm/SwarmCanvas";
import Tape from "@/components/Tape";
import styles from "./page.module.css";

// 배치: 다크 에디터 크롬(툴바) / 중앙 캔버스 — 이벤트 카드 + 스웜 커서, 탭(이벤트·퍼지는 글) /
// 오른쪽 접는 진단 패널 — 기존 기록계(Pulse·게이지)·Tape·Mix·HUD를 밝은 시트 그대로 / 하단 HUD pill.
// 진단 패널은 canvas가 기록지 색 상수로 그려지므로 밝은 인스펙터 시트로 둔다(DECISIONS.md).

export default function Home() {
  return (
    <Shell
      canvas={<SwarmCanvas />}
      inspector={
        <div className={styles.sheet}>
          <Panel name="Pulse" note="초당 이벤트 수" className={styles.pulse} readouts={<Gauges />}>
            <Pulse />
          </Panel>
          <Panel name="Tape" note="새 게시물 표본" className={styles.tape}>
            <Tape />
          </Panel>
          <Panel name="Mix" note="게시물 언어 비율, 최근 60초" className={styles.mix}>
            <Mix />
          </Panel>
          <Hud />
        </div>
      }
      overlay={
        <>
          <HudPill />
          <div className="dark-tokens">
            <DeckStatus />
          </div>
        </>
      }
    />
  );
}
