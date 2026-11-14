import { describe, expect, it } from "vitest";
import { bskyUrl, extractKeys, kindOf, labelOf, normalizeWord, wordStream } from "./extract.ts";
import { stripKoreanParticle } from "./korean.ts";
import type { SlimEvent } from "./slim.ts";
import { slimEvent, toRawEvent } from "./slim.ts";
import { normalizeUrl } from "./url.ts";

const opt = (bg: string[] = []) => ({
  isBackground: (w: string) => bg.includes(w),
  pairMax: 10,
  wordsPerPostMax: 40,
});

function post(x: string, extra: Partial<SlimEvent> = {}): SlimEvent {
  return { t: 1, d: "did:plc:a", c: "p", k: "r1", x, ...extra };
}

function keys(ev: SlimEvent, bg: string[] = []): string[] {
  const out: string[] = [];
  extractKeys(ev, opt(bg), out);
  return out;
}

describe("토크나이저 — 영어", () => {
  it("3자 이상 소문자, 불용어 제거, 축약형 처리", () => {
    const k = keys(post("The Supreme Court's ruling on tariffs, don't panic!"));
    expect(k).toContain("w:supreme");
    expect(k).toContain("w:court");
    expect(k).toContain("w:ruling");
    expect(k).toContain("w:tariffs");
    expect(k).not.toContain("w:the");
    expect(k).not.toContain("w:don");
  });

  it("bigram은 불용어가 아닌 인접 두 단어, 구두점·불용어에서 끊긴다", () => {
    const k = keys(post("Supreme Court ruling. Tariffs are back"));
    expect(k).toContain("b:supreme court");
    expect(k).toContain("b:court ruling");
    expect(k).not.toContain("b:ruling tariffs"); // 마침표 경계
    expect(k).not.toContain("b:tariffs back"); // "are" 불용어 경계
  });

  it("URL·멘션은 단어가 되지 않는다", () => {
    const k = keys(post("read https://apnews.com/article/x @alice.bsky.social nytimes.com/foo now"));
    expect(k.filter((x) => x.startsWith("w:"))).toEqual(["w:read"]);
  });

  it("한 post 안 같은 키는 한 번만", () => {
    const k = keys(post("tariff tariff tariff #Tariff", { h: ["tariff"] }));
    expect(k.filter((x) => x === "w:tariff")).toHaveLength(1);
    expect(k.filter((x) => x === "h:tariff")).toHaveLength(1);
  });
});

describe("토크나이저 — 한·중·일", () => {
  it("한국어 끝 조사 제거(긴 것부터), 2자 이상", () => {
    expect(stripKoreanParticle("서울에서")).toBe("서울");
    expect(stripKoreanParticle("월드컵으로")).toBe("월드컵");
    expect(stripKoreanParticle("대통령은")).toBe("대통령");
    expect(stripKoreanParticle("아이")).toBe("아이"); // 남는 어간 1자 → 떼지 않음
    const k = keys(post("윤석열 대통령은 오늘 서울에서 월드컵을 봤다", { g: ["ko"] }));
    expect(k).toContain("w:대통령");
    expect(k).toContain("w:서울");
    expect(k).toContain("w:월드컵");
    expect(k).not.toContain("w:오늘"); // 불용어
  });

  it("일본어 — Segmenter, 히라가나 기능어 제외", () => {
    const k = keys(post("東京で地震が発生しました", { g: ["ja"] }));
    expect(k).toContain("w:東京");
    expect(k).toContain("w:地震");
    expect(k).toContain("w:発生");
    expect(k).not.toContain("w:で");
  });

  it("중국어 — Segmenter, 불용어 제외", () => {
    const k = keys(post("我们今天在北京看世界杯比赛", { g: ["zh"] }));
    expect(k).toContain("w:北京");
    expect(k.some((x) => x.startsWith("w:世界"))).toBe(true);
    expect(k).not.toContain("w:我们");
  });

  it("해시태그는 언어 무관, # 토큰과 facet 둘 다", () => {
    const k = keys(post("가자 #월드컵 #SuperBowl", { h: ["월드컵"] }));
    expect(k).toContain("h:월드컵");
    expect(k).toContain("h:superbowl");
  });

  it("한글 자모·숫자는 단어가 아니다", () => {
    expect(normalizeWord("ㅋㅋㅋㅋ")).toBeNull();
    expect(normalizeWord("2024")).toBeNull();
  });
});

describe("배경어 짝", () => {
  it("배경어 × 다른 단어 → c:a|b, 배경어끼리는 짝짓지 않음", () => {
    const k = keys(post("trump wants greenland again biden says"), ["trump", "biden"]);
    expect(k).toContain("c:trump|greenland");
    expect(k).toContain("c:biden|greenland");
    expect(k).not.toContain("c:trump|biden");
    expect(k).toContain("w:trump"); // 단어 키 자체는 남는다 — 게이트가 거른다
  });

  it("짝은 배경어 1개당 최대 pairMax", () => {
    const many = Array.from({ length: 20 }, (_, i) => `word${String.fromCharCode(97 + i)}x`).join(" ");
    const out: string[] = [];
    extractKeys(post(`trump ${many}`), { ...opt(["trump"]), pairMax: 10 }, out);
    expect(out.filter((x) => x.startsWith("c:"))).toHaveLength(10);
  });
});

describe("링크·인용·참여", () => {
  it("URL 정규화: 쿼리·utm·해시·www·끝 슬래시 제거", () => {
    expect(normalizeUrl("https://www.apnews.com/article/abc/?utm_source=x#top")).toEqual({
      url: "apnews.com/article/abc",
      domain: "apnews.com",
    });
    expect(normalizeUrl("http://M.Example.co.uk/a/b/")?.url).toBe("example.co.uk/a/b");
    expect(normalizeUrl("https://youtu.be/dQw4w9WgXcQ?si=zz")?.url).toBe("youtube.com/watch?v=dQw4w9WgXcQ");
    expect(normalizeUrl("https://www.youtube.com/watch?v=abc&t=10")?.url).toBe("youtube.com/watch?v=abc");
    expect(normalizeUrl("mailto:a@b.c")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });

  it("post 링크 → u:·d:, 인용 → q:", () => {
    const k = keys(post("look", { u: ["https://apnews.com/x?utm=1"], q: "at://did:plc:b/app.bsky.feed.post/r9" }));
    expect(k).toContain("u:apnews.com/x");
    expect(k).toContain("d:apnews.com");
    expect(k).toContain("q:at://did:plc:b/app.bsky.feed.post/r9");
  });

  it("like/repost → p:대상", () => {
    expect(keys({ t: 1, d: "did:plc:a", c: "l", s: "at://x/app.bsky.feed.post/1" })).toEqual([
      "p:at://x/app.bsky.feed.post/1",
    ]);
  });

  it("slimEvent: facet·embed·recordWithMedia·subject 읽기", () => {
    const raw = {
      did: "did:plc:a",
      time_us: 5,
      kind: "commit",
      commit: {
        collection: "app.bsky.feed.post",
        operation: "create",
        rkey: "rk",
        record: {
          text: "hi",
          langs: ["en"],
          facets: [
            { features: [{ $type: "app.bsky.richtext.facet#tag", tag: "News" }] },
            { features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://a.com/1" }] },
          ],
          embed: {
            $type: "app.bsky.embed.recordWithMedia",
            record: { record: { uri: "at://q/app.bsky.feed.post/2" } },
            media: { $type: "app.bsky.embed.external", external: { uri: "https://b.com/2" } },
          },
          reply: { parent: { uri: "at://p/app.bsky.feed.post/3" } },
        },
      },
    };
    expect(slimEvent(raw)).toEqual({
      t: 5,
      d: "did:plc:a",
      c: "p",
      k: "rk",
      x: "hi",
      g: ["en"],
      h: ["News"],
      u: ["https://a.com/1", "https://b.com/2"],
      q: "at://q/app.bsky.feed.post/2",
      rp: "at://p/app.bsky.feed.post/3",
    });
    expect(
      slimEvent({
        did: "did:plc:a",
        time_us: 6,
        kind: "commit",
        commit: { collection: "app.bsky.feed.repost", operation: "create", record: { subject: { uri: "at://s" } } },
      }),
    ).toEqual({ t: 6, d: "did:plc:a", c: "r", s: "at://s" });
    expect(slimEvent({ kind: "identity" })).toBeNull();
  });
});

describe("보조", () => {
  it("kindOf / labelOf / bskyUrl", () => {
    expect(kindOf("c:trump|greenland")).toBe("c");
    expect(labelOf("c:trump|greenland")).toBe("trump · greenland");
    expect(labelOf("h:월드컵")).toBe("#월드컵");
    expect(bskyUrl("at://did:plc:a/app.bsky.feed.post/xyz")).toBe("https://bsky.app/profile/did:plc:a/post/xyz");
  });

  it("wordStream은 경계에 null", () => {
    const out: (string | null)[] = [];
    wordStream("alpha beta, gamma", undefined, out);
    expect(out).toEqual(["alpha", "beta", null, "gamma"]);
  });

  it("slimEvent: 링크 카드 제목·이미지 alt를 embed 요약(e)으로 — 본문이 빈 글의 대체 문구", () => {
    const post = (embed: unknown) => ({
      did: "did:plc:a",
      time_us: 7,
      kind: "commit",
      commit: { collection: "app.bsky.feed.post", operation: "create", rkey: "rk", record: { text: "", embed } },
    });
    const title = "Sean Duffy says the air traffic control system will “continue to fail”";
    expect(slimEvent(post({ $type: "app.bsky.embed.external", external: { uri: "https://v.com/1", title } }))).toEqual({
      t: 7,
      d: "did:plc:a",
      c: "p",
      k: "rk",
      u: ["https://v.com/1"],
      e: title,
    });
    expect(slimEvent(post({ $type: "app.bsky.embed.images", images: [{ alt: " " }, { alt: "a cat" }] }))?.e).toBe("a cat");
    expect(
      slimEvent(post({ $type: "app.bsky.embed.recordWithMedia", record: { record: { uri: "at://q" } }, media: { $type: "app.bsky.embed.external", external: { uri: "https://v.com/2", title: "t2" } } }))?.e,
    ).toBe("t2");
    expect(slimEvent(post({ $type: "app.bsky.embed.external", external: { uri: "https://v.com/3", title: "" } }))?.e).toBeUndefined();
  });

  it("toRawEvent → slimEvent 왕복은 같은 이벤트 (embed 요약 포함)", () => {
    const cases: SlimEvent[] = [
      { t: 1, d: "did:plc:a", c: "p", k: "r1", x: "hi", g: ["ko"], h: ["Tag"], u: ["https://a.com/1"] },
      { t: 2, d: "did:plc:a", c: "p", k: "r2", u: ["https://a.com/2"], e: "headline" },
      { t: 3, d: "did:plc:a", c: "p", k: "r3", q: "at://q/app.bsky.feed.post/1", e: "headline" },
      { t: 4, d: "did:plc:a", c: "l", s: "at://s" },
    ];
    for (const e of cases) expect(slimEvent(toRawEvent(e))).toEqual(e);
  });
});
