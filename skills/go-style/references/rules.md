<!--
Distilled from the Google Go Style Guide documents copied in this directory
(https://google.github.io/styleguide/go/, copyright Google, CC BY 3.0; sources
retrieved 2026-09-17). This digest is a cache, not the source of truth: each
entry points to the section holding the full rationale and examples. If the
guide changes, re-sync this file. On any conflict the full documents win.
-->

# Go style rules

## Formatting

- `gofmt` output is the only correct format; `gofmt -s` also simplifies literals. — guide.md#formatting
- No fixed line length: refactor to shorten, or let a genuinely minimal line stay long. Never split before an indentation change, or to break a long string. — guide.md#line-length

## Naming

- MixedCaps everywhere, no underscores: `MaxLength`, `maxLength` — never `MAX_LENGTH` or `kMaxBufferSize`. Exceptions: `Test`/`Benchmark`/`Example` function names in `*_test.go`, packages imported only by generated code, OS/cgo identifiers. — guide.md#mixed-caps, decisions.md#underscores
- Package names: short, all-lowercase, unbroken (`tabwriter`); avoid names shadowed by common locals (`count`); never uninformative ones (`util`, `common`, `helper`, `models`). — decisions.md#package-names, best-practices.md#util-packages
- Receiver names: 1–2 letter abbreviations of the type, identical across all its methods, never `this`/`self`. `func (t Tray)`, `func (w *ReportWriter)`. — decisions.md#receiver-names
- Constants: MixedCaps; named for their role, not their value (`MaxPacketSize`, not `MAX_PACKET_SIZE`, `kMaxBufferSize`, or `Twelve`). — decisions.md#constant-names
- Initialisms stay one-case: `URL` or `url`, never `Url`; exported `ID`, `DB`, `API`; each initialism in a name may differ (`XMLAPI`). — decisions.md#initialisms
- Getters start with the noun — `Counts()`, not `GetCounts()`; use `Fetch`/`Compute` when the call may be slow or fail. — decisions.md#getters
- Name length ∝ scope: a 1–7-line block tolerates one letter; file scope needs words. Name what the value holds here, not where it came from. `r` reader, `w` writer, `i` index. — decisions.md#variable-names
- Repetition: the package name is visible at the call site — `widget.New`, `db.Load`, `(*Project).Name()`, `sqldb.Connection`; omit type words (`users`, not `userSlice`); add context words only to disambiguate. — decisions.md#repetition, best-practices.md#function-name-repetition
- Functions returning things get noun names; doing things, verbs; type variants go at the end (`ParseInt64`); a clear primary version drops the type (`Marshal`/`MarshalText`). — best-practices.md#function-name-conventions
- Never name locals after standard packages (`url := ...` blocks `net/url`); prefer renaming your own package over forcing clients to rename imports. — best-practices.md#shadowing

## Comments and documentation

- Every top-level exported name has a doc comment starting with the name, a full sentence: `// Encode writes the JSON encoding of req to w.` Follow the same convention for unexported declarations with non-obvious behavior. — decisions.md#doc-comments
- Doc comments are full sentences, capitalized and punctuated; end-of-line field comments may be lowercase fragments. — decisions.md#comment-sentences
- Explain why, not what; a self-describing name beats a redundant comment. — guide.md#clarity
- Exactly one package comment, immediately above the package clause: `// Package math provides ...`; long ones live in `doc.go`; binaries use `// The seed_generator command ...`. — decisions.md#package-comments
- Document error-prone or non-obvious parameters and fields by saying *why* they matter; never enumerate every parameter. — best-practices.md#documentation-conventions-params
- Document what callers inspect or must do: sentinel errors and error types (including pointer-ness), context behavior that differs from the implied cancel→`ctx.Err()`, cleanup the caller owes (`Stop`, `resp.Body.Close()`), non-obvious concurrency safety. — best-practices.md#documentation-conventions-errors, -contexts, -cleanup, -concurrency
- Runnable examples live in `*_test.go`, appear in godoc, and run as tests — prefer them over commented-out code. — decisions.md#examples
- Godoc: blank line separates paragraphs; two-space indent makes verbatim blocks; wrap comment prose around 80–100 columns. — best-practices.md#godoc-formatting, decisions.md#comment-line-length
- Comment the surprising lookalike: `if err := doSomething(); err == nil { // if NO error`. — best-practices.md#signal-boost

## Imports

- Groups in order: stdlib; project/vendored; protocol buffers; blank (`_`) imports. — decisions.md#import-grouping
- Rename only to fix collisions (rename the most local import) or to strip underscores from generated protos (`foopb "path/to/foo_go_proto"`); use the same local name in every file; free a shadowed name with the `pkg` suffix (`urlpkg`). — decisions.md#import-renaming
- Blank imports (`import _`) only in `package main` or tests that require them. — decisions.md#import-blank
- Never `import .`. — decisions.md#import-dot

## Errors

- `error` is the last return value; exported functions return the `error` interface, not a concrete error type. — decisions.md#returning-errors
- On error the other returns are unspecified — return zero values and the error: `return nil, err`. — decisions.md#returning-errors
- Error strings: lowercase, no trailing punctuation (`fmt.Errorf("something bad")`); displayed messages (logs, `t.Errorf`) are capitalized. — decisions.md#error-strings
- Never discard an error: handle it, return it, or (last resort) terminate the program; a `_` assignment needs a comment saying why it is safe. — decisions.md#handle-errors
- No in-band errors: never `-1`, `""`, or `nil` as the failure signal — return `(value, ok)` or `(value, error)`. — decisions.md#in-band-errors
- Handle errors before proceeding: `if err != nil { return ... }` then the normal path, unindented — no `else` continuation. — decisions.md#indent-error-flow
- Wrap with context the callee cannot know (`fmt.Errorf("launch codes unavailable: %v", err)`), never what it already includes; never `fmt.Errorf("failed: %v", err)`. — best-practices.md#error-extra-info
- `%w` only when callers should inspect via `errors.Is`/`errors.As`; place it last (`"...: %w"`), except sentinel categories, which go first (`"%w: invalid header"`). — best-practices.md#error-percent-w, #error-percent-w-sentinel-placement
- Structure errors for programmatic checks: sentinels (`ErrDuplicate`), typed errors (`*os.PathError`); never string-match `err.Error()`. — best-practices.md#error-structure
- If you return an error, don't also log it — let the caller decide; use ERROR-level logs sparingly (they flush). — best-practices.md#error-logging
- No `panic` for normal error handling; startup failures (bad flags/config) terminate with an actionable message, not a stack trace; an internal panic/recover pair must never cross the package API; never recover panics you cannot explain. — decisions.md#dont-panic, best-practices.md#when-to-panic, #checks-and-panics

## Language constructs

- Struct literals: field names mandatory for other packages' types; omit zero-value fields; closing brace on its own line at the opener's indent; drop repeated types in nested literals (`[]*T{{A: 1}}`). — decisions.md#literal-field-names, #literal-zero-value-fields, #literal-matching-braces, #literal-repeated-type-names
- Prefer `var s []int` over `s := []int{}`; APIs never distinguish nil from empty — test `len(s) == 0`. — decisions.md#nil-slices
- Keep one line: function signatures, `if`/`for` headers, `case` lists (otherwise indent all cases, separated by blank lines). Shorten by extracting locals, not by wrapping. — decisions.md#func-formatting, #conditional-formatting
- Variable on the left in comparisons: `if result == "foo"`. — decisions.md#conditional-formatting
- Never copy a type whose methods take pointer receivers (`sync.Mutex`, `bytes.Buffer`) — pass and return `*T`. — decisions.md#copying
- Receiver: value for maps, funcs, chans, small plain data; pointer to mutate, for sync fields or large/growing types; one style per type; when in doubt, pointer. — decisions.md#receiver-type
- No pointers just to save bytes (`*string`, `*io.Reader`); protobuf messages by pointer. — decisions.md#pass-values
- Every goroutine's exit must be evident: scoped inside the function, tied to a context, or documented; never start one without knowing how it stops. — decisions.md#goroutine-lifetimes
- Prefer synchronous functions — a caller can add concurrency, but cannot remove it. — decisions.md#synchronous-functions
- No `break` at the end of a `switch` clause (Go cases don't fall through); comment empty clauses; inside a loop, `break` leaves the switch — label the loop to exit it. — decisions.md#switch-break
- Type aliases (`type A = B`) are for migrations only. — decisions.md#type-aliases
- `%q` for human-facing strings; `any` over `interface{}`. — decisions.md#use-percent-q, #use-any
- Channel direction in signatures when one-way (`<-chan int`). — best-practices.md#decl-chan
- `:=` for non-zero init; zero-value `var` for later use; `new(T)`/`&T{}` for pointers to zero; size hints and preallocation only with measured need. — best-practices.md#vardecls

## Contexts and common libraries

- `ctx context.Context` first parameter, always; take it from the caller (`req.Context()`, stream, `t.Context()`); `context.Background()` only at entry points; never a struct field; never a custom context type. — decisions.md#contexts, #custom-contexts
- Keys and secrets from `crypto/rand`, never `math/rand`. — decisions.md#crypto-rand
- Flags: snake_case names (`poll_interval`), camelCase variables, defined only in `package main`; libraries configure via API, not flags. — decisions.md#flags

## API shape

- Interfaces: concrete types first; the consumer defines the interface; accept interfaces, return concrete types; keep them small and unexported unless the interface *is* the product; reuse generated RPC interfaces — never hand-wrap them for tests. — decisions.md#interfaces, best-practices.md#interfaces
- Generics only when multiple types actually need the same code; start non-generic; never for DSLs or error-handling frameworks. — decisions.md#generics
- Long argument lists: option struct when all callers set some options; variadic options when most callers set none; options take parameters (`FailFast(bool)`), not presence (`EnableFailFast()`). — best-practices.md#funcargs, #option-structure, #variadic-options
- No package-level state in libraries: instances plus explicit dependency passing. The rare safe cases are logically constant state, or behavior unobservable to callers (e.g., a private cache). — best-practices.md#globals, #globals-litmus-tests

## Strings

- Few pieces: `+`. Formatting: `fmt.Sprintf` — or `fmt.Fprintf` straight to a Writer. Piecewise building: `strings.Builder`. Multi-line constants: backticks. — best-practices.md#string-concat

## Tests

- Only stdlib `testing`; no assertion libraries, no third-party frameworks; `cmp` for equality (never `reflect.DeepEqual`); test through the public API. — decisions.md#use-package-testing, #assert, #types-of-equality
- Failure message: `YourFunc(%v) = %v, want %v` — name the function, show the input, got before want; diffs get a direction legend (`(-want +got)`); use `%q`/`%+v` for visibility. — decisions.md#useful-test-failures, #identify-the-function, #identify-the-input, #got-before-want, #print-diffs
- Keep going after failures: `t.Error` over `t.Fatal`; `t.Fatal` only for setup failures, for continuations that would be meaningless, or inside `t.Run`; never from another goroutine — `t.Error` + return. — decisions.md#keep-going, best-practices.md#t-fatal, #t-fatal-goroutine
- Test helpers (setup/cleanup) call `t.Helper()` and may `t.Fatal` on environment failure; assertion helpers don't exist — validators return an error and the `Test` function decides to fail. — decisions.md#mark-test-helpers, best-practices.md#test-functions, #test-helper-error-handling
- Table-driven tests: field names in rows, zero-value fields omitted, rows never identified by index; per-row conditional logic splits into separate test functions or subtests. — decisions.md#table-driven-tests, #table-tests-identifying-the-row, best-practices.md#t-field-names
- Subtest names readable after escaping: no spaces, no slashes (`hu=en_bug-1234`, not `"AM/PM confusion"`). — decisions.md#subtest-names
- Compare whole structs with `cmp.Diff`, not field-by-field; don't string-match errors — `errors.Is`, `cmpopts.EquateErrors`, or a `wantErr bool`. — decisions.md#compare-full-structures, #test-error-semantics
- Setup scoped to the tests that need it (not `init()`); `sync.Once` or a custom `TestMain` only when amortization genuinely requires it. — best-practices.md#t-common-setup-scope, #t-setup-amortization, #t-custom-main
- Test double packages are named `<pkg>test`; doubles named by behavior (`AlwaysCharges`) or by type when several (`StubService`). — best-practices.md#naming-doubles
- `MustXxx` helpers in tests may `t.Fatal`, enabling value-context use in table rows. — decisions.md#must-functions
