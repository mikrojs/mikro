---
title: AI Disclosure
description: How AI coding agents are used to build Mikro.js
---

# AI Disclosure

Mikro.js is built with substantial help from AI coding agents such as [Claude Code](https://claude.com/claude-code). That includes this documentation and much of the code.

## What is AI-assisted

- **Documentation**: AI agents draft or edit most pages, and a maintainer reviews them.
- **TypeScript**: the CLI, tooling, and runtime modules are written in close collaboration with AI agents.
- **C++ runtime**: most of the native runtime is written with AI assistance. The maintainer is not a trained C++ programmer and relies on AI agents, code review, and the test suites for correctness.

## Review

AI-written does not mean unchecked. A maintainer reviews and manually tests changes, and the usual CI gates (builds, tests, lint) run on every pull request. In addition:

- Commits made by AI agents run a heavier pre-commit suite than human commits, including full C++ and TypeScript builds and both test suites, before a change is committed.
- A memory benchmark fails CI when a change regresses heap usage by more than 10%.
- An on-device test suite exercises the native runtime on real hardware, with committed per-chip heap snapshots that flag memory regressions.

Even so, extra scrutiny is welcome, especially of the C++ code. If something reads wrong, works differently than described, or looks unsound, [opening an issue](https://github.com/mikrojs/mikro/issues) is much appreciated.
