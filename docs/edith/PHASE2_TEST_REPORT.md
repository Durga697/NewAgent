# Phase 2 test and performance report

Executed on Windows on 2026-11-13 with Node 20.11.0. Tests operate on generated files under the ignored workspace `data/test-fixtures` tree. The original Phase 1 work is preserved and no commit/push is performed.

## Executed commands and results

| Command | Actual result |
| --- | --- |
| Phase 2 baseline: npm run test:all | 34 unit tests: 33 pass, 0 fail, 1 Windows file-symlink privilege skip; all five integration checks pass |
| npm run check | 64 JavaScript modules parse successfully; no bundler/TypeScript/lint pipeline exists |
| npm run test:all after integration and SQL optimization | 49 unit tests: 48 pass, 0 fail, 1 same privilege skip; security/files/voice/browser/config integration checks all pass |
| node --test test/indexing.test.mjs test/security.test.mjs after final metadata freshness/limited-result adjustments | 31 tests: 30 pass, 0 fail, 1 same privilege skip |
| node checks/index-benchmark.mjs | Three real runs on 100,000 synthetic SQLite records; final representative p95 search workload below 500 ms, detailed below |
| node checks/index-observation.mjs | Real 100-file disposable crawl and ten watcher-create latency samples, detailed below |
| git diff --check | Passed; Windows line-ending normalization warnings may be printed |
| npm install / uninstall dependency resolution | Pinned node-sqlite3-wasm 0.8.61 added, unused Fuse dependency removed; npm reported 0 vulnerabilities |

`npm run test:phase2` provides a focused repeat of indexing unit tests plus file/security integrations. `npm run benchmark:index` now composes the two executed observation/benchmark scripts. Raw final/baseline/focused/benchmark JSON outputs are retained locally under ignored data/, not committed or exposed by the server. No clean-install (`npm ci`) execution is claimed for this existing workspace.

## Functional/security coverage

Fifteen new indexing tests cover actual SQLite migrations/upserts/rollback/restart/interrupted-run recovery; safe rebuild and schema downgrade rejection; corrupt database preservation/recovery; strict metadata/date/type/size filters; exact/partial/typo/order-independent search; SQL/FTS injection resistance; Unicode and long paths; protected and never-touch directories; junction loops; injected permission errors; cooperative pause/resume/cancel and search during indexing; duplicate index ownership; watcher create/modify/rename/delete/folder bursts; explicit reconciliation; unavailable-root stale policy; session pagination and ordinal/newest/previous references; cross-session/expired refs; changed exclusions; executable/raw-path refusal; voice consent; local-only privacy across new tools; current cloud metadata freshness; and unexpected worker termination.

The file integration follows a recognized transcript through the Gemini double, registry, policy, worker/SQLite, references, SSE and desktop/mobile panel. It verifies index health/status, fictional fixed-volume discovery, metadata lookup, folder actions and PDF launch arguments. Explorer/Notepad/Edge launches and drive-discovery responses are intercepted only by a test preload. No real document app launches and no personal files are searched by automated tests. Other integration checks retain appointment review/save, conflict handling, voice PCM/audio/interruption/mute/shutdown, microphone-denial cleanup, session/CSRF/Origin refusal and alternate-business branding.

The file-symlink test is skipped because this account lacks Developer Mode/link privilege. Junction security tests run and pass. Permission and unexpected filesystem errors are injected rather than modifying user-folder ACLs. Windows ACL restriction executes on new private app/fixture storage only. No destructive filesystem operation targets personal folders.

## Live smoke evidence

The final application returned HTTP 200 with Edith branding, initialized CSRF and zero indexed entries at startup. The listener was observed on `127.0.0.1:3000`. A real authenticated Gemini connection reached ready, produced greeting audio and closed through the authenticated close endpoint. The real Windows discovery adapter returned HTTP 200 and one fixed volume; it did not scan it or grant access. No key values or private filenames were printed. This is not a live human-microphone/accent test; automated microphone/audio use generated input and provider doubles.

## Final 100,000-row benchmark

Hardware: Intel Core i5-1240P (12th generation), 16 logical processors, 16,892,026,880 bytes RAM; Windows 10.0.26200. Runtime Node v20.11.0, SQLite 3.54.1, node-sqlite3-wasm 0.8.61, DELETE rollback journaling. Dataset: 100,000 generated metadata rows over 16 filename topics, eight extensions, 100 folders, controlled sizes/dates and a fictional D drive. No 100,000 real files were created. Twenty later writes bring the final row count to 100,020.

Warm cache: one warmup followed by 24 timed samples per query class. Timings include SQLite retrieval, result mapping and bounded ranking; exclude network/UI, session-page transport and real filesystem revalidation. Pagination measures bounded SQL snapshot retrieval plus page slicing, not an end-to-end HTTP round trip. The host also ran local verification work during parts of the experiment. Percentiles describe this workload, not a guarantee for every drive or fuzzy query.

| Query class | p50 ms | p95 ms | Matches in bounded window |
| --- | ---: | ---: | ---: |
| Exact filename tokens | 10.96 | 17.62 | 1 |
| Fuzzy `resmee` | 181.88 | 291.33 | 200 |
| Partial filename | 278.40 | 436.05 | 600 |
| Word-order independent | 249.98 | 374.27 | 600 |
| Extension + date ordering | 62.59 | 68.27 | 1,000 |
| Combined drive/type/size/date | 67.14 | 72.19 | 1,000 |
| Metadata pagination window | 46.96 | 64.47 | 1,000 |

With interleaved worker writes, fuzzy search over twenty samples measured p50 167.10 ms, p95 246.97 ms. This is serialized write/search work in the real worker, not multiple simultaneous database connections. Final representative warm classes meet the p95 <500 ms target. Result windows are bounded; these figures do not claim exhaustive fuzzy recall.

Batched insert throughput: 100,000 records in 245,784 ms (407 records/sec), batch size 500, including both filename FTS tables and durability costs. Database size: 95,526,912 bytes (~91.1 MiB). Worker JS heap: 23,482,008 bytes; process RSS: 134,750,208 bytes (includes main process and WASM memory, not isolated worker RSS). Main-thread 20 ms heartbeat: p95 additional delay 15.51 ms, maximum 127.49 ms over 8,575 samples. This is an event-loop responsiveness observation, not an HTTP latency percentile.

Query-plan evidence: extension/date lookup used `files_ext (extension=? AND modified_at>?)`. Root/directory/availability/order composites remove the earlier metadata sorting bottleneck. FTS candidate paths explicitly use rowid lookups rather than scanning an entire root-ordered index before filtering candidates.

The first run exposed broad-search/pagination p95 up to 1,996.54 ms and a fuzzy query that returned no valid résumé because erroneous rare grams crowded out good candidates. A second run diversified anchors and added composites, improving broad queries but exposing expensive root-index plans on selective FTS lookups (p95 exact/fuzzy 860.46/819.74 ms). The final run forces bounded rowid candidate lookup and prefers strong prefix matches before fuzzy fallback. All runs used 100,000 rows; the dataset was not reduced to claim success. No 250,000/500,000-row claim is made.

## Real filesystem observations

100 generated ordinary text files: initial crawl 562.24 ms, 178 files/sec, excluding fixture creation and worker/database initialization. Ten sequential watcher creations with the default 350 ms debounce measured p50 446.06 ms, p95 777.06 ms, including file write, debounce, SQLite update and polling observation. These are small disposable-tree observations, not whole-drive throughput estimates.

## Remaining verification limits

Human voice/accent accuracy, disconnected physical external disks, OneDrive recall behavior under every Windows policy, all antivirus/ACL combinations, power-loss recovery and arbitrary third-party document applications are not certified by these tests. Watcher coverage is capped at 256 directories, and reconciliation supplies eventual repair. Background state is cooperative; synchronous SQLite statements can finish after a caller deadline. No extraction, content upload, native atomic open, destructive operation, OCR, embedding or semantic retrieval is implemented or benchmarked.
