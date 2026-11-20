import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolError } from '../tools/errors.mjs';
import { toolSecurity, userPermissions } from '../safety/permissions.mjs';
import { ExecutionGuard } from './guards.mjs';
import { classifyIntent, buildTaskPlan, isLocalTextFile, composeLocalReport } from './planner.mjs';

export const TASK_STATES = Object.freeze({
  CREATED: 'created',
  PLANNING: 'planning',
  AWAITING_APPROVAL: 'awaiting_approval',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

const VALID_TRANSITIONS = new Map([
  [TASK_STATES.CREATED, new Set([TASK_STATES.PLANNING, TASK_STATES.FAILED, TASK_STATES.CANCELLED])],
  [TASK_STATES.PLANNING, new Set([TASK_STATES.RUNNING, TASK_STATES.PAUSED, TASK_STATES.FAILED, TASK_STATES.CANCELLED])],
  [TASK_STATES.RUNNING, new Set([TASK_STATES.AWAITING_APPROVAL, TASK_STATES.PAUSED, TASK_STATES.COMPLETED, TASK_STATES.FAILED, TASK_STATES.CANCELLED])],
  [TASK_STATES.AWAITING_APPROVAL, new Set([TASK_STATES.RUNNING, TASK_STATES.PAUSED, TASK_STATES.COMPLETED, TASK_STATES.FAILED, TASK_STATES.CANCELLED])],
  [TASK_STATES.PAUSED, new Set([TASK_STATES.RUNNING, TASK_STATES.FAILED, TASK_STATES.CANCELLED])],
  [TASK_STATES.COMPLETED, new Set()],
  [TASK_STATES.FAILED, new Set()],
  [TASK_STATES.CANCELLED, new Set()]
]);

export function assertValidTransition(from, to) {
  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed || !allowed.has(to)) {
    throw new ToolError('INVALID_STATE_TRANSITION', `Cannot transition task from "${from}" to "${to}".`);
  }
}

export class AgentOrchestrator {
  constructor({ store, registry, authority, policy, confirmations, files, companion = null, knowledge = null, auditEvent = async () => {}, publish = () => {}, hosted = false }) {
    this.store = store;
    this.registry = registry;
    this.authority = authority;
    this.policy = policy;
    this.confirmations = confirmations;
    this.files = files;
    this.companion = companion;
    this.knowledge = knowledge;
    this.auditEvent = auditEvent;
    this.publish = publish;
    this.hosted = hosted;
    this.pendingConfirmations = new Map();
    this.controllers = new Map();
  }

  describeTools() {
    return this.registry.describe();
  }

  listTasks(ownerKey, limit = 25) {
    return this.store.listTasks(ownerKey, limit);
  }

  getTask(ownerKey, taskId) {
    return this.store.getTask(ownerKey, taskId);
  }

  listApprovals(ownerKey, limit = 50) {
    return this.store.listApprovals(ownerKey, limit);
  }

  pendingApprovalsCount(ownerKey) {
    return this.listApprovals(ownerKey).filter((a) => a.state === 'pending').length;
  }

  activeTasksCount(ownerKey) {
    return this.listTasks(ownerKey).filter((t) => ['created', 'planning', 'running', 'awaiting_approval'].includes(t.state)).length;
  }

  #transition(ownerKey, task, nextState, patch = {}) {
    assertValidTransition(task.state, nextState);
    const updated = this.store.updateTask(ownerKey, task.id, { ...patch, state: nextState, updatedAt: Date.now() });
    return updated;
  }

  #resolveAuthorization(session, { source, text, toolName }) {
    if (source === 'ui') {
      const permissions = [
        ...(toolSecurity[toolName]?.requiredPermissions || []),
        'cloud.metadata',
        'confirmation.create',
        'confirmation.approve'
      ];
      return this.authority.issue(session, {
        source: 'typed',
        text: text || `Explicit UI action: ${toolName}`,
        permissions
      });
    }
    const required = toolSecurity[toolName]?.requiredPermissions || ['calendar.read'];
    const existing = this.authority.current(session);
    if (existing) {
      try {
        for (const perm of required) {
          this.authority.verify(existing, session, perm);
        }
        return existing;
      } catch {
        // Fall through to text-derived issuance if text was provided.
      }
    }
    if (typeof text === 'string' && text.trim()) {
      const authSource = source === 'voice' ? 'voice' : 'typed';
      return this.authority.issue(session, {
        source: authSource,
        text,
        permissions: userPermissions(text, { fileContinuation: session.fileWorkflow })
      });
    }
    return existing;
  }

  async executeToolCall(session, {
    source = 'typed',
    text = '',
    toolName,
    args = {},
    confirmation,
    isCancelled,
    guard,
    ownerKey,
    taskId = null,
    stepId = null
  }) {
    if (guard) guard.beforeCall(toolName, args);
    const authorization = this.#resolveAuthorization(session, { source, text, toolName });
    const toolContextSource = source === 'ui' ? 'ui' : source === 'voice' ? 'voice' : 'typed';
    const context = {
      session,
      source: toolContextSource,
      files: this.files,
      companion: this.companion,
      knowledge: this.knowledge,
      ownerKey,
      authorization,
      confirmation,
      isCancelled,
      publish: (type, data) => this.publish(session, type, data)
    };
    const result = await this.registry.call(toolName, args, context);
    if (result?.status === 'confirmation_required' && result.operationId && result.token && ownerKey) {
      const sec = toolSecurity[toolName] || {};
      const approvalId = randomUUID();
      const approval = this.store.createApproval({
        id: approvalId,
        ownerKey,
        sessionId: session.id,
        taskId,
        stepId,
        operationId: result.operationId,
        toolName,
        riskLevel: result.riskLevel || sec.riskLevel || 'REVERSIBLE',
        reversible: result.reversible ?? (sec.riskLevel === 'REVERSIBLE'),
        targetIds: result.targetIds || [],
        reason: text || `Execute ${toolName}`,
        preview: result.preview,
        expectedChanges: result.preview,
        state: 'pending',
        expiresAt: result.expiresAt,
        createdAt: Date.now()
      });
      this.pendingConfirmations.set(approvalId, {
        approvalId,
        operationId: result.operationId,
        token: result.token,
        requestId: result.requestId,
        operation: { toolName, targetIds: result.targetIds || [], parameters: args },
        toolName,
        taskId,
        stepId,
        sessionId: session.id,
        ownerKey
      });
      this.publish(session, 'agentApproval', approval);
      return {
        ...result,
        token: undefined,
        approvalId
      };
    }
    return result;
  }

  async runTask(session, { ownerKey, prompt, source = 'typed', business = null, bookings = [], documentIds = null }) {
    const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!cleanPrompt || cleanPrompt.length > 2000) {
      throw new ToolError('INVALID_ARGUMENTS', 'Provide a task request between 1 and 2000 characters.');
    }
    const now = Date.now();
    const explicitDocIds = Array.isArray(documentIds) && documentIds.length ? documentIds.filter(Boolean) : null;
    const parsedIntent = classifyIntent(cleanPrompt, { documentIds: explicitDocIds });
    let task = this.store.createTask({
      id: randomUUID(),
      ownerKey,
      sessionId: session.id,
      source,
      intent: parsedIntent.intent,
      prompt: cleanPrompt,
      state: TASK_STATES.CREATED,
      createdAt: now,
      updatedAt: now
    });

    task = this.#transition(ownerKey, task, TASK_STATES.PLANNING);
    const authorizedFolders = this.files?.config?.enabled ? this.files.config.roots : [];
    const planSpecs = buildTaskPlan(cleanPrompt, parsedIntent, { authorizedFolders });

    const createdSteps = planSpecs.map((spec, idx) => ({
      id: randomUUID(),
      taskId: task.id,
      stepIndex: idx,
      title: spec.title,
      toolName: spec.toolName,
      riskLevel: spec.riskLevel || 'READ_ONLY',
      state: 'pending',
      kind: spec.kind
    }));
    this.store.addSteps(createdSteps);

    const runtime = {
      parsedIntent,
      stepKinds: createdSteps.map((s) => s.kind),
      matches: [],
      readItems: [],
      skippedFiles: [],
      reportContent: null,
      reportFileName: parsedIntent.reportFileName || null,
      targetFolder: parsedIntent.targetFolder || authorizedFolders[0]?.id || 'Downloads',
      savedReport: null,
      metricsResult: null,
      processesResult: null,
      appsResult: null,
      launchedApp: null,
      duplicatesResult: null,
      largeFilesResult: null,
      createdDirectory: null,
      movedFiles: [],
      organizeIndex: 0,
      organizeRootId: null,
      organizeSubFolder: parsedIntent.targetSubFolder || null,
      mutationResult: null,
      explicitDocumentIds: explicitDocIds || parsedIntent.documentIds || null,
      knowledgeResult: null,
      nextStepIndex: 0
    };

    task = this.#transition(ownerKey, task, TASK_STATES.RUNNING, { result: runtime });
    this.publish(session, 'agentTask', task);

    return this.#executeFromStep(session, ownerKey, task, 0, runtime, { business, bookings });
  }

  async #executeFromStep(session, ownerKey, currentTask, startIndex, runtime, { business = null, bookings = [] } = {}) {
    let task = currentTask;
    const controller = this.controllers.get(task.id) || { pauseRequested: false, cancelRequested: false };
    this.controllers.set(task.id, controller);
    const guard = new ExecutionGuard();
    const isCancelled = () => controller.cancelRequested;

    const finishCancelled = () => {
      for (let j = startIndex; j < task.steps.length; j += 1) {
        if (['pending', 'running', 'awaiting_approval'].includes(task.steps[j].state)) {
          this.store.updateStep(task.steps[j].id, { state: 'cancelled', finishedAt: Date.now() });
        }
      }
      task = this.#transition(ownerKey, task, TASK_STATES.CANCELLED, {
        summary: 'Task was cancelled before completion.',
        completedAt: Date.now()
      });
      this.publish(session, 'agentTask', task);
      this.controllers.delete(task.id);
      return task;
    };

    try {
      for (let i = startIndex; i < task.steps.length; i += 1) {
        if (controller.cancelRequested) return finishCancelled();
        if (controller.pauseRequested) {
          runtime.nextStepIndex = i;
          task = this.#transition(ownerKey, task, TASK_STATES.PAUSED, {
            result: runtime,
            summary: `Paused before step ${i + 1}: ${task.steps[i].title}.`
          });
          this.publish(session, 'agentTask', task);
          return task;
        }

        guard.beforeStep();
        const step = task.steps[i];
        const kind = runtime.stepKinds?.[i];
        this.store.updateStep(step.id, { state: 'running', startedAt: Date.now() });

        if (kind === 'search') {
          if (this.hosted || !this.files?.config?.enabled) {
            throw new ToolError('FILES_DISABLED', 'Local file search is disabled in this environment.');
          }
          const searchArgs = {
            query: runtime.parsedIntent.searchQuery || 'invoice',
            sortBy: 'modifiedDesc',
            limit: 20
          };
          if (runtime.parsedIntent.searchFolder) {
            const matchedRoot = this.files.config.roots.find(
              (r) => r.id.toLowerCase() === runtime.parsedIntent.searchFolder.toLowerCase()
            );
            if (!matchedRoot) {
              throw new ToolError(
                'OUTSIDE_ALLOWLIST',
                `Search folder "${runtime.parsedIntent.searchFolder}" is not authorized. Authorized folders: ${this.files.config.roots.map((r) => r.id).join(', ') || 'none'}.`
              );
            }
            searchArgs.folder = matchedRoot.id;
          }
          this.store.updateStep(step.id, { input: searchArgs });
          let res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: 'search_files',
            args: searchArgs,
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);

          if (!res.results?.length && runtime.parsedIntent.monthRange && runtime.parsedIntent.coreSubject) {
            const datedArgs = {
              query: runtime.parsedIntent.coreSubject,
              modifiedAfter: runtime.parsedIntent.monthRange.after,
              modifiedBefore: runtime.parsedIntent.monthRange.before,
              sortBy: 'modifiedDesc',
              limit: 20
            };
            if (searchArgs.folder) datedArgs.folder = searchArgs.folder;
            res = await this.executeToolCall(session, {
              source: 'typed',
              text: task.prompt,
              toolName: 'search_files',
              args: datedArgs,
              isCancelled,
              guard,
              ownerKey,
              taskId: task.id,
              stepId: step.id
            });
            if (res.error) throw new ToolError(res.error.code, res.error.message);
          }

          if (!res.results?.length && runtime.parsedIntent.coreSubject && runtime.parsedIntent.coreSubject !== searchArgs.query) {
            const fallbackArgs = { query: runtime.parsedIntent.coreSubject, sortBy: 'modifiedDesc', limit: 20 };
            if (searchArgs.folder) fallbackArgs.folder = searchArgs.folder;
            res = await this.executeToolCall(session, {
              source: 'typed',
              text: task.prompt,
              toolName: 'search_files',
              args: fallbackArgs,
              isCancelled,
              guard,
              ownerKey,
              taskId: task.id,
              stepId: step.id
            });
            if (res.error) throw new ToolError(res.error.code, res.error.message);
          }

          runtime.matches = res.results || [];
          this.store.updateStep(step.id, {
            state: 'completed',
            finishedAt: Date.now(),
            output: {
              matchCount: runtime.matches.length,
              files: runtime.matches.map((m) => ({ name: m.name, rootId: m.rootId, size: m.size, modifiedAt: m.modifiedAt }))
            }
          });
        } else if (kind === 'read_local') {
          const readItems = [];
          const skippedFiles = [];
          for (const item of runtime.matches.slice(0, 10)) {
            if (controller.cancelRequested) return finishCancelled();
            if (!isLocalTextFile(item.name)) {
              skippedFiles.push(item);
              continue;
            }
            const res = await this.executeToolCall(session, {
              source: 'typed',
              text: task.prompt,
              toolName: 'read_local_text',
              args: { resultId: item.resultId, maxChars: 6000 },
              isCancelled,
              guard,
              ownerKey,
              taskId: task.id,
              stepId: step.id
            });
            if (res.error) {
              skippedFiles.push({ ...item, error: res.error.message });
            } else {
              readItems.push(res);
            }
          }
          runtime.readItems = readItems;
          runtime.skippedFiles = skippedFiles;
          this.store.updateStep(step.id, {
            state: 'completed',
            finishedAt: Date.now(),
            output: {
              filesRead: readItems.map((d) => ({ name: d.name, charCount: d.charCount, truncated: d.truncated })),
              skippedCount: skippedFiles.length
            }
          });
        } else if (kind === 'compose_report') {
          const reportContent = composeLocalReport({
            prompt: task.prompt,
            matches: runtime.matches,
            readItems: runtime.readItems,
            skippedFiles: runtime.skippedFiles
          });
          runtime.reportContent = reportContent;
          runtime.reportFileName = runtime.reportFileName || 'edith-summary.md';
          this.store.updateTask(ownerKey, task.id, { preview: reportContent });
          this.store.updateStep(step.id, {
            state: 'completed',
            finishedAt: Date.now(),
            output: {
              fileName: runtime.reportFileName,
              targetFolder: runtime.targetFolder,
              bytes: Buffer.byteLength(reportContent, 'utf8')
            }
          });
        } else if (kind === 'save_report') {
          if (this.hosted || !this.files?.config?.enabled) {
            throw new ToolError('FILES_DISABLED', 'Saving local reports is disabled in this environment.');
          }
          const roots = this.files.config.roots || [];
          const matchedRoot = roots.find((r) => r.id.toLowerCase() === String(runtime.targetFolder || '').toLowerCase());
          if (!matchedRoot) {
            throw new ToolError(
              'OUTSIDE_ALLOWLIST',
              `Folder "${runtime.targetFolder}" is not authorized. Authorized folders: ${roots.map((r) => r.id).join(', ') || 'none'}. Add "${runtime.targetFolder}" in config/file-tools.jsonc and restart EDITH, or specify an authorized folder.`
            );
          }
          const saveArgs = {
            folder: matchedRoot.id,
            fileName: runtime.reportFileName,
            content: runtime.reportContent
          };
          this.store.updateStep(step.id, { input: { folder: saveArgs.folder, fileName: saveArgs.fileName, bytes: Buffer.byteLength(saveArgs.content, 'utf8') } });
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: 'save_report',
            args: saveArgs,
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          if (res.status === 'confirmation_required') {
            runtime.nextStepIndex = i + 1;
            runtime.pendingApprovalId = res.approvalId;
            this.store.updateStep(step.id, { state: 'awaiting_approval' });
            task = this.#transition(ownerKey, task, TASK_STATES.AWAITING_APPROVAL, {
              preview: runtime.reportContent,
              result: { ...runtime, readItems: runtime.readItems.map((d) => ({ name: d.name, charCount: d.charCount, truncated: d.truncated })) },
              summary: `Awaiting approval to create "${saveArgs.fileName}" in ${saveArgs.folder}.`
            });
            this.publish(session, 'agentTask', task);
            return task;
          }
          runtime.savedReport = res;
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: res });
        } else if (kind === 'verify_report') {
          const saved = runtime.savedReport;
          if (!saved || saved.status !== 'saved' || saved.verified !== true || !(saved.sizeBytes > 0)) {
            throw new ToolError('OPERATION_FAILED', 'Saved report verification failed.');
          }
          this.store.updateStep(step.id, {
            state: 'completed',
            finishedAt: Date.now(),
            output: { verified: true, rootId: saved.rootId, fileName: saved.fileName, sizeBytes: saved.sizeBytes }
          });
        } else if (kind === 'file_search') {
          if (this.hosted || !this.files?.config?.enabled) {
            throw new ToolError('FILES_DISABLED', 'Local file search is disabled in this environment.');
          }
          const searchArgs = { query: runtime.parsedIntent.searchQuery, sortBy: 'modifiedDesc', limit: 20 };
          if (runtime.parsedIntent.searchFolder) {
            const matchedRoot = this.files.config.roots.find((r) => r.id.toLowerCase() === runtime.parsedIntent.searchFolder.toLowerCase());
            if (matchedRoot) searchArgs.folder = matchedRoot.id;
          }
          this.store.updateStep(step.id, { input: searchArgs });
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: 'search_files',
            args: searchArgs,
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          runtime.matches = res.results || [];
          this.store.updateStep(step.id, {
            state: 'completed',
            finishedAt: Date.now(),
            output: { matchCount: runtime.matches.length, files: runtime.matches.map((m) => m.name) }
          });
        } else if (kind === 'resolve_ref') {
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: 'resolve_file_reference',
            args: { selector: runtime.parsedIntent.selector || 'selected' },
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          runtime.resolvedItem = res;
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: { name: res.name, resultId: res.resultId } });
        } else if (kind === 'file_act') {
          const targetId = runtime.resolvedItem?.resultId;
          if (!targetId) throw new ToolError('INVALID_FILE_REFERENCE', 'Search for files first before opening or revealing a result.');
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: step.toolName || 'open_file',
            args: { resultId: targetId },
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          runtime.fileActionResult = res;
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: res });
        } else if (kind === 'index') {
          const toolName = step.toolName;
          const args = toolName === 'index_control' ? { action: runtime.parsedIntent.indexAction } : {};
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName,
            args,
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          runtime.indexResult = res;
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: res });
        } else if (kind === 'drives') {
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: 'get_drive_information',
            args: {},
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          runtime.drivesResult = res;
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: res });
        } else if (kind === 'business_summary') {
          const summaryData = business
            ? {
                company: business.name,
                address: business.address,
                primaryContact: business.contact || null,
                services: business.services.map((s) => ({
                  name: s.name,
                  price: s.price,
                  currency: business.currency,
                  minutes: s.minutes,
                  contact: s.contact || business.contact || null
                })),
                bookingsCount: bookings.length
              }
            : { bookingsCount: bookings.length };
          runtime.businessSummary = summaryData;
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: summaryData });
        } else if (kind === 'companion_metrics') {
          const args = runtime.parsedIntent?.drive ? { drive: runtime.parsedIntent.drive } : {};
          this.store.updateStep(step.id, { input: args });
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: 'get_system_metrics',
            args,
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          runtime.metricsResult = res;
          const driveLines = (res.drives || []).map((d) => `- Drive ${d.drive} (${d.label}): ${d.freeGb} GB free of ${d.totalGb} GB (${d.usedPercent}% used)`);
          const previewLines = [
            `Device: ${res.hostname} (${res.platform})`,
            `CPU: ${res.cpu.cpuPercent}% (${res.cpu.cpuCores} cores)`,
            `Memory: ${res.memory.usedGb} GB / ${res.memory.totalGb} GB (${res.memory.usedPercent}%)`,
            ...driveLines,
            `Battery: ${res.battery.supported ? `${res.battery.percent}% (${res.battery.status})` : res.battery.status}`
          ];
          this.store.updateTask(ownerKey, task.id, { preview: previewLines.join('\n') });
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: res });
        } else if (kind === 'companion_processes') {
          const args = { sortBy: runtime.parsedIntent?.sortBy || 'memory', limit: runtime.parsedIntent?.limit || 10 };
          this.store.updateStep(step.id, { input: args });
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: 'list_running_processes',
            args,
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          runtime.processesResult = res;
          const procLines = (res.processes || []).map((p, idx) => `${idx + 1}. ${p.name} (PID ${p.pid}) — ${p.memoryMb} MB RAM · ${p.cpuSeconds}s CPU`);
          this.store.updateTask(ownerKey, task.id, { preview: procLines.join('\n') });
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: res });
        } else if (kind === 'companion_apps') {
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: 'list_installed_apps',
            args: {},
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          runtime.appsResult = res;
          if (task.intent === 'companion_apps_list') {
            const lines = (res.apps || []).map((a) => `- ${a.displayName} (${a.appId}): ${a.installed ? 'Installed' : 'Not installed'}, ${a.enabled ? 'Enabled' : 'Disabled'}`);
            this.store.updateTask(ownerKey, task.id, { preview: lines.join('\n') });
          }
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: res });
        } else if (kind === 'companion_launch_app') {
          const args = { appId: runtime.parsedIntent?.appId };
          this.store.updateStep(step.id, { input: args });
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: 'launch_approved_app',
            args,
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          if (res.status === 'confirmation_required') {
            return this.#awaitStepApproval(session, ownerKey, task, step, i + 1, runtime, res, res.preview);
          }
          runtime.launchedApp = res;
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: res });
        } else if (kind === 'companion_duplicates') {
          if (this.hosted || !this.files?.config?.enabled) {
            throw new ToolError('FILES_DISABLED', 'Local file scanning is disabled in this environment.');
          }
          const args = {};
          if (runtime.parsedIntent?.folder) {
            const matchedRoot = this.files.config.roots.find((r) => r.id.toLowerCase() === runtime.parsedIntent.folder.toLowerCase());
            if (!matchedRoot) {
              throw new ToolError('OUTSIDE_ALLOWLIST', `Folder "${runtime.parsedIntent.folder}" is not authorized.`);
            }
            args.folder = matchedRoot.id;
          }
          if (runtime.parsedIntent?.nameFilter) args.nameFilter = runtime.parsedIntent.nameFilter;
          this.store.updateStep(step.id, { input: args });
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: 'find_duplicate_files',
            args,
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          runtime.duplicatesResult = res;
          const dupPreview = [
            `Read-only duplicate scan complete (0 files deleted; ${res.totalScanned} scanned).`,
            `Duplicate groups: ${res.groupCount} · Total duplicate files: ${res.duplicateFileCount} · Reclaimable bytes: ${res.totalWastedBytes}`,
            ...res.groups.map((g, idx) => `Group ${idx + 1} (${g.sizeBytes} bytes, ${g.count} copies): ${g.files.map((f) => `${f.rootId}/${f.name}`).join(', ')}`)
          ].join('\n');
          this.store.updateTask(ownerKey, task.id, { preview: dupPreview });
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: res });
        } else if (kind === 'companion_large_files') {
          if (this.hosted || !this.files?.config?.enabled) {
            throw new ToolError('FILES_DISABLED', 'Local file scanning is disabled in this environment.');
          }
          const args = {};
          if (runtime.parsedIntent?.folder) {
            const matchedRoot = this.files.config.roots.find((r) => r.id.toLowerCase() === runtime.parsedIntent.folder.toLowerCase());
            if (!matchedRoot) {
              throw new ToolError('OUTSIDE_ALLOWLIST', `Folder "${runtime.parsedIntent.folder}" is not authorized.`);
            }
            args.folder = matchedRoot.id;
          }
          if (runtime.parsedIntent?.minSizeBytes) args.minSizeBytes = runtime.parsedIntent.minSizeBytes;
          this.store.updateStep(step.id, { input: args });
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: 'find_large_files',
            args,
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          runtime.largeFilesResult = res;
          const largePreview = [
            `Scanned ${res.totalScanned} file(s); found ${res.files.length} large file(s) >= ${res.minSizeBytes} bytes.`,
            ...res.files.map((f) => `${f.ordinal}. ${f.rootId}/${f.name} (${f.sizeBytes} bytes)`)
          ].join('\n');
          this.store.updateTask(ownerKey, task.id, { preview: largePreview });
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: res });
        } else if (kind === 'organize_search') {
          if (this.hosted || !this.files?.config?.enabled) {
            throw new ToolError('FILES_DISABLED', 'Local file tools are disabled in this environment.');
          }
          const matchedRoot = this.files.config.roots.find(
            (r) => r.id.toLowerCase() === String(runtime.parsedIntent?.folder || '').toLowerCase()
          );
          if (!matchedRoot) {
            throw new ToolError('OUTSIDE_ALLOWLIST', `Folder "${runtime.parsedIntent?.folder}" is not an authorized folder.`);
          }
          const subFolder = runtime.parsedIntent?.targetSubFolder || 'Organized-Files';
          const searchArgs = {
            folder: matchedRoot.id,
            query: runtime.parsedIntent.searchQuery || 'invoice',
            ...(runtime.parsedIntent.extensions ? { extensions: runtime.parsedIntent.extensions } : {}),
            sortBy: 'modifiedDesc',
            limit: 10
          };
          this.store.updateStep(step.id, { input: searchArgs });
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: 'search_files',
            args: searchArgs,
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          const alreadyDir = path.join(matchedRoot.path, subFolder).toLowerCase();
          const eligible = (res.results || []).filter((item) => item.folder.toLowerCase() !== alreadyDir);
          runtime.matches = eligible;
          runtime.organizeRootId = matchedRoot.id;
          runtime.organizeSubFolder = subFolder;
          this.store.updateStep(step.id, {
            state: 'completed',
            finishedAt: Date.now(),
            output: { matchCount: eligible.length, files: eligible.map((f) => f.name) }
          });
        } else if (kind === 'organize_mkdir') {
          if (!runtime.matches.length) {
            this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: { skipped: true, reason: 'No files to organize.' } });
          } else {
            const matchedRoot = this.files.config.roots.find((r) => r.id === runtime.organizeRootId);
            const targetDirPath = path.join(matchedRoot.path, runtime.organizeSubFolder);
            let existsAlready = false;
            try {
              const existing = await this.files.guard.inspect(targetDirPath, { directory: true });
              existsAlready = Boolean(existing?.path);
            } catch {}
            if (existsAlready) {
              runtime.createdDirectory = { status: 'already_exists', rootId: runtime.organizeRootId, directoryName: runtime.organizeSubFolder };
              this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: runtime.createdDirectory });
            } else {
              const mkdirArgs = { folder: runtime.organizeRootId, directoryName: runtime.organizeSubFolder };
              this.store.updateStep(step.id, { input: mkdirArgs });
              const res = await this.executeToolCall(session, {
                source: 'typed',
                text: task.prompt,
                toolName: 'create_directory',
                args: mkdirArgs,
                isCancelled,
                guard,
                ownerKey,
                taskId: task.id,
                stepId: step.id
              });
              if (res.error) throw new ToolError(res.error.code, res.error.message);
              if (res.status === 'confirmation_required') {
                const planPreview = `Organize ${runtime.matches.length} file(s) into ${runtime.organizeRootId}/${runtime.organizeSubFolder}:\n` +
                  runtime.matches.map((m, idx) => `${idx + 1}. ${m.name}`).join('\n');
                return this.#awaitStepApproval(session, ownerKey, task, step, i + 1, runtime, res, planPreview);
              }
              runtime.createdDirectory = res;
              this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: res });
            }
          }
        } else if (kind === 'organize_move') {
          const idx = runtime.organizeIndex || 0;
          if (!runtime.matches.length || idx >= runtime.matches.length) {
            this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: { movedCount: runtime.movedFiles.length, files: runtime.movedFiles } });
          } else {
            const item = runtime.matches[idx];
            const moveArgs = {
              resultId: item.resultId,
              targetFolder: runtime.organizeRootId,
              subFolder: runtime.organizeSubFolder
            };
            this.store.updateStep(step.id, { input: moveArgs });
            const res = await this.executeToolCall(session, {
              source: 'typed',
              text: task.prompt,
              toolName: 'move_file',
              args: moveArgs,
              isCancelled,
              guard,
              ownerKey,
              taskId: task.id,
              stepId: step.id
            });
            if (res.error) throw new ToolError(res.error.code, res.error.message);
            if (res.status === 'confirmation_required') {
              return this.#awaitStepApproval(session, ownerKey, task, step, i, runtime, res, res.preview);
            }
            runtime.movedFiles.push(res);
            runtime.organizeIndex = idx + 1;
            this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: { movedCount: runtime.movedFiles.length, files: runtime.movedFiles } });
          }
        } else if (kind === 'organize_verify') {
          if (runtime.matches.length && (!runtime.movedFiles.length || !runtime.movedFiles.every((m) => m.verified))) {
            throw new ToolError('OPERATION_FAILED', 'Organized file verification failed.');
          }
          this.store.updateStep(step.id, {
            state: 'completed',
            finishedAt: Date.now(),
            output: { verified: true, movedCount: runtime.movedFiles.length, destination: `${runtime.organizeRootId}/${runtime.organizeSubFolder}` }
          });
        } else if (kind === 'mutate_search') {
          if (this.hosted || !this.files?.config?.enabled) {
            throw new ToolError('FILES_DISABLED', 'Local file tools are disabled in this environment.');
          }
          const searchArgs = { query: runtime.parsedIntent.targetQuery, sortBy: 'modifiedDesc', limit: 10 };
          if (runtime.parsedIntent.folder) {
            const matchedRoot = this.files.config.roots.find((r) => r.id.toLowerCase() === runtime.parsedIntent.folder.toLowerCase());
            if (matchedRoot) searchArgs.folder = matchedRoot.id;
          }
          this.store.updateStep(step.id, { input: searchArgs });
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: 'search_files',
            args: searchArgs,
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          if (!res.results?.length) {
            throw new ToolError('NOT_FOUND', `Could not find "${runtime.parsedIntent.targetQuery}" in authorized folders.`);
          }
          runtime.matches = res.results;
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: { matchCount: res.results.length, topMatch: res.results[0].name } });
        } else if (kind === 'companion_mutate') {
          const item = runtime.matches[0];
          if (!item?.resultId) throw new ToolError('NOT_FOUND', 'Target file result missing.');
          const op = runtime.parsedIntent.mutation;
          let args;
          if (op === 'rename_file') args = { resultId: item.resultId, newName: runtime.parsedIntent.newName };
          else if (op === 'move_file' || op === 'copy_file') args = { resultId: item.resultId, targetFolder: runtime.parsedIntent.targetFolder };
          else args = { resultId: item.resultId };
          this.store.updateStep(step.id, { input: args });
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName: op,
            args,
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          if (res.status === 'confirmation_required') {
            return this.#awaitStepApproval(session, ownerKey, task, step, i + 1, runtime, res, res.preview);
          }
          runtime.mutationResult = res;
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: res });
        } else if (kind === 'knowledge_sync') {
          if (!this.knowledge) {
            throw new ToolError('OPERATION_FAILED', 'Private Knowledge service is unavailable.');
          }
          let synced = { syncedCount: 0, matchedDocumentIds: [] };
          if (!runtime.explicitDocumentIds?.length && !this.hosted && this.files?.config?.enabled) {
            const p = runtime.parsedIntent || {};
            let syncFolder = null;
            if (p.folder) {
              const matchedRoot = this.files.config.roots.find((r) => r.id.toLowerCase() === p.folder.toLowerCase());
              if (matchedRoot) syncFolder = matchedRoot.id;
            }
            synced = await this.knowledge.syncMatchingLocalFiles(session, ownerKey, {
              query: p.mentionQuery || p.subjectQuery || p.searchQuery || '',
              extensions: p.extensions || null,
              modifiedAfter: p.modifiedAfter || null,
              modifiedBefore: p.modifiedBefore || null,
              folder: syncFolder
            });
          }
          runtime.knowledgeSynced = synced;
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: synced });
        } else if (kind === 'knowledge_summarize' || kind === 'knowledge_compare' || kind === 'knowledge_extract_tables' || kind === 'knowledge_mention_search' || kind === 'knowledge_qa') {
          if (!this.knowledge) {
            throw new ToolError('OPERATION_FAILED', 'Private Knowledge service is unavailable.');
          }
          const p = runtime.parsedIntent || {};
          let scopedIds = runtime.explicitDocumentIds ? [...runtime.explicitDocumentIds] : null;
          if (!scopedIds) {
            const allDocs = await this.knowledge.listDocuments(ownerKey);
            const indexedDocs = allDocs.filter((d) => d.status === 'indexed');
            if (kind === 'knowledge_summarize') {
              let candidates = indexedDocs;
              if (p.extensions?.length) {
                const extSet = new Set(p.extensions.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`)));
                candidates = candidates.filter((d) => extSet.has(d.extension));
              }
              if (p.modifiedAfter) {
                const minMs = Date.parse(p.modifiedAfter);
                candidates = candidates.filter((d) => d.modifiedAt >= minMs);
              }
              if (p.modifiedBefore) {
                const maxMs = Date.parse(p.modifiedBefore);
                candidates = candidates.filter((d) => d.modifiedAt <= maxMs);
              }
              if (p.subjectQuery) {
                const sRes = this.knowledge.search(ownerKey, { query: p.subjectQuery, documentIds: candidates.map((d) => d.id), limit: 6 });
                const hitIds = [...new Set(sRes.results.map((r) => r.documentId))];
                if (hitIds.length) {
                  const orderMap = new Map(hitIds.map((id, idx) => [id, idx]));
                  candidates = candidates.filter((d) => orderMap.has(d.id)).sort((a, b) => p.latest ? b.modifiedAt - a.modifiedAt : orderMap.get(a.id) - orderMap.get(b.id));
                }
              } else {
                candidates = [...candidates].sort((a, b) => b.modifiedAt - a.modifiedAt);
              }
              scopedIds = (p.latest ? candidates.slice(0, 1) : candidates.slice(0, 5)).map((d) => d.id);
            } else if (kind === 'knowledge_compare') {
              const sRes = p.subjectQuery ? this.knowledge.search(ownerKey, { query: p.subjectQuery, limit: 12 }) : { results: [] };
              const hitIds = [...new Set(sRes.results.map((r) => r.documentId))];
              scopedIds = hitIds.length >= 2 ? hitIds.slice(0, 4) : indexedDocs.slice(0, 4).map((d) => d.id);
            } else if (kind === 'knowledge_extract_tables') {
              let candidates = indexedDocs.filter((d) => d.tableCount > 0);
              if (p.extensions?.length) {
                const extSet = new Set(p.extensions.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`)));
                candidates = candidates.filter((d) => extSet.has(d.extension));
              }
              scopedIds = candidates.slice(0, 5).map((d) => d.id);
            }
          }

          let toolName = 'knowledge_answer';
          let args = {};
          if (kind === 'knowledge_summarize') {
            toolName = 'knowledge_summarize';
            args = { prompt: p.subjectQuery || task.prompt, ...(scopedIds?.length ? { documentIds: scopedIds } : {}) };
          } else if (kind === 'knowledge_compare') {
            toolName = 'knowledge_compare';
            args = scopedIds?.length ? { documentIds: scopedIds } : {};
          } else if (kind === 'knowledge_extract_tables') {
            toolName = 'knowledge_extract_tables';
            args = scopedIds?.length ? { documentIds: scopedIds } : {};
          } else if (kind === 'knowledge_mention_search') {
            toolName = 'knowledge_search';
            args = { query: p.mentionQuery || task.prompt, limit: 10 };
          } else {
            toolName = 'knowledge_answer';
            args = {
              question: p.question || task.prompt,
              selectedOnly: Boolean(p.selectedOnly),
              ...(scopedIds?.length ? { documentIds: scopedIds } : {})
            };
          }

          this.store.updateStep(step.id, { input: args });
          const res = await this.executeToolCall(session, {
            source: 'typed',
            text: task.prompt,
            toolName,
            args,
            isCancelled,
            guard,
            ownerKey,
            taskId: task.id,
            stepId: step.id
          });
          if (res.error) throw new ToolError(res.error.code, res.error.message);
          runtime.knowledgeResult = res;

          let previewText = res.answer || '';
          if (kind === 'knowledge_mention_search') {
            const byDoc = new Map();
            for (const r of res.results || []) {
              if (!byDoc.has(r.documentId)) byDoc.set(r.documentId, r);
            }
            const uniqueDocs = [...byDoc.values()];
            previewText = uniqueDocs.length
              ? [
                  `# Documents matching "${p.mentionQuery}" (${uniqueDocs.length} file(s))`,
                  '',
                  ...uniqueDocs.map((d, idx) => `${idx + 1}. **${d.fileName}** (${d.section}): ${d.snippet.slice(0, 180)}`)
                ].join('\n')
              : `No indexed documents matched "${p.mentionQuery}".`;
          }
          this.store.updateTask(ownerKey, task.id, { preview: previewText });
          this.store.updateStep(step.id, { state: 'completed', finishedAt: Date.now(), output: res });
        } else {
          this.store.updateStep(step.id, {
            state: 'completed',
            finishedAt: Date.now(),
            output: { note: 'Processed request in Agent Core.' }
          });
        }

        task = this.store.getTask(ownerKey, task.id);
      }

      const summary = this.#buildCompletionSummary(runtime, task);
      const compactResult = {
        ...runtime,
        readItems: runtime.readItems.map((d) => ({ name: d.name, charCount: d.charCount, truncated: d.truncated })),
        matches: runtime.matches.map((m) => ({ name: m.name, rootId: m.rootId, size: m.size, modifiedAt: m.modifiedAt }))
      };
      task = this.#transition(ownerKey, task, TASK_STATES.COMPLETED, {
        summary,
        result: compactResult,
        completedAt: Date.now()
      });
      this.publish(session, 'agentTask', task);
      this.controllers.delete(task.id);
      return task;
    } catch (error) {
      const code = error.code || 'OPERATION_FAILED';
      const message = error.message || 'Task execution failed.';
      const refreshed = this.store.getTask(ownerKey, task.id) || task;
      const runningStep = refreshed.steps.find((s) => s.state === 'running' || s.state === 'awaiting_approval');
      if (runningStep) {
        this.store.updateStep(runningStep.id, {
          state: 'failed',
          errorCode: code,
          errorMessage: message,
          finishedAt: Date.now()
        });
      }
      task = this.#transition(ownerKey, refreshed, TASK_STATES.FAILED, {
        errorCode: code,
        errorMessage: message,
        summary: message,
        completedAt: Date.now()
      });
      this.publish(session, 'agentTask', task);
      this.controllers.delete(task.id);
      return task;
    }
  }

  #awaitStepApproval(session, ownerKey, task, step, nextStepIndex, runtime, confirmationRes, previewText) {
    runtime.nextStepIndex = nextStepIndex;
    runtime.pendingApprovalId = confirmationRes.approvalId;
    this.store.updateStep(step.id, { state: 'awaiting_approval' });
    const updated = this.#transition(ownerKey, task, TASK_STATES.AWAITING_APPROVAL, {
      preview: previewText || task.preview || confirmationRes.preview,
      result: {
        ...runtime,
        readItems: runtime.readItems.map((d) => ({ name: d.name, charCount: d.charCount, truncated: d.truncated }))
      },
      summary: confirmationRes.preview
    });
    this.publish(session, 'agentTask', updated);
    return updated;
  }

  #buildCompletionSummary(runtime, task) {
    if (runtime.savedReport?.status === 'saved') {
      return `Found ${runtime.matches.length} matching file(s), read ${runtime.readItems.length} local text file(s), and verified saved report "${runtime.savedReport.fileName}" in ${runtime.savedReport.rootId} (${runtime.savedReport.sizeBytes} bytes).`;
    }
    if (runtime.launchedApp?.status === 'launched') {
      return `Launched approved application "${runtime.launchedApp.displayName}".`;
    }
    if (runtime.parsedIntent?.intent === 'companion_organize_files') {
      if (!runtime.matches.length) {
        return `No matching files needed organizing in ${runtime.parsedIntent.folder || 'authorized folders'}.`;
      }
      return `Organized ${runtime.movedFiles.length} file(s) into ${runtime.organizeRootId}/${runtime.organizeSubFolder} with reversible undo support.`;
    }
    if (runtime.mutationResult) {
      if (runtime.mutationResult.status === 'renamed') return `Renamed "${runtime.mutationResult.oldName}" to "${runtime.mutationResult.newName}" (Action ID: ${runtime.mutationResult.actionId}).`;
      if (runtime.mutationResult.status === 'moved') return `Moved "${runtime.mutationResult.fileName}" to ${runtime.mutationResult.targetRootId} (Action ID: ${runtime.mutationResult.actionId}).`;
      if (runtime.mutationResult.status === 'copied') return `Copied "${runtime.mutationResult.fileName}" to ${runtime.mutationResult.targetRootId} (Action ID: ${runtime.mutationResult.actionId}).`;
      if (runtime.mutationResult.status === 'recycled') return runtime.mutationResult.message;
    }
    if (runtime.duplicatesResult) {
      return `Found ${runtime.duplicatesResult.groupCount} duplicate group(s) (${runtime.duplicatesResult.duplicateFileCount} files, ${runtime.duplicatesResult.totalWastedBytes} reclaimable bytes). No files were deleted.`;
    }
    if (runtime.largeFilesResult) {
      return `Found ${runtime.largeFilesResult.files.length} large file(s) across ${runtime.largeFilesResult.totalScanned} scanned files.`;
    }
    if (runtime.processesResult) {
      const top = runtime.processesResult.processes.slice(0, 3).map((p) => `${p.name} (${p.memoryMb} MB)`).join(', ');
      return `Top running processes (${runtime.processesResult.sortBy}): ${top || 'none'}.`;
    }
    if (runtime.metricsResult) {
      if (runtime.parsedIntent?.drive) {
        const d = runtime.metricsResult.drives[0];
        return d
          ? `Drive ${d.drive} (${d.label}) has ${d.freeGb} GB free out of ${d.totalGb} GB (${d.usedPercent}% used).`
          : `Drive ${runtime.parsedIntent.drive}: was not reported on this computer.`;
      }
      return `PC telemetry: CPU ${runtime.metricsResult.cpu.cpuPercent}%, RAM ${runtime.metricsResult.memory.usedGb}/${runtime.metricsResult.memory.totalGb} GB (${runtime.metricsResult.memory.usedPercent}%), ${runtime.metricsResult.drives.length} drive(s).`;
    }
    if (runtime.appsResult) {
      return `Approved applications checked (${runtime.appsResult.apps.filter((a) => a.installed).length} installed).`;
    }
    if (runtime.knowledgeResult) {
      const kr = runtime.knowledgeResult;
      if (kr.results) {
        const docs = [...new Set(kr.results.map((r) => r.fileName))];
        return docs.length
          ? `Found ${docs.length} document(s) mentioning "${runtime.parsedIntent?.mentionQuery}": ${docs.slice(0, 5).join(', ')}.`
          : `No documents found mentioning "${runtime.parsedIntent?.mentionQuery}".`;
      }
      const firstLine = String(kr.answer || '').split('\n').find((l) => l.trim().length > 0 && !l.startsWith('#')) || '';
      return firstLine.replace(/\*\*/g, '').slice(0, 220) || 'Private Knowledge analysis completed locally.';
    }
    if (runtime.parsedIntent?.intent === 'file_report') {
      return `Found ${runtime.matches.length} matching file(s) and generated summary preview from ${runtime.readItems.length} local text file(s).`;
    }
    if (runtime.parsedIntent?.intent === 'file_search') {
      return runtime.matches.length
        ? `Found ${runtime.matches.length} matching file(s): ${runtime.matches.slice(0, 5).map((m) => m.name).join(', ')}.`
        : 'No matching authorized files were found.';
    }
    if (runtime.fileActionResult) {
      return runtime.fileActionResult.message || 'File action handled.';
    }
    if (runtime.indexResult) {
      return `Index status: ${runtime.indexResult.status || 'ok'} (${runtime.indexResult.count ?? 0} indexed).`;
    }
    if (runtime.drivesResult) {
      return `Discovered ${runtime.drivesResult.drives?.length || 0} fixed drive(s).`;
    }
    if (runtime.businessSummary?.company) {
      return `${runtime.businessSummary.company} (${runtime.businessSummary.address}) offers ${runtime.businessSummary.services.length} service(s) and has ${runtime.businessSummary.bookingsCount} confirmed booking(s).`;
    }
    return `Task "${task.prompt}" completed.`;
  }

  async approve(session, ownerKey, approvalId) {
    this.store.expireStaleApprovals();
    const approval = this.store.getApproval(ownerKey, approvalId);
    if (!approval) {
      throw new ToolError('CONFIRMATION_MISMATCH', 'Approval request not found for this account.');
    }
    if (approval.state !== 'pending') {
      throw new ToolError('CONFIRMATION_REJECTED', `This approval request is already ${approval.state}.`);
    }
    if (approval.expiresAt <= Date.now()) {
      this.store.expireStaleApprovals();
      throw new ToolError('CONFIRMATION_EXPIRED', 'This approval request expired. Run or resume the task for a fresh preview.');
    }
    const pending = this.pendingConfirmations.get(approvalId);
    if (!pending || pending.ownerKey !== ownerKey || pending.sessionId !== session.id) {
      throw new ToolError('CONFIRMATION_MISMATCH', 'That approval does not belong to this active session.');
    }
    this.pendingConfirmations.delete(approvalId);

    const permissions = [
      ...(toolSecurity[pending.toolName]?.requiredPermissions || []),
      'cloud.metadata',
      'confirmation.create',
      'confirmation.approve'
    ];
    const auth = this.authority.issue(session, {
      source: 'typed',
      text: `Approved ${pending.toolName}`,
      permissions
    });

    const result = await this.registry.call(pending.toolName, pending.operation.parameters, {
      session,
      source: 'ui',
      files: this.files,
      companion: this.companion,
      knowledge: this.knowledge,
      ownerKey,
      authorization: auth,
      confirmation: {
        operationId: pending.operationId,
        token: pending.token,
        requestId: pending.requestId
      },
      publish: (type, data) => this.publish(session, type, data)
    });

    if (result.error) {
      const updatedApproval = this.store.updateApproval(ownerKey, approvalId, { state: 'rejected', resolvedAt: Date.now() });
      this.publish(session, 'agentApproval', updatedApproval);
      if (pending.taskId) {
        if (pending.stepId) {
          this.store.updateStep(pending.stepId, {
            state: 'failed',
            errorCode: result.error.code,
            errorMessage: result.error.message,
            finishedAt: Date.now()
          });
        }
        const t = this.store.getTask(ownerKey, pending.taskId);
        if (t && ['awaiting_approval', 'running'].includes(t.state)) {
          const failedTask = this.#transition(ownerKey, t, TASK_STATES.FAILED, {
            errorCode: result.error.code,
            errorMessage: result.error.message,
            summary: result.error.message,
            completedAt: Date.now()
          });
          this.publish(session, 'agentTask', failedTask);
        }
      }
      throw new ToolError(result.error.code, result.error.message);
    }

    const updatedApproval = this.store.updateApproval(ownerKey, approvalId, {
      state: 'approved',
      resolvedAt: Date.now()
    });
    this.publish(session, 'agentApproval', updatedApproval);

    let updatedTask = null;
    if (pending.taskId) {
      const t = this.store.getTask(ownerKey, pending.taskId);
      if (t) {
        const runtime = { ...(t.result || {}) };
        let nextIndex = Number.isInteger(runtime.nextStepIndex) ? runtime.nextStepIndex : t.steps.length;
        let stepCompleted = true;

        if (pending.toolName === 'save_report') {
          runtime.savedReport = result;
        } else if (pending.toolName === 'launch_approved_app') {
          runtime.launchedApp = result;
        } else if (pending.toolName === 'create_directory') {
          runtime.createdDirectory = result;
        } else if (pending.toolName === 'move_file' && t.intent === 'companion_organize_files') {
          runtime.movedFiles = [...(runtime.movedFiles || []), result];
          runtime.organizeIndex = (runtime.organizeIndex || 0) + 1;
          if (runtime.organizeIndex < (runtime.matches || []).length) {
            stepCompleted = false;
            nextIndex = t.steps.findIndex((s) => s.id === pending.stepId);
          } else {
            nextIndex = t.steps.findIndex((s) => s.id === pending.stepId) + 1;
          }
        } else if (['rename_file', 'move_file', 'copy_file', 'recycle_file', 'undo_file_action'].includes(pending.toolName)) {
          runtime.mutationResult = result;
        }

        if (pending.stepId) {
          this.store.updateStep(pending.stepId, stepCompleted
            ? {
                state: 'completed',
                finishedAt: Date.now(),
                output: pending.toolName === 'move_file' && t.intent === 'companion_organize_files'
                  ? { movedCount: runtime.movedFiles.length, files: runtime.movedFiles }
                  : result
              }
            : { state: 'running' }
          );
        }
        const resumed = this.#transition(ownerKey, this.store.getTask(ownerKey, t.id), TASK_STATES.RUNNING, { result: runtime });
        updatedTask = await this.#executeFromStep(session, ownerKey, resumed, nextIndex, runtime);
      }
    }

    return { approval: updatedApproval, result, task: updatedTask };
  }

  async reject(session, ownerKey, approvalId, reason = 'Rejected by user.') {
    this.store.expireStaleApprovals();
    const approval = this.store.getApproval(ownerKey, approvalId);
    if (!approval) {
      throw new ToolError('CONFIRMATION_MISMATCH', 'Approval request not found for this account.');
    }
    if (approval.state !== 'pending') {
      throw new ToolError('CONFIRMATION_REJECTED', `This approval request is already ${approval.state}.`);
    }
    this.pendingConfirmations.delete(approvalId);
    const updatedApproval = this.store.updateApproval(ownerKey, approvalId, {
      state: 'rejected',
      resolvedAt: Date.now()
    });
    try {
      await this.auditEvent({
        event: 'CONFIRMATION_REJECTED',
        sessionId: session?.id,
        tool: approval.toolName,
        confirmationReference: approval.operationId,
        policyDecision: 'DENY',
        outcome: 'rejected'
      });
    } catch {}
    this.publish(session, 'agentApproval', updatedApproval);

    let updatedTask = null;
    if (approval.taskId) {
      const t = this.store.getTask(ownerKey, approval.taskId);
      if (t) {
        for (const step of t.steps) {
          if (['awaiting_approval', 'pending', 'running'].includes(step.state)) {
            this.store.updateStep(step.id, {
              state: 'cancelled',
              errorCode: 'CONFIRMATION_REJECTED',
              errorMessage: reason,
              finishedAt: Date.now()
            });
          }
        }
        if (['awaiting_approval', 'running', 'paused'].includes(t.state)) {
          updatedTask = this.#transition(ownerKey, t, TASK_STATES.CANCELLED, {
            errorCode: 'CONFIRMATION_REJECTED',
            errorMessage: reason,
            summary: `Cancelled: ${reason}`,
            completedAt: Date.now()
          });
          this.publish(session, 'agentTask', updatedTask);
        }
      }
    }
    return { approval: updatedApproval, task: updatedTask };
  }

  pause(session, ownerKey, taskId) {
    const task = this.store.getTask(ownerKey, taskId);
    if (!task) throw new ToolError('NOT_FOUND', 'Task not found.');
    const ctrl = this.controllers.get(taskId);
    if (ctrl && task.state === TASK_STATES.RUNNING) {
      ctrl.pauseRequested = true;
      return task;
    }
    if (![TASK_STATES.PLANNING, TASK_STATES.RUNNING, TASK_STATES.AWAITING_APPROVAL].includes(task.state)) {
      throw new ToolError('INVALID_STATE_TRANSITION', `Cannot pause task in "${task.state}" state.`);
    }
    const paused = this.#transition(ownerKey, task, TASK_STATES.PAUSED, {
      summary: 'Task paused by user.'
    });
    this.publish(session, 'agentTask', paused);
    return paused;
  }

  async resume(session, ownerKey, taskId, context = {}) {
    const task = this.store.getTask(ownerKey, taskId);
    if (!task) throw new ToolError('NOT_FOUND', 'Task not found.');
    if (task.state !== TASK_STATES.PAUSED) {
      throw new ToolError('INVALID_STATE_TRANSITION', `Only paused tasks can be resumed (current state: "${task.state}").`);
    }
    const runtime = { ...(task.result || {}) };
    const nextStepIndex = task.steps.findIndex((s) => ['pending', 'awaiting_approval', 'running'].includes(s.state));
    if (nextStepIndex === -1) {
      const completed = this.#transition(ownerKey, task, TASK_STATES.COMPLETED, { completedAt: Date.now() });
      this.publish(session, 'agentTask', completed);
      return completed;
    }
    const running = this.#transition(ownerKey, task, TASK_STATES.RUNNING);
    this.publish(session, 'agentTask', running);
    return this.#executeFromStep(session, ownerKey, running, nextStepIndex, runtime, context);
  }

  cancel(session, ownerKey, taskId) {
    const task = this.store.getTask(ownerKey, taskId);
    if (!task) throw new ToolError('NOT_FOUND', 'Task not found.');
    if ([TASK_STATES.COMPLETED, TASK_STATES.FAILED, TASK_STATES.CANCELLED].includes(task.state)) {
      throw new ToolError('INVALID_STATE_TRANSITION', `Task is already "${task.state}".`);
    }
    const ctrl = this.controllers.get(taskId);
    if (ctrl) ctrl.cancelRequested = true;
    for (const [id, pending] of this.pendingConfirmations.entries()) {
      if (pending.taskId === taskId && pending.ownerKey === ownerKey) {
        this.pendingConfirmations.delete(id);
        const app = this.store.updateApproval(ownerKey, id, { state: 'rejected', resolvedAt: Date.now() });
        if (app) this.publish(session, 'agentApproval', app);
      }
    }
    for (const step of task.steps) {
      if (['pending', 'running', 'awaiting_approval'].includes(step.state)) {
        this.store.updateStep(step.id, { state: 'cancelled', finishedAt: Date.now() });
      }
    }
    const cancelled = this.#transition(ownerKey, task, TASK_STATES.CANCELLED, {
      summary: 'Task cancelled by user.',
      completedAt: Date.now()
    });
    this.controllers.delete(taskId);
    this.publish(session, 'agentTask', cancelled);
    return cancelled;
  }

  invalidateSession(session) {
    if (!session) return;
    const now = Date.now();
    for (const [id, pending] of this.pendingConfirmations.entries()) {
      if (pending.sessionId === session.id) {
        this.pendingConfirmations.delete(id);
        this.store.updateApproval(pending.ownerKey, id, { state: 'expired', resolvedAt: now });
      }
    }
  }

  emergencyCancelOwner(session, ownerKey) {
    if (!ownerKey) return { cancelledTasks: 0, cancelledApprovals: 0 };
    const now = Date.now();
    let cancelledApprovals = 0;
    let cancelledTasks = 0;

    for (const [id, pending] of this.pendingConfirmations.entries()) {
      if (pending.ownerKey === ownerKey) {
        this.pendingConfirmations.delete(id);
        const updated = this.store.updateApproval(ownerKey, id, { state: 'rejected', resolvedAt: now });
        if (updated && session) this.publish(session, 'agentApproval', updated);
        cancelledApprovals += 1;
      }
    }

    for (const approval of this.store.listApprovals(ownerKey, 50)) {
      if (approval.state === 'pending') {
        const updated = this.store.updateApproval(ownerKey, approval.id, { state: 'rejected', resolvedAt: now });
        if (updated && session) this.publish(session, 'agentApproval', updated);
        cancelledApprovals += 1;
      }
    }

    for (const task of this.store.listTasks(ownerKey, 50)) {
      if (['created', 'planning', 'running', 'paused', 'awaiting_approval'].includes(task.state)) {
        const ctrl = this.controllers.get(task.id);
        if (ctrl) ctrl.cancelRequested = true;
        for (const step of task.steps) {
          if (['pending', 'running', 'awaiting_approval'].includes(step.state)) {
            this.store.updateStep(step.id, {
              state: 'cancelled',
              errorCode: 'EMERGENCY_STOP',
              errorMessage: 'Cancelled by Emergency Stop.',
              finishedAt: now
            });
          }
        }
        const cancelled = this.#transition(ownerKey, task, TASK_STATES.CANCELLED, {
          errorCode: 'EMERGENCY_STOP',
          errorMessage: 'Emergency Stop activated.',
          summary: 'Cancelled immediately by Emergency Stop.',
          completedAt: now
        });
        this.controllers.delete(task.id);
        if (session) this.publish(session, 'agentTask', cancelled);
        cancelledTasks += 1;
      }
    }

    return { cancelledTasks, cancelledApprovals };
  }

  close() {
    this.pendingConfirmations.clear();
    this.controllers.clear();
    this.store.close();
  }
}
