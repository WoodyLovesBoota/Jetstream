import { describe, expect, it } from "vitest";
import { GET_POSTS_URL, Hydrator, parseGetPosts } from "./hydrate.ts";
import { postTitlePlaceholder } from "./types.ts";

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

  it("본문이 빈 글은 링크 카드 제목 → 인용 글 → 이미지 alt 순으로 채운다", () => {
    const out = parseGetPosts(
      {
        posts: [
          { uri: "at://link", record: { text: "", embed: { external: { uri: "https://x", title: "Sean Duffy says the air traffic control system will “continue to fail”" } } } },
          { uri: "at://rwm", record: { text: " ", embed: { media: { external: { title: "media link" } } } } },
          { uri: "at://quote", record: { text: "", embed: { record: { uri: "at://q" } } }, embed: { record: { value: { text: "quoted body" } } } },
          { uri: "at://img", record: { text: "", embed: { images: [{ alt: "" }, { alt: "a cat" }] } } },
          { uri: "at://both", record: { text: "own text", embed: { external: { title: "ignored" } } } },
          { uri: "at://none", record: { text: "" } },
        ],
      },
      0,
    );
    expect(out.map((p) => p.text)).toEqual([
      "Sean Duffy says the air traffic control system will “continue to fail”",
      "media link",
      "“quoted body”",
      "a cat",
      "own text",
      "",
    ]);
  });

  it("처음 보는 URI는 30초를 기다리지 않고 5초 만에 요청한다 — 응답에 없던 URI는 5분 동안 다시 안 묻는다", async () => {
    let now = 100_000;
    const urls: string[] = [];
    const h = new Hydrator({
      now: () => now,
      fetch: async (url) => {
        urls.push(url);
        // 삭제된 글(gone)은 응답에서 빠진다
        return okResponse(new URL(url).searchParams.getAll("uris").filter((u) => !u.endsWith("gone")));
      },
    });
    h.want(["at://a/app.bsky.feed.post/1", "at://a/app.bsky.feed.post/gone"]);
    await h.tick();
    expect(urls).toHaveLength(1);
    // 새 카드가 생겼다 — 5초 전엔 안 부르고, 5초가 지나면 부른다
    h.want(["at://a/app.bsky.feed.post/1", "at://a/app.bsky.feed.post/gone", "at://a/app.bsky.feed.post/2"]);
    now += 3_000;
    await h.tick();
    expect(urls).toHaveLength(1);
    now += 2_000;
    await h.tick();
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]).searchParams.getAll("uris")).toEqual(["at://a/app.bsky.feed.post/2"]);
    // gone은 새 URI가 아니다 — 1분이 지나도 다시 묻지 않는다
    now += 60_000;
    await h.tick();
    expect(urls).toHaveLength(2);
  });
});

describe("postTitlePlaceholder", () => {
  it("at:// URI의 rkey로 임시 제목을 만든다", () => {
    expect(postTitlePlaceholder("at://did:plc:abc/app.bsky.feed.post/3n2af54ydlz2z")).toBe("Post 3n2af54ydlz2z");
  });
});
