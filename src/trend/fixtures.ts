// 픽스처 시나리오 — 네트워크 없이 UI 전체(트렌드 카드·스웜·패널)를 돌리는 결정적 스트림.
//
// `?fixture=news`: 접속 시점(now)을 기준으로 과거 20분치 이력을 즉시 흘려 평소를 만들고,
// 그 뒤로는 실시간 재생한다. 접속 순간 이미 진입한 이벤트(링크 뉴스·퍼지는 글·짝)와
// 식는 중인 이벤트(곧 흩어짐), 몇 초 뒤 새로 떠오르는 이벤트가 섞여 있다.

import { makeVocab, type SynthOptions } from "./synth.ts";

const MIN = 60_000;

/** 배경 어휘 — 가상 음절어 대신 평범한 영어 명사(커서 이름 태그가 읽히도록) */
export const FIXTURE_VOCAB = [
  "coffee", "morning", "garden", "music", "weekend", "project", "dinner", "movie", "office", "train",
  "weather", "puppy", "kitten", "pizza", "concert", "library", "bicycle", "sunset", "podcast", "recipe",
  "painting", "camera", "travel", "beach", "mountain", "forest", "river", "breakfast", "laptop", "keyboard",
  "update", "release", "meeting", "deadline", "workout", "running", "yoga", "museum", "theater", "novel",
  "poetry", "sketch", "guitar", "piano", "festival", "market", "bakery", "noodles", "sandwich", "salad",
  "election", "budget", "council", "school", "teacher", "student", "hospital", "doctor", "nurse", "science",
  "research", "climate", "ocean", "satellite", "rocket", "telescope", "galaxy", "planet", "nature", "flowers",
  "spring", "autumn", "winter", "summer", "holiday", "birthday", "wedding", "family", "friends", "neighbor",
  "commute", "traffic", "airport", "hotel", "street", "city", "village", "island", "harbor", "bridge",
  "tea", "cookies", "chocolate", "candles", "blanket", "sweater", "boots", "umbrella", "window", "balcony",
];

export interface FixtureScenario {
  /** 과거 이력 길이(ms) — 이만큼 앞에서 시작해 즉시 흘린다 */
  historyMs: number;
  options: (now: number) => SynthOptions;
}

export const FIXTURES: Record<string, FixtureScenario> = {
  news: {
    historyMs: 20 * MIN,
    options: (now) => {
      const t0 = now - 20 * MIN;
      return {
        seed: 20261111,
        startMs: t0,
        endMs: now + 6 * 3600_000,
        postsPerMin: 420,
        likesPerMin: 700,
        authorPool: 40_000,
        // 상위 빈도는 읽히는 영어 명사, 꼬리는 가상 음절어 — 배경어 집합(상위 300)이 어휘 전체가 되지 않게
        vocabSize: 0,
        vocab: [...FIXTURE_VOCAB, ...makeVocab(1500, 99)],
        backgroundWords: [{ word: "trump", p: 0.03 }],
        topics: [
          // 식는 중: 학습(첫 10분)이 끝난 뒤 10분 전 시작, 2분 전부터 반감기 1.5분으로 감쇠
          // → 접속 시점엔 '식는 중'이고 1~2분 안에 퇴출돼 커서가 흩어진다
          {
            text: (_i, r) => `solar flare aurora tonight ${["wow", "photos", "north", "sky"][Math.floor(r() * 4)]}`,
            startMs: now - 10 * MIN,
            endMs: now + 10 * MIN,
            perMin: (t) => (t < now - 2 * MIN ? 18 : 18 * Math.pow(2, -(t - (now - 2 * MIN)) / (1.5 * MIN))),
            authors: 6000,
            authorPrefix: "flare",
            hashtags: ["aurora"],
          },
          // 접속 시점에 이미 진입: 링크 뉴스 + bigram
          {
            text: (_i, r) => `jury verdict announced ${["today", "finally", "breaking", "reaction"][Math.floor(r() * 4)]}`,
            startMs: now - 4 * MIN,
            endMs: now + 6 * 3600_000,
            perMin: 14,
            authors: 8000,
            authorPrefix: "jury",
            links: ["https://apnews.com/article/jury-verdict-trial-2026?utm_source=bsky"],
          },
          // 상시어의 짝
          {
            text: (_i, r) => `trump greenland ${["deal", "purchase", "plan", "talks"][Math.floor(r() * 4)]} again`,
            startMs: now - 5 * MIN,
            endMs: now + 6 * 3600_000,
            perMin: 16,
            authors: 8000,
            authorPrefix: "gl",
          },
          // 퍼지는 글 — 좋아요가 몰린다
          {
            text: "this thread about the city budget is incredible",
            startMs: now - 6 * MIN,
            endMs: now + 6 * 3600_000,
            perMin: 0.5,
            authors: 1,
            authorPrefix: "viral",
            likesPerMin: 90,
          },
          // 접속 몇 초 뒤 떠오름
          {
            text: (_i, r) => `#WorldCupFinal penalty shootout ${["unreal", "goal", "keeper", "crowd"][Math.floor(r() * 4)]}`,
            startMs: now + 2_000,
            endMs: now + 6 * 3600_000,
            perMin: (t) => Math.min(90, 30 + ((t - now) / 1000) * 2),
            authors: 9000,
            authorPrefix: "wc",
            hashtags: ["WorldCupFinal"],
          },
          {
            text: (_i, r) => `東京 地震 ${["揺れ", "速報", "大丈夫", "震度"][Math.floor(r() * 4)]}`,
            startMs: now + 35_000,
            endMs: now + 6 * 3600_000,
            perMin: 30,
            authors: 6000,
            authorPrefix: "eq",
            langs: ["ja"],
          },
        ],
      };
    },
  },
};
