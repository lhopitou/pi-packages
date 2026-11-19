---
name: extending-pi
description: Use when changing or extending Pi, especially when choosing between configuration, skills, prompts, integrations and extensions, or considering a core patch.
---

# Extending Pi

Pi exposes more through public extension points than agents often assume.
Check the current capabilities before inventing infrastructure or patching core.

Use documentation from the Pi installation targeted by the change.
Resolve paths against that package, not the working directory. Start at
`docs/index.md` if the documentation layout has changed. Use installed types
and source when documentation leaves behaviour unclear.

## Choose the mechanism first

Check whether an existing setting or installed package already meets
the request.

- **Context file**: instructions that always apply to a user or project.
- **Skill**: task-specific knowledge or procedures loaded when relevant.
  Only capture what the agent would not already know or reliably discover.
- **Prompt template**: a reusable request the user invokes explicitly,
  optionally with arguments.
- **MCP configuration**: connect an existing tool service.
- **Extension**: executable behaviour inside Pi, such as tools, commands,
  hooks or UI.
- **CLI, RPC or SDK**: automate Pi or use it inside another application.
- **Pi package**: install or distribute extensions, skills, prompts and
  themes together. A package is a delivery format, not a separate runtime
  mechanism.

If the user says "plugin", identify the behaviour they need before choosing
the mechanism. They may mean an extension, a package or an integration.

Read the corresponding installed documentation:
`configuration.md`, `skills.md`, `prompt-templates.md`, `mcp.md`,
`extensions.md`, `cli.md`, `rpc.md`, `sdk.md` or `packages.md`,
all under `docs/`. For other customisations, start with the chooser in
`docs/quickstart.md`.

## Before concluding that core must change

Read `docs/extensions.md` fully and inspect matching examples under
`examples/extensions/`. Agents can miss a suitable capability by reading
only the first matching section.

Explain which public mechanisms you checked and why they cannot provide
the requested behaviour before proposing a core patch.
