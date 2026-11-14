// 퍼지는 글 하이드레이션 — 공개 AppView getPosts로 본문·작성자·카운트를 채운다(메인 스레드).
//
// · 30초마다(처음 보는 URI가 있으면 5초 만에), 원하는 URI(상위 20) 중 없는 것·오래된 것(5분)만
//   25개씩 요청한다(무인증). 본문이 빈 글은 링크 카드 제목·인용 글·이미지 alt로 채운다.
// · CORS·네트워크·HTTP 오류는 조용히 지수 백오프(5초 → 최대 5분). 스트림 처리와 무관하다 —
//   워커가 아니라 메인 스레드의 비동기 fetch이고, 실패해도 UI는 URI·bsky.app 링크로 남는다.
// · fetch와 시계를 주입받아 테스트에서 네트워크 없이 돈다.

export const GET_POSTS_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";
export const HYDRATE_BATCH = 25;
export const HYDRATE_EVERY_MS = 30_000;
export const HYDRATE_STALE_MS = 5 * 60_000;
/** 한 번도 요청 안 한 URI(새 카드)가 있으면 30초를 다 기다리지 않는다 — 카드가 `Post <rkey>`로 오래 남지 않게 */
export const HYDRATE_NEW_MS = 5_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const CACHE_CAP = 500;

export interface HydratedPost {
  uri: string;
  text: string;
  handle: string;
  displayName: string;
  likeCount: number;
  repostCount: number;
  fetchedAt: number;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface HydratorDeps {
  fetch: FetchLike;
  now: () => number;
  onUpdate?: () => void;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/**
 * 본문이 빈 글(링크·이미지·인용만 올린 글)의 대신 보여 줄 문구 — 링크 카드 제목 → 인용 글 본문
 * → 이미지 alt 순. 뉴스 봇이 링크 카드만 올리는 경우가 흔해서, 이게 없으면 카드가 rkey만 남는다.
 * record.embed(원본 레코드)와 o.embed(AppView 뷰)를 둘 다 본다 — 인용 글 본문은 뷰에만 있다.
 */
function embedSummary(record: Record<string, unknown>, view: Record<string, unknown>): string {
  const raw = obj(record.embed);
  // recordWithMedia는 media 아래에 external/images가 한 겹 더 들어간다
  const media = obj(raw.media);
  const external = obj(raw.external ?? media.external);
  const linkTitle = str(external.title).trim() || str(external.description).trim();
  if (linkTitle !== "") return linkTitle;

  // 인용: record#view → record.value.text, recordWithMedia#view → record.record.value.text
  const quoted = obj(view.record);
  const quotedText = str(obj(quoted.value).text).trim() || str(obj(obj(quoted.record).value).text).trim();
  if (quotedText !== "") return `“${quotedText}”`;

  const images = Array.isArray(raw.images) ? raw.images : Array.isArray(media.images) ? media.images : [];
  for (const img of images) {
    const alt = str(obj(img).alt).trim();
    if (alt !== "") return alt;
  }
  return "";
}

/** getPosts 응답 → HydratedPost[] (형식이 어긋난 항목은 버린다). 본문이 비면 embed 요약으로 채운다 */
export function parseGetPosts(json: unknown, now: number): HydratedPost[] {
  const posts = (json as { posts?: unknown })?.posts;
  if (!Array.isArray(posts)) return [];
  const out: HydratedPost[] = [];
  for (const p of posts) {
    if (typeof p !== "object" || p === null) continue;
    const o = p as Record<string, unknown>;
    const uri = str(o.uri);
    if (uri.length === 0) continue;
    const author = (o.author ?? {}) as Record<string, unknown>;
    const record = (o.record ?? {}) as Record<string, unknown>;
    out.push({
      uri,
      text: str(record.text).trim() !== "" ? str(record.text) : embedSummary(record, obj(o.embed)),
      handle: str(author.handle),
      displayName: str(author.displayName),
      likeCount: num(o.likeCount),
      repostCount: num(o.repostCount),
      fetchedAt: now,
    });
  }
  return out;
}

export class Hydrator {
  private readonly cache = new Map<string, HydratedPost>();
  /** 요청은 했는데 응답에 없던 URI(삭제·비공개) → 요청 시각. 새 URI 판정과 재요청 간격에 쓴다 */
  private readonly tried = new Map<string, number>();
  private wanted: string[] = [];
  private failures = 0;
  private nextAllowedAt = 0;
  private lastRunAt = -Infinity;
  private inflight = false;
  private readonly deps: HydratorDeps;
  /** 통계 — HUD·테스트용 */
  requests = 0;
  errors = 0;

  constructor(deps: HydratorDeps) {
    this.deps = deps;
  }

  /** 지금 화면이 원하는 at:// URI들(우선순위 순). 상위 20개만 본다 */
  want(uris: readonly string[]): void {
    const seen = new Set<string>();
    this.wanted = [];
    for (const u of uris) {
      if (!u.startsWith("at://") || seen.has(u)) continue;
      seen.add(u);
      this.wanted.push(u);
      if (this.wanted.length >= 20) break;
    }
  }

  get(uri: string): HydratedPost | undefined {
    return this.cache.get(uri);
  }

  /** 주기 호출(예: 1초마다). 30초 주기·백오프를 스스로 지킨다 */
  async tick(): Promise<void> {
    const now = this.deps.now();
    if (this.inflight || now < this.nextAllowedAt) return;
    const need = this.wanted.filter((u) => {
      const c = this.cache.get(u);
      if (c !== undefined) return now - c.fetchedAt > HYDRATE_STALE_MS;
      const t = this.tried.get(u);
      return t === undefined || now - t > HYDRATE_STALE_MS;
    });
    if (need.length === 0) return;
    const hasNew = need.some((u) => !this.cache.has(u) && !this.tried.has(u));
    if (now - this.lastRunAt < (hasNew ? HYDRATE_NEW_MS : HYDRATE_EVERY_MS)) return;
    this.lastRunAt = now;
    this.inflight = true;
    try {
      for (let i = 0; i < need.length; i += HYDRATE_BATCH) {
        const batch = need.slice(i, i + HYDRATE_BATCH);
        const qs = batch.map((u) => `uris=${encodeURIComponent(u)}`).join("&");
        this.requests++;
        const res = await this.deps.fetch(`${GET_POSTS_URL}?${qs}`);
        if (!res.ok) throw new Error(`getPosts HTTP ${res.status}`);
        for (const u of batch) this.tried.set(u, now);
        for (const p of parseGetPosts(await res.json(), this.deps.now())) this.cache.set(p.uri, p);
      }
      this.failures = 0;
      this.nextAllowedAt = 0;
      if (this.tried.size > CACHE_CAP * 2) this.tried.clear();
      while (this.cache.size > CACHE_CAP) {
        const first = this.cache.keys().next();
        if (first.done === true) break;
        this.cache.delete(first.value);
      }
      this.deps.onUpdate?.();
    } catch {
      // CORS·오프라인·HTTP 오류 — 조용히 물러난다. 화면은 URI·bsky.app 링크로 남는다.
      this.errors++;
      this.failures++;
      this.nextAllowedAt = this.deps.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.failures - 1));
      this.lastRunAt = -Infinity; // 백오프가 끝나면 30초를 기다리지 않고 바로 재시도
    } finally {
      this.inflight = false;
    }
  }
}
