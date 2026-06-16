import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "./model-budget.ts";

describe("boundedMaxTokens", () => {
	it("returns requested value when model has no maxTokens", () => {
		assert.equal(boundedMaxTokens({} as any, 100), 100);
	});

	it("returns requested value when model.maxTokens exceeds requested", () => {
		assert.equal(boundedMaxTokens({ maxTokens: 200 } as any, 100), 100);
	});

	it("returns model.maxTokens when it is less than requested", () => {
		assert.equal(boundedMaxTokens({ maxTokens: 50 } as any, 100), 50);
	});

	it("returns default AGENT_LOOP_MAX_TOKENS when no requested value", () => {
		assert.equal(boundedMaxTokens({} as any), AGENT_LOOP_MAX_TOKENS);
	});

	it("returns requested value when model.maxTokens is 0 or negative", () => {
		assert.equal(boundedMaxTokens({ maxTokens: 0 } as any, 100), 100);
		assert.equal(boundedMaxTokens({ maxTokens: -1 } as any, 100), 100);
	});
});
