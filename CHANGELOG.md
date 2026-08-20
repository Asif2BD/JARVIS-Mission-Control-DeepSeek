# CHANGELOG

All notable changes to JARVIS Mission Control are documented here.
Format: [version] — date | what changed | PR

---

## [Unreleased] — DeepSeek-Harness Edition (this repository)

### Added
- 🐋 **Repository bootstrap: JARVIS Mission Control for DeepSeek-Harness** — ported from [JARVIS-Mission-Control-OpenClaw](https://github.com/Asif2BD/JARVIS-Mission-Control-OpenClaw) v2.1.0 with full history. Board, server, dashboard, and data model carry over unchanged; the connection layer targets DeepSeek-Harness (`dsh`) instead of OpenClaw.
- 🧩 **`dsh-plugin-mission-control` v0.2.1** — payload paths corrected to the real `@deepseek-ai/dsh@0.1.0-rc.7` shapes (`{type, seq, time, data}` wrappers, `ContentBlock[]` content, `data.name` tool names, `data.turn` turn numbers); task creation moved to `session/created`; typed `turn/end` reason mapping (`completed`→REVIEW, `blocked`/`failed`→BLOCKED with structured error, `aborted`/`interrupted`→ASSIGNED); `MC_AGENT_TOKEN`/`authToken` Bearer auth; awaited bounded `flush()` wired to dsh's `session/flush` durability checkpoint and the plugin disposer.
- ✅ **Committed test suite** — 16 tests (`npm test` in the plugin directory): fixture-driven session-event tests using exact rc.7 shapes, plus mock-HTTP tests for auth headers, 5xx retry with order preservation, 4xx no-retry, flush timeout, and stop-then-flush semantics.

### Changed
- 📄 **License: MIT** (was Apache-2.0 in the OpenClaw base), per the maintainer's public-release plan for this edition.
- 📖 **README rewritten** for the DeepSeek-Harness edition.
- 📦 **Release-ready plugin installation** — documented the official scoped dsh CLI, automatic `dsh.bundle` activation, profile override syntax, and npm-first installation path.

---

## Earlier history

This repository was seeded from JARVIS Mission Control v2.1.0. The pre-fork
changelog (v1.0.0 – v2.1.0) lives in the original project:
https://github.com/Asif2BD/JARVIS-Mission-Control-OpenClaw/blob/main/CHANGELOG.md
