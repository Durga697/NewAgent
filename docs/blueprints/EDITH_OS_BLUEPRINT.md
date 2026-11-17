# EDITH OS — Product, UI/UX & Technical Transformation Blueprint

**Design direction:** Minimal, warm, premium. **Product:** Full AI assistant. **Source:** The supplied Front Desk screenshot. **Status:** Implementation specification, not a claim that the functions already work.

## 0. Design objective and constraints

Transform the screenshot's appointment-oriented Front Desk interface into a real, voice-first AI workspace. Keep the source's quiet cream/off-white canvas, muted sage accent, thin card outlines, ample whitespace, crisp typography, slender fixed sidebar, centered orb, supporting right rail, compact status labels, and calm visual hierarchy. Remove the business-service booking workflow. EDITH should be useful through voice, keyboard, and touch, and every demonstrated capability must be linked to a real backend implementation or explicitly labeled a demo.

**North-star task:** A user can say, “Edith, find my October invoices, summarize them, and put matching documents in a folder,” inspect an execution plan, approve scoped changes, watch progress, and review a correct result with links to artifacts and a traceable activity log.

**Product principles:** (1) Voice-first, never voice-only. (2) Show state and progress clearly. (3) Read-only by default. (4) Require scoped permissions and explicit approvals for consequential actions. (5) Never imply OS access from a browser; use an authenticated desktop companion. (6) Preserve useful existing Node.js/Gemini functions and migrate incrementally. (7) Accessible, responsive, understandable, and fast. (8) Separate real integrations from simulated/demo modes.

**Core success metrics:** time to first meaningful interaction, microphone connection success rate, voice turn completion rate, task success with user validation, permission denial rate, mistaken-action rate, task recoverability, accessibility test results, p95 interaction latency, and return usage. Do not invent target figures until baseline metrics are collected.

## 1. Reference screenshot audit and transformation mapping

The reference shows: (a) ~200px left navigation with “front desk.” brand, Edith workspace switcher, Front desk / Appointments links, footer; (b) slim top breadcrumbs and demo status; (c) large welcoming hero in the content area; (d) dominant white voice card containing a pale sage orb and conversation captions; (e) narrow right stack with a business profile and appointment-selection form; (f) full-width appointment history strip below.

Preserve its composition and hierarchy, not its salon/booking domain or exact words. The sidebar becomes Workspace / Intelligence / Automations / System navigation. The central hero becomes a context-aware welcome, central card becomes the universal voice console, right rail becomes Status / Connected Tools / Suggested Actions / Pending Approvals, and the bottom strip becomes Recent Tasks or Your Activity. Remove location, business hours, service type, time slots, name input, and appointment booking language. Reuse existing calendar integration only as a general assistant capability.

## 2. User roles, boundaries, and functional scope

**Initial target:** one signed-in individual, one or more explicitly paired Windows devices, personal knowledge sources, optional third-party connections. **Future:** multiple workspaces, delegated assistants, embeddable voice SDK for other websites, and team permissions, but not required in the first release.

**Assistant capabilities:** conversational Q&A; streamed speech/listening; multilingual speech when providers support it; task reasoning/planning; read-only file search and summaries; explicit folder/file write operations; open approved applications; searchable document knowledge; managed automations; calendar and email through supported OAuth integrations; persistent opt-in memories; task history; audit trail; tool permissions; interruption/cancellation; text-only fallback.

**Explicit non-goals for first launch:** unconstrained shell execution, silent mass deletion, always-on microphone recording, bypassing OS security, arbitrary browsing with inherited credentials, unreviewed email sending, or pretending demo functionality is live.

## 3. Information architecture and page-level specifications

Canonical route prefix: `/app`. Unauthenticated routes: `/welcome`, `/setup`, `/login`, and `/connect-device` as needed by current architecture. Make application shell persistent while nested routes change.

### 3.1 Home — `/app`
Purpose: immediate entry point for all interactions. Header: `Good morning. How can I help?` with date or contextual subtitle only when available. Center: interactive voice orb with start/stop, typed input, optional camera/attachment affordance if implemented. Below: context-aware 4–6 example command chips: Find a file; Open an app; Summarize PDF; Run workflow; Check schedule; Ask anything. Right rail: assistant readiness, microphone and speaker permission, device connection, enabled integrations, pending approvals. Bottom: recent tasks, continue conversation, and pinned automations. Empty state: first-run suggestions without fabricated activity. **Primary CTA:** Talk to Edith.

### 3.2 Voice Studio — `/app/voice`
Purpose: distraction-free active conversation. Large orb, live partial transcript, authoritative finalized transcript, assistant voice response, waveform visual keyed to real mic/audio levels, interruption control, text response, session timer, mic mute and end session. Active tools appear in collapsible execution cards. Controls: push-to-talk versus hands-free mode, speaker mute, caption toggle, output device selector when supported, provider connection, end session. When mic access is denied, offer text-only mode and browser permission guidance. Sessions must end cleanly when page closes or user revokes permission.

### 3.3 Conversations — `/app/conversations`, `/app/conversations/:id`
Purpose: searchable conversation library. List shows title, last modified, origin (voice/text), small status, and delete/archive controls. Detail shows exact dialogue turns, timestamps, associated task cards, user-visible tool decisions, attachments, linked results, retry and resume. Search and filters: date, source, task outcome. Privacy controls: export and delete, governed by retention policy. Empty state prompts to start conversation.

### 3.4 Task Center — `/app/tasks`, `/app/tasks/:taskId`
Purpose: single source of truth for executions, not just chat. Columns or filters: All, Running, Needs approval, Completed, Failed, Cancelled. Task detail contains request, parsed goal, execution plan, step-by-step statuses, evidence/output, errors, retries, cancellation, approvals, audit events and final summary. Statuses: queued, planning, awaiting_permission, running, paused, succeeded, failed, cancelled. Prevent duplicate side effects with idempotency keys. For long-running jobs, tasks persist independent of a browser tab where supported by server/agent.

### 3.5 Automations — `/app/automations`, `/app/automations/:id`
Purpose: recurring or manual automation management. Cards include name, purpose, trigger, next eligible run, last run outcome, access scope, toggle and Run now. Editor: plain-language description plus structured trigger, available tools, file scope, approval policies, notification policy, run timeout, failure/retry controls. Version workflows and keep execution history. Handle timezone and missed-run semantics explicitly. Never automatically schedule unspecified or unsafe side effects.

### 3.6 Files — `/app/files`
Purpose: browse only allowed local/cloud file roots. Search by filename, date, type, metadata or extracted text where indexed. Filters and previews for PDFs, Office files and text where parsers exist. Actions: open, summarize, extract data, rename, move, create folder, organize, export. Separate browsing from indexing status. Display source device, full location and last-indexed timestamp. Edits require confirmation with exact files/paths; deletions go to recycle bin when supported, with recovery instructions.

### 3.7 Knowledge — `/app/knowledge`, `/app/knowledge/:collectionId`
Purpose: opt-in document collections for retrieval-augmented Q&A. Upload/import from permitted sources, parsing and indexing state, collection scope, source counts, retention and deletion. Answers display links to documents and relevant excerpts/pages; state uncertainty when retrieval is weak. Separate private collections and shared/embeddable ones. Allow re-index, remove, export, and forget.

### 3.8 Memory — `/app/memory`
Purpose: transparent personal assistant memory. Views: Saved preferences, Project context, Routines, Recently suggested memories. Actions: inspect, approve, edit, disable, remove, export. Support session-only/no-memory mode. Never silently treat private documents as global model memories. Each memory includes origin, date, scope and deletion control.

### 3.9 Calendar — `/app/calendar`
Purpose: assistant-linked schedule view. Today/week/month, upcoming events, conflicts, available slots, natural-language create/reschedule. Clearly indicate connected calendar account, source, timezone and refresh state. Show a review form before creating or editing events. If no OAuth connected, show a truthful Connect Calendar empty state.

### 3.10 Integrations — `/app/integrations`
Purpose: external app connections. Cards for supported providers (e.g. calendar, email, cloud storage, GitHub, workflow tools) only when implemented or explicitly Coming soon. Connect/disconnect, permission scopes, service health, last sync, account identity, reauthorize, and revoke tokens. Never store provider secrets in the browser. Each connection reveals what EDITH may read or modify.

### 3.11 Devices — `/app/devices`
Purpose: pair and manage local companion(s). Device cards: friendly name, OS, version, online/offline, last heartbeat, permitted roots/apps, revoke access, rotate pairing. Pairing requires a short-lived challenge and local user confirmation. Explain that browser-only mode cannot access arbitrary desktop files or launch local apps. Provide installation/setup guidance and troubleshoot connection.

### 3.12 Skills — `/app/skills`
Purpose: capability catalog with descriptions and permissions. Examples: File Explorer, Document Reader, Browser Research, Calendar, Python Workflow Runner. Each skill displays supported actions, required scopes, examples and test action. Installation is explicit; distinguish available, disabled, needs connection, beta. Third-party skills must be vetted and sandboxed.

### 3.13 Activity — `/app/activity`
Purpose: searchable audit log. Timeline entries for voice sessions, task creation, authorization, file operations, automation execution, integrations, failures and cancellations. Filters by source/device/action/status/time. Each event shows who/what initiated it, target resource (with redaction), time, result, and related task. Do not expose sensitive text to lower-trust observers.

### 3.14 Permissions — `/app/permissions`
Purpose: review and revoke tool grants. Per-skill and per-resource scopes, temporary session permissions, blocked paths, allowed applications, expiration, and approvals history. Force fresh user confirmation for bulk/destructive/external actions; one confirmation should not become unrestricted future access.

### 3.15 Settings — `/app/settings`
Tabs: Profile and workspace; Voice (language, speed, voice, push-to-talk/hands-free); Appearance (light/dark/system, density, reduced motion); AI (model/provider where exposed, response style, usage limits); Privacy (retention, data export/deletion, diagnostics opt-in); Notifications; Local companion; Accessibility; Security and sessions. User settings must be persisted securely and show whether saving succeeded.

### 3.16 Notifications — `/app/notifications`
Purpose: approval needed, task done/failed, disconnected device, expired connection, upcoming run. Prioritize user action over nonessential updates; deep link to affected task.

### 3.17 Help and setup — `/app/help`, `/setup`
Purpose: device setup, mic/browser compatibility, provider connection steps, supported commands, permission explanation, FAQ and troubleshooting. Onboarding sequence: greeting → choose name/voice → grant microphone (only when needed) → verify speech/text → pair PC optional → connect integrations optional → first guided task. Allow skip, recover and return.

### Optional future: Embeddable Assistant SDK — `/app/developer`
Generate per-site scoped embed tokens, configure permitted skills, brand customizations, and origin allowlists; iframe/web component SDK. Embedded agents must never inherit local desktop authority or cross-site private memories.

## 4. Navigation and layout contracts

**Desktop (>=1280px):** left sticky sidebar 224–248px; central flexible content min 560px max ~980px; contextual right rail 288–328px; 24–32px page gutters. Shell header contains breadcrumbs, command search, status, notifications and account. Orb-centered home may use 2-column center/right card layout and a full-width activity section beneath. Don't force right rail on pages where content tables need width.

**Tablet (768–1279px):** collapsed icon rail 64–72px; main content flexible; right rail becomes a drawer or lower collapsible panel. Hide ornamental descriptions, not primary actions.

**Mobile (<768px):** one-column layout; top bar with brand and overflow; bottom navigation for Home / Voice / Tasks / Files / More; fixed accessible voice dock; responsive sheets for status, permissions, tools. Ensure microphone control is never hidden behind the onscreen keyboard. Avoid animated backgrounds causing battery drain.

**Universal navigation:** Ctrl/Cmd+K command palette; search across allowed content; browser back/forward; robust deep linking; breadcrumbs beyond top level; clear active nav; keyboard skip-to-content; no dead nav items.

## 5. Visual design system — minimal, warm, trustworthy

Tokens (starting proposals to refine after evaluating the actual CSS):

```css
:root {
  --color-canvas: #F7F6F2;
  --color-sidebar: #FBFBF8;
  --color-surface: #FFFFFF;
  --color-surface-soft: #F1F3EA;
  --color-surface-muted: #E9EEE3;
  --color-ink: #172B28;
  --color-text-secondary: #63716A;
  --color-text-subtle: #87928B;
  --color-border: #E2E7DC;
  --color-primary: #446B4D;
  --color-primary-hover: #36583E;
  --color-primary-on: #FFFFFF;
  --color-focus: #386F9C;
  --color-success: #38764D;
  --color-warning: #91640C;
  --color-danger: #AD443B;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 24px;
  --shadow-card: 0 2px 10px rgba(22, 42, 27, .035);
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;
}
```

Typography: modern humanist sans (Inter, DM Sans, or existing closest) for main UI; restrained serif only for one-line editorial accent or E monogram if desired. Hierarchy: 40–48px hero on desktop, 28–32px mobile, 24–28px page headings, 16–18px card headings, 14–16px body, 12–13px metadata. Use line-height ~1.4–1.6; don't shrink operational labels below readable size. Type weights 400/500/600. Prefer real font loading strategy with system fallback and no layout shift.

Components: cards on bright surface, 1px soft border, very subtle shadow; large quiet whitespace; pale sage selection background; rounded primary buttons, restrained iconography, meaningful status colors. Do not flood interface with badges/gradients. Maintain WCAG AA contrast for text/control states; verify tokens with automated checker rather than assuming compliance. Show focus-visible rings; all pointer targets >=44x44px on touch.

Microcopy: confident and precise. Examples: “Ready when you are”; “Listening…”; “I found 12 matching documents”; “Review these changes”; “Microphone is blocked”; “Your Windows device is offline.” Avoid pretending execution or integration success.

## 6. Universal voice system specification

**Modes:** Text-only, push-to-talk, and hands-free while a session is intentionally active. Optional wake-word later only when platform capability, privacy consent, and battery behavior are validated.

**State machine:** idle → requesting_permission → connecting → listening → transcribing → thinking → speaking; tool requests branch thinking → awaiting_approval → executing → speaking; transient errors → reconnecting or error; end/cancel → idle. Allow barge-in/interrupt from speaking to listening, cancel pending audio playback and mark previous output interrupted. Tool execution is a separate task state and should not be misrepresented as a conversation state.

**Audio UX:** mic start is explicit; input meter corresponds to actual mic amplitude with smoothing; output meter corresponds to emitted audio rather than random animation; transcript partial text is visually distinct from finalized; mute always visible; stop/disconnect immediate; session record indicator and notice truthful. Show session quality when meaningful. Avoid logging raw audio by default; disclose any audio transfer and retention.

**Fallback behavior:** if WebRTC/WebSocket fails, degrade to typed assistant; if speaker permission or autoplay fails, show caption-only response and a Play action; if microphone denied, explain browser steps; if provider returns rate limit, show retry option; if companion offline, cloud/chat remains usable. A failed tool action should never be narrated as completed.

**Key interaction flows:** (1) Click mic → browser permission → listening → speech → transcript → model/tool selection → result/voice reply. (2) Tool with side effect → show typed approval sheet listing action, exact resources, scope, risk and cancel → execute only after approval → show outcome/undo if supported. (3) User interrupts response → stop playback and begin new turn without corrupting task state. (4) Device disconnect mid-action → pause, record error, determine idempotent retry and ask for reconnection.

**Orb styles:** idle: sage disk with faint 1px rings; listening: gently expanding ring and mic-amplitude waveform; thinking: slow low-amplitude concentric motion; speaking: fluid subtle waveform synchronized to output audio; executing: slim radial progress/busy ring accompanied by text; approval: pause animation and show review CTA; error: static ring with error color + explanation. Use CSS transforms/opacity or SVG, never massive particle engines. Durations: 120–180ms hover/focus; 180–260ms card transitions; 800–1600ms ambient cycles (only while active). Respect `prefers-reduced-motion` and stop unnecessary animation offscreen.

## 7. Functional capability specifications

### 7.1 Conversational AI
Stream text and, when available, audio. Maintain user-visible turns, attachments and context budget. Track provider/model separately from UI. Never expose API keys to the frontend. Bound history and allow conversation deletion.

### 7.2 Task orchestrator
Map natural-language requests to typed tools with verified schemas. Generate a readable plan for multistep operations. Distinguish analysis/read from external side effects. Show each step and source of evidence. Implement cancel, retry with idempotency, timeouts and structured errors. No unrestricted model-authored command execution.

### 7.3 Secure Windows companion
Separate locally installed agent (Node.js/TypeScript, Python or .NET based on repository feasibility), authenticated to backend via local pairing and expiring credentials. Minimum tool set: list allowed directories, find files, inspect metadata, read approved file contents, open allowlisted apps, move/rename with confirmation. Expose granular capabilities, sandbox paths, check traversal/symlink boundaries, constrain size and count, and audit results. Do not permit arbitrary shell commands from prompts.

### 7.4 Document intelligence
Parser adapters for PDF, text, common Office formats. Index only user-selected roots and collections. Capture provenance and citation pointers. Protect against malicious document instruction injections; treat retrieved content as data only. Handle large files asynchronously with progress and cancellation. OCR only when warranted.

### 7.5 Integrations and calendars
OAuth / authorization code flow with PKCE where appropriate, smallest practical scopes, short-lived access tokens, secure encrypted refresh token storage, revocation, and connection health checks. Preview every email send, calendar update and other external write. Make disconnected/expired states explicit.

### 7.6 Memory
Use structured user-approved personal memory entries with scope, origin, timestamps, controls and retention. Distinguish long-term preferences, short-lived session context, and retrieved document facts. Provide export/delete functionality and a privacy mode.

### 7.7 Automation execution
Workflows defined through triggers and steps with typed inputs, bounded retries, timeouts, execution logs and a dry-run option where feasible. Ensure scheduled workflows run through a server-side scheduler/worker, not only an open browser. Respect permission expiration and per-run approval policy.

## 8. Component architecture and recommended code organization

Adapt to existing repo after auditing. Suggested React + TypeScript frontend if not already present; keep Node.js service if it is stable, preserving Gemini integration behind an adapter. Avoid rewriting a functioning server without a measured migration case.

```text
frontend/src/
  app/                 # router, auth, providers, error boundaries
  layouts/             # AppShell, Sidebar, Header, RightRail, MobileDock
  pages/               # Home, Voice, Tasks, Files, Knowledge, Memory, ...
  features/
    voice/              # state machine, session hooks, orb, captions, audio
    conversation/       # turns, history, attachments
    tasks/              # execution plans, approvals, progress
    files/              # file browser, preview, scoped actions
    knowledge/          # collections, upload, source citations
    integrations/       # connect, revoke, health
    automations/        # workflow editor, history
    memory/             # review/edit/delete memories
    permissions/        # confirmation dialog, access management
  components/ui/       # button, dialog, input, card, toast, skeleton, etc.
  design/              # tokens, themes, global CSS, icons
  hooks/               # typed fetch, queries, accessibility utilities
  lib/                 # API client, event protocol, error handling
  types/               # shared contracts
backend/src/
  api/                 # HTTP routes, auth, validations
  realtime/            # voice/text session gateway and events
  ai/                  # provider adapter, prompts, bounded context
  agent/               # planner, tool registry, policy, executor
  tools/               # typed tool modules with permission contracts
  tasks/               # durable task runner, idempotency, audit
  integrations/        # OAuth providers and token lifecycle
  documents/           # parsers, indexing, retrieval
  memory/              # stores, user consent and retention
  security/            # auth, authorization, audit, rate limits
companion/             # installable Windows device agent, local permissions
shared/                # event schemas, tool contracts, validation types
```

### Component inventory
- **Shell:** AppShell, WorkspaceSidebar, TopBar, GlobalSearch, CommandPalette, NotificationsPopover, AccountMenu, MobileBottomNav.
- **Voice:** VoiceOrb, VoiceController, MicrophonePermissionCard, AudioLevelMeter, RealtimeTranscript, VoiceStateLabel, DeviceSelector, SessionControls, VoiceErrorPanel.
- **Conversation:** MessageList, UserMessage, AssistantMessage, StreamingMessage, ToolCallCard, AttachmentCard, SourceCitation, ConversationSearch.
- **Tasks:** TaskList, TaskFilterBar, TaskDetail, StepTimeline, PermissionReviewDialog, ToolExecutionCard, ResultArtifactCard, CancelRetryControls.
- **Data:** FileTree, FileSearchBar, DocumentPreview, KnowledgeCollectionCard, MemoryEntryCard, ConnectionCard, DeviceCard, AutomationCard, ActivityTimeline.
- **Shared:** Button, Card, Modal, Sheet, Tooltip, Popover, Tabs, Badge (sparingly), Skeleton, EmptyState, ErrorState, Toast, ConfirmDialog.

### Example typed protocol (adapt as needed)
```ts
type VoiceState = 'idle' | 'requesting_permission' | 'connecting' |
  'listening' | 'transcribing' | 'thinking' | 'speaking' |
  'awaiting_approval' | 'executing' | 'reconnecting' | 'error';

type TaskStatus = 'queued' | 'planning' | 'awaiting_permission' |
  'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

type AssistantEvent =
  | { type: 'session.state'; sessionId: string; state: VoiceState }
  | { type: 'transcript.partial'; sessionId: string; text: string }
  | { type: 'transcript.final'; sessionId: string; text: string }
  | { type: 'assistant.text.delta'; sessionId: string; text: string }
  | { type: 'task.created'; taskId: string; title: string }
  | { type: 'task.step'; taskId: string; stepId: string; status: TaskStatus }
  | { type: 'approval.requested'; taskId: string; approvalId: string; summary: string }
  | { type: 'tool.result'; taskId: string; toolName: string; ok: boolean; summary: string }
  | { type: 'session.error'; sessionId: string; code: string; message: string };
```

Backend contracts (starting proposal, not assumed existing): `POST /api/sessions`, `WS /api/realtime`, `POST /api/conversations/:id/messages`, `GET /api/tasks`, `GET /api/tasks/:id`, `POST /api/tasks/:id/cancel`, `POST /api/approvals/:id/decision`, `GET /api/files/search`, `GET /api/integrations`, `POST /api/devices/pair`, `GET /api/activity`, `GET/PATCH /api/settings`. Validate every input server-side, authorize every route and tool separately; the browser never decides authorization.

Persistence entities: Users, Workspaces, Conversations, Messages, Sessions, Tasks, TaskSteps, ToolRuns, Approvals, Devices, FileIndexItems, KnowledgeCollections, Sources, Memories, Integrations, Automations, AutomationRuns, AuditEvents, Settings. Define schema migrations, indexes, ownership checks and retention policies. Use relational storage where transactional correctness is useful; select DB by existing stack rather than mandate a rewrite.

## 9. Security and trust requirements

Security boundary is critical because voice will request real-world actions. Untrusted model output, web pages, PDF text, voice transcription and metadata cannot grant privileges. Server-side policy engine evaluates tool name, user, workspace, device, allowed path, resource, risk level, and user consent; never rely on the model saying approval was given. Tools must have narrow JSON schemas, input validation, output sanitization, rate limits, audit entries and cancellation.

Require explicit preview/confirm for delete, overwrite, bulk rename/move, send/forward email, publish, payment, share externally, install software, modify credentials, or system settings. Do not handle credentials or passwords via chat transcripts. Reconfirm when requested scope changes. Use trash/backup and undo where supported. Expose denial and partial success clearly. Encrypt tokens at rest; use HTTPS and secure cookies; protect against CSRF, XSS and WebSocket cross-origin misuse. Pair devices with user approval; allow immediate revocation. Keep audit logs redacted, access-controlled, and retention-bound. Do not treat the voice speaker's identity as authentication.

## 10. UX quality, accessibility, and failure states

Every page needs loading, empty, error, permission-denied, offline, partial-success, and success states. Empty pages should guide first action. Distinguish `not configured`, `disconnected`, `no data`, `no match`, and `failed`.

Keyboard navigation: logical tab order, focus traps for dialogs, Escape to close, accessible command shortcuts, screen-reader labels for voice controls, live regions for state updates without excessive announcements, accessible transcripts, visible focus indicators. Voice must never be the only input. Test responsive layouts at 360, 390, 768, 1024, 1440 and 1920 widths, with 200% zoom and reduced motion. Test color contrast with automated tooling; maintain a manual screen-reader checklist.

## 11. Phased engineering roadmap, gates and outputs

### Phase 0 — Repository intelligence and guardrails
Inspect actual repo, read package files and architecture, identify Node/browser/Gemini stack, working routes and voice features. Run baseline tests, list environment variables without printing values, map dependencies and existing reusable modules. Add `docs/architecture.md`, route map, feature flags, migration and rollback plan. **Gate:** existing functionality understood, tests pass or baseline failures documented, no destructive changes.

### Phase 1 — Minimal design system and application shell
Establish tokens, global typography, sidebar, responsive top bar, navigation, main content container, right rail, basic cards, dark mode only if appropriate. Build home, page stubs, error/empty/skeleton states, accessible core components. Remove booking-specific text and widgets only after wiring replacement routes. **Gate:** screenshot-inspired shell across desktop/mobile; all links resolve; no appointment terminology except historical/migrated data.

### Phase 2 — Voice Studio and conversation layer
Build explicit mic permission flow, streaming transport adapter, session state machine, interactive orb, captions, playback, controls, reconnection and text mode. Reuse existing Gemini integration behind provider adapter; support cancellation. **Gate:** speak → transcript → response; interrupt; deny mic; disconnect/reconnect; keyboard-only; reduced motion tested.

### Phase 3 — Conversations, task model and approvals
Persist conversation records; implement task abstraction, list/detail UI, execution timeline, tool registry and permissions review. Start with deterministic harmless example tools. **Gate:** every tool action maps to a task event; approvals are enforced server-side; failure/cancel/retry visible and tested.

### Phase 4 — Local Windows companion and file intelligence
Design pairing, secure channel, capability registration, allowlisted roots/apps, indexed read-only file search and previews. Then add scoped moves/renames with confirmation, safety checks and audit. **Gate:** blocked paths stay blocked; revoke kills access; malicious tool args cannot traverse; offline state gracefully degrades.

### Phase 5 — Knowledge, memories and integrations
Add document parsers/indexing/retrieval with citation anchors; opt-in memory controls; initial OAuth-based integrations, preferably calendar and email if useful. **Gate:** grounded answers with source references; memory export/delete; access token revocation; every external write reviewed.

### Phase 6 — Automation and scheduled agents
Implement workflow editor, scheduler, execution workers, run history, notifications, dry-run and failure handling. Support extensible Python automation through validated, pre-registered tasks rather than arbitrary command execution. **Gate:** scheduled runs do not require browser open; retry/idempotency works; scopes and approvals remain enforced.

### Phase 7 — Hardening, production readiness and rollout
Threat-model and security review; perf instrumentation; integration tests; e2e tests; accessibility evaluation; reliable CI; backup/migrations; observability and error reporting; gradual release with flags. Document deployment, support, logs/retention and privacy disclosures. **Gate:** no critical security/a11y blockers; reproducible deployment; recoverable failure paths; measurable baseline metrics.

### Phase 8 — Optional embed SDK and multi-workspace
If future websites need EDITH widgets, define site-specific scoped API, allowed origins, embed UI, isolation and billing/limits. Never share PC grants or private knowledge across tenants. **Gate:** isolation tests prove one site/workspace cannot access another's data.

## 12. Testing and definition of done

- **Unit:** UI state machines, reducers, policy decisions, tool schema validation, formatting, permission scope matching.
- **Integration:** voice events, model adapter failures, task persistence, worker retries, OAuth state checks, pairing and revocation, indexed document citation.
- **E2E:** first-run onboarding, typed and spoken chat, permission rejection/approval, file search, simulated desktop offline, cancel task, export/delete memory, keyboard navigation.
- **Visual:** reference-based desktop home, tablet and mobile regressions; contrast and layout; reduce-motion snapshots.
- **Security:** prompt injection via documents, path traversal, symlink escape, cross-origin attacks, unapproved writes, token leakage, replayed approvals, unauthorized task views, device revocation.
- **Performance:** code splitting, lazy-loaded complex pages, bounded lists, virtualized history, minimized audio UI re-renders, worker backpressure and connection retry budgets.

Definition of done: actual user action works end-to-end; loading/empty/error/permission states exist; no mocked status represented as live; tool calls protected by server policy; tests and documentation exist; accessible keyboard path; telemetry redacts secrets; migration/rollback documented.

## 13. Recommended implementation order for Codex

Start with Phase 0 and Phase 1 only. Do not attempt to replace the voice backend and implement PC controls while also redesigning the entire UI. Scaffold future routes using honest empty states, not fabricated activity. Then implement each phase behind feature flags with acceptance tests. Always inspect repository conventions before choosing React Router versus another router, state management library, database, UI system or WebSocket framework. Prefer reuse and incremental migration.

## 14. Final interaction and copy examples

Home headline: “Your day, a little easier.” Support line: “Ask a question, find something, or let Edith take care of the next step.” Primary button: “Talk to Edith.” Suggested commands: “Find my latest resume”; “Summarize this PDF”; “Open VS Code”; “What’s on my calendar?”; “Run my report”; “Organize these files.”

Voice status: “Ready when you are”; “Connecting microphone”; “Listening”; “Thinking”; “Speaking”; “Preparing a plan”; “Review required”; “Running step 2 of 4”; “Completed”; “Partially completed”; “Couldn’t connect to your computer.”

Consent copy: “Edith needs access to your Documents folder to search these files. This access will be read-only and can be revoked anytime.” Approval copy: “Move 12 files from Downloads to Invoices? Review names and destination before continuing.”

**End state:** a warm, quiet, capable AI desktop and web assistant; the home page remains simple, complex power lives in context-dependent pages and task panels, and the system is honest about every action it takes.
