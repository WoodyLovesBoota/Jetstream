// Jetstream 원시 이벤트 → 엔진 입력(SlimEvent). 워커·녹화기·리플레이가 모두 이
// 함수 하나를 거치므로 "엔진이 읽는 필드"의 정의는 여기 한 곳뿐이다.
//
// 순수 함수 — DOM·Worker API 없음. 형식이 어긋난 필드는 조용히 무시하고(그 필드만),
// 엔진이 쓸 게 하나도 없는 이벤트는 null.

/** 엔진 입력 이벤트. 키를 짧게 둔 건 녹화 파일 크기 때문이다(jsonl.gz). */
export interface SlimEvent {
  /** time_us (마이크로초 epoch) */
  t: number;
  /** 작성자 DID */
  d: string;
  /** p = post create, l = like, r = repost */
  c: "p" | "l" | "r";
  /** post rkey */
  k?: string;
  /** post 본문 */
  x?: string;
  /**
   * embed 요약 — 링크 카드 제목, 없으면 첫 이미지 alt. 화면 표시 전용(본문이 빈 글의 대체 문구)이라
   * 후보 추출(단어·바이그램)에는 쓰지 않는다. 뉴스 봇처럼 링크 카드만 올리는 글이 흔해서다.
   */
  e?: string;
  /** post langs */
  g?: string[];
  /** facet 해시태그 (# 없이, 원문 대소문자) */
  h?: string[];
  /** 링크 URI들 (facet link + embed.external) */
  u?: string[];
  /** 인용한 레코드 URI (embed.record / recordWithMedia) */
  q?: string;
  /** like·repost 대상 URI */
  s?: string;
  /** 답글이면 부모 글 URI */
  rp?: string;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const COLLECTION_CODE: Record<string, SlimEvent["c"]> = {
  "app.bsky.feed.post": "p",
  "app.bsky.feed.like": "l",
  "app.bsky.feed.repost": "r",
};

/** embed 요약 문구 상한 — 카드 제목은 80자로 자르지만 대표 글 인용은 140자까지 보여 준다 */
const EMBED_SUMMARY_MAX = 200;

/** embed에서 외부 링크·인용 URI·요약 문구를 뽑는다. recordWithMedia는 양쪽 다 볼 수 있다. */
function readEmbed(embed: Obj | null, links: string[], out: { q?: string; e?: string }): void {
  if (embed === null) return;
  const type = str(embed.$type);
  if (type === "app.bsky.embed.external") {
    const external = obj(embed.external);
    const uri = str(external?.uri);
    if (uri !== null) links.push(uri);
    const title = (str(external?.title) ?? "").trim();
    if (title !== "") out.e = title.slice(0, EMBED_SUMMARY_MAX);
  } else if (type === "app.bsky.embed.images") {
    if (out.e === undefined && Array.isArray(embed.images)) {
      for (const img of embed.images) {
        const alt = (str(obj(img)?.alt) ?? "").trim();
        if (alt !== "") {
          out.e = alt.slice(0, EMBED_SUMMARY_MAX);
          break;
        }
      }
    }
  } else if (type === "app.bsky.embed.record") {
    const uri = str(obj(embed.record)?.uri);
    if (uri !== null) out.q = uri;
  } else if (type === "app.bsky.embed.recordWithMedia") {
    const uri = str(obj(obj(embed.record)?.record)?.uri);
    if (uri !== null) out.q = uri;
    readEmbed(obj(embed.media), links, out);
  }
}

export function slimEvent(raw: unknown): SlimEvent | null {
  const ev = obj(raw);
  if (ev === null || ev.kind !== "commit") return null;
  const did = str(ev.did);
  const t = typeof ev.time_us === "number" ? ev.time_us : null;
  const commit = obj(ev.commit);
  if (did === null || t === null || commit === null) return null;
  if (commit.operation !== "create") return null;
  const c = COLLECTION_CODE[String(commit.collection)];
  if (c === undefined) return null;
  const record = obj(commit.record);
  if (record === null) return null;

  if (c !== "p") {
    const s = str(obj(record.subject)?.uri);
    return s === null ? null : { t, d: did, c, s };
  }

  const out: SlimEvent = { t, d: did, c };
  const rkey = str(commit.rkey);
  if (rkey !== null) out.k = rkey;
  const text = typeof record.text === "string" ? record.text : "";
  if (text.length > 0) out.x = text;
  if (Array.isArray(record.langs)) {
    const langs = record.langs.filter((l): l is string => typeof l === "string").slice(0, 3);
    if (langs.length > 0) out.g = langs;
  }

  const tags: string[] = [];
  const links: string[] = [];
  if (Array.isArray(record.facets)) {
    for (const f of record.facets) {
      const features = obj(f)?.features;
      if (!Array.isArray(features)) continue;
      for (const feat of features) {
        const fo = obj(feat);
        if (fo === null) continue;
        if (fo.$type === "app.bsky.richtext.facet#tag") {
          const tag = str(fo.tag);
          if (tag !== null) tags.push(tag);
        } else if (fo.$type === "app.bsky.richtext.facet#link") {
          const uri = str(fo.uri);
          if (uri !== null) links.push(uri);
        }
      }
    }
  }
  const embedOut: { q?: string; e?: string } = {};
  readEmbed(obj(record.embed), links, embedOut);
  if (tags.length > 0) out.h = tags.slice(0, 10);
  if (links.length > 0) out.u = Array.from(new Set(links)).slice(0, 5);
  if (embedOut.q !== undefined) out.q = embedOut.q;
  if (embedOut.e !== undefined) out.e = embedOut.e;
  const parent = str(obj(obj(record.reply)?.parent)?.uri);
  if (parent !== null) out.rp = parent;
  return out;
}

/**
 * SlimEvent → Jetstream 원시 이벤트 모양. 픽스처 모드가 합성 이벤트를 실제 수신 경로
 * (JSON.parse → 게이지·Pulse·Mix·Tape·트렌드)에 그대로 태우기 위해 쓴다.
 * slimEvent(toRawEvent(e))는 e와 같다(테스트로 보장).
 */
export function toRawEvent(e: SlimEvent): Record<string, unknown> {
  const collection = e.c === "p" ? "app.bsky.feed.post" : e.c === "l" ? "app.bsky.feed.like" : "app.bsky.feed.repost";
  let record: Record<string, unknown>;
  if (e.c !== "p") {
    record = { $type: collection, subject: { uri: e.s, cid: "" }, createdAt: "" };
  } else {
    record = { $type: collection, text: e.x ?? "", createdAt: "" };
    if (e.g !== undefined) record.langs = e.g;
    const facets: unknown[] = [];
    for (const tag of e.h ?? []) facets.push({ features: [{ $type: "app.bsky.richtext.facet#tag", tag }] });
    for (const uri of e.u ?? []) facets.push({ features: [{ $type: "app.bsky.richtext.facet#link", uri }] });
    if (facets.length > 0) record.facets = facets;
    // 요약은 링크 카드 제목으로 되돌린다 — uri가 비어 있어 링크(u)로는 다시 읽히지 않는다
    const media = e.e !== undefined ? { $type: "app.bsky.embed.external", external: { uri: "", title: e.e } } : null;
    if (e.q !== undefined) {
      const rec = { uri: e.q };
      record.embed = media === null ? { $type: "app.bsky.embed.record", record: rec } : { $type: "app.bsky.embed.recordWithMedia", record: { record: rec }, media };
    } else if (media !== null) {
      record.embed = media;
    }
    if (e.rp !== undefined) record.reply = { parent: { uri: e.rp }, root: { uri: e.rp } };
  }
  return {
    did: e.d,
    time_us: e.t,
    kind: "commit",
    commit: { rev: "", operation: "create", collection, rkey: e.k ?? `fx${e.t}`, record },
  };
}
