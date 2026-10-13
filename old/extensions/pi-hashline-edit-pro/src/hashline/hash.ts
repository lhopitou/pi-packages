
import xxhash from "xxhash-wasm";


export const HASH_LENGTH = 4;

export const HASH_PREFIX = "";

export const ANCHOR_LENGTH = HASH_LENGTH;

const HASH_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HASH_ALPHABET_BITS = 6;
const HASH_ALPHABET_MASK = (1 << HASH_ALPHABET_BITS) - 1;
const HASH_ALPHABET_REGEX_SAFE = HASH_ALPHABET.replace(/-/g, "\\-");
const HASH_ALPHABET_RE = new RegExp(`^[${HASH_ALPHABET_REGEX_SAFE}]+$`);
export const HASH_CHARS_CLASS = `${HASH_PREFIX}[${HASH_ALPHABET_REGEX_SAFE}]{${HASH_LENGTH}}`;
function hashToString(h: number): string {
	const totalBits = HASH_LENGTH * HASH_ALPHABET_BITS;
	const shift = 32 - totalBits;
	let n = h >>> shift;
	let out = "";
	for (let j = 0; j < HASH_LENGTH; j++) {
		out +=
			HASH_ALPHABET[
				(n >>> ((HASH_LENGTH - 1 - j) * HASH_ALPHABET_BITS)) &
					HASH_ALPHABET_MASK
			]!;
	}
	return out;
}

export const HASHLINE_PREFIX_RE = new RegExp(
	`^\\s*(?:>>>|>>)?\\s*${HASH_CHARS_CLASS}│`,
);
export const HASHLINE_PREFIX_PLUS_RE = new RegExp(
	`^\\+\\s*${HASH_CHARS_CLASS}│`,
);
export const DIFF_MINUS_RE = /^-\s*\d+\s{4}/;

export const HASHLINE_BARE_PREFIX_RE = new RegExp(`^\\s*(${HASH_CHARS_CLASS})│`);



// Lazy-initialized xxhash-wasm hasher. Initialization starts at module load
// time and completes in ~2ms. By the time any tool calls xxh32(), the hasher
// is ready.
type Hasher = { h32(input: string, seed?: number): number };
let hasherPromise: Promise<Hasher> | null = null;
let hasherSync: Hasher | null = null;

function getHasher(): Hasher {
	if (hasherSync) return hasherSync;
	// Fast path won't hit this in practice — the wasm init completes in ~2ms
	// and no tool call happens at import time. But if it does, throw clearly.
	throw new Error("xxhash-wasm not initialized yet. This should not happen.");
}

// Start initialization immediately at module load time.
hasherPromise = xxhash().then((h) => {
	hasherSync = h;
	return h;
});

// Export for tests that need to await readiness.
export function ensureHasherReady(): Promise<Hasher> {
	return hasherPromise!
}

function xxh32(input: string, seed = 0): number {
	return getHasher().h32(input, seed) >>> 0;
}

const DISCRIMINATOR = (occurrence: number): string => `C${occurrence}`;

function canonicalizeLine(line: string): string {
	return line.replace(/\r/g, "").trimEnd();
}

export function computeLineHashes(content: string): string[] {
	const lines = content.split("\n");
	const hashes = new Array<string>(lines.length);
	const counts = new Map<string, number>();
	for (let i = 0; i < lines.length; i++) {
		const canonical = canonicalizeLine(lines[i]!);
		const occurrence = (counts.get(canonical) ?? 0) + 1;
		counts.set(canonical, occurrence);
		hashes[i] = hashToString(xxh32(`${DISCRIMINATOR(occurrence)}:${canonical}`));
	}
	return hashes;
}

export function computeLineHash(idx: number, line: string): string {
	const canonical = canonicalizeLine(line);
	return hashToString(xxh32(`${DISCRIMINATOR(1)}:${canonical}`));
}

export const HASH_FORMAT = {
	prefix: HASH_PREFIX,
	length: HASH_LENGTH,
	anchorLength: ANCHOR_LENGTH,
	bitsPerChar: HASH_ALPHABET_BITS,
	alphabet: HASH_ALPHABET,
};


export { HASH_ALPHABET_RE };
