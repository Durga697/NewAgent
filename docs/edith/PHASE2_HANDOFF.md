# EDITH AI Phase 2 handoff

## A. Repository verification

Phase 1 was verified, not assumed: tools/registry.mjs, tools/pathGuard.mjs, safety/policy.mjs, authority.mjs, sessions.mjs, audit.mjs, cloudGate.mjs, config.mjs, permissions.mjs and the Windows adapter were inspected/reused. Baseline `npm run test:all` passed 33 of 34 unit tests (one privilege-dependent symlink skip) and all five integration checks. The existing uncommitted Phase 1 implementation was preserved. The original app is plain browser JavaScript plus Node 20.11/Express/Gemini Live, not React/Electron. SQLite and the worker were expressly requested in this phase; a WASM dependency avoids native bindings, compiler installation or a runtime/framework/provider change.

## B. Implemented capabilities

Dynamic fixed-drive metadata discovery uses the guarded Windows adapter; real local discovery returned one fixed volume during verification. It does not grant access. Explicit configured folders/drive roots are traversed by a secure streaming crawler with hard denies, Unicode/long-path handling, link/identity checks, limits, cancellation and safe diagnostics.

SQLite persists metadata, run history, migrations, queued updates and filename/token/trigram FTS. A single Node worker owns transactions, crawling, watchers, reconciliation and bounded queries. Worker lifecycle controls integrate into existing authenticated routes and SSE. Watchers debounce/coalesce bounded updates and periodic scans repair missed events; unavailable drives retain stale records. Search supports exact/prefix/partial, order-independent and bounded typo ranking, extension/type/drive/folder/size/created/modified filters, stable sorting and session snapshot pages. The parser uses the configured user timezone and rejects ambiguous numeric dates.

Opaque session references and current/previous search/selection context resolve ordinal/newest/oldest/last/selected/previous commands. Every page/action is revalidated through the original security boundary. Existing Gemini tool calling, audio input/output, interruption, appointment review/save and frontend theme remain. Notepad text and trusted Edge PDF opening are supported, plus Explorer reveal and authorized folder opening. No arbitrary associated apps are launched. The existing UI adds filters/pages, metadata details, indeterminate real progress, drive discovery, read-only effective settings, lifecycle controls and reviewed metadata reset. No fake files, snippets or guessed completion percentage are displayed.

## C. Complete Phase 2 file changes

Paths are relative to this repository. Some modified files were already uncommitted additions from Phase 1; this table distinguishes Phase 2 work from the inherited Git diff.

New files:

| File | Purpose |
| --- | --- |
| config/indexing.jsonc | Private SQLite/worker/search/watcher limits and startup/timezone settings |
| index/config.mjs | Strict config, safe private storage and test isolation |
| index/database.mjs | Durable schema/migrations, FTS, batched upserts, bounded parameterized search and recovery |
| index/crawler.mjs | Streaming guarded traversal and cooperative lifecycle checkpoints |
| index/driveDiscovery.mjs | Authorized dynamic Windows drive reporting |
| index/service.mjs | Worker RPC, deadlines, progress, run correlation and compatibility interface |
| index/watcher.mjs | Validated-directory watcher cap, debounce and bounded event coalescing |
| index/worker.mjs | One database owner, crawl/queue/reconciliation lifecycle and safe rebuild |
| search/queryParser.mjs | Natural filename/metadata/date/size filters using configured timezone |
| search/ranking.mjs | Classification, normalization, bounded edit-distance and configurable deterministic scoring |
| tools/intelligence.mjs | Registry definitions for metadata/context/folder/drive/index tools |
| test/indexing.test.mjs | Fifteen real SQLite/crawler/worker/watcher/context/security tests |
| checks/helpers/index-benchmark-worker.mjs | Actual 100,000-row worker benchmark |
| checks/index-benchmark.mjs | Benchmark orchestration, hardware/latency/memory/event-loop reporting |
| checks/index-observation.mjs | Real disposable-tree crawl/watcher throughput/latency observations |
| docs/edith/PHASE2_BASELINE_AUDIT.md | Verified baseline and integration decisions |
| docs/edith/PHASE2_ARCHITECTURE.md | Final architecture, dependency decision and boundaries |
| docs/edith/PHASE2_DATABASE_SCHEMA.md | Schema, migrations, ownership, recovery and FTS contracts |
| docs/edith/PHASE2_SEARCH_DESIGN.md | Parser, ranking, pagination/references and privacy |
| docs/edith/PHASE2_INDEXING_DESIGN.md | Crawler, lifecycle, watcher and stale-record behavior |
| docs/edith/PHASE2_TEST_REPORT.md | Exact executed results, benchmark evidence and limits |
| docs/edith/PHASE2_HANDOFF.md | This complete delivery report |

Modified existing Phase 1 files:

| File | Phase 2 change |
| --- | --- |
| .env.example | Non-secret EDITH_INDEX_CONFIG selector |
| README.md | Current Windows setup, commands, search/index/privacy/rebuild guidance |
| package.json | Pin SQLite WASM, remove unused Fuse, add focused/benchmark scripts |
| package-lock.json | Exact dependency resolution for that change |
| server.mjs | Initialize persistent worker, status/control routes, SSE progress, cancellation and voice tool guidance |
| public/app.js | Forward progress from existing SSE stream |
| public/files.js | Shared voice/UI results, metadata filters/pages/actions and index controls |
| public/index.html | Extend the existing panel with accessible filters/progress/settings/controls |
| public/style.css | Small responsive styles for those added controls |
| config/edith-security.jsonc | Add the fixed Microsoft Edge PDF handler |
| safety/config.mjs | Strictly validate only known Notepad/Edge handler paths and exact arguments |
| safety/cloudGate.mjs | Filter all new file/context seams, sanitize index/drive output and refresh shared metadata |
| safety/permissions.mjs | Security metadata for new tools and natural file/index/drive instruction scopes |
| tools/config.mjs | Load strict indexing config alongside existing root settings |
| tools/fileIndex.mjs | Compatibility export for the new persistent service; remove obsolete in-memory implementation |
| tools/intent.mjs | Consent for newest/previous/selected/folder commands |
| tools/list_allowed_folders.mjs | Read worker counts instead of an in-memory Map |
| tools/pathGuard.mjs | Exclude private index storage and validate folder capabilities |
| tools/registry.mjs | Register new tools through existing mandatory policy/audit pipeline |
| tools/results.mjs | Bound previous/selected context and one-use session snapshot pagination |
| tools/search_files.mjs | Expanded validated filters, worker search, snapshots and current-path page checks |
| tools/service.mjs | Persistent startup/lifecycle, approved folder targets and selected-action context |
| tools/windows.mjs | Fixed Edge PDF URL arguments, installed-handler checks and Explorer folder operation |
| test/file-tools.test.mjs | Observe worker state through async fixture APIs, retain original assertions |
| test/security.test.mjs | Isolated index storage, async adapter failure and PDF handler validation |
| checks/files.mjs | Extend full voice/SQLite/UI flow with health/discovery/PDF/folder coverage |
| checks/helpers/mock-explorer.mjs | Test-only Edge launch and fictional drive interception |
| checks/syntax.mjs | Include new index/search modules in syntax verification |

Other dirty files/additions shown by Git belong to the preserved Phase 1 patch and were not newly changed by Phase 2: checks/browser.mjs, checks/gemini.mjs, checks/helpers/fixtures.mjs, checks/security.mjs, public/security.js, tools/audit.mjs, tools/errors.mjs, safety/audit.mjs, safety/authority.mjs, safety/confirmations.mjs, safety/errors.mjs, safety/pathRules.mjs, safety/policy.mjs, safety/sessions.mjs, safety/undo.mjs, safety/windowsContracts.mjs and all five PHASE1 documents. Their reasons/inventory remain in PHASE1_HANDOFF.md. Ignored databases, test reports and private environment files are not source deliverables.

## D. Tests

Exact executed baseline, full regression, focused final verification, live smoke and performance commands/results are in PHASE2_TEST_REPORT.md. Full regression: 49 tests, 48 pass, zero fail, one Windows file-symlink privilege skip; all five integration checks pass. Final focused checks: 31 tests, 30 pass, zero fail, same one skip. Syntax: 64 modules. Fake provider/microphone and intercepted apps are explicitly distinguished from a real Gemini greeting-audio and fixed-drive discovery smoke test. No human accent accuracy claim is made.

## E. Performance

Real final 100,000-row SQLite benchmark (100,020 after interleaved writes): warm p95 exact 17.62 ms, fuzzy 291.33 ms, partial 436.05 ms, word-order 374.27 ms, metadata 68.27 ms, combined 72.19 ms and pagination-window 64.47 ms. Each class has 24 measured samples after warmup. Interleaved-write fuzzy p95: 246.97 ms. These exclude UI/network/path revalidation and do not claim exhaustive fuzzy recall.

Hardware, p50 values, query plans, three optimization runs, memory, journal mode and scope are fully documented in the test report. Durable batched insertion was 407 records/sec; database ~91.1 MiB. Real 100-file crawl: 562.24 ms (178/sec); ten watcher creations: p50 446.06 ms, p95 777.06 ms with 350 ms debounce. No 250k/500k or whole-drive throughput claim is made.

## F. Windows execution

1. From the project root, use Node >=20.11 and run `npm ci` for a fresh installation. Existing local installation was updated successfully. No native compiler is required.
2. Keep the existing Gemini key in ignored `.env.local`; do not copy it to the browser or Git. Run `npm start` for the backend.
3. Open http://localhost:3000 for the frontend; the same backend serves it. Reload older tabs to establish current cookie/CSRF state.
4. Review `config/file-tools.jsonc` and explicitly allow desired local folders or drive roots. Defaults remain Downloads only. Adjust stricter exclusions/localOnly/neverTouch in config/edith-security.jsonc. Restart after edits. Discover drives reports metadata, never permission.
5. Click Start indexing in the existing file panel. Monitor real counts/status and incomplete-results warnings. Pause/Resume/Cancel scan are cooperative. To opt into automatic startup, set `startup:true` in config/indexing.jsonc. User-search timezone also lives there, independently from business booking timezone.
6. Enter filename/natural metadata words and optional UI filters, search and page results. Use Open / Show in folder / Open folder on authorized result cards. Empty-index search can start a background scan; repeat when initial results are incomplete.
7. Start a voice conversation, allow microphone access, say the examples below and select a result. Finish closes voice and releases the microphone. Denial and interruption cleanup are regression tested.
8. Run `npm run check`, `npm run test:all`, `npm run test:phase2`; run `npm run benchmark:index` for real disposable-tree and 100,000-metadata-row benchmarks. Benchmark setup can take several minutes because writes are durable. No API key is required for automated doubles.
9. To rebuild, Cancel scan and wait for completion, open Index settings & maintenance, click Rebuild metadata index, review and confirm reset, then Start indexing. Only app metadata is reset; corrupt databases are preserved as timestamped siblings. For INDEX_LOCKED, close the owning process; never delete a live lock. Restart after WORKER_FAILED. Do not elevate the app to bypass protected paths.

## G. Manual voice acceptance

Use temporary sample files in an explicitly configured disposable root, not personal documents just for testing. Wait for a complete scan before expecting complete results.

- “Edith, find my resume.” Verify real filename results and concise speech, not fabricated contents.
- “Edith, show my latest PDF.” Verify type/date order; “Open the first one” should hand the chosen PDF to trusted Edge if installed. Automated PDF handoff is intercepted; manual viewing is your actual test.
- “Edith, open the second one.” Verify the second result of the current page, not a different session/search. If changed/deleted/expired, Edith should ask for a new search.
- “Edith, find Excel files from last week.” Verify the configured timezone/Monday-based date range and spreadsheet type. No spreadsheet contents are read.
- “Edith, show the biggest files on D drive.” First explicitly authorize an existing drive/folder on D if present; this machine's live smoke found only one fixed drive, so a nonexistent/unapproved drive must not fabricate matches.
- “Edith, open that folder.” First select/open a result so “that” is unambiguous; verify its allowed parent opens in Explorer. With multiple unresolved candidates, ask for clarification.

Also ask an unrelated normal question after a search; it must remain normal Gemini conversation. Test interruption/preferences and microphone denial. LocalOnly names stay in the local results panel; the cloud cannot resolve hidden ordinals reliably, so select those locally. Finish conversation closes the voice transport.

## H. Remaining limitations and acceptance boundaries

Implemented and tested: Phase 1 enforcement; existing app regressions; dynamic fixed-drive discovery; guarded recursive metadata indexing; persistent worker/SQLite; cooperative lifecycle/recovery; watcher/reconciliation; exact/partial/fuzzy/order-independent filters/sorting; result/context/session protection; approved opening/reveal/folder actions; existing voice/tool/SSE/UI integration; read-only effective configuration; local-only egress; realistic benchmarks and seven Phase 2 documents.

Explicit limits: windows-wide access requires explicitly configured roots; discovery never authorizes every drive. Settings editing is local/restart-based, not a browser config writer. Watchers cover up to 256 validated directories with eventual reconciliation beyond that. Candidate/snapshot windows cap broad searches and label fuzzy fallback limited. Filename ranking cannot infer document contents. Cancellation/deadlines are cooperative; a synchronous query can finish after the caller stops waiting. Interrupted scans reconcile from roots, not an exact saved traversal cursor. Drive loss retains unavailable metadata. Renames conservatively reconcile paths rather than claiming durable file-ID tracking across every filesystem.

SQLite WASM uses rollback journaling and one exclusive owner, not WAL/multiple simultaneous writers. Durable insert throughput is modest and reported honestly. Index metadata is ACL-restricted but unencrypted and not protected from the same account/admin; OS handle-based atomic action protection and Windows identity pairing remain outside this phase. File-symlink tests need privileges not present here. OneDrive placeholder behavior, human Indian-accent recognition and every hardware/antivirus combination require local manual testing. The PDF handler requires Edge installed under the validated Program Files path (default x86; a reviewed x64 path is also accepted by strict config). Text handlers remain fixed Notepad. Office/image/video/source discovery does not authorize arbitrary app execution; executables/scripts are blocked, and unsupported document opens must use an allowed reveal action. No public deployment is claimed.

No Phase 3 extraction, content FTS, OCR, embeddings, semantic ranking, summarization/Q&A, mutations, packaging or arbitrary app launch is implemented. No tests/performance figures are invented.

## I. Phase 3 readiness and stop

Phase 3 can add versioned document/chunk/extraction tables keyed to internal metadata IDs and introduce bounded PDF/DOCX/XLSX/PPTX/OCR processing behind the same authority/policy/path/permission/audit contracts. It can reuse worker messaging, lifecycle, migration, result/context, UI progress and privacy seams. Filename FTS is separate from future document-content FTS, so content/chunk retrieval need not replace the metadata schema. Embeddings, semantic/hybrid retrieval and content-cloud consent require separately reviewed tools and egress policy; no content-upload fallback is enabled now.

STOPPED after Phase 2. Existing Phase 1 work remains intact. All changes are local/uncommitted; nothing was automatically committed or pushed.
