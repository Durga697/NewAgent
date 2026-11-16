# Phase 2 database schema

Private location: `config/indexing.jsonc` directory, default `data/file-index/metadata.sqlite`. Storage must be strictly under the repository's ignored `data` directory, with no symlink/junction redirect. Windows ACLs are restricted on the dedicated directory. Nothing under this directory is served statically or indexed through tools. Owner lock and SQLite sidecars are private app data. Never copy or publish a live index without considering the private paths it contains.

## Version 1

`files`: internal integer id; canonical_path; unique normalized_path (Windows case-folded); name and normalized_name; extension and file_type; parent_path; root_id and drive_id; size_bytes; nullable created_at; modified_at; indexed_at; last_seen_at; filesystem_identity (device:inode where available); ino/dev; is_directory; availability_status; last scan run_id. Timestamps are epoch milliseconds. Creation time is nullable when unsupported; it is never silently substituted with modification time. Directories have size zero.

`index_runs`: run_id primary key, started_at, finished_at, status, scanned/indexed/skipped/error counts. Running/paused rows from a prior process become interrupted at startup. A new scan reconciles from committed data. `index_queue`: target_path primary key, root_id, operation_type, attempt_count, created_at. Events coalesce by path; overflow coalesces into root refreshes, and periodic scans repair gaps. Retries are bounded to three per queued failure. `schema_migrations`: version primary key/applied_at; PRAGMA user_version also guards against opening newer schemas. New content/chunk tables can be introduced by later migrations without replacing the metadata table.

Indexes cover normalized path uniqueness, root/run, drive, parent, extension, type, created/modified timestamps, size and normalized name. Root + directory-kind + availability composites support newest/created/size/name ordered filtering. Use EXPLAIN QUERY PLAN to verify representative plans; the executed benchmark records the extension/date index use.

`filename_fts`: external-content FTS5 unicode61 tokens of normalized filenames. `filename_trigrams`: external-content FTS5 trigram filename tokens. Insert/delete/name-update triggers maintain them transactionally. Neither table contains document text. FTS expressions are constructed from normalized bounded terms, and every value is bound through parameters. Sort column names come only from an internal allowlist.

## Transactions and recovery

One worker owns one connection. Prepared batch upserts execute in transactions; explicit statements are finalized. Search runs synchronously inside the worker, so main HTTP/audio work is not blocked by SQLite calls. Rollback journaling (DELETE, synchronous FULL) is used; WASM VFS WAL/multi-process locking is not assumed. Application ownership uses an exclusive PID lock. The initial quick_check rejects corruption; schema versions newer than supported fail closed.

Missing databases are created. Partial transactions roll back; interrupted scans keep committed batches. Missing drives mark rows unavailable rather than asserting all files were deleted. Successful complete root scans remove unseen rows; incomplete/error/cancelled scans retain them. Results are revalidated against actual filesystem metadata before exposure/actions.

Authenticated rebuild resets only the app's tables. If the database is corrupt/newer, it is renamed to a `.corrupt-<timestamp>` sibling before creating a replacement; it is not silently discarded. No personal documents are deleted. The UI requires review before metadata reset; then Start indexing repopulates it. If another process owns the index, close it before rebuilding. Do not delete owner locks of a running process.
