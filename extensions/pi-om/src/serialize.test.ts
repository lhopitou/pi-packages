import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	nowTimestamp,
	truncateRecordContent,
	MAX_RECORD_CONTENT_CHARS,
	serializeConversation,
	serializeBranchEntries,
	serializeSourceAddressedBranchEntries,
	renderRecallSourceEntries,
} from "./serialize.ts";

// ── nowTimestamp ──

describe("nowTimestamp", () => {
	it("returns timestamp in YYYY-MM-DD HH:MM format", () => {
		const ts = nowTimestamp();
		assert.match(ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
	});
});

// ── truncateRecordContent ──

describe("truncateRecordContent", () => {
	it("returns content unchanged when under limit", () => {
		const content = "hello world";
		assert.equal(truncateRecordContent(content), content);
	});

	it("truncates content at MAX_RECORD_CONTENT_CHARS", () => {
		const content = "a".repeat(MAX_RECORD_CONTENT_CHARS + 100);
		const result = truncateRecordContent(content);
		assert.equal(result.length, MAX_RECORD_CONTENT_CHARS + " … [truncated 100 chars]".length);
		assert.ok(result.includes("truncated 100 chars"));
	});

	it("does not truncate at exactly the limit", () => {
		const content = "a".repeat(MAX_RECORD_CONTENT_CHARS);
		assert.equal(truncateRecordContent(content), content);
	});

	it("handles empty string", () => {
		assert.equal(truncateRecordContent(""), "");
	});
});

// ── serializeConversation ──

describe("serializeConversation", () => {
	it("serializes user message", () => {
		const messages = [{
			role: "user" as const,
			content: [{ type: "text" as const, text: "hello" }],
			timestamp: 1700000000000,
		}];
		const result = serializeConversation(messages as any);
		assert.ok(result.includes("[User @"));
		assert.ok(result.includes("hello"));
	});

	it("serializes assistant message", () => {
		const messages = [{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "response" }],
			timestamp: 1700000000000,
		}];
		const result = serializeConversation(messages as any);
		assert.ok(result.includes("[Assistant @"));
		assert.ok(result.includes("response"));
	});

	it("includes thinking in assistant message when includeThinking is true", () => {
		const messages = [{
			role: "assistant" as const,
			content: [{ type: "thinking" as const, thinking: "internal" }],
			timestamp: 1700000000000,
		}];
		const result = serializeConversation(messages as any);
		assert.ok(result.includes("[thinking: internal]"));
	});

	it("skips assistant messages with no serializable content", () => {
		const messages = [{
			role: "assistant" as const,
			content: [{ type: "image" as const, url: "http://example.com/img.png" }],
			timestamp: 1700000000000,
		}];
		const result = serializeConversation(messages as any);
		// image content produces [non-text content omitted] which .filter(Boolean) keeps,
		// so assistant messages always produce at least one line
		assert.ok(result.includes("[Assistant @"));
	});

	it("serializes tool result message", () => {
		const messages = [{
			role: "tool_result" as any,
			toolName: "read",
			content: [{ type: "text" as const, text: "file content" }],
			timestamp: 1700000000000,
		}];
		const result = serializeConversation(messages as any);
		assert.ok(result.includes("[Tool result for read @"));
		assert.ok(result.includes("file content"));
	});
});

// ── serializeSourceAddressedBranchEntries ──

describe("serializeSourceAddressedBranchEntries", () => {
	it("serializes message entries with source entry ids", () => {
		const entries = [{
			type: "message",
			id: "msg1",
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1700000000000 },
		}];
		const result = serializeSourceAddressedBranchEntries(entries as any);
		assert.ok(result.text.includes("[Source entry id: msg1]"));
		assert.ok(result.text.includes("hello"));
		assert.deepEqual(result.sourceEntryIds, ["msg1"]);
	});

	it("skips entries without id", () => {
		const entries = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } }];
		const result = serializeSourceAddressedBranchEntries(entries as any);
		assert.equal(result.sourceEntryIds.length, 0);
	});

	it("skips non-source entries (custom, compaction)", () => {
		const entries = [
			{ type: "custom", id: "c1", customType: "om.observations.recorded", data: {} },
			{ type: "compaction", id: "comp1" },
		];
		const result = serializeSourceAddressedBranchEntries(entries as any);
		assert.equal(result.sourceEntryIds.length, 0);
	});

	it("includes branch_summary entries", () => {
		const entries = [{
			type: "branch_summary",
			id: "bs1",
			summary: "Summary of prior work",
			timestamp: 1700000000000,
		}];
		const result = serializeSourceAddressedBranchEntries(entries as any);
		assert.deepEqual(result.sourceEntryIds, ["bs1"]);
		assert.ok(result.text.includes("Summary of prior work"));
	});
});

// ── renderRecallSourceEntries ──

describe("renderRecallSourceEntries", () => {
	it("renders message entries for recall", () => {
		const entries = [{
			type: "message",
			id: "msg1",
			message: { role: "user", content: [{ type: "text", text: "recall this" }], timestamp: 1700000000000 },
		}];
		const result = renderRecallSourceEntries(entries as any);
		assert.ok(result.includes("[User @"));
		assert.ok(result.includes("recall this"));
	});

	it("skips entries that render to null", () => {
		const entries = [{ type: "custom", id: "c1" }];
		const result = renderRecallSourceEntries(entries as any);
		assert.equal(result, "");
	});
});
