// 후보 추출 — SlimEvent 하나 → 후보 키 목록(`종류:값`). 한 이벤트 안에서 같은 키는 한 번만.
//
//   w:단어  b:두 단어  h:해시태그  c:배경어|단어  u:정규화URL  d:도메인  q:인용URI  p:참여대상URI
//
// 순수 함수. 배경어 판정만 호출자가 주입한다(엔진의 D 집합).

import { STOPWORDS } from "../../lib/jetstream/stopwords.ts";
import { CJK_STOPWORDS, stripKoreanParticle } from "./korean.ts";
import type { SlimEvent } from "./slim.ts";
import { normalizeUrl } from "./url.ts";

export type CandidateKind = "w" | "b" | "h" | "c" | "u" | "d" | "q" | "p";

export function kindOf(key: string): CandidateKind {
  return key.charCodeAt(1) === 58 /* ':' */ ? (key[0] as CandidateKind) : "w";
}

/** 키 → 화면 라벨. `c:trump|greenland` → `trump · greenland`, `h:x` → `#x` */
export function labelOf(key: string): string {
  const kind = kindOf(key);
  const v = key.slice(2);
  switch (kind) {
    case "c":
      return v.replace("|", " · ");
    case "h":
      return `#${v}`;
    case "q":
    case "p":
      return v;
    default:
      return v;
  }
}

/** 링크·글처럼 베이스라인≈0이라 z 대신 수렴 z'를 쓰는 종류 */
export function isConvergent(kind: CandidateKind): boolean {
  return kind === "u" || kind === "q" || kind === "p";
}

const URL_RE = /https?:\/\/\S+/gi;
const BARE_DOMAIN_RE = /\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|co|io|news|app|social|gov|edu|uk|de|jp|kr|be|ly|it|me|tv|gg|ca|au|fr|es|br|in|ru|nl|us|info|xyz|link|site|online|digital|shop|store|blog|page|dev|ai)(?:\/\S*)?/gi;

/** 단축 URL·링크 집계 서비스 — 도메인 자체엔 정보가 없다(u:는 남긴다) */
const GENERIC_DOMAINS = new Set([
  "bit.ly", "buff.ly", "tinyurl.com", "t.co", "ow.ly", "dlvr.it", "ift.tt", "is.gd", "goo.gl", "shorturl.at",
  "rebrand.ly", "trib.al", "linktr.ee", "lnkd.in", "fb.me", "amzn.to", "a.co", "tiny.cc", "cutt.ly", "s.id",
]);
const MENTION_RE = /@[\w.-]+/g;
const HASHTAG_RE = /[#＃]([\p{L}\p{M}\p{N}_]+)/gu;
const CONTRACTION_RE = /['’](?:s|t|re|ll|ve|d|m)\b/giu;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HANGUL_SYL_RE = /^[가-힣]+$/;
const HIRAGANA_RE = /^\p{Script=Hiragana}+$/u;
const LETTER_RE = /\p{L}/u;
/** 비 CJK 경로: 글자로 시작하는 토큰 */
const TOKEN_RE = /[\p{L}\p{M}\p{N}_]+/gu;
const MAX_WORD = 30;
const MAX_TAG = 40;

// ── Segmenter 캐시 ──
type Seg = { segment: (s: string) => Iterable<{ segment: string; index: number; isWordLike?: boolean }> };
const segmenters = new Map<string, Seg | null>();
function segmenterFor(locale: string): Seg | null {
  let s = segmenters.get(locale);
  if (s === undefined) {
    const Ctor = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: string }) => Seg }).Segmenter;
    s = Ctor === undefined ? null : new Ctor(locale, { granularity: "word" });
    segmenters.set(locale, s);
  }
  return s;
}

function cjkLocale(text: string, langs: string[] | undefined): string {
  const primary = langs?.[0]?.split("-")[0]?.toLowerCase();
  if (primary === "ko" || primary === "ja" || primary === "zh") return primary;
  if (/\p{Script=Hangul}/u.test(text)) return "ko";
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja";
  return "zh";
}

/**
 * 토큰 하나 → 단어(정규화) 또는 null(불용어·너무 짧음 → bigram 경계).
 * 한글은 끝 조사 제거 후 2자+, 한자·가나는 2자+(히라가나만으로 된 4자 미만은 기능어),
 * 그 외 문자는 3자+.
 */
export function normalizeWord(tok: string): string | null {
  if (tok.length > MAX_WORD || !LETTER_RE.test(tok)) return null;
  let w = tok.toLowerCase();
  if (CJK_RE.test(w)) {
    if (HANGUL_SYL_RE.test(w)) {
      w = stripKoreanParticle(w);
      if (w.length < 2) return null;
    } else if (HIRAGANA_RE.test(w)) {
      if (w.length < 4) return null;
    } else if (w.length < 2) {
      return null;
    }
    // 한글 자모(ㅋㅋ)·혼합 잡음은 위 테스트를 빠져나온다 — 음절이 하나도 없으면 버린다
    if (/^[ㄱ-ㆎ]+$/.test(w)) return null;
    return CJK_STOPWORDS.has(w) ? null : w;
  }
  if (w.length < 3) return null;
  if (/^\p{N}/u.test(w)) return null;
  return STOPWORDS.has(w) ? null : w;
}

/**
 * 본문 → 단어 열. 불용어·구두점 자리에는 null을 넣어 bigram 경계로 쓴다.
 * (호출자가 out을 재사용할 수 있게 배열을 받는다)
 */
export function wordStream(text: string, langs: string[] | undefined, out: (string | null)[]): void {
  out.length = 0;
  const clean = text
    .normalize("NFKC")
    .replace(URL_RE, " . ")
    .replace(BARE_DOMAIN_RE, " . ")
    .replace(MENTION_RE, " . ")
    .replace(HASHTAG_RE, " . ")
    .replace(CONTRACTION_RE, "");

  const seg = CJK_RE.test(clean) ? segmenterFor(cjkLocale(clean, langs)) : null;
  if (seg !== null) {
    for (const s of seg.segment(clean)) {
      if (s.isWordLike === true) {
        out.push(normalizeWord(s.segment));
      } else if (s.segment.trim().length > 0) {
        out.push(null);
      }
    }
    return;
  }
  // 비 CJK(또는 Segmenter 없음): 정규식 토큰. 토큰 사이가 공백이 아니면 경계
  let lastEnd = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(clean)) !== null) {
    if (lastEnd > 0 && clean.slice(lastEnd, m.index).trim().length > 0) out.push(null);
    out.push(normalizeWord(m[0]));
    lastEnd = m.index + m[0].length;
  }
}

function normTag(tag: string): string | null {
  const t = tag.normalize("NFKC").toLowerCase().replace(/^[#＃]/, "");
  if (t.length === 0 || t.length > MAX_TAG) return null;
  // 1자 ASCII 태그는 잡음, 1자 CJK 태그(#雨)는 단어
  if (t.length < 2 && t.charCodeAt(0) < 0x80) return null;
  if (/^\p{N}+$/u.test(t)) return null;
  return t;
}

export interface ExtractOptions {
  isBackground: (word: string) => boolean;
  pairMax: number;
  wordsPerPostMax: number;
}

const streamBuf: (string | null)[] = [];

/**
 * 이벤트 → 후보 키. like/repost는 `p:` 하나, post는 나머지 전부.
 * `words`를 넘기면 이 post의 (중복 없는) 단어 목록도 채워 준다 — lift 계산용.
 */
export function extractKeys(ev: SlimEvent, opt: ExtractOptions, out: string[], words?: string[]): void {
  out.length = 0;
  if (words !== undefined) words.length = 0;
  if (ev.c !== "p") {
    if (ev.s !== undefined) out.push(`p:${ev.s}`);
    return;
  }
  const seen = new Set<string>();
  const add = (k: string): void => {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  };

  // 해시태그 — facet 우선, 본문 # 토큰도(facet 없는 클라이언트)
  if (ev.h !== undefined) for (const tag of ev.h) {
    const t = normTag(tag);
    if (t !== null) add(`h:${t}`);
  }
  const text = ev.x ?? "";
  if (text.includes("#") || text.includes("＃")) {
    HASHTAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HASHTAG_RE.exec(text)) !== null) {
      const t = normTag(m[1]);
      if (t !== null) add(`h:${t}`);
    }
  }

  // 단어·bigram
  if (text.length > 0) {
    wordStream(text, ev.g, streamBuf);
    const uniq: string[] = [];
    const uniqSet = new Set<string>();
    let prev: string | null = null;
    for (const w of streamBuf) {
      if (w !== null && !uniqSet.has(w) && uniq.length < opt.wordsPerPostMax) {
        uniqSet.add(w);
        uniq.push(w);
      }
      if (w !== null && prev !== null && w !== prev) add(`b:${prev} ${w}`);
      prev = w;
    }
    const background: string[] = [];
    const plain: string[] = [];
    for (const w of uniq) {
      add(`w:${w}`);
      if (opt.isBackground(w)) background.push(w);
      else plain.push(w);
    }
    // 배경어 짝 — 배경어 × 같은 글의 다른(비배경) 단어, 최대 pairMax개
    if (background.length > 0 && plain.length > 0) {
      const partners = plain.slice(0, opt.pairMax);
      for (const a of background) for (const b of partners) add(`c:${a}|${b}`);
    }
    if (words !== undefined) for (const w of uniq) words.push(w);
  }

  // 링크·인용
  if (ev.u !== undefined) for (const raw of ev.u) {
    const n = normalizeUrl(raw);
    if (n === null) continue;
    add(`u:${n.url}`);
    if (!GENERIC_DOMAINS.has(n.domain)) add(`d:${n.domain}`);
  }
  if (ev.q !== undefined) add(`q:${ev.q}`);
}

/** at://did/app.bsky.feed.post/rkey → bsky.app 링크. 형식이 다르면 null */
export function bskyUrl(uri: string): string | null {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
  return m === null ? null : `https://bsky.app/profile/${m[1]}/post/${m[2]}`;
}

export function postUri(did: string, rkey: string): string {
  return `at://${did}/app.bsky.feed.post/${rkey}`;
}
