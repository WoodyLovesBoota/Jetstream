// 합성 이벤트 스트림 — 결정적(시드). 단위 테스트, 주입 테스트(scripts/inject.ts),
// 픽스처 스트림 모드(?fixture=)가 모두 쓴다.
//
// 배경: 분당 일정한 post(가상 어휘 Zipf + 상시어), 최근 글을 향한 like·repost.
// 주제(topic): 정해진 시간대에 정해진 속도·작성자 풀로 특정 문구를 섞어 넣는다.
// 봇: 소수 계정이 같은 태그를 도배한다.

import type { SlimEvent } from "./slim.ts";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYL = ["ka", "lo", "mi", "ren", "tu", "sa", "vel", "no", "dri", "pa", "zo", "gan", "fi", "mar", "qu", "bel", "tor", "si", "wen", "dax"];

/** 가상 어휘 — 실제 단어·불용어와 겹치지 않는 3~4음절 */
export function makeVocab(n: number, seed = 1): string[] {
  const r = mulberry32(seed);
  const out = new Set<string>();
  while (out.size < n) {
    const k = 3 + Math.floor(r() * 2);
    let w = "";
    for (let i = 0; i < k; i++) w += SYL[Math.floor(r() * SYL.length)];
    out.add(w);
  }
  return [...out];
}

export interface SynthTopic {
  /** 글 본문 — 문자열이거나 (순번, 난수) → 문자열 */
  text: string | ((i: number, r: () => number) => string);
  startMs: number;
  endMs: number;
  /** 분당 post 수 — 상수 또는 시각의 함수 */
  perMin: number | ((tMs: number) => number);
  /** 작성자 풀 크기와 DID 접두어 — 서로 다른 사람 수 */
  authors: number;
  authorPrefix: string;
  langs?: string[];
  links?: string[];
  hashtags?: string[];
  quote?: string;
  /** 이 주제 글에 붙는 분당 like 수(대상 = 주제 첫 글) */
  likesPerMin?: number;
}

export interface SynthBot {
  accounts: number;
  /** 총 post 수 — 구간에 고르게 */
  posts: number;
  startMs: number;
  endMs: number;
  text: string;
  hashtags?: string[];
}

export interface SynthOptions {
  seed: number;
  startMs: number;
  endMs: number;
  postsPerMin: number;
  likesPerMin: number;
  authorPool: number;
  vocabSize: number;
  /** 상시어와 그 등장 확률 */
  backgroundWords: { word: string; p: number }[];
  topics?: SynthTopic[];
  bots?: SynthBot[];
  /** 배경 post 언어 */
  langs?: string[];
}

function rkeyOf(n: number): string {
  return `3k${n.toString(36).padStart(8, "0")}`;
}

/** 시간 순서 SlimEvent 생성기 */
export function* synthStream(o: SynthOptions): Generator<SlimEvent> {
  const r = mulberry32(o.seed);
  const vocab = makeVocab(o.vocabSize, o.seed + 1);
  // Zipf: 앞쪽 단어일수록 잦다 — r^2.2 로 인덱스를 뽑는다
  const word = (): string => vocab[Math.floor(Math.pow(r(), 2.2) * vocab.length)];
  const recent: string[] = [];
  const topicCarry = (o.topics ?? []).map(() => 0);
  const topicCount = (o.topics ?? []).map(() => 0);
  const topicFirstUri: (string | null)[] = (o.topics ?? []).map(() => null);
  const likeCarry = (o.topics ?? []).map(() => 0);
  let bgCarry = 0;
  let likeBgCarry = 0;
  let seq = 0;
  const batch: SlimEvent[] = [];

  for (let sec = o.startMs; sec < o.endMs; sec += 1000) {
    batch.length = 0;
    const at = (): number => (sec + Math.floor(r() * 1000)) * 1000 + (seq++ % 1000);

    bgCarry += o.postsPerMin / 60;
    while (bgCarry >= 1) {
      bgCarry--;
      const n = 6 + Math.floor(r() * 10);
      const words: string[] = [];
      for (let i = 0; i < n; i++) words.push(word());
      for (const b of o.backgroundWords) if (r() < b.p) words.splice(Math.floor(r() * words.length), 0, b.word);
      const did = `did:plc:bg${Math.floor(r() * o.authorPool)}`;
      const rkey = rkeyOf(seq);
      batch.push({ t: at(), d: did, c: "p", k: rkey, x: words.join(" "), g: o.langs ?? ["en"] });
      recent.push(`at://${did}/app.bsky.feed.post/${rkey}`);
      if (recent.length > 2000) recent.shift();
    }

    likeBgCarry += o.likesPerMin / 60;
    while (likeBgCarry >= 1 && recent.length > 0) {
      likeBgCarry--;
      const s = recent[recent.length - 1 - Math.floor(Math.pow(r(), 3) * recent.length)];
      batch.push({ t: at(), d: `did:plc:lk${Math.floor(r() * o.authorPool * 3)}`, c: r() < 0.15 ? "r" : "l", s });
    }

    (o.topics ?? []).forEach((tp, i) => {
      if (sec < tp.startMs || sec >= tp.endMs) return;
      const rate = typeof tp.perMin === "function" ? tp.perMin(sec) : tp.perMin;
      topicCarry[i] += rate / 60;
      while (topicCarry[i] >= 1) {
        topicCarry[i]--;
        const n = topicCount[i]++;
        const text = typeof tp.text === "function" ? tp.text(n, r) : `${tp.text} ${word()} ${word()}`;
        const did = `did:plc:${tp.authorPrefix}${Math.floor(r() * tp.authors)}`;
        const rkey = rkeyOf(seq);
        const ev: SlimEvent = { t: at(), d: did, c: "p", k: rkey, x: text, g: tp.langs ?? o.langs ?? ["en"] };
        if (tp.links !== undefined) ev.u = tp.links;
        if (tp.hashtags !== undefined) ev.h = tp.hashtags;
        if (tp.quote !== undefined) ev.q = tp.quote;
        batch.push(ev);
        if (topicFirstUri[i] === null) topicFirstUri[i] = `at://${did}/app.bsky.feed.post/${rkey}`;
      }
      const target = topicFirstUri[i];
      if (tp.likesPerMin !== undefined && target !== null) {
        likeCarry[i] += tp.likesPerMin / 60;
        while (likeCarry[i] >= 1) {
          likeCarry[i]--;
          batch.push({ t: at(), d: `did:plc:${tp.authorPrefix}lk${Math.floor(r() * 1e6)}`, c: "l", s: target });
        }
      }
    });

    for (const b of o.bots ?? []) {
      if (sec < b.startMs || sec >= b.endMs) continue;
      const perSec = b.posts / ((b.endMs - b.startMs) / 1000);
      const n = Math.floor(perSec) + (r() < perSec % 1 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const ev: SlimEvent = { t: at(), d: `did:plc:bot${Math.floor(r() * b.accounts)}`, c: "p", k: rkeyOf(seq), x: `${b.text} ${word()}`, g: ["en"] };
        if (b.hashtags !== undefined) ev.h = b.hashtags;
        batch.push(ev);
      }
    }

    batch.sort((a, b) => a.t - b.t);
    for (const ev of batch) yield ev;
  }
}
