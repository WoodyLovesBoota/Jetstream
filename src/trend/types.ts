// 엔진 → 메인 스레드 스냅샷 타입. structured clone 가능한 plain 값만.

import type { AmpStats } from "./amplification.ts";
import type { CandidateKind } from "./extract.ts";
import type { Lifecycle } from "./signals.ts";

export type { CandidateKind, Lifecycle };

/** active: 트렌드 판정 통과 · watch: 판정 전, 지금 많이 나오는 후보(바로 그리는 관찰 카드) · past: 지나간 트렌드 */
export type EventState = "active" | "watch" | "past";

export interface TrendMember {
  key: string;
  kind: CandidateKind;
  label: string;
  score: number;
  z: number;
  /** 5분 고유 작성자(참여자) */
  u: number;
  /** 진입 상태인 멤버인가(아니면 묶기로 딸려 온 관련 후보) */
  active: boolean;
}

export interface TrendPost {
  did: string;
  rkey: string;
  text: string;
  timeMs: number;
  url: string;
  langs: string[];
}

/**
 * 제목 글(p:/q:)의 본문을 세션 중 못 봤을 때(또는 본문이 비어 링크 카드만 있을 때) 엔진이
 * 임시로 다는 제목. UI는 이 값과 같으면 getPosts 하이드레이션 결과로 갈아 끼운다.
 */
export function postTitlePlaceholder(uri: string): string {
  return `Post ${uri.split("/").pop() ?? ""}`;
}

export interface TrendEvent {
  id: number;
  /** 12색 팔레트 인덱스 */
  colorIdx: number;
  state: EventState;
  title: string;
  titleKey: string;
  titleKind: CandidateKind;
  related: string[];
  members: TrendMember[];
  score: number;
  lifecycle: Lifecycle;
  /** 15분 스파크라인 — 30포인트(포인트당 30초), 오래된 것 → 최신 */
  spark: number[];
  representativePosts: TrendPost[];
  link: { url: string; domain: string } | null;
  stats: {
    /** ×배수 = (x+1)/(λ+1) */
    mult: number;
    u: number;
    newRatio: number;
    a: number;
    isNew: boolean;
  };
  langs: string[];
  enteredAt: number;
  exitedAt: number | null;
  /** 제목 멤버가 글(p:/q:)이면 그 at:// URI — UI가 본문을 채운다 */
  postUri: string | null;
  /** 리포스트 도달 — 이벤트 글들이 평소보다 얼마나 퍼 날라지는가. 계산 전이면 null */
  repostReach: RepostReach | null;
  /** 정렬 점수 = score × 평활 R. 진입·퇴출은 score로만 판정한다 */
  rankScore: number;
}

export interface RepostReach {
  /** 5분 고유 리포스터(봇·자기 리포스트 제외, 링 의심은 0.2명으로) */
  reposters: number;
  /** P_e — 5분 이벤트 post 수 */
  posts: number;
  /** E_e = ρ × P_e */
  expected: number;
  /** (Rp+1)/(E+1) */
  amp: number;
  /** 정렬에 쓰는 평활 R(관찰 카드는 평활 없이 이번 패스 값) */
  r: number;
}

export interface SpreadingPost {
  uri: string;
  url: string | null;
  /** 세션 중 본 글이면 본문 앞 140자, 아니면 null(UI가 getPosts로 채운다) */
  text: string | null;
  score: number;
  /** 5분·30분 고유 참여자, 30분 가중 표(repost 3) */
  p5: number;
  p30: number;
  votes30: number;
  a: number;
  lifecycle: Lifecycle;
  eventId: number | null;
}

export interface TrendStats {
  tracked: number;
  trackedCap: number;
  hot: number;
  engage: number;
  engageCap: number;
  background: number;
  trackedEvicted: number;
  engageEvicted: number;
  muted: number;
  mutedEvents: number;
  dupDropped: number;
  staleDropped: number;
  /** 최근 5분 post 수(G) */
  posts5m: number;
  /** 엔진 자체 추정 메모리(bytes) — typed array 실측 + 맵 항목 추정 */
  approxBytes: number;
  /** 마지막 점수 패스 소요(ms) */
  scoreMs: number;
  evaluated: number;
  passed: number;
  active: number;
  /** 리포스트 증폭(R) 집계 상태 */
  repost: AmpStats;
}

export interface TrendSnapshot {
  ts: number;
  events: TrendEvent[];
  spreading: SpreadingPost[];
  learning: { active: boolean; minutes: number; hasPrior: boolean };
  stats: TrendStats;
  /** 이 스냅샷에 걸린 언어 필터(주 언어 코드, 예: "ko"). null이면 전체 */
  lang: string | null;
}

/** 좋아요·리포스트가 퍼지는 글/이벤트에 들어온 순간 — UI 클릭 링 */
export interface EngagePing {
  uri: string;
  eventId: number | null;
  repost: boolean;
  /** 이벤트 멤버 글에 귀속된 리포스트(R 집계) — UI는 ↻ 링으로 따로 그린다 */
  reach?: boolean;
}
