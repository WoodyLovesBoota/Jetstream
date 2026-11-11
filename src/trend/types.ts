// 엔진 → 메인 스레드 스냅샷 타입. structured clone 가능한 plain 값만.

import type { CandidateKind } from "./extract.ts";
import type { Lifecycle } from "./signals.ts";

export type { CandidateKind, Lifecycle };

export type EventState = "active" | "past";

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
}

export interface SpreadingPost {
  uri: string;
  url: string | null;
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
}

export interface TrendSnapshot {
  ts: number;
  events: TrendEvent[];
  spreading: SpreadingPost[];
  learning: { active: boolean; minutes: number; hasPrior: boolean };
  stats: TrendStats;
}

/** 좋아요·리포스트가 퍼지는 글/이벤트에 들어온 순간 — UI 클릭 링 */
export interface EngagePing {
  uri: string;
  eventId: number | null;
  repost: boolean;
}
