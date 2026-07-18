import { describe, expect, it } from "vitest";
import {
  DEFAULT_WANTED_COLLECTIONS,
  collectionsFor,
  instanceLabel,
} from "./protocol";

describe("instanceLabel", () => {
  it("공식 인스턴스 URL을 HUD 폭에 맞는 축약 라벨로 만든다", () => {
    expect(instanceLabel("wss://jetstream2.us-east.bsky.network/subscribe")).toBe("js2.us-east");
    expect(instanceLabel("wss://jetstream1.us-west.bsky.network/subscribe")).toBe("js1.us-west");
  });

  it("패턴 밖 호스트는 host 그대로 보여준다 — 지어내지 않는다", () => {
    expect(instanceLabel("wss://example.com/subscribe")).toBe("example.com");
  });
});

describe("collectionsFor", () => {
  it("full은 빈 배열(파라미터 생략 = 전체 스트림), filtered는 기본 컬렉션이다", () => {
    expect(collectionsFor("full")).toEqual([]);
    expect(collectionsFor("filtered")).toEqual(DEFAULT_WANTED_COLLECTIONS);
  });
});
