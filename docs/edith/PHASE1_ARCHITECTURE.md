# Phase 1 additive architecture

## Execution pipeline

Existing frontend -> same-origin cookie session + CSRF -> schema validation / registry lookup -> independently branded current user instruction -> risk/permission policy -> canonical path and privacy guard -> exact-operation confirmation where required -> bounded Windows adapter -> redacted append-only audit -> structured result.

Gemini proposes operations; it does not mint user authority, path capabilities, confirmations or adapter permits. All file tools use the same registry/executor. Existing calendar behavior remains intact. Security configuration is loaded/validated locally on restart; no configuration mutation endpoint is introduced.

## Decisions

1. Retain Node/Express, browser modules, Gemini Live, cookie sessions, local JSON bookings and existing result/index APIs. New modules are additive under `safety/`; existing `tools/` is hardened rather than duplicated.
2. Same-origin bootstrap keeps the existing cookie. Add cryptographic CSRF, idle/absolute expiry, rotation/invalidation and bounded session storage. No browser localStorage token, credential URL, new login provider or cross-origin protocol is needed.
3. Keep the prior filename feature as legacy functionality; Phase 1 adds no SQLite, content reading, additional watchers, full-drive crawling or background workers. Do not expand included roots automatically. Avoid startup crawling by making the existing root index demand-started when used; no new index algorithm is planned.
4. Existing Explorer file associations are not a sufficient safe-open contract. Retain controlled spawn, but direct approved text formats to the trusted Windows Notepad handler; Explorer is only a selection/reveal adapter. Other associations fail closed until an approved handler is explicitly configured. No native package is added.
5. Confirmation manager supports exact target/parameter previews, one-time tokens, request/session binding and expiry. No destructive executor is registered. Undo is an interface/state contract, not a claim of reversibility.
6. Cloud egress gate validates provider, genuine instruction, opaque file references and local-only rules. Content upload remains disabled in Phase 1. Existing metadata responses are filtered at every Gemini egress seam. Retrieved data cannot mint authority.

## Extension interfaces

- Security config: explicit existing roots by default, exclusions, immutable hard denies, never-touch/local-only rules, approved types/handlers, fixed-drive metadata discovery on explicit request only, policy/privacy/logging/confirmation limits.
- PathGuard: existing path capabilities and future nearest-existing-ancestor destination capabilities; neither is a client-supplied string capability. Revalidate immediately before launch. No create operation is implemented.
- Policy engine: READ_ONLY / REVERSIBLE / DESTRUCTIVE_OR_BULK / FORBIDDEN; structured ALLOW/DENY/NEEDS_CONFIRMATION. Future reversible/bulk tools remain unimplemented.
- User authority: authenticated typed/voice provenance versus model output, retrieved content, tool output and external service data.
- Registry: one schema/risk/permission/path/confirmation contract, optional output validation, model-neutral dispatch. Gemini declarations are a bridge view of these definitions.
- Audit: append service with redaction, request correlation, sanitized pagination and explicit failure policy. Local filesystem administrators can still tamper with writable storage.
- Windows adapter: capability/permit-bound open/reveal and fixed-drive metadata. Recycle/restore/application launch contracts return unsupported until later approved phases.

## Approval boundaries

No framework, provider, database, native binding, service deployment or authentication replacement is required. A global OS login/token pairing protocol, Electron, atomic handle-based native filesystem operations, approved general app launching, SQLite persistence and Recycle Bin native integration would require separate design/approval before implementation. None is part of this phase.
