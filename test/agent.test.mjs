import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { disposable, removeDisposable } from '../checks/helpers/fixtures.mjs';
import { loadSecurityConfig } from '../safety/config.mjs';
import { loadFileConfig } from '../tools/config.mjs';
import { LocalSessions } from '../safety/sessions.mjs';
import { UserAuthority } from '../safety/authority.mjs';
import { PolicyEngine, Risk } from '../safety/policy.mjs';
import { ConfirmationManager } from '../safety/confirmations.mjs';
import { AuditService } from '../safety/audit.mjs';
import { CloudGate } from '../safety/cloudGate.mjs';
import { FileService } from '../tools/service.mjs';
import { ToolRegistry, fileTools } from '../tools/registry.mjs';
import { AgentStore } from '../agent/store.mjs';
import { ExecutionGuard } from '../agent/guards.mjs';
import { AgentOrchestrator, TASK_STATES, assertValidTransition } from '../agent/orchestrator.mjs';

async function agentFixture({ persistentDb = false } = {}) {
  const dir = await disposable('agent-core-');
  const downloads = path.join(dir, 'Downloads');
  const documents = path.join(dir, 'Documents');
  await mkdir(downloads, { recursive: true });
  await mkdir(documents, { recursive: true });

  const sec = structuredClone(await loadSecurityConfig());
  sec.filesystem.includedRoots = [downloads, documents];
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
    maxFiles: 200,
    maxDepth: 4,
    security: sec
  };
  fileCfg.indexing = { ...fileCfg.indexing, directory: path.join(dir, 'index-store') };

  const sessions = new LocalSessions(sec.sessions);
  const session = sessions.create();
  const sessionOther = sessions.create();
  const authority = new UserAuthority({ isSessionValid: (s) => sessions.valid(s) });
  const policy = new PolicyEngine(sec, authority);
  const audit = new AuditService(path.join(dir, 'audit', 'events.jsonl'), { authority });
  const auditEvent = (rec) => audit.append(rec);
  const confirmations = new ConfirmationManager(sec.confirmation, authority, { audit: auditEvent });
  const files = new FileService(fileCfg);
  const registry = new ToolRegistry(fileTools, auditEvent, { policy, confirmations });
  const cloudGate = new CloudGate(sec, authority, files);
  const dbPath = persistentDb ? path.join(dir, 'agent.sqlite') : ':memory:';
  const store = new AgentStore(dbPath);
  const published = [];
  const orchestrator = new AgentOrchestrator({
    store,
    registry,
    authority,
    policy,
    confirmations,
    files,
    auditEvent,
    publish: (_s, type, data) => published.push({ type, data })
  });

  return {
    dir,
    downloads,
    documents,
    dbPath,
    sessions,
    session,
    sessionOther,
    authority,
    policy,
    confirmations,
    audit,
    files,
    registry,
    cloudGate,
    store,
    orchestrator,
    published,
    async close() {
      orchestrator.close();
      await files.close();
      await audit.queue;
      await removeDisposable(dir);
    }
  };
}

test('task lifecycle transitions enforce valid state graph', () => {
  assertValidTransition(TASK_STATES.CREATED, TASK_STATES.PLANNING);
  assertValidTransition(TASK_STATES.PLANNING, TASK_STATES.RUNNING);
  assertValidTransition(TASK_STATES.RUNNING, TASK_STATES.AWAITING_APPROVAL);
  assertValidTransition(TASK_STATES.AWAITING_APPROVAL, TASK_STATES.RUNNING);
  assertValidTransition(TASK_STATES.RUNNING, TASK_STATES.COMPLETED);
  assert.throws(() => assertValidTransition(TASK_STATES.COMPLETED, TASK_STATES.RUNNING), /INVALID_STATE_TRANSITION|Cannot transition/);
  assert.throws(() => assertValidTransition(TASK_STATES.CANCELLED, TASK_STATES.PAUSED), /Cannot transition/);
});

test('ToolRegistry exposes metadata descriptors and enforces per-tool timeouts', async () => {
  const f = await agentFixture();
  try {
    const desc = f.orchestrator.describeTools();
    const saveMeta = desc.find((t) => t.name === 'save_report');
    assert.equal(saveMeta.id, 'files.save_report');
    assert.equal(saveMeta.riskLevel, 'REVERSIBLE');
    assert.equal(saveMeta.requiresConfirmation, true);
    assert.equal(saveMeta.cancellable, true);
    assert.equal(saveMeta.idempotent, false);

    const slowRegistry = new ToolRegistry(
      [
        {
          id: 'test.slow',
          name: 'slow_tool',
          description: 'Slow tool',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          riskLevel: Risk.READ_ONLY,
          requiredPermissions: ['test'],
          requiresPathValidation: false,
          timeoutMs: 40,
          async run() {
            await new Promise((r) => setTimeout(r, 150));
            return { ok: true };
          }
        }
      ],
      (r) => f.audit.append(r),
      { policy: f.policy, confirmations: f.confirmations }
    );
    const auth = f.authority.issue(f.session, { source: 'typed', text: 'test slow', permissions: ['test'] });
    const res = await slowRegistry.call('slow_tool', {}, { session: f.session, source: 'ui', authorization: auth });
    assert.equal(res.error.code, 'TOOL_TIMEOUT');
  } finally {
    await f.close();
  }
});

test('ExecutionGuard blocks identical tool loops and step/call caps', () => {
  const guard = new ExecutionGuard({ maxSteps: 2, maxToolCalls: 4, maxIdenticalCalls: 2 });
  guard.beforeStep();
  guard.beforeStep();
  assert.throws(() => guard.beforeStep(), (e) => e.code === 'RESOURCE_LIMIT');

  guard.beforeCall('search_files', { query: 'invoice' });
  guard.beforeCall('search_files', { query: 'invoice' });
  assert.throws(() => guard.beforeCall('search_files', { query: 'invoice' }), (e) => e.code === 'LOOP_DETECTED');
});

test('AgentOrchestrator decomposes October invoice report, awaits approval, verifies saved file and isolates users', async () => {
  const f = await agentFixture({ persistentDb: true });
  try {
    await writeFile(
      path.join(f.downloads, 'invoice-october-acme.txt'),
      'Acme Logistics Invoice\nDate: 2026-10-08\nTotal Amount: INR 12,400\n',
      'utf8'
    );
    await writeFile(
      path.join(f.downloads, 'invoice-october-beta.txt'),
      'Beta Energy Invoice\nDate: 2026-10-19\nAmount Due: INR 4,200\n',
      'utf8'
    );
    await f.files.start();

    const task = await f.orchestrator.runTask(f.session, {
      ownerKey: 'user:alice',
      prompt: 'EDITH, find all invoices from October, create a summary report, and save the report in my Documents folder.',
      source: 'typed'
    });

    assert.equal(task.intent, 'file_report');
    assert.equal(task.state, TASK_STATES.AWAITING_APPROVAL);
    assert(task.preview.includes('invoice-october-acme.txt'));
    assert(task.preview.includes('INR 12,400'));
    assert(task.preview.includes('INR 4,200'));
    assert.equal(task.approvals.length, 1);
    const approvalId = task.approvals[0].id;
    assert.equal(task.approvals[0].state, 'pending');
    assert.equal(task.approvals[0].riskLevel, 'REVERSIBLE');

    // File must NOT exist yet before user approval
    const reportPath = path.join(f.documents, task.result.reportFileName);
    await assert.rejects(() => access(reportPath));

    // Cross-user isolation: Bob cannot view or approve Alice's task/approval
    assert.equal(f.orchestrator.getTask('user:bob', task.id), null);
    await assert.rejects(
      () => f.orchestrator.approve(f.sessionOther, 'user:bob', approvalId),
      (e) => e.code === 'CONFIRMATION_MISMATCH'
    );

    // Approve Alice's task
    const approved = await f.orchestrator.approve(f.session, 'user:alice', approvalId);
    assert.equal(approved.approval.state, 'approved');
    assert.equal(approved.task.state, TASK_STATES.COMPLETED);
    assert.equal(approved.result.status, 'saved');
    assert.equal(approved.result.verified, true);

    const diskContent = await readFile(reportPath, 'utf8');
    assert(diskContent.includes('INR 12,400'));
    assert(diskContent.includes('invoice-october-beta.txt'));

    // Replaying consumed approval fails closed
    await assert.rejects(
      () => f.orchestrator.approve(f.session, 'user:alice', approvalId),
      (e) => e.code === 'CONFIRMATION_REJECTED'
    );

    // CloudGate never passes read_local_text excerpts to Gemini
    const found = await f.orchestrator.executeToolCall(f.session, {
      source: 'typed',
      text: 'Find my october invoices',
      toolName: 'search_files',
      args: { query: 'invoice' }
    });
    const localRead = await f.orchestrator.executeToolCall(f.session, {
      source: 'typed',
      text: 'Summarize my october invoices',
      toolName: 'read_local_text',
      args: { resultId: found.results[0].resultId }
    });
    assert(localRead.excerpt.includes('Invoice'));
    const cloudSafe = await f.cloudGate.toolOutput('read_local_text', localRead, {
      session: f.session,
      authorization: f.authority.current(f.session)
    });
    assert.equal(cloudSafe.excerpt, undefined);
    assert.equal(cloudSafe.localOnly, true);

    // save_report rejects existing file overwrite, traversal, and blocked extensions
    const dupApproval = await f.orchestrator.executeToolCall(f.session, {
      source: 'typed',
      text: 'Save a summary report',
      toolName: 'save_report',
      args: { folder: 'Documents', fileName: task.result.reportFileName, content: 'Overwrite attempt' },
      ownerKey: 'user:alice'
    });
    assert.equal(dupApproval.status, 'confirmation_required');
    await assert.rejects(
      () => f.orchestrator.approve(f.session, 'user:alice', dupApproval.approvalId),
      (e) => e.code === 'FILE_EXISTS'
    );

    const badExt = await f.orchestrator.executeToolCall(f.session, {
      source: 'typed',
      text: 'Save a report',
      toolName: 'save_report',
      args: { folder: 'Documents', fileName: 'evil.ps1', content: 'echo 1' }
    });
    assert.equal(badExt.error.code, 'INVALID_ARGUMENTS');

    // SQLite restart persistence
    f.orchestrator.close();
    const reopened = new AgentStore(f.dbPath);
    try {
      const persisted = reopened.getTask('user:alice', task.id);
      assert.equal(persisted.state, TASK_STATES.COMPLETED);
      assert.equal(persisted.steps.length, 5);
      assert.equal(reopened.listTasks('user:bob').length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});

test('Rejecting an approval cancels the task without modifying disk', async () => {
  const f = await agentFixture();
  try {
    await writeFile(path.join(f.downloads, 'invoice-october-1.txt'), 'Amount: INR 900\n', 'utf8');
    await f.files.start();
    const task = await f.orchestrator.runTask(f.session, {
      ownerKey: 'user:alice',
      prompt: 'Find invoices from October, create a summary report, and save the report in Downloads',
      source: 'typed'
    });
    assert.equal(task.state, TASK_STATES.AWAITING_APPROVAL);
    const approvalId = task.approvals[0].id;
    const rejected = await f.orchestrator.reject(f.session, 'user:alice', approvalId, 'Do not write file');
    assert.equal(rejected.approval.state, 'rejected');
    assert.equal(rejected.task.state, TASK_STATES.CANCELLED);
    await assert.rejects(() => access(path.join(f.downloads, task.result.reportFileName)));
  } finally {
    await f.close();
  }
});
