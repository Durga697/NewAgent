# EDITH OS 3.0 — Milestone 0 Repository Audit

**Date:** 2026-11-19  
**Baseline Package:** `front-desk@1.0.0` (Node.js `>=20.11.0`, native ES Modules)

## 1. Verified Implemented Baseline

| Area | Implemented Files & Capabilities | Notes |
| --- | --- | --- |
| **HTTP, WebSocket & SSE Core** | [server.mjs](../../server.mjs) | Express app with Origin/Host checks, `HttpOnly` session cookies (`frontdesk`), `X-Edith-CSRF`, SSE (`/api/events`), and three WebSocket endpoints (`/api/voice`, `/api/assistant/voice`, `/api/assistant/text`). |
| **Multi-User Accounts & Business Operations** | [users.mjs](../../users.mjs), [config.mjs](../../config.mjs), [calendar.mjs](../../calendar.mjs), [dates.mjs](../../dates.mjs) | Salted `scrypt` password hashing, `UserStore` persisted to `data/users.json`, per-user company name/address/primary contact/hours/services/prices/per-service personal contacts, timezone-aware availability, confirm-before-save drafts, and booking cancellation. |
| **Front Desk UI** | [views/demo.html](../../views/demo.html), [public/app.js](../../public/app.js), [public/business-editor.js](../../public/business-editor.js), [public/style.css](../../public/style.css) | Default root `/` redirects to `/desk` (`/demo` alias). Supports account auth, company/services/contacts editor, voice concierge, calendar booking, and local Windows file search. |
| **EDITH OS Workspace Shell** | [views/workspace.html](../../views/workspace.html), [public/workspace.js](../../public/workspace.js), [public/workspace-nav.js](../../public/workspace-nav.js), [public/workspace-session.js](../../public/workspace-session.js), [public/workspace.css](../../public/workspace.css) | 17-route History API SPA (`/app/*`) with persistent voice/text sessions, `Ctrl+K`/`⌘K` command palette, WCAG 2.1 A/AA checks, company setup in `/app/settings`, and company/booking summary in `/app/calendar`. |
| **Phase 1 Security Foundation** | [safety/sessions.mjs](../../safety/sessions.mjs), [safety/authority.mjs](../../safety/authority.mjs), [safety/policy.mjs](../../safety/policy.mjs), [safety/confirmations.mjs](../../safety/confirmations.mjs), [safety/cloudGate.mjs](../../safety/cloudGate.mjs), [safety/audit.mjs](../../safety/audit.mjs), [safety/config.mjs](../../safety/config.mjs), [safety/pathRules.mjs](../../safety/pathRules.mjs), [safety/permissions.mjs](../../safety/permissions.mjs), [safety/windowsContracts.mjs](../../safety/windowsContracts.mjs), [safety/undo.mjs](../../safety/undo.mjs), [safety/errors.mjs](../../safety/errors.mjs) | Policy engine (`READ_ONLY`, `REVERSIBLE`, `DESTRUCTIVE_OR_BULK`, `FORBIDDEN`), short-lived unforgeable `UserAuthority`, exact-operation one-time `ConfirmationManager`, `CloudGate` local-only filtering, redacted SHA-256 hash-chained JSONL audit logs, and fixed Notepad / Edge PDF handlers. |
| **Phase 2 Local File Intelligence** | [index/worker.mjs](../../index/worker.mjs), [index/database.mjs](../../index/database.mjs), [index/crawler.mjs](../../index/crawler.mjs), [index/watcher.mjs](../../index/watcher.mjs), [index/service.mjs](../../index/service.mjs), [index/driveDiscovery.mjs](../../index/driveDiscovery.mjs), [search/queryParser.mjs](../../search/queryParser.mjs), [search/ranking.mjs](../../search/ranking.mjs), [tools/*.mjs](../../tools/registry.mjs) | `node-sqlite3-wasm` worker index with FTS5 + trigram fuzzy matching, natural-language date/size/extension/drive queries, canonical path/symlink/junction guard (`PathGuard`), and session-scoped opaque `resultId` references. Default root in [config/file-tools.jsonc](../../config/file-tools.jsonc) is `${home}/Downloads`. |

## 2. Verified Gaps & Placeholders (Prior to Milestone 1)

1. **Workspace Placeholders in `public/workspace.js`**:
   - `/app/tasks`, `/app/automations`, `/app/knowledge`, `/app/memory`, `/app/notifications` rendered static "coming in a later release" cards (`upcoming` map).
   - `/app/devices` showed only static local-edition vs hosted status.
   - `/app/permissions` displayed static Microphone & File access cards plus a single transient `pendingReview` banner without an interactive approval queue.
2. **Voice vs. Text Tool Disparity in `server.mjs`**:
   - WebSocket `/api/assistant/text` explicitly stripped all tool `declarations` (`!textOnly` filter) and called `authority.revoke(s)` on every incoming typed message.
   - Typed sessions could not execute local tools or participate in the same tool authorization flow as voice sessions.
3. **Missing Agent Core Orchestration**:
   - No intent classification or multi-step task decomposition (e.g., locate files → read local text → preview summary → request approval → save report → verify on disk).
   - No persistent task/step/approval state machine or safeguards against infinite tool loops / duplicate calls / excessive runtime.
4. **Incomplete Tool Metadata & Reversible Execution**:
   - `ToolRegistry` lacked standardized tool IDs, timeout enforcement, cancellation metadata, idempotency flags, and full `outputSchema` coverage on built-in tools.
   - `ToolRegistry.call` unconditionally rejected `Risk.REVERSIBLE` with `UNSUPPORTED_OPERATION`, and `PolicyEngine.permit` only permitted `ALLOW` decisions rather than consuming verified `ConfirmationManager` approvals for `NEEDS_CONFIRMATION` operations.
5. **No Local Document Content Reading or Report Creation**:
   - `CloudGate.filePayload` blocks cloud file-content access (`kind: 'content'` → `UNSUPPORTED_OPERATION`), and no local-only scoped text reader or confirmed report-saving tool existed.

## 3. Non-Negotiable Constraints & Existing Test Contracts

- `checks/workspace.mjs` asserts exactly **17** links in `#side-nav`, Home `<h1>` `"Your day, a little easier."`, WCAG 2.0/2.1 A/AA compliance (`axe-core`, 0 violations), and `!setup.tools` when `NODE_ENV=test` without `FILE_TOOLS_CONFIG`.
- `checks/config.mjs` asserts the literal word `"Edith"` does not appear in `/demo` rendered `body` text when overridden by `config/examples/clinic.json`.
- `test/security.test.mjs` asserts:
  - `PolicyEngine.permit` rejects forged permits and `REVERSIBLE` operations exceeding `bulkActionThreshold` require confirmation.
  - `ConfirmationManager` enforces exact canonical operation digests, session/request binding, expiration, one-time consumption, and explicit spoken confirmation words.
  - `CloudGate.filePayload({ kind: 'content' })` rejects cloud file content with `UNSUPPORTED_OPERATION`.
  - `windowsContracts` stubs (`recycleFile`, `launchApprovedApplication`) remain deferred (`UNSUPPORTED_OPERATION`).
- Hosted `RENDER=true` mode disables all local Windows tools and enforces the public HTTPS origin.

## 4. EDITH OS 3.0 Milestone Matrix

| Milestone | Scope | Status |
| --- | --- | --- |
| **Milestone 0** | Repository Audit & Implementation Matrix | **Completed** (this document) |
| **Milestone 1** | **Agent Core (Phase A)**: SQLite `AgentStore`, `ExecutionGuard` (loop/step/call/time limits), `Planner` (intent & multi-step task decomposition), `AgentOrchestrator` (state machine + approval execution), enriched `ToolRegistry`/`PolicyEngine`/`CloudGate`, `read_local_text` + confirmed `save_report`, Voice/Text tool parity, `/api/agent/*` endpoints, `/app/tasks`, `/app/permissions`, `/app/skills` UI | **Completed** (`agent/*`, `tools/report_tools.mjs`, `test/agent.test.mjs`, `checks/agent.mjs`) |
| **Milestone 2** | **Windows Companion (Phase B)**: Local companion daemon (`127.0.0.1` HMAC IPC + scoped capability tokens), explicit device pairing, CPU/RAM/disk/battery telemetry, process/app discovery, confirmed approved app launch, read-only large/duplicate file scanning, confirmed reversible `create_directory`/`rename_file`/`move_file`/`copy_file`/`recycle_file` + verified `undo_file_action`, Emergency Stop, SQLite v2 schema, `/app/devices` dashboard | **Completed** (`companion/*`, `config/companion.jsonc`, `tools/companion_tools.mjs`, `test/companion.test.mjs`, `checks/companion.mjs`) |
| **Milestone 3** | **Document Intelligence (Phase C)**: Zero-dependency `.pdf`/`.docx`/`.xlsx`/`.csv`/`.txt`/`.md`/`.json`/`.log` parsers + opt-in WinRT OCR (`.png`/`.jpg`), local chunking & 256-dim deterministic embeddings, SQLite v3 knowledge tables, grounded citation Q&A/summary/comparison/table-extraction tools, CloudGate local-only isolation, `/app/knowledge` workspace | **Completed** (`knowledge/*`, `knowledge/parsers/*`, `tools/knowledge_tools.mjs`, `test/knowledge.test.mjs`, `checks/knowledge.mjs`) |
| **Milestone 4** | **Voice & Memory (Phase D & E)**: VAD/barge-in/push-to-talk/voice selection upgrades, persistent categorized memory engine & `/app/memory` UI | Planned |
| **Milestone 5** | **Automation Studio (Phase F)**: Visual node workflow builder, triggers, templates, bounded persistent worker queue, `/app/automations` UI | Planned |
| **Milestone 6** | **AI Data Studio (Phase G)**: `/app/data-studio`, sandboxed Python/Pandas analytics worker, profiling, charts, CSV/XLSX/PDF export | Planned |
| **Milestone 7** | **Integrations & Business Ops (Phase H & I)**: Encrypted OAuth connector framework (Gmail, Calendar, Drive, GitHub), staff/customer CRM & business analytics | Planned |
| **Milestone 8** | **UI/UX Modernization & Skill System (Phase K & L)**: Dark-first theme + optional light toggle, extended Command Palette, modular Skill manifest/runtime | Planned |
| **Milestone 9** | **Production Hardening**: Security audit, performance benchmarks, migration validation, deployment readiness | Planned |
