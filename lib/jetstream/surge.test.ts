import { describe, expect, it } from "vitest";
import { createSurgeAggregator, tokenizePost } from "./surge";
import { SURGE_TUNING_DEFAULTS } from "./protocol";

// 시간은 전부 nowSec 파라미터로 주입되므로 가짜 타이머 없이 검증한다.
// 세션 시작(sessionStartSec)만 생성 시점의 실제 시계를 쓰므로, 워밍업 판정은
// "생성 직후 ± 수 초" 안에서 안전한 여유를 두고 오프셋으로 밀어 확인한다.

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  tokenizePost(text, out);
  return out;
}

describe("tokenizePost", () => {
  it("해시태그는 스크립트 불문 추출하고 소문자화한다", () => {
    const t = tokens("Big News #Seoul #서울");
    expect(t.has("#seoul")).toBe(true);
    expect(t.has("#서울")).toBe(true);
  });

  it("1자 ASCII 태그는 잡음, 1자 CJK 태그는 단어다", () => {
    const t = tokens("#a #雨");
    expect(t.has("#a")).toBe(false);
    expect(t.has("#雨")).toBe(true);
  });

  it("URL·멘션은 단어 추출 전에 제거된다", () => {
    const t = tokens("lantern https://example.com/typhoon @alice.bsky.social");
    expect(t.has("https")).toBe(false);
    expect(t.has("example")).toBe(false);
    expect(t.has("typhoon")).toBe(false); // URL 경로 안의 단어도 잡음이다
    expect(t.has("alice")).toBe(false);
    expect(t.has("lantern")).toBe(true);
  });

  it("불용어·3자 미만은 걸러지고 같은 post 안 중복은 1회만 센다", () => {
    const t = tokens("the typhoon typhoon is ok");
    expect(t.has("the")).toBe(false);
    expect(t.has("typhoon")).toBe(true);
    expect(t.size).toBe(1); // "is"/"ok"는 2자라 매치 자체가 안 된다
  });

  it("MAX_TOKEN_LEN을 넘는 스팸성 문자열은 추적하지 않는다", () => {
    const long = "a".repeat(41);
    expect(tokens(long).has(long)).toBe(false);
    expect(tokens(`#${"b".repeat(41)}`).size).toBe(0);
  });
});

describe("createSurgeAggregator — 롤링 합", () => {
  it("1m/5m/15m 창이 시간 경과에 따라 정확히 마른다", () => {
    const t0 = Math.floor(Date.now() / 1000);
    const agg = createSurgeAggregator();
    for (let i = 0; i < 7; i++) agg.ingest("#typhoon", t0);
    agg.sweep(t0); // 첫 sweep이 재정렬을 돌려 지속 리스트에 올린다

    let item = agg.snapshot(t0).data.sustained[0];
    expect(item.token).toBe("#typhoon");
    expect(item.count1m).toBe(7);
    expect(item.count5m).toBe(7);
    expect(item.count15m).toBe(7);

    // 70초 뒤 — 1분 창(10초 버킷 6개) 밖, 5분 창 안
    item = agg.snapshot(t0 + 70).data.sustained[0];
    expect(item.count1m).toBe(0);
    expect(item.count5m).toBe(7);

    // 310초 뒤 — 5분 창 밖, 15분 창 안
    item = agg.snapshot(t0 + 310).data.sustained[0];
    expect(item.count5m).toBe(0);
    expect(item.count15m).toBe(7);

    // 920초 뒤 — 링 전체(90버킷)를 넘는 공백은 통째로 리셋된다
    item = agg.snapshot(t0 + 920).data.sustained[0];
    expect(item.count15m).toBe(0);
  });

  it("위생 TTL(10분 무활동)이 토큰을 퇴출하고 카운터에 남긴다", () => {
    const t0 = Math.floor(Date.now() / 1000);
    const agg = createSurgeAggregator();
    agg.ingest("#idle", t0);
    agg.sweep(t0); // 첫 정리 패스 — 아직 idle 아님
    expect(agg.snapshot(t0).stats.tracked).toBe(1);

    agg.sweep(t0 + 700); // 700초 무활동 > IDLE_TTL 600초
    const snap = agg.snapshot(t0 + 700);
    expect(snap.stats.tracked).toBe(0);
    expect(snap.stats.evicted).toBe(1);
    // 퇴출된 토큰은 리스트에서도 사라진다 (buildItem이 null을 걸러낸다)
    expect(snap.data.sustained.length).toBe(0);
  });
});

describe("createSurgeAggregator — 워밍업·자격·튜닝", () => {
  it("워밍업(120초) 중 급상승 랭킹은 비활성, 지속 리스트는 정상이다", () => {
    const t0 = Math.floor(Date.now() / 1000);
    const agg = createSurgeAggregator();
    for (let i = 0; i < 40; i++) agg.ingest("#boom wordburst", t0 + i);

    agg.sweep(t0 + 60); // 아직 워밍업
    let snap = agg.snapshot(t0 + 60);
    expect(snap.data.baselineWarmup.active).toBe(true);
    expect(snap.data.surging.length).toBe(0);
    expect(snap.data.sustained[0]?.token).toBe("#boom"); // 지속은 해시태그만, 정상 동작

    agg.sweep(t0 + 130); // 워밍업 종료 후 재정렬
    snap = agg.snapshot(t0 + 130);
    expect(snap.data.baselineWarmup.active).toBe(false);
    // 급상승은 단어+해시태그 전체: 40회/5분 ≥ 최소 지지 30, burst (8+2)/(0+2)=5 ≥ 2.0
    const surgingTokens = snap.data.surging.map((s) => s.token);
    expect(surgingTokens).toContain("wordburst");
    expect(surgingTokens).toContain("#boom");
    // 지속은 여전히 해시태그만
    expect(snap.data.sustained.map((s) => s.token)).toEqual(["#boom"]);
  });

  it("튜닝 클램프 — 퇴출 문턱은 진입을 넘지 못하고 범위 밖 값은 눌린다", () => {
    const t0 = Math.floor(Date.now() / 1000);
    const agg = createSurgeAggregator();

    agg.tune({ enterMult: 2, exitMult: 5 }); // 히스테리시스 역전 시도
    agg.tune({ deadbandPct: 250, resortSec: 0 });
    const tuning = agg.snapshot(t0).data.tuning;
    expect(tuning.exitMult).toBe(2);
    expect(tuning.deadbandPct).toBe(100);
    expect(tuning.resortSec).toBe(1);
    // 건드리지 않은 값은 기본값 그대로
    expect(tuning.alpha).toBe(SURGE_TUNING_DEFAULTS.alpha);
  });
});
