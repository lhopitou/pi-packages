import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashId, accumulateWithCollisionCheck } from "./ids.ts";

describe("hashId", () => {
  it("returns 16 lowercase hex characters", () => {
    const id = hashId("test content");
    assert.match(id, /^[a-f0-9]{16}$/);
  });

  it("is deterministic for the same input", () => {
    const a = hashId("hello world");
    const b = hashId("hello world");
    assert.equal(a, b);
  });

  it("produces different ids for different inputs", () => {
    const a = hashId("hello");
    const b = hashId("world");
    assert.notEqual(a, b);
  });

  it("handles empty string", () => {
    const id = hashId("");
    assert.match(id, /^[a-f0-9]{16}$/);
  });

  it("handles unicode input", () => {
    const id = hashId("héllo wörld 日本語");
    assert.match(id, /^[a-f0-9]{16}$/);
  });

  it("handles very long input", () => {
    const id = hashId("x".repeat(100_000));
    assert.match(id, /^[a-f0-9]{16}$/);
  });

  it("produces the expected sha256 prefix", () => {
    // sha256("test") = 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
    assert.equal(hashId("test"), "9f86d081884c7d65");
  });
});

describe("accumulateWithCollisionCheck", () => {
  it("inserts new item and returns true", () => {
    const map = new Map<string, { id: string; content: string }>();
    const result = accumulateWithCollisionCheck(
      map,
      { id: "abc123", content: "hello" },
      "test",
    );
    assert.equal(result, true);
    assert.equal(map.size, 1);
  });

  it("returns false for duplicate id with same content (dedup)", () => {
    const map = new Map<string, { id: string; content: string }>();
    accumulateWithCollisionCheck(
      map,
      { id: "abc123", content: "hello" },
      "test",
    );
    const result = accumulateWithCollisionCheck(
      map,
      { id: "abc123", content: "hello" },
      "test",
    );
    assert.equal(result, false);
    assert.equal(map.size, 1);
  });

  it("returns false for duplicate id with different content (collision)", () => {
    const map = new Map<string, { id: string; content: string }>();
    accumulateWithCollisionCheck(
      map,
      { id: "abc123", content: "hello" },
      "test",
    );
    const result = accumulateWithCollisionCheck(
      map,
      { id: "abc123", content: "different" },
      "test",
    );
    assert.equal(result, false);
    assert.equal(map.size, 1);
  });
});
