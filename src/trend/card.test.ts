// M6 — 이벤트 카드 모델: 제목 우선순위, 대표 글, 링크 부착, 언어, ID 승계, 지나간 트렌드, 상한.

import { describe, expect, it } from "vitest";
import { TrendEngine } from "./engine.ts";
import type { Prior } from "./prior.ts";
import { synthStream, type SynthOptions } from "./synth.ts";
import type { TrendSnapshot } from "./types.ts";

const T0 = Date.UTC(2026, 10, 11, 9, 0, 0);
const MIN = 60_000;

const prior: Prior = {
  createdAt: new Date(T0 - 3_600_000).toISOString(),
  sourceMinutes: 60,
  postsPerMinute: 400,
  background: [],
  entries: new Map([["w:placeholder", { mu: 0.001, phi: 0.1 }]]),
};

function run(o: Partial<SynthOptions>): { snaps: TrendSnapshot[]; engine: TrendEngine } {
  const opts: SynthOptions = {
    seed: 7,
    startMs: T0,
    endMs: T0 + 25 * MIN,
    postsPerMin: 400,
    likesPerMin: 600,
    authorPool: 20_000,
    vocabSize: 3000,
    backgroundWords: [],
    ...o,
  };
  const engine = new TrendEngine({ nowMs: T0, prior });
  const snaps: TrendSnapshot[] = [];
  let next = T0 + 1000;
  for (const ev of synthStream(opts)) {
    const t = ev.t / 1000;
    while (next <= t) {
      const s = engine.tick(next);
      if (s !== null) snaps.push(s);
      next += 1000;
    }
    engine.ingest(ev, t);
  }
  while (next <= opts.endMs) {
    const s = engine.tick(next);
    if (s !== null) snaps.push(s);
    next += 1000;
  }
  return { snaps, engine };
}

describe("이벤트 카드", () => {
  const start = T0 + 12 * MIN;
  const r = run({
    topics: [
      {
        text: (_i, rr) => `#eclipse2026 total solar eclipse ${["amazing", "wow", "clouds", "photo"][Math.floor(rr() * 4)]}`,
        startMs: start,
        endMs: T0 + 20 * MIN,
        perMin: 25,
        authors: 5000,
        authorPrefix: "ecl",
        hashtags: ["eclipse2026"],
        langs: ["ja"],
        links: ["https://www.nasa.gov/eclipse?utm_source=x"],
      },
    ],
  });
  const activeSnaps = r.snaps.filter((s) => s.events.some((e) => e.state === "active" && e.members.some((m) => m.key === "h:eclipse2026")));
  // 주제가 한창인 시점(18분)의 카드
  const card = activeSnaps.filter((s) => s.ts <= T0 + 18 * MIN).at(-1)?.events.find((e) => e.members.some((m) => m.key === "h:eclipse2026"));

  it("해시태그·bigram·단어·링크가 한 이벤트로 묶이고 제목은 해시태그", () => {
    expect(card).toBeDefined();
    expect(card?.title).toBe("#eclipse2026");
    expect(card?.titleKind).toBe("h");
    const keys = card?.members.map((m) => m.key) ?? [];
    expect(keys.some((k) => k.startsWith("b:"))).toBe(true);
  });

  it("관련 단어에 다른 멤버 라벨이 들어간다", () => {
    expect(card?.related.length).toBeGreaterThan(0);
    expect(card?.related).not.toContain("#eclipse2026");
  });

  it("대표 글 2개 — 서로 다른 작성자, bsky.app 링크", () => {
    const posts = card?.representativePosts ?? [];
    expect(posts.length).toBe(2);
    expect(posts[0].did).not.toBe(posts[1].did);
    expect(posts[0].url).toMatch(/^https:\/\/bsky\.app\/profile\/did:plc:ecl\d+\/post\/3k/);
    expect(posts[0].text).toContain("eclipse");
  });

  it("링크 부착(정규화된 URL·도메인)과 언어", () => {
    expect(card?.link).toEqual({ url: "nasa.gov/eclipse", domain: "nasa.gov" });
    expect(card?.langs[0]).toBe("ja");
  });

  it("스파크라인 30포인트, 통계, 새 단어", () => {
    expect(card?.spark).toHaveLength(30);
    expect(card?.spark.at(-1)).toBeGreaterThan(0);
    expect(card?.stats.u).toBeGreaterThanOrEqual(8);
    expect(card?.stats.isNew).toBe(true);
    expect(card?.colorIdx).toBeGreaterThanOrEqual(0);
    expect(card?.colorIdx).toBeLessThan(12);
  });

  it("이벤트 ID는 틱이 지나도 유지된다", () => {
    const ids = new Set(activeSnaps.map((s) => s.events.find((e) => e.members.some((m) => m.key === "h:eclipse2026"))?.id));
    expect(ids.size).toBe(1);
  });

  it("주제가 끝나면 '지나간 트렌드'로 남았다가 15분 뒤 사라진다", () => {
    const id = card?.id;
    const past = r.snaps.find((s) => s.events.some((e) => e.id === id && e.state === "past"));
    expect(past).toBeDefined();
    const pastEv = past?.events.find((e) => e.id === id);
    expect(pastEv?.exitedAt).not.toBeNull();
    // 25분 시점: 퇴출(≈20~23분) 후 15분이 안 됐으므로 아직 남아 있다
    expect(r.snaps.at(-1)?.events.some((e) => e.id === id)).toBe(true);
  });

  it("화면 이벤트는 최대 15개, 진입 이벤트가 지나간 것보다 앞", () => {
    for (const s of r.snaps) {
      expect(s.events.length).toBeLessThanOrEqual(15);
      const firstPast = s.events.findIndex((e) => e.state === "past");
      if (firstPast >= 0) expect(s.events.slice(firstPast).every((e) => e.state === "past")).toBe(true);
    }
  });

  it("스파크·카드 값은 structured clone 가능한 plain 값", () => {
    expect(() => structuredClone(r.snaps.at(-1))).not.toThrow();
  });
});

describe("퍼지는 글", () => {
  it("좋아요가 몰리는 글은 퍼지는 글 1위 — p: 단독으로는 이벤트 카드가 되지 않는다", () => {
    const start = T0 + 12 * MIN;
    const { snaps, engine } = run({
      endMs: T0 + 18 * MIN,
      topics: [{ text: "look at this", startMs: start, endMs: T0 + 18 * MIN, perMin: 1, authors: 1, authorPrefix: "viral", likesPerMin: 40 }],
    });
    const last = snaps.at(-1);
    const top = last?.spreading[0];
    expect(top?.uri).toMatch(/^at:\/\/did:plc:viral0\/app\.bsky\.feed\.post\//);
    expect(top?.url).toMatch(/^https:\/\/bsky\.app\/profile\/did:plc:viral0\/post\//);
    expect(top?.p5).toBeGreaterThanOrEqual(15);
    expect(top?.text).toContain("look at this"); // 세션 중 본 글이라 하이드레이션 전에도 본문이 있다
    expect(engine.stateOf(`p:${top?.uri}`)).toBe("active");
    expect(last?.events.some((e) => e.members.some((m) => m.kind === "p"))).toBe(false);
  });
});

describe("관찰 카드(트렌드 판정 전)", () => {
  const start = T0 + 12 * MIN;
  const r = run({
    endMs: T0 + 18 * MIN,
    topics: [
      {
        text: (_i, rr) => `#eclipse2026 total solar eclipse ${["amazing", "wow", "clouds", "photo"][Math.floor(rr() * 4)]}`,
        startMs: start,
        endMs: T0 + 18 * MIN,
        perMin: 25,
        authors: 5000,
        authorPrefix: "ecl",
        hashtags: ["eclipse2026"],
        langs: ["ja"],
      },
    ],
  });

  it("세션 시작 1분 안에 판정 없이도 카드를 그린다", () => {
    const early = r.snaps.filter((s) => s.ts <= T0 + MIN);
    expect(early.some((s) => s.events.some((e) => e.state === "watch"))).toBe(true);
    for (const s of early) expect(s.events.every((e) => e.state !== "active")).toBe(true);
  });

  it("관찰 카드는 상한을 지키고 진입 이벤트 뒤·지나간 트렌드 앞에 온다", () => {
    for (const s of r.snaps) {
      expect(s.events.filter((e) => e.state === "watch").length).toBeLessThanOrEqual(8);
      expect(s.events.length).toBeLessThanOrEqual(15);
      const order = s.events.map((e) => (e.state === "active" ? 0 : e.state === "watch" ? 1 : 2));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });

  it("관찰 카드가 트렌드가 되면 같은 카드 ID를 이어받는다", () => {
    const watchSnap = r.snaps.find((s) => s.ts >= start && s.events.some((e) => e.state === "watch" && e.titleKey === "h:eclipse2026"));
    const activeSnap = r.snaps.find((s) => s.events.some((e) => e.state === "active" && e.members.some((m) => m.key === "h:eclipse2026")));
    expect(watchSnap).toBeDefined();
    expect(activeSnap).toBeDefined();
    const wid = watchSnap?.events.find((e) => e.titleKey === "h:eclipse2026")?.id;
    const aid = activeSnap?.events.find((e) => e.members.some((m) => m.key === "h:eclipse2026"))?.id;
    expect(aid).toBe(wid);
  });
});
