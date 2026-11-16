# Phase 2 architecture

## Integration and decisions

The existing Node 20.11/Express/browser-module/Gemini Live application is retained. No framework, AI provider, deployment model or authentication replacement is introduced. `tools/fileIndex.mjs` remains a compatibility import; its old in-memory/Fuse crawler is replaced by `index/service.mjs`. FileService, PathGuard, ResultStore, ToolRegistry, PolicyEngine, UserAuthority, CloudGate, LocalSessions and AuditService remain the execution boundary.

The expressly requested SQLite/worker architecture is implemented with pinned `node-sqlite3-wasm@0.8.61`, verified locally as SQLite 3.54.1 with FTS5. It supports Node filesystem persistence without native compilation. Upstream: https://github.com/tndrle/node-sqlite3-wasm . No native addon, compiler, Docker or runtime upgrade is needed. This VFS is not a general multi-process SQLite concurrency layer: use DELETE rollback journaling with synchronous FULL, one worker connection, prepared batched transactions, and an exclusive app-owned PID lock. WAL is deliberately not claimed. A second application owner fails with INDEX_LOCKED; stale locks are recovered only when their PID is demonstrably absent. PID reuse can conservatively block startup until local review. Do not open the live database with a second writer.

## Execution paths

Voice audio -> existing Gemini transcript -> authenticated current user authority -> Gemini tool proposal -> registry/schema/permission/policy -> search worker -> SQLite candidates/ranking -> session snapshot -> main-process PathGuard revalidation -> opaque result references -> existing SSE/results UI. Only CloudGate-approved metadata crosses the Gemini bridge. Normal conversation and appointment review/save remain unchanged.

UI writes -> existing cookie + CSRF + Host/Origin checks -> same registry. Existing POST /api/file-tools/:name is the primary API. GET /api/index/status and POST /api/index/:action are convenience routes using the same registry; their permissions/audit are not bypassed. Internal worker messages are app-authored, not browser- or model-accessible commands. Configured roots authorize automatic/periodic metadata reads; discovery does not add roots.

Explicit file/folder action -> session reference -> current principal/permit -> filesystem identity and path revalidation -> known Notepad text or Edge PDF handler / Explorer. No shell association, arbitrary executable or model-supplied command is used. Metadata support for a format is not permission to launch an arbitrary associated app. Missing Edge returns an explicit unsupported-type error. DOCX/XLSX/PPTX can be found/revealed; opening them remains unavailable until another handler is reviewed.

## Lifecycle, configuration and UI

Load strict security and indexing JSONC, restrict the dedicated index directory, start one worker, migrate/restore SQLite, inspect root availability, then serve the app. Initial crawling is not a prerequisite for voice startup. Default startup scanning is off; Start indexing, first authorized search on an empty index, or explicit `startup:true` can start it. Existing data is immediately searchable. A partial scan is labeled incomplete. Restarting after an interrupted run preserves committed batches; an explicit start (or startup opt-in) performs a fresh reconciliation rather than claiming an exact traversal checkpoint.

The worker streams directories, batches metadata, persists watcher tasks, serializes writes and services bounded search RPCs between crawl yields. Start/pause/resume/cancel/status/rebuild are available. Rescans requested during incremental work are queued by run ID. SSE publishes sanitized counts/status, never a guessed completion percentage. The UI extends the original panel with filters, paginated result cards, type/size/date/location, folder/open/reveal actions, progress, drive discovery, read-only effective settings and a two-step metadata-reset control. Configuration remains local/restart-based; no settings-write endpoint is exposed.

## Security boundaries and residuals

Protected/system/credential/dependency paths, exclusion and never-touch rules override drive roots. Links/junctions are not traversed. The database and audit stores are excluded from file tools even if a parent drive is allowed. Main-process result/action checks enforce current rules even when SQLite contains stale rows. Index filenames/paths and result text are untrusted data, never authority. User instructions, keys and document contents are not written to this index.

Index data contains private local paths and names; directory ACLs restrict it to the account/System. It is not encrypted and does not defend against that account or an administrator. LocalOnly entries remain searchable locally and are filtered at every file-result cloud seam. Spoken requests themselves still reach Gemini. A local-only ordinal that is unavailable to the model requires local UI selection; no local TTS engine is introduced. Existing TOCTOU and nearby-audio spoofing limits remain. No document extraction, OCR, semantic retrieval or file mutation is added.
