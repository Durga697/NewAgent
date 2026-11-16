# EDITH AI Phase 1 handoff

## A. Actual repository findings

The existing app is a Node/Express server with plain browser JavaScript, Gemini Live streaming via WebSocket/Web Audio, JSON demo bookings, an existing filename index/watcher and a schema-driven file tool registry. It is not a React, Electron or TypeScript application. Baseline commit `58f3eda` passed 18 tests and four integration checks. No architecture replacement or new dependency was necessary. See PHASE1_REPOSITORY_AUDIT.md for the inspected baseline.

## B. Implemented foundation

Authenticated same-origin cookie sessions now expire, rotate and invalidate, with CSRF required for writes and cookie/Origin checks for WebSockets. The registry checks branded current user authority, schemas, permissions, risk policy and validated paths before issuing an adapter permit. Gemini, documents and tool outputs cannot mint authority. System, credential, executable, exclusion and never-touch rules override configurable roots. Local-only metadata is filtered from Gemini; file-content cloud processing is disabled.

Exact-operation confirmations are session/request-bound, expiring, audited and one-time. There is no registered destructive executor. New audits redact values and private paths, serialize appends, chain hashes and fail closed when required writes fail. Only a new dedicated log directory receives restricted ACLs. Unsupported operations return structured failures. Existing audio, booking review and UI flows remain.

## C. Complete changed-file inventory

All paths below are relative to this repository. New files:

| File | Purpose |
| --- | --- |
| config/edith-security.jsonc | Strict security defaults and extension settings |
| safety/config.mjs | JSONC schema, immutable config, canonical rules and safe handler validation |
| safety/errors.mjs | Structured safe errors and HTTP statuses |
| safety/pathRules.mjs | Hard system/credential/executable denies and root/local-only predicates |
| safety/authority.mjs | Current authenticated typed/voice authority and untrusted-data wrapper |
| safety/permissions.mjs | Shared tool permissions, metadata and request scopes |
| safety/policy.mjs | Risk decisions and unforgeable execution permits |
| safety/confirmations.mjs | Exact previews, expiry, one-time approval and audit |
| safety/audit.mjs | Redacted serialized hash-chained audit service and authorized pagination |
| safety/sessions.mjs | Cookie sessions, CSRF, Origin/Host and lifetime checks |
| safety/cloudGate.mjs | Provider and metadata egress boundary |
| safety/windowsContracts.mjs | Dedicated audit ACLs and guarded future Windows interfaces |
| safety/undo.mjs | Honest undo state/unsupported contract |
| public/security.js | Module-memory CSRF helper |
| checks/helpers/fixtures.mjs | Bounded disposable workspace fixture directories |
| checks/security.mjs | Isolated HTTP/WS/privacy security integration |
| checks/syntax.mjs | Parse checking for project JavaScript modules |
| test/security.test.mjs | Policy, path, auth, privacy, audit and failure tests |
| docs/edith/PHASE1_REPOSITORY_AUDIT.md | Actual baseline inspection |
| docs/edith/PHASE1_ARCHITECTURE.md | Compatible architecture and extension contracts |
| docs/edith/PHASE1_THREAT_MODEL.md | Trust boundaries, threats and residual risks |
| docs/edith/PHASE1_SECURITY_TEST_REPORT.md | Executed results and verification limits |
| docs/edith/PHASE1_HANDOFF.md | This complete handoff and file inventory |

Modified files:

| File | Reason |
| --- | --- |
| .env.example | Non-secret security-config selector |
| README.md | Current safe behavior, configuration and verification guidance |
| package.json | Syntax/security/full verification commands; dependencies unchanged |
| server.mjs | Wire sessions, policy, audit, privacy and authenticated tools into existing routes/voice; safe async failures and bounded streams |
| public/app.js | CSRF bootstrap and authenticated close/write requests |
| public/files.js | CSRF headers for file actions |
| tools/audit.mjs | Legacy facade delegates to safe audit service |
| tools/errors.mjs | Compatible aliases for central errors |
| tools/fileIndex.mjs | Prevent existing index from crawling drive roots |
| tools/pathGuard.mjs | Canonical protected-path validation, capability identity, destinations and injected failure testing |
| tools/registry.mjs | Central mandatory authorization/policy/schema/path/audit pipeline |
| tools/search_files.mjs | Demand-start existing index after authorized request |
| tools/service.mjs | Security-aware guard, lazy startup, root inspection, action revalidation and permits |
| tools/windows.mjs | Capability-bound fixed text handler and Explorer reveal, no shell associations |
| test/file-tools.test.mjs | Authorized disposable-root fixtures compatible with enforced boundary |
| checks/files.mjs | CSRF/security-aware isolated file/voice/UI regression checks |
| checks/browser.mjs | Authenticate existing calendar test requests |
| checks/gemini.mjs | Simulate genuine recognized user instructions before model tool proposals |
| checks/helpers/mock-explorer.mjs | Test-only interception of Notepad as well as Explorer |

No lockfile, dependency, private environment credential, existing booking data, HTML/CSS design or historical log is changed by the patch. Ignored runtime/test logs are not source deliverables.

## D. Automated test results

`npm run check`: 50 modules passed. `npm run test:all`: 34 unit tests, 33 passed, zero failed, one Windows file-symlink privilege skip; security/files/voice/browser/config integration checks all passed. Baseline was 18 passing unit tests. See PHASE1_SECURITY_TEST_REPORT.md for actual coverage, live Gemini audio smoke evidence and limits. There is no separate build/lint/TypeScript pipeline in this repository.

## E. Exact local setup

Use Node >=20.11 and existing npm dependencies (`npm ci` for a fresh checkout). Keep the existing Gemini key in ignored `.env.local`; never place a key in browser JavaScript, a URL or Git. No new key is required. Local development retains `.env.local` precedence; test/production use explicitly supplied settings. Optional non-secret selector: `EDITH_SECURITY_CONFIG=config/edith-security.jsonc`.

Review `config/file-tools.jsonc` for narrowly allowed folders and `config/edith-security.jsonc` for further restrictions. Empty security includedRoots inherits the existing allowlist; it does not authorize all drives. Restart after config changes. Never add a drive root or credential directory. Local-only rules filter cloud output, not the authenticated local UI.

Run `npm run check`, `npm run test:security` or the full `npm run test:all`. Run `npm start` and open http://localhost:3000; the same backend serves the frontend. Reload existing browser tabs after upgrading for the new session/CSRF bootstrap. The listener stays on IPv4 loopback. No database migration or new service is required.

## F. Safe manual verification

1. Open a fresh page at localhost:3000. Check the business, available appointments and existing controls. Use manual booking, review the exact summary, confirm once and verify the booking appears. This writes only demo booking data.
2. Start a conversation, allow microphone access, speak a normal appointment request, interrupt/change the time, then finish. Verify audio stops and the microphone indicator clears. Deny permission in a separate attempt and verify a useful error without a stuck session. Human Indian-accent accuracy still needs this real microphone check.
3. Run `npm run test:security` for generated sample files only. It verifies 401 without a session/CSRF, 403 for hostile origins/protected paths, session rotation, local-only cloud filtering, malformed/unknown tool refusal and clean errors without touching personal documents.
4. Use generated sample `.txt` files in a specifically opted-in disposable folder if manually checking search/open. Startup does not scan. Notepad is the only approved opening handler; other formats may be revealed but not opened. Do not enable personal folders merely for testing.
5. Confirmation unit tests preview fictitious targets, reject changed/session-mismatched/expired/replayed approvals and verify one-time approval. No delete UI/endpoint or real mutation is present; an approved preview never means deletion happened.
6. New audit records appear under ignored `data/security-audit/events-<port>.jsonl`. Verify event/status/hash fields, without publishing local logs. There is no unauthenticated log endpoint; authorized bounded service pagination is tested. Historical audit files are unchanged.

## G. Security review and remaining approvals

Fully implemented: strict config, protected/excluded/never-touch paths, canonical containment and junction refusal, branded path capabilities and execution permits, mandatory registry checks, authenticated current request provenance, session/CSRF/Origin controls, safe text opening/reveal, cloud metadata filtering, structured failures, bounded resources and new redacted audited decisions. Confirmations have working preview/token/consumption logic, but no destructive executor or general destructive-confirmation UI.

Interfaces only: fixed-drive metadata discovery (guarded, not registered/called automatically), future metadata/destination operations, application manifest contract, Recycle Bin/restore and undo states. Reversible/bulk execution remains denied/deferred. Config-validation audit event names are defined, but invalid startup configuration is rejected before the normal audit writer starts; do not interpret this as proof every startup rejection is recorded there.

Residual risks: same-account malware/admin access can control local processes, files and cookies; local cookie bootstrap is not Windows identity/login pairing. Node path checks and external application opens have a TOCTOU gap despite revalidation and link refusal. An administrator can rewrite an unanchored audit chain. Existing historical logs may contain values from the old implementation and are not retroactively scrubbed. User speech and conversation still go to Gemini for the existing voice feature; this boundary blocks tool-result file content/metadata as configured, not secrets a user intentionally says. No claim is made that heuristic language intent perfectly understands every ambiguous command. A valid key/quota/network is still necessary for live voice.

Windows file-symlink creation tests require unavailable privileges; junction checks pass. Only reviewed Notepad text formats can open. Native atomic handle-based operations, OS-level login/pairing, broader application handlers, Recycle Bin implementation and persistent SQLite architecture need separate design/approval before later phases. No significant architecture approval was required for this additive phase.

## H. Phase 2 readiness and stop point

Phase 2 can build on the registry schema/permission contract, current user authority, policy/risk engine, path capabilities, local-only gate, Windows adapter boundary, audit and confirmation services, plus existing bounded legacy filename/results UI. Additions must pass through these boundaries. The pre-existing index and watcher were preserved and demand-started, not newly implemented by Phase 1. No new Windows-wide discovery, SQLite persistence, crawling workers, watchers, extraction, semantic search, file mutation, wake word, global hotkey or packaging is added here. No performance claims for those future systems are made.

STOPPED after Phase 1. Changes are local and uncommitted; no automatic commit or push was performed.
