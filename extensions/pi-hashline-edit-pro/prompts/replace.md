Replace lines in a text file using HASH anchors from `read`.

Put all operations on one file in a single `replace` call. Stack every region into the `edits` array, even when they are far apart. Anchors within one call must all come from the same pre-edit read; the runtime applies them atomically against that one snapshot.

How to use:

1. Call `read` to get HASH anchors:
```
read({ path: "src/main.ts" })
// Returns:
// MQXV│const x = 1;
// ZPMQ│const y = 2;
// VRWS│const z = 3;
```

2. Copy the 4-character HASH (before `│`) into `start`/`end`:
```json
{ "path": "src/main.ts", "edits": [
  { "start": "MQXV", "end": "MQXV", "lines": ["const x = 99;"] }
] }
```

Examples:

1. Single line replace:
```json
{ "path": "src/main.ts", "edits": [
  { "start": "MQXV", "end": "MQXV", "lines": ["const x = 1;"] }
] }
```

2. Range replace (3 lines → 3 new lines):
```json
{ "path": "src/main.ts", "edits": [
  { "start": "ZPMQ", "end": "VRWS", "lines": [
    "function greet(name) {",
    "  return `Hello, ${name}`;",
    "}"
  }
] }
```

3. Multiple regions in one call (delete two non-adjacent ranges):
```json
{ "path": "src/server.ts", "edits": [
  { "start": "aB3x", "end": "xY7q", "lines": [] },
  { "start": "MQXV", "end": "ZPMQ", "lines": [] }
] }
```

Rules:
- `start` and `end` are required. A single-line replace is `start=X, end=X`.
- To delete a range, use `lines: []`.
- `start`, `end` are HASH anchors only (e.g. `aB3x`). Do not include `│` or line content.
- `lines` is literal file content — each string becomes exactly one line in the file. No `HASH│` prefix, no `+`/`-` diff markers.
- Don't add `""` for spacing unless you actually want a new blank line.
- Copy anchors from the most recent `read` of the file. Do not guess or construct them.
- All edits in one call must be non-conflicting. The runtime rejects with `[E_EDIT_CONFLICT]` if two ranges overlap.
- If `lines` matches current content, the replace is classified as `noop` (file unchanged).
- The `start`/`end` range is inclusive — both anchors and every line between them are replaced. If your replacement content includes lines that already exist in the file (e.g. closing brackets), make sure those lines are within your range, otherwise they will appear twice.

On success, the response contains an `--- Anchors ---` block with fresh HASH anchors for the changed region. Use those for nearby follow-up replaces instead of re-reading.

Auto-read after write:
- After a successful `write`, the result includes a `--- Auto-read (hashline anchors) ---` block.
- Use those anchors directly for `replace` calls without a separate `read`.

Error recovery:
- `[E_STALE_ANCHOR]` — file changed since last read. The error includes fresh `>>> HASH│content` lines; copy the HASH and retry.
- `[E_BAD_REF]` — malformed HASH. Re-read and try again.
