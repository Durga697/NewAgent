process.env.NODE_ENV = 'test';
process.env.EDITH_COMPANION_MOCK_WINDOWS = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import sqlite from 'node-sqlite3-wasm';
import { disposable, removeDisposable } from '../checks/helpers/fixtures.mjs';
import { loadSecurityConfig } from '../safety/config.mjs';
import { loadFileConfig } from '../tools/config.mjs';
import { loadCompanionConfig } from '../companion/config.mjs';
import { CompanionManager } from '../companion/manager.mjs';
import { LocalSessions } from '../safety/sessions.mjs';
import { UserAuthority } from '../safety/authority.mjs';
import { PolicyEngine } from '../safety/policy.mjs';
import { ConfirmationManager } from '../safety/confirmations.mjs';
import { AuditService } from '../safety/audit.mjs';
import { CloudGate } from '../safety/cloudGate.mjs';
import { FileService } from '../tools/service.mjs';
import { ToolRegistry, fileTools, companionTools } from '../tools/registry.mjs';
import { AgentStore } from '../agent/store.mjs';
import { AgentOrchestrator, TASK_STATES } from '../agent/orchestrator.mjs';

async function companionFixture({ hosted = false, persistentDb = false } = {}) {
  const dir = await disposable('edith-companion-');
  const downloads = path.join(dir, 'Downloads');
  const documents = path.join(dir, 'Documents');
  const localOnlyDir = path.join(downloads, 'PrivateVault');
  const testRecycleDir = path.join(dir, 'TestRecycleBin');
  await mkdir(downloads, { recursive: true });
  await mkdir(documents, { recursive: true });
  await mkdir(localOnlyDir, { recursive: true });

  const sec = structuredClone(await loadSecurityConfig());
  sec.filesystem.includedRoots = [downloads, documents];
  sec.filesystem.localOnlyPaths = [localOnlyDir];
  sec.logging.directory = path.join(dir, 'audit');

  const fileCfg = {
    ...await loadFileConfig(),
    enabled: true,
    roots: [
      { id: 'Downloads', path: downloads },
      { id: 'Documents', path: documents }
    ],
    auditFile: path.join(dir, 'old-audit.jsonl'),
    resultTtlSeconds: 120,
    maxFiles: 300,
    maxDepth: 5,
    security: sec
  };
  fileCfg.indexing = { ...fileCfg.indexing, directory: path.join(dir, 'index-store') };

  const compCfg = {
    ...await loadCompanionConfig(),
    largeFileMinBytes: 4096
  };

  const sessions = new LocalSessions(sec.sessions);
  const session = sessions.create();
  const sessionBob = sessions.create();
  const authority = new UserAuthority({ isSessionValid: (s) => sessions.valid(s) });
  const policy = new PolicyEngine(sec, authority);
  const audit = new AuditService(path.join(dir, 'audit', 'events.jsonl'), { authority });
  const auditEvent = (rec) => audit.append(rec);
  const confirmations = new ConfirmationManager(sec.confirmation, authority, { audit: auditEvent });
  const files = new FileService(fileCfg);
  const registry = new ToolRegistry([...fileTools, ...companionTools], auditEvent, { policy, confirmations });
  const cloudGate = new CloudGate(sec, authority, files);
  const dbPath = persistentDb ? path.join(dir, 'agent.sqlite') : ':memory:';
  const store = new AgentStore(dbPath);
  const published = [];
  const companion = new CompanionManager({
    store,
    config: compCfg,
    files,
    auditEvent,
    publish: (_s, type, data) => published.push({ type, data }),
    hosted,
    testRecycleDir
  });
  const orchestrator = new AgentOrchestrator({
    store,
    registry,
    authority,
    policy,
    confirmations,
    files,
    companion,
    auditEvent,
    publish: (_s, type, data) => published.push({ type, data }),
    hosted
  });
  companion.bindOrchestrator(orchestrator);

  async function pairUser(sess = session, ownerKey = 'user:alice', deviceName = 'Alice-PC') {
    const start = await companion.startPairing(sess, ownerKey);
    return companion.completePairing(sess, ownerKey, {
      challengeId: start.challengeId,
      pairingCode: start.pairingCode,
      deviceName
    });
  }

  return {
    dir,
    downloads,
    documents,
    localOnlyDir,
    testRecycleDir,
    session,
    sessionBob,
    authority,
    cloudGate,
    files,
    store,
    companion,
    orchestrator,
    published,
    pairUser,
    async close() {
      await companion.close();
      orchestrator.close();
      await files.close();
      await audit.queue;
      await removeDisposable(dir);
    }
  };
}

test('loadCompanionConfig rejects shell binaries, UNC paths, and path traversal', async () => {
  const dir = await disposable('comp-cfg-');
  try {
    const writeCfg = async (name, apps) => {
      const p = path.join(dir, name);
      await writeFile(
        p,
        JSON.stringify({ version: 1, enabled: true, approvedApps: apps }),
        'utf8'
      );
      return p;
    };

    const shellCfg = await writeCfg('shell.json', [
      { appId: 'cmd', displayName: 'CMD', category: 'system', enabled: true, candidates: ['${systemRoot}\\System32\\cmd.exe'] }
    ]);
    await assert.rejects(() => loadCompanionConfig(shellCfg), (e) => e.code === 'CONFIG_INVALID');

    const psCfg = await writeCfg('ps.json', [
      { appId: 'ps', displayName: 'PowerShell', category: 'system', enabled: true, candidates: ['${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] }
    ]);
    await assert.rejects(() => loadCompanionConfig(psCfg), (e) => e.code === 'CONFIG_INVALID');

    const uncCfg = await writeCfg('unc.json', [
      { appId: 'uncapp', displayName: 'UNC', category: 'other', enabled: true, candidates: ['\\\\server\\share\\app.exe'] }
    ]);
    await assert.rejects(() => loadCompanionConfig(uncCfg), (e) => e.code === 'CONFIG_INVALID');

    const travCfg = await writeCfg('trav.json', [
      { appId: 'travapp', displayName: 'Trav', category: 'other', enabled: true, candidates: ['${systemRoot}\\System32\\..\\evil.exe'] }
    ]);
    await assert.rejects(() => loadCompanionConfig(travCfg), (e) => e.code === 'CONFIG_INVALID');
  } finally {
    await removeDisposable(dir);
  }
});

test('AgentStore cleanly migrates a pre-existing v1 SQLite database to v2 preserving tasks and approvals', async () => {
  const dir = await disposable('comp-migrate-');
  try {
    const dbPath = path.join(dir, 'v1.sqlite');
    const raw = new sqlite.Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE agent_tasks(id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, session_id TEXT NOT NULL, source TEXT NOT NULL, intent TEXT NOT NULL, prompt TEXT NOT NULL, state TEXT NOT NULL, summary TEXT, error_code TEXT, error_message TEXT, preview TEXT, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER);
      CREATE TABLE agent_task_steps(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE, step_index INTEGER NOT NULL, title TEXT NOT NULL, tool_name TEXT, risk_level TEXT NOT NULL, state TEXT NOT NULL, input_json TEXT, output_json TEXT, error_code TEXT, error_message TEXT, started_at INTEGER, finished_at INTEGER);
      CREATE TABLE agent_approvals(id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, session_id TEXT NOT NULL, task_id TEXT REFERENCES agent_tasks(id) ON DELETE CASCADE, step_id TEXT, operation_id TEXT NOT NULL, tool_name TEXT NOT NULL, risk_level TEXT NOT NULL, reversible INTEGER NOT NULL DEFAULT 1, target_ids_json TEXT NOT NULL, reason TEXT NOT NULL, preview TEXT NOT NULL, expected_changes TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER);
      INSERT INTO schema_migrations VALUES(1, 1000);
      INSERT INTO agent_tasks(id, owner_key, session_id, source, intent, prompt, state, summary, created_at, updated_at, completed_at) VALUES('v1-task', 'user:alice', 's1', 'typed', 'file_search', 'Find bills', 'completed', 'Done', 1000, 2000, 2000);
      INSERT INTO agent_approvals(id, owner_key, session_id, task_id, step_id, operation_id, tool_name, risk_level, reversible, target_ids_json, reason, preview, expected_changes, state, expires_at, created_at, resolved_at) VALUES('v1-app', 'user:alice', 's1', 'v1-task', NULL, 'op-1', 'save_report', 'REVERSIBLE', 1, '["Downloads/r.md"]', 'save', 'preview', 'changes', 'approved', 9999999999999, 1000, 1500);
      PRAGMA user_version=1;
    `);
    raw.close();

    const upgraded = new AgentStore(dbPath);
    try {
      assert.equal(upgraded.schemaVersion(), 3);
      const oldTask = upgraded.getTask('user:alice', 'v1-task');
      assert.equal(oldTask.prompt, 'Find bills');
      assert.equal(oldTask.approvals.length, 1);
      assert.equal(oldTask.approvals[0].id, 'v1-app');

      upgraded.upsertCompanionDevice({
        id: 'dev-1',
        ownerKey: 'user:alice',
        deviceName: 'Migrated PC',
        hostname: 'LOCAL',
        platform: 'win32',
        state: 'disconnected',
        permissions: { telemetry: true, apps: true, fileAnalysis: true, fileMutations: true },
        disabledApps: [],
        pairedAt: 3000,
        lastSeenAt: 3000,
        disconnectedAt: 3100
      });
      assert.equal(upgraded.listCompanionDevices('user:alice').length, 1);
    } finally {
      upgraded.close();
    }
  } finally {
    await removeDisposable(dir);
  }
});

test('Explicit device pairing, hosted fail-closed, and daemon HMAC/capability enforcement', async () => {
  const hostedFx = await companionFixture({ hosted: true });
  try {
    await assert.rejects(() => hostedFx.companion.startPairing(hostedFx.session, 'user:alice'), (e) => e.code === 'COMPANION_DISABLED');
    const st = await hostedFx.companion.status('user:alice');
    assert.equal(st.hosted, true);
    assert.equal(st.paired, false);
  } finally {
    await hostedFx.close();
  }

  const f = await companionFixture();
  try {
    // Unpaired call must fail closed
    const unpairedRes = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'get_system_metrics',
      args: {},
      ownerKey: 'user:alice'
    });
    assert.equal(unpairedRes.error.code, 'COMPANION_NOT_PAIRED');

    // Wrong pairing code fails cleanly
    const challenge = await f.companion.startPairing(f.session, 'user:alice');
    await assert.rejects(
      () => f.companion.completePairing(f.session, 'user:alice', { challengeId: challenge.challengeId, pairingCode: 'WRONGC' }),
      (e) => e.code === 'PAIRING_INVALID'
    );

    // Cross-session pairing completion fails cleanly
    await assert.rejects(
      () => f.companion.completePairing(f.sessionBob, 'user:bob', { challengeId: challenge.challengeId, pairingCode: challenge.pairingCode }),
      (e) => e.code === 'PAIRING_INVALID'
    );

    // Valid pairing succeeds and exposes daemon on loopback
    const pairedStatus = await f.pairUser(f.session, 'user:alice', 'Office-Desktop');
    assert.equal(pairedStatus.paired, true);
    assert.equal(pairedStatus.device.deviceName, 'Office-Desktop');
    const port = f.companion.daemonPort();
    assert(Number.isInteger(port) && port > 0);

    // Raw HTTP call without IPC HMAC is rejected with 401
    const unauthDaemon = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerKey: 'user:alice', action: 'get_system_metrics', args: {} })
    });
    assert.equal(unauthDaemon.status, 401);

    // Paired owner can retrieve telemetry while different owner remains unpaired
    const metrics = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'get_system_metrics',
      args: {},
      ownerKey: 'user:alice'
    });
    assert.equal(metrics.memory.totalGb, 16);
    assert.equal(metrics.drives.find((d) => d.drive === 'D:').freeGb, 318);

    const bobRes = await f.orchestrator.executeToolCall(f.sessionBob, {
      source: 'ui',
      toolName: 'get_system_metrics',
      args: {},
      ownerKey: 'user:bob'
    });
    assert.equal(bobRes.error.code, 'COMPANION_NOT_PAIRED');
  } finally {
    await f.close();
  }
});

test('Scoped permissions, per-app allowlist, confirmed app launch, and Emergency Stop', async () => {
  const f = await companionFixture();
  try {
    await f.pairUser(f.session, 'user:alice');

    // Unapproved shell executable is denied
    const cmdAttempt = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'launch_approved_app',
      args: { appId: 'cmd' },
      ownerKey: 'user:alice'
    });
    assert.equal(cmdAttempt.error.code, 'APP_NOT_APPROVED');

    // Disable telemetry scope -> get_system_metrics blocked
    await f.companion.updatePermissions(f.session, 'user:alice', { scopes: { telemetry: false } });
    const deniedMetrics = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'get_system_metrics',
      args: {},
      ownerKey: 'user:alice'
    });
    assert.equal(deniedMetrics.error.code, 'CAPABILITY_DENIED');

    // Disable vscode per-app -> launch_approved_app('vscode') blocked with APP_DISABLED
    await f.companion.updatePermissions(f.session, 'user:alice', {
      scopes: { telemetry: true },
      disabledApps: ['vscode']
    });
    const disabledApp = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'launch_approved_app',
      args: { appId: 'vscode' },
      ownerKey: 'user:alice'
    });
    assert.equal(disabledApp.error.code, 'APP_DISABLED');

    // Re-enable vscode, request launch -> awaits confirmation -> approve once -> launched
    await f.companion.updatePermissions(f.session, 'user:alice', { disabledApps: [] });
    const launchReq = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'launch_approved_app',
      args: { appId: 'vscode' },
      ownerKey: 'user:alice'
    });
    assert.equal(launchReq.status, 'confirmation_required');
    const approved = await f.orchestrator.approve(f.session, 'user:alice', launchReq.approvalId);
    assert.equal(approved.result.status, 'launched');
    assert.equal(approved.result.appId, 'vscode');

    // Queue another pending approval, then trigger Emergency Stop -> must cancel & block further RPCs
    const pendingTask = await f.orchestrator.runTask(f.session, {
      ownerKey: 'user:alice',
      prompt: 'EDITH, open VS Code.',
      source: 'typed'
    });
    assert.equal(pendingTask.state, TASK_STATES.AWAITING_APPROVAL);

    const stopRes = await f.companion.emergencyStop(f.session, 'user:alice');
    assert.equal(stopRes.paired, false);
    assert.equal(stopRes.securityState, 'revoked');
    assert.equal(stopRes.emergency.cancelledTasks, 1);

    const cancelledTask = f.orchestrator.getTask('user:alice', pendingTask.id);
    assert.equal(cancelledTask.state, TASK_STATES.CANCELLED);

    const afterStop = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'get_system_metrics',
      args: {},
      ownerKey: 'user:alice'
    });
    assert.equal(afterStop.error.code, 'COMPANION_NOT_PAIRED');
  } finally {
    await f.close();
  }
});

test('Large files & SHA-256 duplicate scanning are read-only and CloudGate hides localOnly/raw paths', async () => {
  const f = await companionFixture();
  try {
    await f.pairUser(f.session, 'user:alice');
    const s1 = path.join(f.downloads, 'screenshot-2026-10-01.png');
    const s2 = path.join(f.downloads, 'screenshot-2026-10-01-copy.png');
    const priv1 = path.join(f.localOnlyDir, 'screenshot-secret.png');
    const priv2 = path.join(f.localOnlyDir, 'screenshot-secret-dup.png');
    const bigFile = path.join(f.downloads, 'large-dataset.bin');

    const dupPayload = Buffer.from('PNG_SAME_CONTENT_BYTES_1234567890');
    await writeFile(s1, dupPayload);
    await writeFile(s2, dupPayload);
    await writeFile(priv1, Buffer.from('PRIVATE_VAULT_BYTES'));
    await writeFile(priv2, Buffer.from('PRIVATE_VAULT_BYTES'));
    await writeFile(bigFile, Buffer.alloc(6000, 0x41));

    const dupRes = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'find_duplicate_files',
      args: { folder: 'Downloads', nameFilter: 'screenshot' },
      ownerKey: 'user:alice'
    });
    assert.equal(dupRes.readOnly, true);
    assert.equal(dupRes.deletedCount, 0);
    assert.equal(dupRes.groupCount, 2);

    // Ensure CloudGate removes localOnly group before sharing with Gemini
    const cloudSafeDups = await f.cloudGate.toolOutput('find_duplicate_files', dupRes, {
      session: f.session,
      authorization: f.authority.issue(f.session, { source: 'typed', text: 'find duplicates', permissions: ['cloud.metadata'] })
    });
    assert.equal(cloudSafeDups.groupCount, 1);
    assert(!JSON.stringify(cloudSafeDups).includes('screenshot-secret'));
    assert(!JSON.stringify(cloudSafeDups).includes(f.downloads.replaceAll('\\', '\\\\')));

    // Verify all duplicate files are still untouched on disk
    await access(s1);
    await access(s2);

    const largeRes = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'find_large_files',
      args: { folder: 'Downloads' },
      ownerKey: 'user:alice'
    });
    assert.equal(largeRes.files.length, 1);
    assert.equal(largeRes.files[0].name, 'large-dataset.bin');
  } finally {
    await f.close();
  }
});

test('Confirmed mkdir/rename/move/copy/recycle + Undo + PathGuard protections + cross-user isolation', async () => {
  const f = await companionFixture();
  try {
    await f.pairUser(f.session, 'user:alice');
    const origPath = path.join(f.downloads, 'alpha.txt');
    const existingTarget = path.join(f.documents, 'alpha.txt');
    await writeFile(origPath, 'Hello EDITH reversible content', 'utf8');
    await writeFile(existingTarget, 'Existing protected file', 'utf8');
    await f.files.start();

    // 1. Confirmed create_directory + Undo
    const mkdirReq = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'create_directory',
      args: { folder: 'Downloads', directoryName: 'Archive' },
      ownerKey: 'user:alice'
    });
    assert.equal(mkdirReq.status, 'confirmation_required');
    const mkdirDone = await f.orchestrator.approve(f.session, 'user:alice', mkdirReq.approvalId);
    assert.equal(mkdirDone.result.status, 'created');
    await access(path.join(f.downloads, 'Archive'));

    // Undo create_directory removes empty folder
    const undoMkdirReq = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'undo_file_action',
      args: { actionId: mkdirDone.result.actionId },
      ownerKey: 'user:alice'
    });
    await f.orchestrator.approve(f.session, 'user:alice', undoMkdirReq.approvalId);
    await assert.rejects(() => access(path.join(f.downloads, 'Archive')));

    // 2. Search file & test PathGuard protections on rename
    let search = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'search_files',
      args: { query: 'alpha', folder: 'Downloads' },
      ownerKey: 'user:alice'
    });
    const alphaId = search.results[0].resultId;

    const badExt = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'rename_file',
      args: { resultId: alphaId, newName: 'evil.ps1' },
      ownerKey: 'user:alice'
    });
    assert.equal(badExt.error.code, 'BLOCKED_EXTENSION');

    const travName = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'rename_file',
      args: { resultId: alphaId, newName: '../escape.txt' },
      ownerKey: 'user:alice'
    });
    assert.equal(travName.error.code, 'PATH_TRAVERSAL');

    // Move collision against existing file must fail with FILE_EXISTS
    const collisionMove = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'move_file',
      args: { resultId: alphaId, targetFolder: 'Documents' },
      ownerKey: 'user:alice'
    });
    await assert.rejects(
      () => f.orchestrator.approve(f.session, 'user:alice', collisionMove.approvalId),
      (e) => e.code === 'FILE_EXISTS'
    );
    assert.equal(await readFile(existingTarget, 'utf8'), 'Existing protected file');

    // 3. Confirmed rename + Undo
    const renameReq = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'rename_file',
      args: { resultId: alphaId, newName: 'alpha-renamed.txt' },
      ownerKey: 'user:alice'
    });
    const renameDone = await f.orchestrator.approve(f.session, 'user:alice', renameReq.approvalId);
    assert.equal(renameDone.result.status, 'renamed');
    await access(path.join(f.downloads, 'alpha-renamed.txt'));

    const undoRenameReq = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'undo_file_action',
      args: { actionId: renameDone.result.actionId },
      ownerKey: 'user:alice'
    });
    // Cross-user Bob cannot approve or undo Alice's action
    await assert.rejects(
      () => f.orchestrator.approve(f.sessionBob, 'user:bob', undoRenameReq.approvalId),
      (e) => e.code === 'CONFIRMATION_MISMATCH'
    );
    await f.orchestrator.approve(f.session, 'user:alice', undoRenameReq.approvalId);
    await access(origPath);

    // 4. Confirmed copy + Undo (and precondition guard when modified)
    search = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'search_files',
      args: { query: 'alpha', folder: 'Downloads' },
      ownerKey: 'user:alice'
    });
    const freshAlphaId = search.results[0].resultId;
    const copyReq = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'copy_file',
      args: { resultId: freshAlphaId, targetFolder: 'Documents', subFolder: 'Copies', newName: 'alpha-copy.txt' },
      ownerKey: 'user:alice'
    });
    const copyDone = await f.orchestrator.approve(f.session, 'user:alice', copyReq.approvalId);
    const copiedPath = path.join(f.documents, 'Copies', 'alpha-copy.txt');
    assert.equal(copyDone.result.status, 'copied');
    await access(copiedPath);

    const undoCopyReq = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'undo_file_action',
      args: { actionId: copyDone.result.actionId },
      ownerKey: 'user:alice'
    });
    await f.orchestrator.approve(f.session, 'user:alice', undoCopyReq.approvalId);
    await assert.rejects(() => access(copiedPath));

    // 5. Confirmed Recycle Bin (mocked safe quarantine dir) -> reports NOT_UNDOABLE for programmatic undo
    const recycleReq = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'recycle_file',
      args: { resultId: freshAlphaId },
      ownerKey: 'user:alice'
    });
    const recycleDone = await f.orchestrator.approve(f.session, 'user:alice', recycleReq.approvalId);
    assert.equal(recycleDone.result.status, 'recycled');
    assert.equal(recycleDone.result.undoAvailable, false);
    await assert.rejects(() => access(origPath));

    const badUndo = await f.orchestrator.executeToolCall(f.session, {
      source: 'ui',
      toolName: 'undo_file_action',
      args: { actionId: recycleDone.result.actionId },
      ownerKey: 'user:alice'
    });
    assert.equal(badUndo.error.code, 'NOT_UNDOABLE');
  } finally {
    await f.close();
  }
});

test('Natural-language AgentOrchestrator decomposes Windows Assistant & organize tasks', async () => {
  const f = await companionFixture({ persistentDb: true });
  try {
    await f.pairUser(f.session, 'user:alice');
    await writeFile(path.join(f.downloads, 'invoice-oct-101.pdf'), '%PDF-1.4 invoice 1', 'utf8');
    await writeFile(path.join(f.downloads, 'shot-dup-a.png'), 'IMG_DATA_DUPLICATE', 'utf8');
    await writeFile(path.join(f.downloads, 'shot-dup-b.png'), 'IMG_DATA_DUPLICATE', 'utf8');
    await f.files.start();

    // Top RAM processes
    const ramTask = await f.orchestrator.runTask(f.session, {
      ownerKey: 'user:alice',
      prompt: 'EDITH, show which applications consume the most RAM.',
      source: 'typed'
    });
    assert.equal(ramTask.state, TASK_STATES.COMPLETED);
    assert(ramTask.summary.includes('Code'));
    assert(ramTask.summary.includes('642.4 MB'));

    // D drive storage
    const driveTask = await f.orchestrator.runTask(f.session, {
      ownerKey: 'user:alice',
      prompt: 'EDITH, check how much storage is left on D drive.',
      source: 'typed'
    });
    assert.equal(driveTask.state, TASK_STATES.COMPLETED);
    assert(driveTask.summary.includes('318 GB free'));

    // Read-only duplicate screenshots
    const dupTask = await f.orchestrator.runTask(f.session, {
      ownerKey: 'user:alice',
      prompt: "EDITH, find duplicate screenshots, but don't delete anything.",
      source: 'typed'
    });
    assert.equal(dupTask.state, TASK_STATES.COMPLETED);
    assert(dupTask.summary.includes('No files were deleted'));

    // Organize PDF invoices in Downloads (mkdir + move_file with approvals)
    const orgTask = await f.orchestrator.runTask(f.session, {
      ownerKey: 'user:alice',
      prompt: 'EDITH, organize the PDF invoices in my Downloads folder.',
      source: 'typed'
    });
    assert.equal(orgTask.intent, 'companion_organize_files');
    assert.equal(orgTask.state, TASK_STATES.AWAITING_APPROVAL);
    assert.equal(orgTask.approvals[0].toolName, 'create_directory');

    // Approve mkdir -> advances to move_file approval
    const afterMkdir = await f.orchestrator.approve(f.session, 'user:alice', orgTask.approvals[0].id);
    assert.equal(afterMkdir.task.state, TASK_STATES.AWAITING_APPROVAL);
    const moveApproval = afterMkdir.task.approvals.find((a) => a.state === 'pending' && a.toolName === 'move_file');
    assert(moveApproval);

    // Approve move_file -> completes & verifies moved PDF
    const afterMove = await f.orchestrator.approve(f.session, 'user:alice', moveApproval.id);
    assert.equal(afterMove.task.state, TASK_STATES.COMPLETED);
    await access(path.join(f.downloads, 'Invoices', 'invoice-oct-101.pdf'));
    await assert.rejects(() => access(path.join(f.downloads, 'invoice-oct-101.pdf')));
  } finally {
    await f.close();
  }
});
