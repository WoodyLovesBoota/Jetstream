import { describe, expect, it } from "vitest";
import {
  DEFAULT_WANTED_COLLECTIONS,
  collectionsFor,
  instanceLabel,
} from "./protocol";

describe("instanceLabel", () => {
  it("turns an official instance URL into an abbreviated label that fits the HUD width", () => {
    expect(instanceLabel("wss://jetstream2.us-east.bsky.network/subscribe")).toBe("js2.us-east");
    expect(instanceLabel("wss://jetstream1.us-west.bsky.network/subscribe")).toBe("js1.us-west");
  });

  it("shows hosts outside the pattern as the host verbatim — it does not invent one", () => {
    expect(instanceLabel("wss://example.com/subscribe")).toBe("example.com");
  });
});

describe("collectionsFor", () => {
  it("full is an empty array (parameter omitted = whole stream), filtered is the default collections", () => {
    expect(collectionsFor("full")).toEqual([]);
    expect(collectionsFor("filtered")).toEqual(DEFAULT_WANTED_COLLECTIONS);
  });
});
