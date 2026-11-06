/**
 * Tree-sitter engine for ast_signatures.
 *
 * Lazy-loads web-tree-sitter (WASM) and the per-language grammar on first use,
 * parses the source, and walks the tree once to collect "blocks": one block per
 * top-level definition, containing its signature line plus any nested signature
 * lines (indented). Paging (`after`) is by top-level definition — a parent is
 * never split from its members.
 *
 * Output line shape (text-only for now): `<verbatim header slice>  Lstart-end`,
 * indented by nesting depth. The verbatim slice contains the language's own
 * keyword (function/def/func/class/pub fn/...), so no separate kind label is
 * prepended — the keyword IS the kind, in full.
 */

import TreeSitter from "web-tree-sitter";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { LangConfig } from "./languages.ts";

const require = createRequire(import.meta.url);
function wasmPath(grammar: string): string {
  return require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
}

// Minimal structural view of a tree-sitter Node (we use `any` at runtime).
interface NodeLike {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childForFieldName(name: string): NodeLike | null;
  namedChildren: NodeLike[];
}

let initPromise: Promise<void> | null = null;
const langCache = new Map<string, Promise<unknown>>();

async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = (TreeSitter as any).init();
  await initPromise;
}

async function getLanguage(grammar: string): Promise<any> {
  let p = langCache.get(grammar);
  if (!p) {
    p = (async () => {
      await ensureInit();
      const buf = readFileSync(wasmPath(grammar));
      return (TreeSitter as any).Language.load(buf);
    })();
    langCache.set(grammar, p);
  }
  return p;
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Verbatim signature: source text from node start to its `body` child's start
 * (or node end if there is no body), whitespace-collapsed, trailing block colon stripped.
 *
 * web-tree-sitter 0.20.x reports startIndex/endIndex as UTF-16 code-unit offsets
 * (matching JS string indices), so we slice the source string directly — NOT a
 * byte buffer, which would drift on any non-ASCII content. */
function headerSlice(node: NodeLike, src: string): string {
  const body = node.childForFieldName("body");
  const end = body ? body.startIndex : node.endIndex;
  let sig = src.slice(node.startIndex, end);
  sig = collapseWs(sig);
  // Python's block colon is part of the slice; strip a single trailing colon.
  sig = sig.replace(/:$/, "").trim();
  return sig;
}

function rangeStr(node: NodeLike): string {
  const s = node.startPosition.row + 1;
  const e = node.endPosition.row + 1;
  return s === e ? `L${s}` : `L${s}-${e}`;
}

export interface ExtractResult {
  blocks: string[];
  totalLines: number;
}

/** Parse source text with the configured grammar; caller must `tree.delete()`. */
export async function parseSource(grammar: string, src: string): Promise<any> {
  const lang = await getLanguage(grammar);
  const parser: any = new (TreeSitter as any)();
  parser.setLanguage(lang);
  const tree = parser.parse(src);
  parser.delete();
  return tree;
}

/** Walk the tree once, collecting one block per top-level definition. */
export function extract(
  rootNode: any,
  config: LangConfig,
  src: string,
): ExtractResult {
  const blocks: string[] = [];
  const defStack: string[] = [];
  const defSet = new Set(config.definitions);
  const overrideSet = new Set(config.overrides ?? []);

  // indent 0 → start a new block; >0 → append to the current (last) block.
  function emit(indent: number, line: string): void {
    const ind = "  ".repeat(indent);
    if (indent === 0) blocks.push(`${ind}${line}`);
    else if (blocks.length) blocks[blocks.length - 1] += `\n${ind}${line}`;
  }

  function walk(node: NodeLike): void {
    const type = node.type;
    if (overrideSet.has(type)) {
      handleOverride(node, type);
      return;
    }
    if (defSet.has(type)) {
      emit(defStack.length, `${headerSlice(node, src)}  ${rangeStr(node)}`);
      defStack.push(type);
      for (const c of node.namedChildren) walk(c);
      defStack.pop();
      return;
    }
    for (const c of node.namedChildren) walk(c);
  }

  function handleOverride(node: NodeLike, type: string): void {
    if (type === "lexical_declaration" || type === "variable_declaration") {
      handleFnConst(node);
    } else if (type === "type_declaration") {
      handleGoTypeDeclaration(node);
    }
  }

  // `const name = (a) => …` / `const name = function (a) {…}`
  function handleFnConst(decl: NodeLike): void {
    const indent = defStack.length;
    for (const child of decl.namedChildren) {
      if (child.type !== "variable_declarator") continue;
      const value = child.childForFieldName("value");
      if (!value) continue;
      if (
        value.type !== "arrow_function" &&
        value.type !== "function_expression"
      )
        continue;
      const body = value.childForFieldName("body");
      const sigEnd = body ? body.startIndex : value.endIndex;
      const sig = collapseWs(src.slice(child.startIndex, sigEnd));
      emit(indent, `${sig}  ${rangeStr(decl)}`);
    }
  }

  // Go: `type ( A struct{…}; B interface{…}; C int )` — one or more type_specs.
  function handleGoTypeDeclaration(node: NodeLike): void {
    const indent = defStack.length;
    for (const spec of node.namedChildren) {
      if (spec.type !== "type_spec") continue;
      const nameNode = spec.childForFieldName("name");
      const typeNode = spec.childForFieldName("type");
      const name = nameNode ? nameNode.text : "?";
      let kindWord = "";
      if (typeNode?.type === "struct_type") kindWord = "struct";
      else if (typeNode?.type === "interface_type") kindWord = "interface";
      else if (typeNode) kindWord = collapseWs(typeNode.text);
      const sig = kindWord ? `type ${name} ${kindWord}` : `type ${name}`;
      emit(indent, `${sig}  ${rangeStr(node)}`);
      if (typeNode?.type === "interface_type") {
        for (const ms of typeNode.namedChildren) {
          if (ms.type !== "method_spec") continue;
          emit(indent + 1, `${collapseWs(ms.text)}  ${rangeStr(ms)}`);
        }
      }
    }
  }

  walk(rootNode as NodeLike);
  return { blocks, totalLines: src.split("\n").length };
}
