# Phase 2 filename and metadata search

## Query interpretation

`search/queryParser.mjs` converts bounded natural language plus validated explicit filters into normalized filename terms, extension/type, drive/folder, size and created/modified ranges. Explicit filters take precedence over inferred values. Categories include PDFs, documents, spreadsheets, presentations, images, videos, audio, code, archives and other. Metadata discovery may include source files, but executable/script opening is always denied.

Supported time expressions: today/yesterday, this/last week (Monday start), this/last month, this morning, named month plus year, and last weekday. `config/indexing.jsonc` supplies an explicit user-search timezone; it is independent of the sample business's booking timezone. Default Asia/Kolkata matches this workstation. ISO date-only ranges are local calendar days; ISO timestamps include an offset. Ambiguous numeric shorthand is refused. Creation and modification filters remain distinct. Unknown phrases are treated as filename words, not semantic content requests; no language model-generated dates silently bypass validation.

Examples: `Find Excel files from last week`, `images created this morning`, `files larger than 500 MB on D drive`, `files from October 2026`, `latest Python project`, `What files did I work on today?`. Folder aliases and valid authorized physical subfolders are accepted as explicit filters; path syntax/traversal in free-form filename queries is refused.

## Retrieval and ranking

SQLite performs exact/token-prefix FTS candidate selection and parameterized metadata filters. When strong token-prefix candidates are absent, a bounded, diversified trigram fallback retrieves candidates for typos/partial tokens. Independent token anchors prevent a rare erroneous trigram from crowding out relevant results (the benchmark exposed `resmee` retrieving only unrelated meeting candidates before this fix). Edit distance runs only over bounded candidates, not all indexed files. Exact/prefix matches receive higher configurable scores than fuzzy matches. Every query token must match. Token order is independent; deterministic pathname tie-breaking follows the requested relevance/newest/oldest/size/name order. Creation-time sorting is also supported. This is filename matching, not document understanding.

Default candidate limit is 600; fallback candidate retrieval is also bounded and is conservatively labeled limited. Snapshot windows are capped at 1,000 entries. Very broad name searches may be truncated even if more files exist; `limited` and UI guidance make that explicit. Narrow the query for exhaustive retrieval. The 100,000-row benchmark includes broad searches and reports both before/after optimization; bounds are not a claim of globally exhaustive fuzzy recall.

## References and pagination

Internal database IDs never authorize access. ResultStore issues unpredictable HMAC references bound to the local session and metadata identity, with a configured TTL (default 600 seconds). It retains current/previous searches, selected/previous selected file, current folder, last action and version. Server snapshots yield one-use random 48-hex pagination cursors, bound to that session/TTL, with at most three snapshot records. Page size is at most configured maxResults/100. TotalInWindow is a bounded candidate-window count, not a fabricated whole-computer count. Expired, forged, reused and cross-session cursors fail.

`resolve_file_reference` resolves ordinals, newest/oldest/last/selected/previous or previousSearch. Several plausible meanings of "it" require clarification. Resolution does not launch a file or create user authority. Current speech consent, policy, session, identity and PathGuard checks still precede every action. Stale size/mtime/device/inode results must be searched again.

## API and privacy

POST /api/file-tools/search_files accepts query or cursor, optional folder/parentFolder, drive, fileType, isDirectory, extensions, minSize/maxSize, createdAfter/Before, modifiedAfter/Before, sortBy, limit. Unknown properties and excessive limits are rejected by Ajv. Related registry tools: get_file_metadata, resolve_file_reference, open_file, reveal_in_folder, open_folder, get_index_status, get_drive_information, index_control. All go through Phase 1 authentication/policy/audit. No raw-path action endpoint exists.

Main-process filesystem revalidation filters result pages before IDs/UI/cloud output. Cancellation and RPC deadlines bound requests; a timed-out synchronous SQLite statement may finish in the worker before the next message, but its result is discarded. There is no unbounded SQL job queue. CloudGate shares only approved small metadata subsets, omits absolute paths, filters LocalOnly results and treats names as untrusted data. No document contents are read or uploaded.
