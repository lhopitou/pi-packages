/**
 * Per-language configuration for the ast_signatures tool.
 *
 * A "definition" node type is one we emit as a signature line and push onto the
 * nesting stack (so its children indent). An "override" node type is handled by
 * a named special-case handler in engine.ts instead of the generic path.
 *
 * Tree-sitter grammars consistently use a `body` field for the brace/colon block,
 * so the generic renderer slices the source from the node's start to the body's
 * start — yielding the verbatim signature header, losslessly.
 */

export interface LangConfig {
	/** tree-sitter-wasms grammar name (the WASM file without the prefix) */
	grammar: string;
	/** node types treated as definitions (emitted + pushed for nesting) */
	definitions: string[];
	/** node types handled by named override handlers in engine.ts */
	overrides?: string[];
}

/** TS/JS/TSX share node-type names; only the grammar (WASM) differs. */
function jsLike(grammar: string): LangConfig {
	return {
		grammar,
		definitions: [
			"function_declaration",
			"method_definition",
			"class_declaration",
			"interface_declaration",
			"type_alias_declaration",
			"enum_declaration",
		],
		overrides: ["lexical_declaration", "variable_declaration"],
	};
}

export const LANGUAGES: Record<string, LangConfig> = {
	ts: jsLike("typescript"),
	mts: jsLike("typescript"),
	cts: jsLike("typescript"),
	tsx: jsLike("tsx"),
	js: jsLike("javascript"),
	mjs: jsLike("javascript"),
	cjs: jsLike("javascript"),
	jsx: jsLike("javascript"),
	rs: {
		grammar: "rust",
		definitions: ["function_item", "struct_item", "enum_item", "trait_item", "impl_item"],
	},
	py: { grammar: "python", definitions: ["function_definition", "class_definition"] },
	pyi: { grammar: "python", definitions: ["function_definition", "class_definition"] },
	go: {
		grammar: "go",
		definitions: ["function_declaration", "method_declaration"],
		overrides: ["type_declaration"],
	},
};

export function configForPath(filePath: string): LangConfig | undefined {
	const dot = filePath.lastIndexOf(".");
	if (dot < 0) return undefined;
	const ext = filePath.slice(dot + 1).toLowerCase();
	return LANGUAGES[ext];
}
