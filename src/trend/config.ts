// 트렌드 엔진 파라미터 — 전부 여기 한 곳. 바꾸면 DECISIONS.md에 근거(리플레이 지표 전후)를 남긴다.

export interface TrendConfig {
  // ── 창·시간 ──
  /** 신호 창 W(분) */
  windowMin: number;
  /** 추적 버킷 폭(초) */
  bucketSec: number;
  /** 추적 버킷 수 — 10초 × 90 = 15분 */
  buckets: number;
  /** 점수 계산 주기(ms) */
  scoreEveryMs: number;

  // ── 베이스라인 ──
  /** 점유율 EWMA 반감기(분) */
  baselineHalfLifeMin: number;
  /** 베이스라인 갱신 지연(분) — 이보다 최근 데이터로는 갱신하지 않는다 */
  baselineDelayMin: number;
  /** 과분산 φ 기본값 / 하한 / 상한 */
  phiDefault: number;
  phiMin: number;
  phiMax: number;
  /** 관측 분산으로 φ를 추정하려면 필요한 최소 갱신 분 수 */
  phiMinObsMin: number;
  /** prior를 몇 분치 관측으로 볼지 */
  priorWeightMin: number;
  /** 이 시간 미만 & prior 없음이면 "학습 중" */
  learningMin: number;

  // ── 배경어 ──
  backgroundTopN: number;
  backgroundShare: number;
  /** 배경어 집합 재계산 주기(분) — 세션 첫 1시간은 earlyMin마다 */
  backgroundEveryMin: number;
  backgroundEarlyEveryMin: number;

  // ── 카운터 ──
  cmsDepth: number;
  cmsWidth: number;
  /** CMS 1분 링 길이 */
  cmsMinutes: number;
  /** 추적 승격: 직전 1분 추정치 ≥ 이 값 */
  promoteMin: number;
  trackedCap: number;
  /** 추적 상한 도달 시 한 번에 비우는 비율 */
  trackedEvictFrac: number;
  hotCap: number;
  hotAuthorCap: number;
  hotRecentPosts: number;
  hotPostIdCap: number;
  /** 핫 후보별 링크 집계 칸 */
  hotLinkSlots: number;

  // ── 참여(Space-Saving) ──
  engageCap: number;
  /** 일괄 퇴출 비율 */
  engageEvictFrac: number;
  /** repost 가중치 */
  repostVotes: number;
  /** p: 참여 창(분) — 짧은/긴 */
  engageShortMin: number;
  engageLongMin: number;

  // ── 중복 제거·봇 ──
  /** 분당 post 이 수를 넘기면 봇 */
  botPostsPerMin: number;
  /** 분당 like+repost 이 수를 넘기면 봇(참여 쪽) */
  botEngagePerMin: number;
  botMuteMin: number;

  // ── 추출 ──
  /** 배경어 짝: 배경어 1개당 짝지을 단어 최대 수 */
  pairMax: number;
  /** post 하나에서 뽑는 단어 최대 수(스팸 방어) */
  wordsPerPostMax: number;

  // ── 신호·게이트 ──
  zEnter: number;
  zExit: number;
  zCap: number;
  minAuthors: number;
  topShareMax: number;
  liftMin: number;
  /** 포섭: 단어 언급 중 bigram이 이 비율 이상이면 단어 제외 */
  subsumeFrac: number;
  /** S5 최소 참여자 — p: / u:·q: */
  minParticipantsEngage: number;
  minParticipantsLink: number;
  /** z' = min(zCap, 참여자 / 이 값) */
  convergeDiv: number;
  /** 링크 부착: 핫 후보 최근 글 중 같은 URL 비율 */
  linkAttachFrac: number;
  /** 가속 ε (언급 수 단위) */
  accelEps: number;
  risingA: number;
  fadingA: number;
  /** 새로움 */
  noveltyNew: number;
  noveltyRare: number;
  /** "새것"으로 볼 세션 내 최대 추적 경과(분) */
  noveltyFreshMin: number;

  // ── 진입·퇴출 ──
  scoreEnter: number;
  enterStreak: number;
  fadingExitMin: number;
  pastKeepMin: number;
  maxEvents: number;

  // ── 이벤트 묶기 ──
  clusterTopN: number;
  overlapMin: number;
  /** 겹침 계수를 믿기 위한 최소 집합 크기 */
  overlapMinSet: number;
  relatedMax: number;
  /** 퍼지는 글 탭 길이 */
  spreadingMax: number;
}

export const DEFAULT_CONFIG: TrendConfig = {
  windowMin: 5,
  bucketSec: 10,
  buckets: 90,
  scoreEveryMs: 5_000,

  baselineHalfLifeMin: 360,
  baselineDelayMin: 5,
  phiDefault: 0.1,
  phiMin: 0.05,
  phiMax: 2,
  phiMinObsMin: 30,
  priorWeightMin: 60,
  learningMin: 10,

  backgroundTopN: 300,
  backgroundShare: 0.003,
  backgroundEveryMin: 60,
  backgroundEarlyEveryMin: 5,

  cmsDepth: 4,
  cmsWidth: 65_536,
  cmsMinutes: 6,
  promoteMin: 3,
  trackedCap: 30_000,
  trackedEvictFrac: 0.1,
  hotCap: 1_000,
  hotAuthorCap: 2_000,
  hotRecentPosts: 5,
  hotPostIdCap: 500,
  hotLinkSlots: 8,

  engageCap: 20_000,
  engageEvictFrac: 0.25,
  repostVotes: 3,
  engageShortMin: 5,
  engageLongMin: 30,

  botPostsPerMin: 20,
  botEngagePerMin: 60,
  botMuteMin: 10,

  pairMax: 10,
  wordsPerPostMax: 40,

  zEnter: 4,
  zExit: 2,
  zCap: 30,
  minAuthors: 8,
  topShareMax: 0.2,
  liftMin: 3,
  subsumeFrac: 0.5,
  minParticipantsEngage: 15,
  minParticipantsLink: 8,
  convergeDiv: 3,
  linkAttachFrac: 0.3,
  accelEps: 1,
  risingA: 1.3,
  fadingA: 0.8,
  noveltyNew: 1.5,
  noveltyRare: 1.2,
  noveltyFreshMin: 60,

  scoreEnter: 6,
  enterStreak: 2,
  fadingExitMin: 3,
  pastKeepMin: 15,
  maxEvents: 15,

  clusterTopN: 100,
  overlapMin: 0.4,
  overlapMinSet: 3,
  relatedMax: 6,
  spreadingMax: 20,
};

export function makeConfig(over?: Partial<TrendConfig>): TrendConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

/** 반감기(분) → 분당 EWMA 계수 α */
export function alphaFromHalfLife(halfLifeMin: number): number {
  return 1 - Math.pow(2, -1 / halfLifeMin);
}
