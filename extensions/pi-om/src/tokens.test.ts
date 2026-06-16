import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateStringTokens } from "./tokens.ts";

describe("estimateStringTokens", () => {
	it("returns ceil of length/4", () => {
		assert.equal(estimateStringTokens("hello"), 2); // 5/4 = 1.25 → ceil = 2
		assert.equal(estimateStringTokens("abcd"), 1); // 4/4 = 1
		assert.equal(estimateStringTokens(""), 0);
	});

	it("handles long strings", () => {
		assert.equal(estimateStringTokens("a".repeat(1000)), 250);
	});

	it("handles unicode strings", () => {
		// Unicode chars may be longer in bytes but length counts chars
		const result = estimateStringTokens("日本語テスト");
		assert.ok(result > 0);
	});
});
