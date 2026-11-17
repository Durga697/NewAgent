# Codex Master Prompt — Transform Front Desk into EDITH OS

You are the lead product engineer, UI architect, accessibility specialist, AI agent engineer, and security reviewer for an existing project named **Frontdesk / Edith**. The objective is a complete **minimal, voice-first, full AI assistant website** called **EDITH OS**. Read `EDITH_OS_BLUEPRINT.md` (provide it to the repository or use the specification supplied in the conversation) as the source of truth for UX, pages, voice states, technical boundaries, milestones, and tests.

## Context and visual identity

The existing screenshot is an appointment-booking voice concierge: fixed narrow left nav, warm off-white canvas, muted sage accent, top breadcrumb/status strip, generous hero type, main white card with circular green voice orb and captions, right-hand business/booking cards, and activity below. **Preserve the quiet premium composition, typography, spacing, card borders, and orb-centric design, but completely remove appointment booking as the primary product.** The new site is a general-purpose personal AI assistant, not a booking demo.

Existing project knowledge suggests Node.js backend, browser frontend and Gemini conversation integration, but **do not assume any file, framework, model API, route, or capability exists until repository inspection proves it**. Preserve existing working functionality where useful. Do not expose or print secrets.

## Mandatory execution approach

1. **Inspect before changing:** inventory repo tree, README, package files, existing routes, UI components, audio/transcription/provider adapters, auth, storage and tests. Execute baseline checks; document failures without concealing them. Identify safe migration and feature flag plan.
2. **Write an implementation plan:** map existing files to proposed modules, dependencies, decisions, data contracts, security implications, tests and phases. Store as `docs/edith-migration-plan.md`. Keep updates incremental and reversible.
3. **Build Phase 1 first:** introduce design tokens, responsive AppShell, sidebar, top bar, home voice centerpiece, right context rail, command input, coherent route structure, truthful page empty states and polished interactions. Remove booking-specific interface references only when equivalents are in place. Do not fake live data.
4. **Test every phase:** lint, type check, unit, component and end-to-end smoke checks as supported by repo. Resolve new failures. Report pre-existing failures separately.
5. **Continue phase by phase:** Phase 2 voice, Phase 3 tasks/approval, Phase 4 secure companion/files, Phase 5 knowledge/memory/integrations, Phase 6 automations, Phase 7 hardening. At each phase checkpoint, list changed files, features working, tests, risks and remaining work. Never claim full implementation when a feature is mocked or incomplete.
6. **Do not block unnecessarily:** select sensible defaults from the specification while preserving existing architecture; ask only for truly required credentials, external accounts, deployment authority or irreversible decisions. Keep local demo behavior separated from real execution.

## Page and navigation requirements

Create/plan routes for: Home `/app`; Voice Studio `/app/voice`; Conversations `/app/conversations/:id?`; Task Center `/app/tasks/:id?`; Automations `/app/automations/:id?`; Files `/app/files`; Knowledge `/app/knowledge/:collectionId?`; Memory `/app/memory`; Calendar `/app/calendar`; Integrations `/app/integrations`; Devices `/app/devices`; Skills `/app/skills`; Activity `/app/activity`; Permissions `/app/permissions`; Notifications `/app/notifications`; Settings `/app/settings`; Help `/app/help`; optional onboarding `/setup`. Use real router conventions. All visible nav links must work and must expose real/coming-soon status clearly.

**Desktop shell:** 224–248px left sidebar, flexible central region, contextual right rail of 288–328px on suitable pages, top status/search. **Tablet:** icon-only nav and collapsible right rail. **Mobile:** one-column layout with bottom nav and persistent voice dock. Provide an accessible Ctrl/Cmd+K command palette. No horizontal overflow.

## Visual design system

Use palette as a starting point: canvas `#F7F6F2`, sidebar `#FBFBF8`, surface `#FFF`, soft sage `#F1F3EA`, ink `#172B28`, secondary text `#63716A`, border `#E2E7DC`, primary green `#446B4D`, hover `#36583E`, danger `#AD443B`. Calm whitespace, 8px spacing rhythm, 8/12/16/24px radii, 1px borders, unobtrusive shadows, restrained serif accents, modern sans body. Validate WCAG AA contrast. Support keyboard focus, 44px mobile touch targets and reduced motion.

## Home UX details

Header welcome and status; large central voice orb; clearly labeled session control; text composer; suggestion chips; recent real tasks; right-rail assistant readiness, paired PC, tool connections and permission requests; honest empty states. The orb has visible distinct idle, requesting permission, connecting, listening, thinking, speaking, executing, awaiting approval, reconnecting and error states. Subtle animations only, preferably SVG/CSS transforms; never animate meaningless audio levels while mic is off.

## Voice system and backend contracts

Build a typed finite-state session manager; stream partial/final transcripts separately; support user interrupt/barge-in, microphone mute, playback cancel, text fallback, connection recovery and clean teardown. Reuse Gemini through a provider adapter where it exists. Keep model keys on server. Do not claim user speech was processed if permission or connection failed. Create typed realtime event schemas and task events, strongly validate runtime payloads, and surface meaningful errors.

## Agent architecture and security constraints

Plan a typed tool registry, policy engine, durable task model, step execution log, approval UI, rate limits, timeouts, idempotency and cancellation. Every tool checks authenticated user, workspace, device, resource, scope and consent server-side. Retrieved documents, web results, transcripts and model text are untrusted data, not authority. No arbitrary shell command invocation via raw LLM output. All destructive, bulk, external, sharing, or credential-related actions require clear user confirmation with exact resource impact. Audit results with sensitive fields redacted.

**Desktop control:** browsers do not directly have arbitrary Windows filesystem or app launch access; implement a separately installed, paired, scope-limited companion. Read-only file search first; writes later with previews and permission confirmation. Handle path traversal, symlinks, revoked grants and offline devices. Never install a silent background agent.

**Integrations:** OAuth tokens only server-side, least privileges, explicit connect/revoke, accurate connection statuses. **Memory:** explicit, inspectable, editable, removable, scoped, with retention. **Automations:** durable worker/scheduler with execution history and safe retry semantics; never rely on browser tab for recurrence.

## Acceptance tests

- Home and all navigation routes are accessible and responsive at 360, 390, 768, 1024 and 1440px.
- Voice button produces honest permission and connection states; typed mode always available.
- Real streaming transcript and assistant output work if provider is configured; demo is visibly labeled otherwise.
- User can interrupt speaking; captions and playback stop accurately.
- Task approval is enforced by backend; decline blocks execution; cancel/error visible.
- Unauthorized file path, external write, and revoked device access fail safely.
- Disconnecting PC or provider does not crash UI; clear fallback guidance appears.
- Activity logs accurately reflect outcome, linked to task and consent events.
- Keyboard-only, screen-reader labels, focus treatment and reduced motion verified.
- No secrets in client bundle, logs, commits, screenshots or sample environment files.
- No false success banners or pre-populated fabricated records.

## Reporting format for each phase

Summarize: inspected structure and assumptions verified; files changed; new routes/components; security changes; tests run with pass/fail; screenshots or visual diff where supported; remaining caveats; safe next phase. Do actual implementation work in repository, not only write a plan. If blocked by provider credentials or external authority, implement safe stubs and explicitly identify the blocker.

**Begin now with Phase 0 repository audit and Phase 1 minimal UI transformation.** Build from the real repo and do not invent file paths or completed functionality.
