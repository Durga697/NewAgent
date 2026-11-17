# EDITH OS migration

## Phase 0 — inventory and decisions

The starting release is commit 8c859de. Express serves native browser ES modules, a Gemini Live WebSocket, session-scoped server-sent events and a configurable calendar. The frontend is a single booking page with a separate local file panel. Gemini credentials stay in the Node process. The security modules enforce origin checks, expiring HttpOnly sessions, CSRF, scoped tool authorization and redacted audits. The Windows edition indexes authorized filename metadata. Render has no desktop filesystem capabilities. There is no account login, paired companion, OAuth calendar, durable task scheduler or conversation database.

Keep the existing JavaScript stack and AudioWorklet. A client-side History API router can change views without interrupting an active conversation. Preserve the booking experience at /demo. EDITH_UI=classic selects it at the root for rollback. Direct /app routes select the new workspace. Existing booking tests should explicitly enter /demo.

## Phase 1 — release plan

1. Add an accessible responsive shell, direct links for all 17 views, a keyboard command palette, an orb console, a text composer and a status rail. Use real provider configuration, browser media events and file capability data. Keep unsupported actions visibly unavailable.
2. Serve the same local file form in both products. Reuse the existing session and tool policy. Keep hosted filesystem access disabled. Reuse the Gemini transport for the workspace with a general assistant instruction, microphone-free typed turns and no booking tools. Keep the legacy voice contract intact.
3. Keep transcripts and activity bounded to the open page. Distinguish session activity from durable tasks. Provide useful local navigation commands even without a provider. Avoid browser persistence of sensitive conversations.
4. Exercise the legacy suite, new routes, tool boundaries, provider success/failure, permissions, real input/output transitions, keyboard navigation and the specified viewport sizes. Save representative screenshots.

## Subsequent release gates

| Phase | Dependency and release gate |
| --- | --- |
| 2 — Advanced voice | Formalize provider event schemas, recovery and voice preferences. Verify real interruption, clean close and provider failure. |
| 3 — Tasks | Add authenticated workspace ownership, durable task/step storage, cancellation and exact-operation approvals. Test replay, decline and isolation. |
| 4 — Companion | Pair a separately installed agent using short-lived challenges. Verify local consent, allowlists, revocation, offline behavior and traversal protection before enabling remote actions. |
| 5 — Knowledge, memory, integrations | Add consent, citations, retention controls and scoped OAuth. Test deletion, revocation and external write review. |
| 6 — Automations | Add a server-side scheduler and durable workers. Verify retries, idempotency and missed runs. |
| 7 — Rollout | Measure latency, accessibility and resource limits. Exercise migrations, recovery and rollback. |

The screenshot and copy references guide composition. Runtime status comes from application responses. Demo artifacts, calendar reservations and local index entries are never presented as external integrations or completed AI tasks.

## Phase checkpoints

**Phase 0.** The unmodified baseline passed syntax checks and the unit, security, file, voice, booking browser and alternate-business suites. Of 49 unit cases, 48 passed and one Windows symlink case skipped because the host lacks symlink privilege. Junction and path-boundary coverage ran. There was no configured lint, TypeScript or frontend build pipeline. The route and environment inventory is in [architecture.md](architecture.md). The supplied design references are in [blueprints](blueprints/).

**Phase 1.** The new templates are in `views/`. The browser changes are in the `public/workspace*` modules, with the existing capture processor, CSRF module and shared file panel. `server.mjs` owns the entry routes, mode-specific assistant instructions and allowed tool declarations. The original browser checks explicitly enter the demo. `checks/workspace.mjs` exercises the new entry points, real browser media capture with a local Gemini double, typed turns without microphone access, denial, cleanup, keyboard navigation, browser history and all 17 pages at 360, 390, 768, 1024 and 1440 pixels. Automated axe WCAG A/AA checks cover Home at mobile, tablet and desktop widths. The local service also returned two related real Gemini text replies and a spoken greeting.

Desktop and mobile evidence is under [screenshots](screenshots/). Use `npm run test:workspace -- --screenshots` to regenerate the workspace images. The remaining voice roadmap includes automatic reconnection and full session resumption. Authentication across devices, durable tasks, remote pairing, document content access, OAuth and scheduling belong to subsequent phases. Browser checks cover accessible names, focus/navigation and automated rules. A human screen-reader review remains outstanding.

During a repeat of the combined regression run the original booking browser check hit its 10-second server startup timeout. An isolated startup took 4.2 seconds and the booking browser check passed on retry. The original timeout remains in the test harness.
