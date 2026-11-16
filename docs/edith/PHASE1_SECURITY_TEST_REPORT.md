# Phase 1 security test report

Executed on Windows, Node 20.11.0, on 2026-11-13. Baseline commit: `58f3eda`. These results describe local tests, not a security certification.

## Baseline

Before changes, `npm test` passed all 18 tests. `npm run test:files`, `test:voice`, `test:browser` and `test:config` also passed. Existing voice, calendar and filename tools were established before implementation.

## Final verification

- `npm run check`: all 50 JavaScript modules parse successfully. This repository has no TypeScript compiler, bundler, build script or lint script; none is claimed to have run.
- `npm run test:all`: 34 unit tests, 33 passed, zero failed, one explicitly skipped. All five subsequent integration checks passed: security, files, voice, browser and config.
- `npm run test:security`: focused unit/file suite plus isolated HTTP/WebSocket security integration. Included in the broader verification above through its constituent checks.
- `git diff --check`: passed (Git may report Windows line-ending normalization warnings).

Unit coverage includes strict/frozen config, protected paths, exclusions/never-touch, canonical containment and junction escape, forged capabilities/permits, destination ancestors, session expiry/rotation/CSRF, provenance, policy classification, confirmation expiry/replay/target changes, audit redaction/concurrent append/tamper/write failure, cloud local-only filtering, disabled content upload, malicious instructions, registry validation, unsupported adapters/undo, and structured permission/filesystem errors.

The file-symlink test is skipped because this Windows account lacks Developer Mode/link creation privilege (EPERM). Junction tests still execute and pass. EACCES/EPERM/EIO and canonicalization failures are injected deterministically; no permissions on personal files are modified.

## Integration evidence

Security integration uses a generated disposable tree under ignored `data/test-fixtures` and a local Gemini double. It verifies unauthenticated HTTP/WS denial, CSRF, hostile Origin/Host denial, rotation/logout invalidation, no startup crawl, authorized local results, local-only metadata absent upstream, no file contents or absolute paths sent upstream, protected credentials-path denial and unknown-tool refusal. All negative assertions passed.

File integration verifies search, ordered conversation selection, reveal/open routing through an intercepted Windows adapter, protected/outside refusal and desktop/mobile UI. Voice integration verifies streamed audio, tool calls, interruption and booking review against a local provider double. Browser/config checks verify calendar review/save and configurable business behavior. No real document app launches in automated checks; test-only interception covers both Explorer and Notepad.

A separate live smoke test connected to the real configured Gemini service, observed session ready and generated audio, then closed the session. The production listener was observed on `127.0.0.1:3000`, and state bootstrap returned HTTP 200 with an established CSRF token and zero indexed files at startup. No key value was printed. This is not a human microphone/accent recognition test. Automated audio checks use fake microphone input.

## Limits

No full-drive scan, SQLite benchmark, 100,000-file performance claim, real destructive action, Recycle Bin restore, arbitrary application launch, PDF/Office extraction or undo execution was tested or implemented. New audit-directory ACL restriction runs on Windows; existing user directories/logs are untouched. Hash chaining detects edits to the observed log chain, but cannot prevent an administrator from rewriting the entire chain. Native handle-based atomic path/open protection remains future work.
