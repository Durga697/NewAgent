# Phase 1 threat model

Assets: user documents and filesystem boundaries, credentials, local-only metadata/content, server sessions, Gemini quota, audit privacy and existing booking data.

Trust boundaries: untrusted browser origins -> local request boundary; authenticated user speech/typing -> model proposals; retrieved filenames/content -> inert data; registry -> policy -> path guard -> Windows process; local file metadata -> Gemini egress. A model response or retrieved document is never a user authorization.

| Threat | Baseline exposure | Phase 1 control |
|---|---|---|
| Malicious website / localhost CSRF / WebSocket hijack | Host/Origin and cookie existed, but sessions were created on writes | Bootstrap only on safe same-origin navigation/state; existing cookie plus CSRF on writes; host/origin/fetch-site checks; expiry/revocation |
| Model or file text proposes destructive commands | No destructive tool exists, but no explicit provenance authority | Branded authenticated request provenance, strict registry, independent policy; all forbidden operations denied |
| Traversal / sibling-prefix / ADS / UNC / device / junction | Most path-text checks existed | Keep existing checks; add protected segments, exclusions, never-touch and post-realpath rechecks; capability objects |
| Included system/credential roots | Root allowlist alone could include them | Immutable hard denies override included roots and every configurable permission |
| Stale confirmation, replay, changed targets or parameters | Recent text/ordinal only | Session/request/operation-bound preview digest, random one-time token, expiry and replay rejection |
| Unsafe Windows associations | Explorer could launch arbitrary registered handler | Known safe direct text handler only; explicit approved executable/argument contract; unsupported types denied |
| Prompt injection in content or fake tool JSON | Prompt instructions only + no file content reads | Untrusted-data boundary cannot issue principal/permit; registry validates independent authority; no extraction or content egress |
| Local-only file metadata leaks | Metadata was sent to Gemini and raw arguments logged | Central metadata/content egress gate, local-only deny, reference validation, path/argument redaction before audit |
| Log tamper / storage failure | Raw synchronous JSONL | Append ordering, bounded records, malformed detection, sanitized read interface and fail-closed tool decisions; restricted new log directory |
| Resource exhaustion | Unbounded sessions/seen IDs, startup scan | Bounded session/instruction/confirmation/audit state; no new broad startup scan; preserve bounded legacy search on demand |

Residual risks: another process running as the same Windows user can forge local HTTP headers, steal browser/session data or alter the app; local administrator compromise is out of scope. Voice recognition can mishear names or be spoofed by nearby audio. Cookies/CSRF are not Windows account authentication. Filesystem checks and process handoff have a residual TOCTOU race; strict atomic handle-based protection requires a separately approved native design. No perfect undo, tamper-proof logs, exhaustive malware detection, remote deployment support or guaranteed accent/recognition quality is claimed. Application-readable private paths and original historical logs are not deleted/migrated by this phase.
