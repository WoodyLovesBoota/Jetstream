import { describe, expect, it } from "vitest";
import { GET_POSTS_URL, Hydrator, parseGetPosts } from "./hydrate.ts";

function okResponse(uris: string[]): { ok: boolean; status: number; json(): Promise<unknown> } {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      posts: uris.map((uri) => ({
        uri,
        author: { handle: "alice.bsky.social", displayName: "Alice" },
        record: { text: `text of ${uri}` },
        likeCount: 7,
        repostCount: 2,
      })),
    }),
  };
}

describe("getPosts 하이드레이션", () => {
  it("응답 파싱 — 형식이 어긋난 항목은 버린다", () => {
    const out = parseGetPosts({ posts: [{ uri: "at://a", record: { text: "hi" }, author: { handle: "h" }, likeCount: 3 }, null, { nope: 1 }] }, 9);
    expect(out).toEqual([{ uri: "at://a", text: "hi", handle: "h", displayName: "", likeCount: 3, repostCount: 0, fetchedAt: 9 }]);
    expect(parseGetPosts("garbage", 0)).toEqual([]);
  });

  it("상위 20개만, 25개씩 묶어 요청하고 캐시를 채운다", async () => {
    let now = 100_000;
    const urls: string[] = [];
    const h = new Hydrator({
      now: () => now,
      fetch: async (url) => {
        urls.push(url);
        const uris = new URL(url).searchParams.getAll("uris");
        return okResponse(uris);
      },
    });
    h.want(Array.from({ length: 30 }, (_, i) => `at://did:plc:x/app.bsky.feed.post/${i}`));
    await h.tick();
    expect(urls).toHaveLength(1);
    expect(urls[0].startsWith(GET_POSTS_URL)).toBe(true);
    expect(new URL(urls[0]).searchParams.getAll("uris")).toHaveLength(20);
    expect(h.get("at://did:plc:x/app.bsky.feed.post/3")?.text).toBe("text of at://did:plc:x/app.bsky.feed.post/3");
    // 30초 안엔 다시 부르지 않고, 다 채워졌으면 30초 뒤에도 부르지 않는다
    now += 10_000;
    await h.tick();
    now += 40_000;
    await h.tick();
    expect(urls).toHaveLength(1);
  });

  it("실패(CORS·네트워크)는 조용히 지수 백오프 후 재시도", async () => {
    let now = 0;
    let fail = true;
    let calls = 0;
    const h = new Hydrator({
      now: () => now,
      fetch: async (url) => {
        calls++;
        if (fail) throw new TypeError("Failed to fetch");
        return okResponse(new URL(url).searchParams.getAll("uris"));
      },
    });
    h.want(["at://a/app.bsky.feed.post/1"]);
    await h.tick(); // 실패 1 → 5초 백오프
    expect(h.errors).toBe(1);
    now += 3_000;
    await h.tick();
    expect(calls).toBe(1); // 백오프 중
    now += 3_000;
    await h.tick(); // 실패 2 → 10초
    expect(calls).toBe(2);
    now += 9_000;
    await h.tick();
    expect(calls).toBe(2);
    fail = false;
    now += 2_000;
    await h.tick();
    expect(calls).toBe(3);
    expect(h.get("at://a/app.bsky.feed.post/1")).toBeDefined();
  });

  it("HTTP 오류도 실패로 친다", async () => {
    const h = new Hydrator({ now: () => 0, fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
    h.want(["at://a"]);
    await h.tick();
    expect(h.errors).toBe(1);
  });
});
