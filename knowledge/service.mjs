import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { ToolError } from '../tools/errors.mjs';
import { containsPath } from '../tools/pathGuard.mjs';
import { assertPathPolicy, isLocalOnly } from '../safety/pathRules.mjs';
import { assertSafeSimpleName } from '../companion/fileOps.mjs';
import { SUPPORTED_EXTENSIONS, MAX_DOCUMENT_BYTES, parseDocument } from './parsers/index.mjs';
import { chunkDocumentText } from './chunker.mjs';
import { embedText, scoreChunk, extractCurrencyNumbers, normalizeTokens } from './embeddings.mjs';
import {
  answerFromChunks,
  summarizeDocuments,
  compareDocuments,
  formatExtractedTables
} from './qa.mjs';

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export class KnowledgeService {
  constructor({ store, files, security, auditEvent = async () => {}, publish = () => {}, hosted = false }) {
    this.store = store;
    this.files = files;
    this.security = security;
    this.auditEvent = auditEvent;
    this.publish = publish;
    this.hosted = hosted;
  }

  summary(ownerKey) {
    return {
      ...this.store.countKnowledgeStats(ownerKey),
      supportedExtensions: [...SUPPORTED_EXTENSIONS],
      hosted: this.hosted
    };
  }

  hasIndexedDocuments(ownerKey) {
    return this.store.countKnowledgeStats(ownerKey).documents > 0;
  }

  ensureDefaultCollection(ownerKey, { name = 'Private Knowledge', ocrEnabled = false } = {}) {
    const existing = this.store.listKnowledgeCollections(ownerKey);
    const match = existing.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (match) return match;
    if (existing.length && name === 'Private Knowledge') return existing[0];
    const now = Date.now();
    return this.store.createKnowledgeCollection({
      id: randomUUID(),
      ownerKey,
      name,
      description: name === 'Local Folders'
        ? 'Authorized local folder sources indexed locally inside EDITH OS.'
        : 'Private collection stored locally with source citations.',
      folderRootId: null,
      ocrEnabled,
      cloudAccess: false,
      retentionDays: 0,
      createdAt: now,
      updatedAt: now
    });
  }

  listCollections(ownerKey) {
    this.store.deleteExpiredKnowledgeDocuments(ownerKey);
    const cols = this.store.listKnowledgeCollections(ownerKey);
    const docs = this.store.listKnowledgeDocuments(ownerKey);
    return cols.map((c) => {
      const colDocs = docs.filter((d) => d.collectionId === c.id);
      return {
        ...c,
        documentCount: colDocs.length,
        chunkCount: colDocs.reduce((sum, d) => sum + (d.chunkCount || 0), 0),
        errorCount: colDocs.filter((d) => d.status === 'error').length
      };
    });
  }

  async createCollection(session, ownerKey, { name, description = '', folderRootId = null, ocrEnabled = false, retentionDays = 0 } = {}) {
    const cleanName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
    if (!cleanName) {
      throw new ToolError('INVALID_ARGUMENTS', 'Collection name is required.');
    }
    const safeRetention = Number.isInteger(Number(retentionDays)) ? Math.max(0, Math.min(3650, Number(retentionDays))) : 0;
    const now = Date.now();
    const created = this.store.createKnowledgeCollection({
      id: randomUUID(),
      ownerKey,
      name: cleanName,
      description: String(description || '').trim().slice(0, 300),
      folderRootId: folderRootId ? String(folderRootId).trim().slice(0, 80) : null,
      ocrEnabled: Boolean(ocrEnabled),
      cloudAccess: false,
      retentionDays: safeRetention,
      createdAt: now,
      updatedAt: now
    });
    await this.auditEvent({
      event: 'OPERATION_SUCCEEDED',
      tool: 'knowledge_collection_create',
      sessionId: session?.id,
      policyDecision: 'ALLOW',
      outcome: 'created'
    }).catch(() => {});
    this.publish(session, 'knowledgeUpdated', { type: 'collection', collectionId: created.id });
    return { ...created, documentCount: 0, chunkCount: 0, errorCount: 0 };
  }

  async deleteCollection(session, ownerKey, collectionId) {
    const col = this.store.getKnowledgeCollection(ownerKey, collectionId);
    if (!col) throw new ToolError('NOT_FOUND', 'Collection not found.');
    // Deletes ONLY Knowledge index entries; original local disk files remain untouched.
    this.store.deleteKnowledgeCollection(ownerKey, collectionId);
    await this.auditEvent({
      event: 'OPERATION_SUCCEEDED',
      tool: 'knowledge_collection_delete',
      sessionId: session?.id,
      policyDecision: 'ALLOW',
      outcome: 'deleted'
    }).catch(() => {});
    this.publish(session, 'knowledgeUpdated', { type: 'collection_deleted', collectionId });
    return { deleted: true, collectionId };
  }

  async #checkFreshness(doc) {
    if (doc.sourceType === 'upload') return 'uploaded';
    if (this.hosted || !this.files?.config?.enabled || !doc.sourcePath) return 'local_unavailable';
    try {
      const checked = await this.files.guard.inspect(doc.sourcePath, { opening: false, directory: false });
      if (checked.stat.size !== doc.sizeBytes || Math.abs(checked.stat.mtimeMs - doc.modifiedAt) > 2) {
        return 'stale';
      }
      return 'fresh';
    } catch {
      return 'missing';
    }
  }

  #publicDoc(doc, freshness = 'uploaded') {
    return {
      id: doc.id,
      collectionId: doc.collectionId,
      sourceType: doc.sourceType,
      rootId: doc.rootId,
      fileName: doc.fileName,
      extension: doc.extension,
      sizeBytes: doc.sizeBytes,
      modifiedAt: doc.modifiedAt,
      version: doc.version,
      status: doc.status,
      errorCode: doc.errorCode,
      errorMessage: doc.errorMessage,
      localOnly: doc.localOnly,
      parserName: doc.parserName,
      textPreview: doc.textPreview,
      tableCount: Array.isArray(doc.tables) ? doc.tables.length : 0,
      metadata: doc.metadata || {},
      chunkCount: doc.chunkCount,
      freshness,
      indexedAt: doc.indexedAt,
      updatedAt: doc.updatedAt
    };
  }

  async listDocuments(ownerKey, { collectionId = null } = {}) {
    this.store.deleteExpiredKnowledgeDocuments(ownerKey);
    const docs = this.store.listKnowledgeDocuments(ownerKey, { collectionId });
    return Promise.all(docs.map(async (d) => this.#publicDoc(d, await this.#checkFreshness(d))));
  }

  async getDocumentDetail(ownerKey, documentId) {
    const doc = this.store.getKnowledgeDocument(ownerKey, documentId);
    if (!doc) throw new ToolError('NOT_FOUND', 'Indexed document not found.');
    const chunks = this.store.listKnowledgeChunks(ownerKey, { documentIds: [doc.id] });
    return {
      ...this.#publicDoc(doc, await this.#checkFreshness(doc)),
      fullText: doc.fullText,
      tables: doc.tables || [],
      chunks: chunks.map((c) => ({
        id: c.id,
        chunkIndex: c.chunkIndex,
        section: c.section,
        content: c.content
      }))
    };
  }

  async #indexDocumentBytes(session, ownerKey, {
    collection,
    sourceType,
    sourcePath = null,
    rootId = null,
    fileName,
    extension,
    buffer,
    modifiedAt = Date.now(),
    localOnly = true,
    ocrEnabled = false,
    force = false
  }) {
    const sha256 = sha256Hex(buffer);
    const existing = this.store.findKnowledgeDocumentBySource(ownerKey, collection.id, {
      sourcePath,
      fileName,
      sourceType
    });

    if (
      existing &&
      !force &&
      existing.status === 'indexed' &&
      existing.contentSha256 === sha256 &&
      existing.sizeBytes === buffer.length
    ) {
      return { status: 'unchanged', document: this.#publicDoc(existing, sourceType === 'upload' ? 'uploaded' : 'fresh') };
    }

    const docId = existing?.id || randomUUID();
    const nextVersion = existing ? existing.version + 1 : 1;
    const now = Date.now();

    let parsed;
    try {
      parsed = await parseDocument({
        buffer,
        filePath: sourcePath,
        fileName,
        extension,
        ocrEnabled
      });
    } catch (err) {
      const failedDoc = this.store.upsertKnowledgeDocument({
        id: docId,
        ownerKey,
        collectionId: collection.id,
        sourceType,
        sourcePath,
        rootId,
        fileName,
        extension,
        sizeBytes: buffer.length,
        contentSha256: sha256,
        modifiedAt,
        version: nextVersion,
        status: 'error',
        errorCode: err.code || 'EXTRACTION_FAILED',
        errorMessage: err.message || 'Document parsing failed.',
        localOnly: true,
        parserName: extension.slice(1),
        textPreview: '',
        fullText: '',
        tables: [],
        metadata: {},
        chunkCount: 0,
        indexedAt: now,
        updatedAt: now
      });
      this.store.replaceKnowledgeChunks(ownerKey, docId, collection.id, []);
      this.publish(session, 'knowledgeUpdated', { type: 'document_error', documentId: docId });
      return { status: 'error', document: this.#publicDoc(failedDoc, sourceType === 'upload' ? 'uploaded' : 'fresh') };
    }

    if (parsed.skipped) {
      const skippedDoc = this.store.upsertKnowledgeDocument({
        id: docId,
        ownerKey,
        collectionId: collection.id,
        sourceType,
        sourcePath,
        rootId,
        fileName,
        extension,
        sizeBytes: buffer.length,
        contentSha256: sha256,
        modifiedAt,
        version: nextVersion,
        status: 'ocr_disabled',
        errorCode: null,
        errorMessage: parsed.warnings[0] || 'OCR is disabled for this collection.',
        localOnly: true,
        parserName: parsed.parser,
        textPreview: '',
        fullText: '',
        tables: [],
        metadata: { ...parsed.metadata, warnings: parsed.warnings },
        chunkCount: 0,
        indexedAt: now,
        updatedAt: now
      });
      this.store.replaceKnowledgeChunks(ownerKey, docId, collection.id, []);
      this.publish(session, 'knowledgeUpdated', { type: 'document_skipped', documentId: docId });
      return { status: 'ocr_disabled', document: this.#publicDoc(skippedDoc, sourceType === 'upload' ? 'uploaded' : 'fresh') };
    }

    const rawChunks = chunkDocumentText(parsed.text);
    const embeddedChunks = rawChunks.map((ch) => ({
      ...ch,
      id: randomUUID(),
      embedding: embedText(`${fileName} ${ch.section} ${ch.content}`)
    }));

    const storedDoc = this.store.upsertKnowledgeDocument({
      id: docId,
      ownerKey,
      collectionId: collection.id,
      sourceType,
      sourcePath,
      rootId,
      fileName,
      extension,
      sizeBytes: buffer.length,
      contentSha256: sha256,
      modifiedAt,
      version: nextVersion,
      status: 'indexed',
      errorCode: null,
      errorMessage: parsed.warnings?.length ? parsed.warnings.join(' ') : null,
      localOnly: localOnly !== false,
      parserName: parsed.parser,
      textPreview: parsed.text.slice(0, 600),
      fullText: parsed.text,
      tables: parsed.tables || [],
      metadata: { ...parsed.metadata, warnings: parsed.warnings || [] },
      chunkCount: embeddedChunks.length,
      indexedAt: now,
      updatedAt: now
    });

    this.store.replaceKnowledgeChunks(ownerKey, docId, collection.id, embeddedChunks);
    this.store.updateKnowledgeCollection(ownerKey, collection.id, { updatedAt: now });

    await this.auditEvent({
      event: 'OPERATION_SUCCEEDED',
      tool: 'knowledge_index_doc',
      sessionId: session?.id,
      policyDecision: 'ALLOW',
      outcome: 'indexed',
      resultCount: embeddedChunks.length
    }).catch(() => {});
    this.publish(session, 'knowledgeUpdated', { type: 'document_indexed', documentId: docId, version: nextVersion });

    return {
      status: existing ? 'reindexed' : 'indexed',
      document: this.#publicDoc(storedDoc, sourceType === 'upload' ? 'uploaded' : 'fresh')
    };
  }

  async ingestUploadedFile(session, ownerKey, { collectionId = null, fileName, buffer, ocrEnabled } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new ToolError('INVALID_DOCUMENT', 'Uploaded document cannot be empty.');
    }
    if (buffer.length > MAX_DOCUMENT_BYTES) {
      throw new ToolError('FILE_TOO_LARGE', `Document exceeds the ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB limit.`);
    }

    const blocked = this.files?.guard?.blocked || new Set();
    const cleanName = assertSafeSimpleName(fileName, blocked, { allowExtensionless: false });
    const ext = path.extname(cleanName).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      throw new ToolError('EXTRACTION_UNSUPPORTED', `Unsupported document type "${ext}".`);
    }

    const collection = collectionId
      ? this.store.getKnowledgeCollection(ownerKey, collectionId)
      : this.ensureDefaultCollection(ownerKey);
    if (!collection) throw new ToolError('NOT_FOUND', 'Target collection not found.');

    return this.#indexDocumentBytes(session, ownerKey, {
      collection,
      sourceType: 'upload',
      sourcePath: null,
      rootId: 'Upload',
      fileName: cleanName,
      extension: ext,
      buffer,
      modifiedAt: Date.now(),
      localOnly: true,
      ocrEnabled: ocrEnabled !== undefined ? Boolean(ocrEnabled) : collection.ocrEnabled,
      force: true
    });
  }

  async ingestLocalFile(session, ownerKey, { collectionId = null, filePath, rootId = null, ocrEnabled, force = false } = {}) {
    if (this.hosted || !this.files?.config?.enabled) {
      throw new ToolError('FILES_DISABLED', 'Local folder document indexing is disabled in this environment.');
    }
    const checked = await this.files.guard.inspect(filePath, { opening: false, directory: false });
    const ext = path.extname(checked.path).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      throw new ToolError('EXTRACTION_UNSUPPORTED', `Unsupported document extension "${ext}".`);
    }
    if (checked.stat.size > MAX_DOCUMENT_BYTES) {
      throw new ToolError('FILE_TOO_LARGE', `File "${path.basename(checked.path)}" exceeds the 10 MB Knowledge limit.`);
    }

    const collection = collectionId
      ? this.store.getKnowledgeCollection(ownerKey, collectionId)
      : this.ensureDefaultCollection(ownerKey, { name: 'Local Folders' });
    if (!collection) throw new ToolError('NOT_FOUND', 'Target collection not found.');

    const buf = await readFile(checked.path);
    const localFlag = true || isLocalOnly(checked.path, this.security);
    return this.#indexDocumentBytes(session, ownerKey, {
      collection,
      sourceType: 'local_folder',
      sourcePath: checked.path,
      rootId: rootId || checked.root?.id || 'Local',
      fileName: path.basename(checked.path),
      extension: ext,
      buffer: buf,
      modifiedAt: checked.stat.mtimeMs,
      localOnly: localFlag,
      ocrEnabled: ocrEnabled !== undefined ? Boolean(ocrEnabled) : collection.ocrEnabled,
      force
    });
  }

  async ingestAuthorizedFolder(session, ownerKey, { collectionId = null, folder, ocrEnabled, maxFiles = 100, force = false } = {}) {
    if (this.hosted || !this.files?.config?.enabled) {
      throw new ToolError('FILES_DISABLED', 'Local folder document indexing is disabled in this environment.');
    }
    const roots = await this.files.guard.folders(folder);
    const collection = collectionId
      ? this.store.getKnowledgeCollection(ownerKey, collectionId)
      : this.ensureDefaultCollection(ownerKey, { name: 'Local Folders', ocrEnabled: Boolean(ocrEnabled) });
    if (!collection) throw new ToolError('NOT_FOUND', 'Target collection not found.');

    const effectiveOcr = ocrEnabled !== undefined ? Boolean(ocrEnabled) : collection.ocrEnabled;
    let indexedCount = 0;
    let unchangedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const documents = [];
    let processed = 0;

    for (const root of roots) {
      let rootCap;
      try {
        rootCap = await this.files.guard.inspect(root.path, { directory: true });
      } catch {
        continue;
      }
      const queue = [rootCap.path];
      while (queue.length && processed < maxFiles) {
        const dirPath = queue.shift();
        let entries;
        try {
          entries = await readdir(dirPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (processed >= maxFiles) break;
          const full = path.join(dirPath, entry.name);
          if (entry.isSymbolicLink()) continue;
          try {
            if (this.files.guard.storageRoots?.some((sr) => containsPath(sr, full))) continue;
            assertPathPolicy(full, this.security);
            const info = await lstat(full);
            if (info.isSymbolicLink()) continue;
            if (info.isDirectory()) {
              queue.push(full);
            } else if (info.isFile()) {
              const ext = path.extname(entry.name).toLowerCase();
              if (!SUPPORTED_EXTENSIONS.includes(ext) || info.size > MAX_DOCUMENT_BYTES) {
                skippedCount += 1;
                continue;
              }
              processed += 1;
              const res = await this.ingestLocalFile(session, ownerKey, {
                collectionId: collection.id,
                filePath: full,
                rootId: root.id,
                ocrEnabled: effectiveOcr,
                force
              });
              documents.push(res.document);
              if (res.status === 'unchanged') unchangedCount += 1;
              else if (res.status === 'error' || res.status === 'ocr_disabled') {
                if (res.status === 'error') errorCount += 1;
                else skippedCount += 1;
              } else {
                indexedCount += 1;
              }
            }
          } catch {
            skippedCount += 1;
          }
        }
      }
    }

    return {
      status: 'completed',
      collectionId: collection.id,
      folder: folder || roots.map((r) => r.id).join(', '),
      indexedCount,
      unchangedCount,
      skippedCount,
      errorCount,
      documents
    };
  }

  async reindexDocument(session, ownerKey, documentId, { ocrEnabled } = {}) {
    const doc = this.store.getKnowledgeDocument(ownerKey, documentId);
    if (!doc) throw new ToolError('NOT_FOUND', 'Indexed document not found.');
    const collection = this.store.getKnowledgeCollection(ownerKey, doc.collectionId);

    if (doc.sourceType === 'upload') {
      // Uploaded documents re-chunk and re-embed their stored normalized text
      const chunks = chunkDocumentText(doc.fullText);
      const embedded = chunks.map((ch) => ({
        ...ch,
        id: randomUUID(),
        embedding: embedText(`${doc.fileName} ${ch.section} ${ch.content}`)
      }));
      const now = Date.now();
      const updated = this.store.upsertKnowledgeDocument({
        ...doc,
        version: doc.version + 1,
        chunkCount: embedded.length,
        indexedAt: now,
        updatedAt: now
      });
      this.store.replaceKnowledgeChunks(ownerKey, doc.id, doc.collectionId, embedded);
      this.publish(session, 'knowledgeUpdated', { type: 'document_reindexed', documentId: doc.id });
      return { status: 'reindexed', document: this.#publicDoc(updated, 'uploaded') };
    }

    return this.ingestLocalFile(session, ownerKey, {
      collectionId: doc.collectionId,
      filePath: doc.sourcePath,
      rootId: doc.rootId,
      ocrEnabled: ocrEnabled !== undefined ? Boolean(ocrEnabled) : collection?.ocrEnabled,
      force: true
    });
  }

  async reindexCollection(session, ownerKey, collectionId) {
    const col = this.store.getKnowledgeCollection(ownerKey, collectionId);
    if (!col) throw new ToolError('NOT_FOUND', 'Collection not found.');
    const docs = this.store.listKnowledgeDocuments(ownerKey, { collectionId });
    const results = [];
    for (const doc of docs) {
      try {
        results.push(await this.reindexDocument(session, ownerKey, doc.id));
      } catch (err) {
        results.push({ status: 'error', documentId: doc.id, message: err.message });
      }
    }
    return { collectionId, processed: results.length, results };
  }

  async deleteDocument(session, ownerKey, documentId) {
    const doc = this.store.getKnowledgeDocument(ownerKey, documentId);
    if (!doc) throw new ToolError('NOT_FOUND', 'Indexed document not found.');
    // Delete ONLY index records in SQLite; NEVER delete source files on disk!
    this.store.deleteKnowledgeDocument(ownerKey, documentId);
    await this.auditEvent({
      event: 'OPERATION_SUCCEEDED',
      tool: 'knowledge_doc_delete',
      sessionId: session?.id,
      policyDecision: 'ALLOW',
      outcome: 'deleted'
    }).catch(() => {});
    this.publish(session, 'knowledgeUpdated', { type: 'document_deleted', documentId });
    return { deleted: true, documentId, originalFilePreserved: true };
  }

  purgeExpired(session, ownerKey) {
    const deletedCount = this.store.deleteExpiredKnowledgeDocuments(ownerKey);
    if (deletedCount > 0) {
      this.publish(session, 'knowledgeUpdated', { type: 'retention_purged', deletedCount });
    }
    return { deletedCount };
  }

  async syncMatchingLocalFiles(
    session,
    ownerKey,
    { query = '', extensions = null, modifiedAfter = null, modifiedBefore = null, folder = null, limit = 8 } = {}
  ) {
    if (this.hosted || !this.files?.config?.enabled) {
      return { syncedCount: 0, matchedDocs: [] };
    }
    await this.files.ensureStarted();
    const collection = this.ensureDefaultCollection(ownerKey, { name: 'Local Folders' });

    const searchArgs = { sortBy: 'modifiedDesc', limit };
    if (query) searchArgs.query = query;
    if (extensions?.length) searchArgs.extensions = extensions;
    if (modifiedAfter) searchArgs.modifiedAfter = modifiedAfter;
    if (modifiedBefore) searchArgs.modifiedBefore = modifiedBefore;
    if (folder) searchArgs.folder = folder;

    let candidatePaths = [];
    try {
      const found = await this.files.index.search(searchArgs);
      candidatePaths = (found.matches || [])
        .filter((m) => !m.isDirectory && SUPPORTED_EXTENSIONS.includes(m.extension?.toLowerCase()))
        .map((m) => ({ path: m.path, rootId: m.rootId }));
    } catch {
      candidatePaths = [];
    }

    const syncedIds = [];
    for (const cand of candidatePaths) {
      try {
        const res = await this.ingestLocalFile(session, ownerKey, {
          collectionId: collection.id,
          filePath: cand.path,
          rootId: cand.rootId,
          ocrEnabled: collection.ocrEnabled
        });
        if (res.document?.id) syncedIds.push(res.document.id);
      } catch {
        // Skip locked/oversize candidates cleanly
      }
    }

    // If filename search returned 0 candidates (e.g., query searches text content inside documents
    // like "Mahindra Logistics" or invoice amount "14,850"), scan authorized local roots up to 50 files.
    if (!syncedIds.length && (!extensions || extensions.length)) {
      await this.ingestAuthorizedFolder(session, ownerKey, {
        collectionId: collection.id,
        folder,
        maxFiles: 50
      });
    }

    return { syncedCount: syncedIds.length, matchedDocumentIds: syncedIds };
  }

  search(ownerKey, { query, collectionId = null, documentIds = null, limit = 8 } = {}) {
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) {
      throw new ToolError('INVALID_ARGUMENTS', 'Provide a search query.');
    }
    this.store.deleteExpiredKnowledgeDocuments(ownerKey);

    const docs = this.store.listKnowledgeDocuments(ownerKey, { collectionId, documentIds })
      .filter((d) => d.status === 'indexed');
    if (!docs.length) {
      return { query: cleanQuery, results: [], scopedDocumentCount: 0, localOnly: true };
    }

    const docMap = new Map(docs.map((d) => [d.id, d]));
    const allowedDocIds = docs.map((d) => d.id);
    const chunks = this.store.listKnowledgeChunks(ownerKey, { collectionId, documentIds: allowedDocIds });
    const qVec = embedText(cleanQuery);
    const qTokens = normalizeTokens(cleanQuery);
    const qNums = extractCurrencyNumbers(cleanQuery);

    const scored = [];
    for (const ch of chunks) {
      const doc = docMap.get(ch.documentId);
      if (!doc) continue;
      const metrics = scoreChunk(cleanQuery, `${doc.fileName}\n${ch.section}\n${ch.content}`, qVec, ch.embedding);
      if (metrics.score >= 0.14 || metrics.matchedNumber || metrics.lexicalHits > 0) {
        scored.push({
          chunkId: ch.id,
          documentId: doc.id,
          collectionId: doc.collectionId,
          fileName: doc.fileName,
          sourceType: doc.sourceType,
          rootId: doc.rootId,
          chunkIndex: ch.chunkIndex,
          section: ch.section,
          content: ch.content,
          localOnly: doc.localOnly,
          score: metrics.score,
          cosine: metrics.cosine,
          matchedNumber: metrics.matchedNumber,
          hasLexicalMatch: metrics.lexicalHits > 0 || qNums.length === 0 && qTokens.length === 0
        });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex);
    return {
      query: cleanQuery,
      scopedDocumentCount: docs.length,
      localOnly: true,
      results: scored.slice(0, Math.max(1, Math.min(25, limit)))
    };
  }

  chat(ownerKey, { question = '', collectionId = null, documentIds = null, mode = 'qa', selectedOnly = false } = {}) {
    this.store.deleteExpiredKnowledgeDocuments(ownerKey);
    const effectiveIds = Array.isArray(documentIds) && documentIds.length ? documentIds : null;
    if (selectedOnly && !effectiveIds) {
      throw new ToolError('INVALID_ARGUMENTS', 'Select at least one document when "selected documents only" is enabled.');
    }

    const docs = this.store
      .listKnowledgeDocuments(ownerKey, { collectionId, documentIds: effectiveIds })
      .filter((d) => d.status === 'indexed');

    const chunks = docs.length
      ? this.store.listKnowledgeChunks(ownerKey, { collectionId, documentIds: docs.map((d) => d.id) })
      : [];

    if (mode === 'compare') {
      const out = compareDocuments({ documents: docs, chunks });
      return { ...out, mode, selectedOnly, scopedDocumentCount: docs.length, localOnly: true };
    }
    if (mode === 'tables') {
      const out = formatExtractedTables({ documents: docs, chunks });
      return { ...out, mode, selectedOnly, scopedDocumentCount: docs.length, localOnly: true };
    }
    if (mode === 'summarize') {
      const out = summarizeDocuments({ documents: docs, chunks, prompt: question });
      return { ...out, mode, selectedOnly, scopedDocumentCount: docs.length, localOnly: true };
    }

    // Q&A mode: rank chunks semantically & lexically within strict scope
    const cleanQ = String(question || '').trim();
    if (!cleanQ) {
      throw new ToolError('INVALID_ARGUMENTS', 'Enter a question for Private Knowledge Q&A.');
    }
    const searched = this.search(ownerKey, { query: cleanQ, collectionId, documentIds: effectiveIds, limit: 8 });
    // Enforce strong relevance threshold when selectedOnly or general Q&A so irrelevant docs aren't hallucinated
    const relevant = searched.results.filter((r) => r.score >= 0.25 || r.matchedNumber || r.hasLexicalMatch && r.score >= 0.18);
    const out = answerFromChunks({ question: cleanQ, rankedChunks: relevant, selectedOnly });
    return { ...out, mode: 'qa', selectedOnly, scopedDocumentCount: docs.length, localOnly: true };
  }
}
