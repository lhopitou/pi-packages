---
name: go-style
description: Google Go Style rules for idiomatic Go. Use when writing, editing, reviewing, or refactoring Go code, or when answering a Go style or idiom question.
---

# Google Go Style

## Working procedure

1. **Read [references/rules.md](references/rules.md) before writing or changing Go code.**
   It is the distilled rule set — the settled answers on naming, comments,
   imports, errors, language constructs, and tests. It is short enough to read
   whole on every Go task; every entry points into the full documents below for
   rationale and examples.
2. **Write with the rules in view.** rules.md is the binding answer on style.
   For what it does not settle, judge against the principles below, in order.
   If a rules.md entry might apply to something you are writing but you cannot
   say from memory what that entry says, re-read the entry, not your habits.
3. **Audit before reporting done.** Check your diff against rules.md: every name
   you introduced, every doc comment, every error construction and wrap, every
   test failure message. Each is compliant, fixed, or consciously justified —
   and justified against the entry it cites, not against fluency. Code that
   "looks idiomatic" is exactly what this audit exists to catch: habits encode
   what you believe, rules.md states what the guide requires.

## Principles, in priority order

Judge every undecided question against these, in order:

1. **Clarity** — the reader can see what the code does and why; easy to read
   beats easy to write; comments explain why, not what.
2. **Simplicity** — the simplest way that accomplishes the goal, including
   performance. *Least mechanism*: core language construct → standard library →
   existing library, before building new machinery. Complexity only on purpose,
   and then documented.
3. **Concision** — high signal-to-noise; repetition and opaque names bury what
   matters.
4. **Maintainability** — easy for a future programmer to change correctly;
   abstractions must pay their way; critical details never hidden where they
   are easy to miss.
5. **Consistency** — with the surrounding file, package, and codebase; breaks
   ties, never overrides the principles above.

## Full documents

Loaded only when a rules.md entry points to them — grep for the topic, then
read that section rather than the whole file:

| Reach for | Contains |
|---|---|
| [references/guide.md](references/guide.md) | Normative and canonical: principles, formatting, MixedCaps, naming, line length, local consistency. |
| [references/decisions.md](references/decisions.md) | Normative: settled decisions — naming details, commentary, imports, errors, language constructs, common libraries, test failures, test structure. |
| [references/best-practices.md](references/best-practices.md) | Advisory: judgment calls — naming, test doubles, package design, error handling, documentation, argument lists, tests, strings, global state, interfaces. |

On conflict: guide > decisions > best-practices.

Source: https://google.github.io/styleguide/go — copied and distilled under CC BY 3.0.
