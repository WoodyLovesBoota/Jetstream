// 작성자 중복 제거 + 봇 필터.
//
// · 같은 작성자가 같은 후보를 같은 1분 안에 또 언급하면 세지 않는다 → "작성자당 1분에 최대 1".
//   (DID해시, 후보해시)를 섞은 32비트 값 하나의 Set으로 들고 매분 비운다. 분당 17만 쌍
//   규모에서 32비트 충돌 기대치는 수 건 — 무시 가능한 과소 집계다.
// · 분당 post가 botPostsPerMin을 넘는 DID는 botMuteMin분 동안 집계에서 뺀다.
//   like·repost는 별도 문턱(botEngagePerMin) — 정상 사용자도 분당 20회는 좋아요를 누른다.
//   Tape(표시)는 이 모듈을 거치지 않는다.

import { combine32 } from "./hash.ts";

export interface DedupConfig {
  botPostsPerMin: number;
  botEngagePerMin: number;
  botMuteMin: number;
}

export interface DedupStats {
  /** 지금 뮤트 중인 DID 수 */
  muted: number;
  /** 누적 뮤트 진입 */
  mutedTotal: number;
  /** 뮤트로 집계에서 빠진 이벤트 누적 */
  mutedEvents: number;
  /** 같은 분 재언급으로 버린 (작성자,후보) 누적 */
  dupDropped: number;
  /** 이번 분 Set 크기 */
  pairsThisMinute: number;
}

export class AuthorDedup {
  private minute = -1;
  private pairs = new Set<number>();
  private postCount = new Map<number, number>();
  private engageCount = new Map<number, number>();
  private mutedUntil = new Map<number, number>();
  private mutedTotal = 0;
  private mutedEvents = 0;
  private dupDropped = 0;
  private readonly cfg: DedupConfig;

  constructor(cfg: DedupConfig) {
    this.cfg = cfg;
  }

  private roll(minute: number): void {
    if (minute <= this.minute) return;
    this.minute = minute;
    this.pairs.clear();
    this.postCount.clear();
    this.engageCount.clear();
    for (const [did, until] of this.mutedUntil) if (until <= minute) this.mutedUntil.delete(did);
  }

  /**
   * 이 작성자의 이벤트를 집계에 넣어도 되는가. 분당 카운트를 올리고 문턱을 넘으면 뮤트한다.
   * false면 이 이벤트의 모든 후보를 건너뛴다.
   */
  admit(didHash: number, isPost: boolean, minute: number): boolean {
    this.roll(minute);
    const until = this.mutedUntil.get(didHash);
    if (until !== undefined && until > minute) {
      this.mutedEvents++;
      return false;
    }
    const map = isPost ? this.postCount : this.engageCount;
    const limit = isPost ? this.cfg.botPostsPerMin : this.cfg.botEngagePerMin;
    const n = (map.get(didHash) ?? 0) + 1;
    map.set(didHash, n);
    if (n > limit) {
      this.mutedUntil.set(didHash, minute + this.cfg.botMuteMin);
      this.mutedTotal++;
      this.mutedEvents++;
      return false;
    }
    return true;
  }

  /** (작성자, 후보)가 이번 분 첫 언급이면 true */
  first(didHash: number, keyHash: number): boolean {
    const k = combine32(didHash, keyHash);
    if (this.pairs.has(k)) {
      this.dupDropped++;
      return false;
    }
    this.pairs.add(k);
    return true;
  }

  isMuted(didHash: number, minute: number): boolean {
    const until = this.mutedUntil.get(didHash);
    return until !== undefined && until > minute;
  }

  stats(): DedupStats {
    return {
      muted: this.mutedUntil.size,
      mutedTotal: this.mutedTotal,
      mutedEvents: this.mutedEvents,
      dupDropped: this.dupDropped,
      pairsThisMinute: this.pairs.size,
    };
  }
}
