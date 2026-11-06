import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  safeDebugLogSessionId,
  debugLogRelativePath,
  DEBUG_LOG_RELATIVE_PATH,
  DEBUG_LOG_SESSION_DIR_RELATIVE_PATH,
} from "./debug-log.ts";

describe("safeDebugLogSessionId", () => {
  it("returns undefined for undefined input", () => {
    assert.equal(safeDebugLogSessionId(undefined), undefined);
  });

  it("returns undefined for empty string", () => {
    assert.equal(safeDebugLogSessionId(""), undefined);
  });

  it("returns undefined for whitespace-only string", () => {
    assert.equal(safeDebugLogSessionId("   "), undefined);
  });

  it("sanitizes special characters", () => {
    const result = safeDebugLogSessionId("session/with:bad*chars");
    assert.ok(result !== undefined);
    assert.ok(!result.includes("/"));
    assert.ok(!result.includes(":"));
    assert.ok(!result.includes("*"));
  });

  it("preserves alphanumeric and safe chars", () => {
    const result = safeDebugLogSessionId("session-123_test.txt");
    assert.equal(result, "session-123_test.txt");
  });

  it("trims to 128 chars max", () => {
    const result = safeDebugLogSessionId("a".repeat(200));
    assert.ok(result !== undefined);
    assert.equal(result!.length, 128);
  });

  it("returns undefined when result has no alphanumeric chars", () => {
    assert.equal(safeDebugLogSessionId("---"), undefined);
  });

  it("trims leading/trailing underscores", () => {
    const result = safeDebugLogSessionId("_test_");
    assert.equal(result, "test");
  });
});

describe("debugLogRelativePath", () => {
  it("returns default path when no session id", () => {
    const result = debugLogRelativePath({});
    assert.equal(result, DEBUG_LOG_RELATIVE_PATH);
  });

  it("returns session-specific path when session id is valid", () => {
    const result = debugLogRelativePath({ sessionId: "test-session-123" });
    assert.equal(
      result,
      `${DEBUG_LOG_SESSION_DIR_RELATIVE_PATH}/test-session-123.ndjson`,
    );
  });

  it("returns default path when session id is invalid", () => {
    const result = debugLogRelativePath({ sessionId: "   " });
    assert.equal(result, DEBUG_LOG_RELATIVE_PATH);
  });
});
