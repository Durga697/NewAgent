import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import sqlite from 'node-sqlite3-wasm';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations(
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_tasks(
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  intent TEXT NOT NULL,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL,
  summary TEXT,
  error_code TEXT,
  error_message TEXT,
  preview TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_tasks_owner_idx ON agent_tasks(owner_key, created_at DESC);
CREATE TABLE IF NOT EXISTS agent_task_steps(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  tool_name TEXT,
  risk_level TEXT NOT NULL,
  state TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_steps_task_idx ON agent_task_steps(task_id, step_index ASC);
CREATE TABLE IF NOT EXISTS agent_approvals(
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT REFERENCES agent_tasks(id) ON DELETE CASCADE,
  step_id TEXT,
  operation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  reversible INTEGER NOT NULL DEFAULT 1,
  target_ids_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  preview TEXT NOT NULL,
  expected_changes TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_approvals_owner_idx ON agent_approvals(owner_key, created_at DESC);
`;

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS companion_devices(
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  device_name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  platform TEXT NOT NULL,
  state TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  disabled_apps_json TEXT NOT NULL DEFAULT '[]',
  paired_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  disconnected_at INTEGER
);
CREATE INDEX IF NOT EXISTS companion_devices_owner_idx ON companion_devices(owner_key, paired_at DESC);
CREATE TABLE IF NOT EXISTS companion_events(
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  device_id TEXT,
  event_type TEXT NOT NULL,
  tool_name TEXT,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS companion_events_owner_idx ON companion_events(owner_key, created_at DESC);
CREATE TABLE IF NOT EXISTS reversible_actions(
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  device_id TEXT,
  task_id TEXT,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL,
  undo_available INTEGER NOT NULL DEFAULT 1,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  undone_at INTEGER
);
CREATE INDEX IF NOT EXISTS reversible_actions_owner_idx ON reversible_actions(owner_key, created_at DESC);
`;

const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS knowledge_collections(
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  folder_root_id TEXT,
  ocr_enabled INTEGER NOT NULL DEFAULT 0,
  cloud_access INTEGER NOT NULL DEFAULT 0,
  retention_days INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS kb_collections_owner_idx ON knowledge_collections(owner_key, updated_at DESC);
CREATE TABLE IF NOT EXISTS knowledge_documents(
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  collection_id TEXT NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_path TEXT,
  root_id TEXT,
  file_name TEXT NOT NULL,
  extension TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_sha256 TEXT,
  modified_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  local_only INTEGER NOT NULL DEFAULT 1,
  parser_name TEXT,
  text_preview TEXT,
  full_text TEXT,
  tables_json TEXT,
  metadata_json TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS kb_docs_owner_idx ON knowledge_documents(owner_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS kb_docs_coll_idx ON knowledge_documents(owner_key, collection_id);
CREATE TABLE IF NOT EXISTS knowledge_chunks(
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  owner_key TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  section TEXT,
  content TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  embedding_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS kb_chunks_doc_idx ON knowledge_chunks(document_id, chunk_index ASC);
CREATE INDEX IF NOT EXISTS kb_chunks_owner_idx ON knowledge_chunks(owner_key, collection_id);
`;

function parseJson(value, fallback = null) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapStep(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    stepIndex: row.step_index,
    title: row.title,
    toolName: row.tool_name || null,
    riskLevel: row.risk_level,
    state: row.state,
    input: parseJson(row.input_json, null),
    output: parseJson(row.output_json, null),
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null
  };
}

function mapApproval(row) {
  return {
    id: row.id,
    ownerKey: row.owner_key,
    sessionId: row.session_id,
    taskId: row.task_id || null,
    stepId: row.step_id || null,
    operationId: row.operation_id,
    toolName: row.tool_name,
    riskLevel: row.risk_level,
    reversible: Boolean(row.reversible),
    targetIds: parseJson(row.target_ids_json, []),
    reason: row.reason,
    preview: row.preview,
    expectedChanges: row.expected_changes,
    state: row.state,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null
  };
}

function mapTask(row, steps = [], approvals = []) {
  if (!row) return null;
  return {
    id: row.id,
    ownerKey: row.owner_key,
    sessionId: row.session_id,
    source: row.source,
    intent: row.intent,
    prompt: row.prompt,
    state: row.state,
    summary: row.summary || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    preview: row.preview || null,
    result: parseJson(row.result_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
    steps,
    approvals
  };
}

function mapCompanionDevice(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerKey: row.owner_key,
    deviceName: row.device_name,
    hostname: row.hostname,
    platform: row.platform,
    state: row.state,
    permissions: parseJson(row.permissions_json, {
      telemetry: true,
      apps: true,
      fileAnalysis: true,
      fileMutations: true
    }),
    disabledApps: parseJson(row.disabled_apps_json, []),
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
    disconnectedAt: row.disconnected_at || null
  };
}

function mapCompanionEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerKey: row.owner_key,
    deviceId: row.device_id || null,
    eventType: row.event_type,
    toolName: row.tool_name || null,
    summary: row.summary,
    status: row.status,
    detail: parseJson(row.detail_json, null),
    createdAt: row.created_at
  };
}

function mapReversibleAction(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerKey: row.owner_key,
    deviceId: row.device_id || null,
    taskId: row.task_id || null,
    actionType: row.action_type,
    status: row.status,
    undoAvailable: Boolean(row.undo_available),
    summary: row.summary,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at,
    undoneAt: row.undone_at || null
  };
}

function mapKnowledgeCollection(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerKey: row.owner_key,
    name: row.name,
    description: row.description || '',
    folderRootId: row.folder_root_id || null,
    ocrEnabled: Boolean(row.ocr_enabled),
    cloudAccess: Boolean(row.cloud_access),
    retentionDays: Number(row.retention_days || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapKnowledgeDocument(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerKey: row.owner_key,
    collectionId: row.collection_id,
    sourceType: row.source_type,
    sourcePath: row.source_path || null,
    rootId: row.root_id || null,
    fileName: row.file_name,
    extension: row.extension,
    sizeBytes: row.size_bytes,
    contentSha256: row.content_sha256 || null,
    modifiedAt: row.modified_at,
    version: row.version,
    status: row.status,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    localOnly: Boolean(row.local_only),
    parserName: row.parser_name || null,
    textPreview: row.text_preview || '',
    fullText: row.full_text || '',
    tables: parseJson(row.tables_json, []),
    metadata: parseJson(row.metadata_json, {}),
    chunkCount: row.chunk_count,
    indexedAt: row.indexed_at,
    updatedAt: row.updated_at
  };
}

function mapKnowledgeChunk(row) {
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.document_id,
    ownerKey: row.owner_key,
    collectionId: row.collection_id,
    chunkIndex: row.chunk_index,
    section: row.section || 'Overview',
    content: row.content,
    charStart: row.char_start,
    charEnd: row.char_end,
    embedding: parseJson(row.embedding_json, []),
    createdAt: row.created_at
  };
}

export class AgentStore {
  constructor(filename = ':memory:') {
    const target = !filename || filename === ':memory:' ? ':memory:' : filename;
    if (target !== ':memory:') {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    }
    this.filename = target;
    this.db = new sqlite.Database(target);
    this.closed = false;
    this.db.exec('PRAGMA journal_mode=TRUNCATE; PRAGMA temp_store=MEMORY; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(SCHEMA);
      const now = Date.now();
      this.db.run('INSERT OR IGNORE INTO schema_migrations VALUES(1, ?)', [now]);
      const verRow = this.db.get('SELECT MAX(version) AS version FROM schema_migrations');
      const currentVersion = Number(verRow?.version || 1);
      if (currentVersion < 2) {
        this.db.exec(SCHEMA_V2);
        this.db.run('INSERT OR IGNORE INTO schema_migrations VALUES(2, ?)', [now]);
      } else {
        this.db.exec(SCHEMA_V2);
      }
      if (currentVersion < 3) {
        this.db.exec(SCHEMA_V3);
        this.db.run('INSERT OR IGNORE INTO schema_migrations VALUES(3, ?)', [now]);
      } else {
        this.db.exec(SCHEMA_V3);
      }
      this.db.exec('PRAGMA user_version=3; COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
    const now = Date.now();
    this.db.run("UPDATE agent_tasks SET state='paused', updated_at=? WHERE state IN ('running','planning','awaiting_approval')", [now]);
    this.db.run("UPDATE agent_approvals SET state='expired', resolved_at=? WHERE state='pending'", [now]);
    this.db.run("UPDATE companion_devices SET state='disconnected', disconnected_at=? WHERE state='paired'", [now]);
  }

  schemaVersion() {
    const verRow = this.db.get('PRAGMA user_version');
    return Number(verRow?.user_version ?? verRow?.USER_VERSION ?? 0);
  }

  createTask(task) {
    this.db.run(
      'INSERT INTO agent_tasks(id, owner_key, session_id, source, intent, prompt, state, summary, error_code, error_message, preview, result_json, created_at, updated_at, completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        task.id,
        task.ownerKey,
        task.sessionId,
        task.source,
        task.intent,
        task.prompt,
        task.state,
        task.summary ?? null,
        task.errorCode ?? null,
        task.errorMessage ?? null,
        task.preview ?? null,
        task.result ? JSON.stringify(task.result) : null,
        task.createdAt,
        task.updatedAt,
        task.completedAt ?? null
      ]
    );
    return this.getTask(task.ownerKey, task.id);
  }

  updateTask(ownerKey, taskId, patch) {
    const sets = [];
    const params = [];
    const map = {
      intent: 'intent',
      state: 'state',
      summary: 'summary',
      errorCode: 'error_code',
      errorMessage: 'error_message',
      preview: 'preview',
      updatedAt: 'updated_at',
      completedAt: 'completed_at'
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        sets.push(`${col}=?`);
        params.push(patch[k] ?? null);
      }
    }
    if ('result' in patch) {
      sets.push('result_json=?');
      params.push(patch.result ? JSON.stringify(patch.result) : null);
    }
    if (!sets.length) return this.getTask(ownerKey, taskId);
    if (!('updatedAt' in patch)) {
      sets.push('updated_at=?');
      params.push(Date.now());
    }
    params.push(taskId, ownerKey);
    this.db.run(`UPDATE agent_tasks SET ${sets.join(', ')} WHERE id=? AND owner_key=?`, params);
    return this.getTask(ownerKey, taskId);
  }

  addStep(step) {
    this.db.run(
      'INSERT INTO agent_task_steps(id, task_id, step_index, title, tool_name, risk_level, state, input_json, output_json, error_code, error_message, started_at, finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        step.id,
        step.taskId,
        step.stepIndex,
        step.title,
        step.toolName ?? null,
        step.riskLevel || 'READ_ONLY',
        step.state,
        step.input !== undefined && step.input !== null ? JSON.stringify(step.input) : null,
        step.output !== undefined && step.output !== null ? JSON.stringify(step.output) : null,
        step.errorCode ?? null,
        step.errorMessage ?? null,
        step.startedAt ?? null,
        step.finishedAt ?? null
      ]
    );
  }

  addSteps(steps) {
    if (!steps.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const step of steps) {
        this.addStep(step);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  updateStep(stepId, patch) {
    const sets = [];
    const params = [];
    const map = {
      state: 'state',
      errorCode: 'error_code',
      errorMessage: 'error_message',
      startedAt: 'started_at',
      finishedAt: 'finished_at'
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        sets.push(`${col}=?`);
        params.push(patch[k] ?? null);
      }
    }
    if ('input' in patch) {
      sets.push('input_json=?');
      params.push(patch.input !== undefined && patch.input !== null ? JSON.stringify(patch.input) : null);
    }
    if ('output' in patch) {
      sets.push('output_json=?');
      params.push(patch.output !== undefined && patch.output !== null ? JSON.stringify(patch.output) : null);
    }
    if (!sets.length) return;
    params.push(stepId);
    this.db.run(`UPDATE agent_task_steps SET ${sets.join(', ')} WHERE id=?`, params);
  }

  getTask(ownerKey, taskId) {
    const row = this.db.get('SELECT * FROM agent_tasks WHERE id=? AND owner_key=?', [taskId, ownerKey]);
    if (!row) return null;
    const steps = this.db.all('SELECT * FROM agent_task_steps WHERE task_id=? ORDER BY step_index ASC', [taskId]).map(mapStep);
    const approvals = this.db.all('SELECT * FROM agent_approvals WHERE task_id=? AND owner_key=? ORDER BY created_at DESC', [taskId, ownerKey]).map(mapApproval);
    return mapTask(row, steps, approvals);
  }

  listTasks(ownerKey, limit = 25) {
    this.expireStaleApprovals();
    const rows = this.db.all('SELECT * FROM agent_tasks WHERE owner_key=? ORDER BY created_at DESC LIMIT ?', [ownerKey, limit]);
    return rows.map((row) => {
      const steps = this.db.all('SELECT * FROM agent_task_steps WHERE task_id=? ORDER BY step_index ASC', [row.id]).map(mapStep);
      const approvals = this.db.all('SELECT * FROM agent_approvals WHERE task_id=? AND owner_key=? ORDER BY created_at DESC', [row.id, ownerKey]).map(mapApproval);
      return mapTask(row, steps, approvals);
    });
  }

  createApproval(approval) {
    this.db.run(
      'INSERT INTO agent_approvals(id, owner_key, session_id, task_id, step_id, operation_id, tool_name, risk_level, reversible, target_ids_json, reason, preview, expected_changes, state, expires_at, created_at, resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        approval.id,
        approval.ownerKey,
        approval.sessionId,
        approval.taskId ?? null,
        approval.stepId ?? null,
        approval.operationId,
        approval.toolName,
        approval.riskLevel || 'REVERSIBLE',
        approval.reversible ? 1 : 0,
        JSON.stringify(approval.targetIds || []),
        approval.reason,
        approval.preview,
        approval.expectedChanges,
        approval.state || 'pending',
        approval.expiresAt,
        approval.createdAt,
        approval.resolvedAt ?? null
      ]
    );
    return this.getApproval(approval.ownerKey, approval.id);
  }

  updateApproval(ownerKey, approvalId, patch) {
    const sets = [];
    const params = [];
    for (const [k, col] of [['state', 'state'], ['resolvedAt', 'resolved_at'], ['preview', 'preview']]) {
      if (k in patch) {
        sets.push(`${col}=?`);
        params.push(patch[k] ?? null);
      }
    }
    if (!sets.length) return this.getApproval(ownerKey, approvalId);
    params.push(approvalId, ownerKey);
    this.db.run(`UPDATE agent_approvals SET ${sets.join(', ')} WHERE id=? AND owner_key=?`, params);
    return this.getApproval(ownerKey, approvalId);
  }

  getApproval(ownerKey, approvalId) {
    const row = this.db.get('SELECT * FROM agent_approvals WHERE id=? AND owner_key=?', [approvalId, ownerKey]);
    return row ? mapApproval(row) : null;
  }

  listApprovals(ownerKey, limit = 50) {
    this.expireStaleApprovals();
    return this.db.all('SELECT * FROM agent_approvals WHERE owner_key=? ORDER BY created_at DESC LIMIT ?', [ownerKey, limit]).map(mapApproval);
  }

  expireStaleApprovals(now = Date.now()) {
    const expired = this.db.all("SELECT id, task_id, step_id FROM agent_approvals WHERE state='pending' AND expires_at<=?", [now]);
    if (!expired.length) return [];
    this.db.run("UPDATE agent_approvals SET state='expired', resolved_at=? WHERE state='pending' AND expires_at<=?", [now, now]);
    for (const row of expired) {
      if (row.step_id) {
        this.db.run("UPDATE agent_task_steps SET state='failed', error_code='CONFIRMATION_EXPIRED', error_message='Approval request expired.', finished_at=? WHERE id=? AND state='awaiting_approval'", [now, row.step_id]);
      }
      if (row.task_id) {
        this.db.run("UPDATE agent_tasks SET state='failed', error_code='CONFIRMATION_EXPIRED', error_message='Approval request expired before confirmation.', updated_at=? WHERE id=? AND state='awaiting_approval'", [now, row.task_id]);
      }
    }
    return expired;
  }

  upsertCompanionDevice(device) {
    this.db.run(
      `INSERT INTO companion_devices(id, owner_key, device_name, hostname, platform, state, permissions_json, disabled_apps_json, paired_at, last_seen_at, disconnected_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         device_name=excluded.device_name,
         hostname=excluded.hostname,
         platform=excluded.platform,
         state=excluded.state,
         permissions_json=excluded.permissions_json,
         disabled_apps_json=excluded.disabled_apps_json,
         last_seen_at=excluded.last_seen_at,
         disconnected_at=excluded.disconnected_at`,
      [
        device.id,
        device.ownerKey,
        device.deviceName,
        device.hostname,
        device.platform,
        device.state,
        JSON.stringify(device.permissions || {}),
        JSON.stringify(device.disabledApps || []),
        device.pairedAt,
        device.lastSeenAt,
        device.disconnectedAt ?? null
      ]
    );
    return this.getCompanionDevice(device.ownerKey, device.id);
  }

  getCompanionDevice(ownerKey, deviceId) {
    const row = this.db.get('SELECT * FROM companion_devices WHERE id=? AND owner_key=?', [deviceId, ownerKey]);
    return mapCompanionDevice(row);
  }

  getActiveCompanionDevice(ownerKey) {
    const row = this.db.get(
      "SELECT * FROM companion_devices WHERE owner_key=? AND state='paired' ORDER BY paired_at DESC LIMIT 1",
      [ownerKey]
    );
    return mapCompanionDevice(row);
  }

  listCompanionDevices(ownerKey, limit = 20) {
    return this.db
      .all('SELECT * FROM companion_devices WHERE owner_key=? ORDER BY paired_at DESC LIMIT ?', [ownerKey, limit])
      .map(mapCompanionDevice);
  }

  updateCompanionDevice(ownerKey, deviceId, patch) {
    const sets = [];
    const params = [];
    for (const [k, col] of [
      ['deviceName', 'device_name'],
      ['state', 'state'],
      ['lastSeenAt', 'last_seen_at'],
      ['disconnectedAt', 'disconnected_at']
    ]) {
      if (k in patch) {
        sets.push(`${col}=?`);
        params.push(patch[k] ?? null);
      }
    }
    if ('permissions' in patch) {
      sets.push('permissions_json=?');
      params.push(JSON.stringify(patch.permissions || {}));
    }
    if ('disabledApps' in patch) {
      sets.push('disabled_apps_json=?');
      params.push(JSON.stringify(patch.disabledApps || []));
    }
    if (!sets.length) return this.getCompanionDevice(ownerKey, deviceId);
    params.push(deviceId, ownerKey);
    this.db.run(`UPDATE companion_devices SET ${sets.join(', ')} WHERE id=? AND owner_key=?`, params);
    return this.getCompanionDevice(ownerKey, deviceId);
  }

  addCompanionEvent(event) {
    this.db.run(
      'INSERT INTO companion_events(id, owner_key, device_id, event_type, tool_name, summary, status, detail_json, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [
        event.id,
        event.ownerKey,
        event.deviceId ?? null,
        event.eventType,
        event.toolName ?? null,
        event.summary,
        event.status || 'ok',
        event.detail ? JSON.stringify(event.detail) : null,
        event.createdAt
      ]
    );
    return mapCompanionEvent(this.db.get('SELECT * FROM companion_events WHERE id=?', [event.id]));
  }

  listCompanionEvents(ownerKey, limit = 40) {
    return this.db
      .all('SELECT * FROM companion_events WHERE owner_key=? ORDER BY created_at DESC LIMIT ?', [ownerKey, limit])
      .map(mapCompanionEvent);
  }

  createReversibleAction(action) {
    this.db.run(
      'INSERT INTO reversible_actions(id, owner_key, device_id, task_id, action_type, status, undo_available, summary, payload_json, created_at, undone_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [
        action.id,
        action.ownerKey,
        action.deviceId ?? null,
        action.taskId ?? null,
        action.actionType,
        action.status || 'available',
        action.undoAvailable ? 1 : 0,
        action.summary,
        JSON.stringify(action.payload || {}),
        action.createdAt,
        action.undoneAt ?? null
      ]
    );
    return this.getReversibleAction(action.ownerKey, action.id);
  }

  getReversibleAction(ownerKey, actionId) {
    const row = this.db.get('SELECT * FROM reversible_actions WHERE id=? AND owner_key=?', [actionId, ownerKey]);
    return mapReversibleAction(row);
  }

  listReversibleActions(ownerKey, limit = 30) {
    return this.db
      .all('SELECT * FROM reversible_actions WHERE owner_key=? ORDER BY created_at DESC LIMIT ?', [ownerKey, limit])
      .map(mapReversibleAction);
  }

  updateReversibleAction(ownerKey, actionId, patch) {
    const sets = [];
    const params = [];
    for (const [k, col] of [
      ['status', 'status'],
      ['undoneAt', 'undone_at'],
      ['summary', 'summary']
    ]) {
      if (k in patch) {
        sets.push(`${col}=?`);
        params.push(patch[k] ?? null);
      }
    }
    if ('undoAvailable' in patch) {
      sets.push('undo_available=?');
      params.push(patch.undoAvailable ? 1 : 0);
    }
    if (!sets.length) return this.getReversibleAction(ownerKey, actionId);
    params.push(actionId, ownerKey);
    this.db.run(`UPDATE reversible_actions SET ${sets.join(', ')} WHERE id=? AND owner_key=?`, params);
    return this.getReversibleAction(ownerKey, actionId);
  }

  createKnowledgeCollection(collection) {
    this.db.run(
      'INSERT INTO knowledge_collections(id, owner_key, name, description, folder_root_id, ocr_enabled, cloud_access, retention_days, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [
        collection.id,
        collection.ownerKey,
        collection.name,
        collection.description || '',
        collection.folderRootId ?? null,
        collection.ocrEnabled ? 1 : 0,
        collection.cloudAccess ? 1 : 0,
        collection.retentionDays || 0,
        collection.createdAt,
        collection.updatedAt
      ]
    );
    return this.getKnowledgeCollection(collection.ownerKey, collection.id);
  }

  getKnowledgeCollection(ownerKey, collectionId) {
    const row = this.db.get('SELECT * FROM knowledge_collections WHERE id=? AND owner_key=?', [collectionId, ownerKey]);
    return mapKnowledgeCollection(row);
  }

  listKnowledgeCollections(ownerKey) {
    return this.db
      .all('SELECT * FROM knowledge_collections WHERE owner_key=? ORDER BY created_at ASC', [ownerKey])
      .map(mapKnowledgeCollection);
  }

  updateKnowledgeCollection(ownerKey, collectionId, patch) {
    const sets = [];
    const params = [];
    for (const [k, col] of [
      ['name', 'name'],
      ['description', 'description'],
      ['folderRootId', 'folder_root_id'],
      ['retentionDays', 'retention_days'],
      ['updatedAt', 'updated_at']
    ]) {
      if (k in patch) {
        sets.push(`${col}=?`);
        params.push(patch[k] ?? null);
      }
    }
    if ('ocrEnabled' in patch) {
      sets.push('ocr_enabled=?');
      params.push(patch.ocrEnabled ? 1 : 0);
    }
    if ('cloudAccess' in patch) {
      sets.push('cloud_access=?');
      params.push(patch.cloudAccess ? 1 : 0);
    }
    if (!sets.length) return this.getKnowledgeCollection(ownerKey, collectionId);
    if (!('updatedAt' in patch)) {
      sets.push('updated_at=?');
      params.push(Date.now());
    }
    params.push(collectionId, ownerKey);
    this.db.run(`UPDATE knowledge_collections SET ${sets.join(', ')} WHERE id=? AND owner_key=?`, params);
    return this.getKnowledgeCollection(ownerKey, collectionId);
  }

  deleteKnowledgeCollection(ownerKey, collectionId) {
    this.db.run('DELETE FROM knowledge_collections WHERE id=? AND owner_key=?', [collectionId, ownerKey]);
    return true;
  }

  upsertKnowledgeDocument(doc) {
    this.db.run(
      `INSERT INTO knowledge_documents(
        id, owner_key, collection_id, source_type, source_path, root_id, file_name, extension,
        size_bytes, content_sha256, modified_at, version, status, error_code, error_message,
        local_only, parser_name, text_preview, full_text, tables_json, metadata_json, chunk_count,
        indexed_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        collection_id=excluded.collection_id,
        source_type=excluded.source_type,
        source_path=excluded.source_path,
        root_id=excluded.root_id,
        file_name=excluded.file_name,
        extension=excluded.extension,
        size_bytes=excluded.size_bytes,
        content_sha256=excluded.content_sha256,
        modified_at=excluded.modified_at,
        version=excluded.version,
        status=excluded.status,
        error_code=excluded.error_code,
        error_message=excluded.error_message,
        local_only=excluded.local_only,
        parser_name=excluded.parser_name,
        text_preview=excluded.text_preview,
        full_text=excluded.full_text,
        tables_json=excluded.tables_json,
        metadata_json=excluded.metadata_json,
        chunk_count=excluded.chunk_count,
        indexed_at=excluded.indexed_at,
        updated_at=excluded.updated_at`,
      [
        doc.id,
        doc.ownerKey,
        doc.collectionId,
        doc.sourceType,
        doc.sourcePath ?? null,
        doc.rootId ?? null,
        doc.fileName,
        doc.extension,
        doc.sizeBytes,
        doc.contentSha256 ?? null,
        doc.modifiedAt,
        doc.version || 1,
        doc.status,
        doc.errorCode ?? null,
        doc.errorMessage ?? null,
        doc.localOnly === false ? 0 : 1,
        doc.parserName ?? null,
        doc.textPreview ?? '',
        doc.fullText ?? '',
        JSON.stringify(doc.tables || []),
        JSON.stringify(doc.metadata || {}),
        doc.chunkCount || 0,
        doc.indexedAt,
        doc.updatedAt
      ]
    );
    return this.getKnowledgeDocument(doc.ownerKey, doc.id);
  }

  getKnowledgeDocument(ownerKey, documentId) {
    const row = this.db.get('SELECT * FROM knowledge_documents WHERE id=? AND owner_key=?', [documentId, ownerKey]);
    return mapKnowledgeDocument(row);
  }

  findKnowledgeDocumentBySource(ownerKey, collectionId, { sourcePath = null, fileName = null, sourceType = null } = {}) {
    if (sourcePath) {
      const row = this.db.get(
        'SELECT * FROM knowledge_documents WHERE owner_key=? AND collection_id=? AND source_path=?',
        [ownerKey, collectionId, sourcePath]
      );
      return mapKnowledgeDocument(row);
    }
    if (fileName && sourceType) {
      const row = this.db.get(
        'SELECT * FROM knowledge_documents WHERE owner_key=? AND collection_id=? AND source_type=? AND file_name=?',
        [ownerKey, collectionId, sourceType, fileName]
      );
      return mapKnowledgeDocument(row);
    }
    return null;
  }

  listKnowledgeDocuments(ownerKey, { collectionId = null, documentIds = null } = {}) {
    if (Array.isArray(documentIds) && documentIds.length) {
      const placeholders = documentIds.map(() => '?').join(',');
      return this.db
        .all(`SELECT * FROM knowledge_documents WHERE owner_key=? AND id IN (${placeholders}) ORDER BY updated_at DESC`, [ownerKey, ...documentIds])
        .map(mapKnowledgeDocument);
    }
    if (collectionId) {
      return this.db
        .all('SELECT * FROM knowledge_documents WHERE owner_key=? AND collection_id=? ORDER BY updated_at DESC', [ownerKey, collectionId])
        .map(mapKnowledgeDocument);
    }
    return this.db
      .all('SELECT * FROM knowledge_documents WHERE owner_key=? ORDER BY updated_at DESC', [ownerKey])
      .map(mapKnowledgeDocument);
  }

  deleteKnowledgeDocument(ownerKey, documentId) {
    this.db.run('DELETE FROM knowledge_documents WHERE id=? AND owner_key=?', [documentId, ownerKey]);
    return true;
  }

  deleteExpiredKnowledgeDocuments(ownerKey, now = Date.now()) {
    const collections = this.listKnowledgeCollections(ownerKey).filter((c) => c.retentionDays > 0);
    let deleted = 0;
    for (const c of collections) {
      const cutoff = now - c.retentionDays * 86400000;
      const stale = this.db.all(
        'SELECT id FROM knowledge_documents WHERE owner_key=? AND collection_id=? AND indexed_at < ?',
        [ownerKey, c.id, cutoff]
      );
      for (const row of stale) {
        this.deleteKnowledgeDocument(ownerKey, row.id);
        deleted += 1;
      }
    }
    return deleted;
  }

  replaceKnowledgeChunks(ownerKey, documentId, collectionId, chunks) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.run('DELETE FROM knowledge_chunks WHERE document_id=? AND owner_key=?', [documentId, ownerKey]);
      const now = Date.now();
      for (const ch of chunks) {
        this.db.run(
          'INSERT INTO knowledge_chunks(id, document_id, owner_key, collection_id, chunk_index, section, content, char_start, char_end, embedding_json, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          [
            ch.id,
            documentId,
            ownerKey,
            collectionId,
            ch.chunkIndex,
            ch.section || 'Overview',
            ch.content,
            ch.charStart,
            ch.charEnd,
            JSON.stringify(ch.embedding || []),
            now
          ]
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listKnowledgeChunks(ownerKey, { collectionId = null, documentIds = null } = {}) {
    if (Array.isArray(documentIds) && documentIds.length) {
      const placeholders = documentIds.map(() => '?').join(',');
      return this.db
        .all(`SELECT * FROM knowledge_chunks WHERE owner_key=? AND id IS NOT NULL AND document_id IN (${placeholders}) ORDER BY chunk_index ASC`, [ownerKey, ...documentIds])
        .map(mapKnowledgeChunk);
    }
    if (collectionId) {
      return this.db
        .all('SELECT * FROM knowledge_chunks WHERE owner_key=? AND collection_id=? ORDER BY chunk_index ASC', [ownerKey, collectionId])
        .map(mapKnowledgeChunk);
    }
    return this.db
      .all('SELECT * FROM knowledge_chunks WHERE owner_key=? ORDER BY chunk_index ASC', [ownerKey])
      .map(mapKnowledgeChunk);
  }

  countKnowledgeStats(ownerKey) {
    const collections = this.db.get('SELECT COUNT(*) n FROM knowledge_collections WHERE owner_key=?', [ownerKey])?.n || 0;
    const documents = this.db.get('SELECT COUNT(*) n FROM knowledge_documents WHERE owner_key=?', [ownerKey])?.n || 0;
    const chunks = this.db.get('SELECT COUNT(*) n FROM knowledge_chunks WHERE owner_key=?', [ownerKey])?.n || 0;
    return { collections, documents, chunks };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
