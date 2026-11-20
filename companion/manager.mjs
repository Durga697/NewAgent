import { fork } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ToolError } from '../tools/errors.mjs';

const DEFAULT_SCOPES = Object.freeze({
  telemetry: true,
  apps: true,
  fileAnalysis: true,
  fileMutations: true
});

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export class CompanionManager {
  constructor({
    store,
    config,
    files,
    auditEvent = async () => {},
    publish = () => {},
    hosted = false,
    configPath = null,
    testRecycleDir = null
  }) {
    this.store = store;
    this.config = config;
    this.files = files;
    this.auditEvent = auditEvent;
    this.publish = publish;
    this.hosted = hosted;
    this.configPath = configPath || process.env.EDITH_COMPANION_CONFIG || null;
    this.testRecycleDir = testRecycleDir || process.env.EDITH_COMPANION_TEST_RECYCLE_DIR || null;

    this.daemonSecret = randomBytes(32).toString('hex');
    this.daemonChild = null;
    this.daemonStartPromise = null;
    this.daemonInfo = null; // { port, pid, hostname, platform }
    this.challenges = new Map(); // challengeId -> { challengeId, ownerKey, sessionId, pairingCode, expiresAt, attempts }
    this.activePairings = new Map(); // ownerKey -> { deviceId, deviceName, hostname, platform, capabilityToken, scopes, disabledApps }
    this.orchestratorRef = null;
    this.closed = false;
  }

  bindOrchestrator(orchestrator) {
    this.orchestratorRef = orchestrator;
  }

  daemonPort() {
    return this.daemonInfo?.port || null;
  }

  isPairedFor(ownerKey) {
    return !this.hosted && Boolean(this.config?.enabled) && Boolean(ownerKey && this.activePairings.has(ownerKey));
  }

  requireEnabled() {
    if (this.hosted) {
      throw new ToolError('COMPANION_DISABLED', 'Local Windows companion is disabled in hosted deployments.');
    }
    if (!this.config?.enabled) {
      throw new ToolError('COMPANION_DISABLED', 'Windows companion features are disabled in config/companion.jsonc.');
    }
  }

  requirePaired(ownerKey, requiredScope = null) {
    this.requireEnabled();
    const pairing = ownerKey ? this.activePairings.get(ownerKey) : null;
    if (!pairing || !this.daemonInfo) {
      throw new ToolError(
        'COMPANION_NOT_PAIRED',
        'Pair your Windows computer on the Devices page (/app/devices) before running local PC tools.'
      );
    }
    if (requiredScope && !pairing.scopes?.[requiredScope]) {
      throw new ToolError(
        'CAPABILITY_DENIED',
        `The "${requiredScope}" companion permission is turned off. Re-enable it in Devices (/app/devices).`
      );
    }
    return pairing;
  }

  summary(ownerKey) {
    if (this.hosted) {
      return { hosted: true, enabled: false, paired: false, securityState: 'hosted_disabled', deviceName: null };
    }
    const active = this.activePairings.get(ownerKey);
    const history = ownerKey ? this.store.listCompanionDevices(ownerKey, 1) : [];
    const lastState = history[0]?.state || 'unpaired';
    return {
      hosted: false,
      enabled: Boolean(this.config?.enabled),
      paired: Boolean(active && this.daemonInfo),
      securityState: active && this.daemonInfo ? 'paired_local_hmac' : lastState === 'revoked' ? 'revoked' : 'unpaired',
      deviceName: active?.deviceName || null
    };
  }

  async status(ownerKey) {
    if (this.hosted) {
      return {
        hosted: true,
        enabled: false,
        paired: false,
        securityState: 'hosted_disabled',
        device: null,
        daemon: { running: false, transport: 'disabled', pid: null },
        permissions: { telemetry: false, apps: false, fileAnalysis: false, fileMutations: false },
        disabledApps: [],
        approvedApps: [],
        recentActions: [],
        connectionHistory: [],
        reversibleActions: []
      };
    }

    const active = ownerKey ? this.activePairings.get(ownerKey) : null;
    const isPaired = Boolean(active && this.daemonInfo);
    const history = ownerKey ? this.store.listCompanionDevices(ownerKey, 15) : [];
    const recentActions = ownerKey ? this.store.listCompanionEvents(ownerKey, 25) : [];
    const reversibleRaw = ownerKey ? this.store.listReversibleActions(ownerKey, 20) : [];
    const reversibleActions = reversibleRaw.map((a) => ({
      id: a.id,
      actionType: a.actionType,
      status: a.status,
      undoAvailable: Boolean(a.undoAvailable),
      summary: a.summary,
      createdAt: a.createdAt,
      undoneAt: a.undoneAt
    }));

    let approvedApps = [];
    if (isPaired) {
      try {
        const res = await this.#ipcRequest('/rpc', {
          method: 'POST',
          body: { ownerKey, action: 'list_installed_apps', args: {} },
          capabilityToken: active.capabilityToken
        });
        approvedApps = res.apps || [];
      } catch {
        approvedApps = (this.config?.approvedApps || []).map((a) => ({
          appId: a.appId,
          displayName: a.displayName,
          category: a.category,
          installed: false,
          enabled: a.enabled !== false && !(active.disabledApps || []).includes(a.appId)
        }));
      }
    } else {
      approvedApps = (this.config?.approvedApps || []).map((a) => ({
        appId: a.appId,
        displayName: a.displayName,
        category: a.category,
        installed: false,
        enabled: a.enabled !== false
      }));
    }

    const lastState = history[0]?.state || 'unpaired';
    return {
      hosted: false,
      enabled: Boolean(this.config?.enabled),
      paired: isPaired,
      securityState: isPaired ? 'paired_local_hmac' : lastState === 'revoked' ? 'revoked' : 'unpaired',
      device: isPaired
        ? {
            id: active.deviceId,
            deviceName: active.deviceName,
            hostname: active.hostname,
            platform: active.platform
          }
        : null,
      daemon: {
        running: Boolean(this.daemonInfo),
        transport: '127.0.0.1-hmac',
        pid: this.daemonInfo?.pid || null
      },
      permissions: isPaired ? { ...active.scopes } : { ...DEFAULT_SCOPES },
      disabledApps: isPaired ? [...(active.disabledApps || [])] : [],
      approvedApps,
      recentActions,
      connectionHistory: history.map((d) => ({
        id: d.id,
        deviceName: d.deviceName,
        hostname: d.hostname,
        platform: d.platform,
        state: d.state,
        pairedAt: d.pairedAt,
        lastSeenAt: d.lastSeenAt,
        disconnectedAt: d.disconnectedAt
      })),
      reversibleActions
    };
  }

  async #ensureDaemon() {
    this.requireEnabled();
    if (this.closed) {
      throw new ToolError('COMPANION_UNAVAILABLE', 'Companion manager is closed.');
    }
    if (this.daemonInfo && this.daemonChild && this.daemonChild.exitCode === null) {
      return this.daemonInfo;
    }
    if (this.daemonStartPromise) {
      return this.daemonStartPromise;
    }

    this.daemonStartPromise = (async () => {
      const daemonUrl = new URL('./daemon.mjs', import.meta.url);
      const childEnv = {
        ...process.env,
        EDITH_COMPANION_SECRET: this.daemonSecret
      };
      if (this.configPath) childEnv.EDITH_COMPANION_CONFIG = this.configPath;
      if (this.testRecycleDir) childEnv.EDITH_COMPANION_TEST_RECYCLE_DIR = this.testRecycleDir;

      const child = fork(daemonUrl, [], {
        env: childEnv,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      });
      this.daemonChild = child;

      let stderrBuf = '';
      child.stderr?.on('data', (chunk) => {
        stderrBuf = (stderrBuf + chunk.toString()).slice(-2000);
      });

      const info = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new ToolError('COMPANION_UNAVAILABLE', 'Local Windows companion process timed out starting.'));
        }, 8000);

        child.on('message', (msg) => {
          if (msg?.type === 'ready' && msg.port) {
            clearTimeout(timer);
            resolve({ port: msg.port, pid: msg.pid, hostname: msg.hostname, platform: msg.platform });
          }
        });

        child.once('error', (err) => {
          clearTimeout(timer);
          reject(new ToolError('COMPANION_UNAVAILABLE', `Failed to start companion process: ${err.message}`));
        });

        child.once('exit', (code) => {
          if (this.daemonChild === child) {
            this.daemonChild = null;
            this.daemonInfo = null;
            this.activePairings.clear();
          }
          clearTimeout(timer);
          reject(
            new ToolError(
              'COMPANION_UNAVAILABLE',
              `Companion process exited unexpectedly (${code}): ${stderrBuf || 'no stderr'}`
            )
          );
        });
      });

      child.on('exit', () => {
        if (this.daemonChild === child) {
          this.daemonChild = null;
          this.daemonInfo = null;
          this.activePairings.clear();
        }
      });

      this.daemonInfo = info;
      return info;
    })().finally(() => {
      this.daemonStartPromise = null;
    });

    return this.daemonStartPromise;
  }

  async #stopDaemon() {
    const child = this.daemonChild;
    this.daemonChild = null;
    this.daemonInfo = null;
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      const killer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve();
      }, 1500);
      child.once('exit', () => {
        clearTimeout(killer);
        resolve();
      });
      try {
        child.disconnect();
      } catch {}
      try {
        child.kill('SIGTERM');
      } catch {}
    });
  }

  async #ipcRequest(urlPath, { method = 'POST', body = null, capabilityToken = null } = {}) {
    if (!this.daemonInfo?.port) {
      throw new ToolError('COMPANION_UNAVAILABLE', 'Local Windows companion process is not running.');
    }
    const rawBody = body === null ? '' : JSON.stringify(body);
    const ts = String(Date.now());
    const nonce = randomBytes(16).toString('hex');
    const sig = createHmac('sha256', this.daemonSecret)
      .update(`${ts}\0${nonce}\0${method}\0${urlPath}\0${rawBody}`)
      .digest('hex');

    const headers = {
      'Content-Type': 'application/json',
      'X-Edith-Companion-Timestamp': ts,
      'X-Edith-Companion-Nonce': nonce,
      'X-Edith-Companion-Sig': sig
    };
    if (capabilityToken) {
      headers['X-Edith-Capability-Token'] = capabilityToken;
    }

    const res = await fetch(`http://127.0.0.1:${this.daemonInfo.port}${urlPath}`, {
      method,
      headers,
      body: method === 'GET' ? undefined : rawBody
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ToolError(payload.error?.code || 'COMPANION_UNAVAILABLE', payload.error?.message || 'Companion IPC request failed.');
    }
    return payload;
  }

  async startPairing(session, ownerKey) {
    this.requireEnabled();
    if (!session?.id || !ownerKey) {
      throw new ToolError('AUTH_DENIED', 'Authenticated session required to pair this computer.');
    }
    const info = await this.#ensureDaemon();
    const challengeId = randomUUID();
    const pairingCode = randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
    const expiresAt = Date.now() + 120000;
    this.challenges.set(challengeId, {
      challengeId,
      ownerKey,
      sessionId: session.id,
      pairingCode,
      expiresAt,
      attempts: 0
    });
    // Prune stale challenges cleanly
    const now = Date.now();
    for (const [id, ch] of this.challenges.entries()) {
      if (ch.expiresAt <= now) this.challenges.delete(id);
    }

    return {
      challengeId,
      pairingCode,
      expiresAt,
      hostname: info.hostname,
      platform: info.platform,
      suggestedDeviceName: this.config.deviceName || `${info.hostname} (Windows PC)`
    };
  }

  async completePairing(session, ownerKey, { challengeId, pairingCode, deviceName } = {}) {
    this.requireEnabled();
    if (!session?.id || !ownerKey) {
      throw new ToolError('AUTH_DENIED', 'Authenticated session required to complete pairing.');
    }
    const challenge = challengeId ? this.challenges.get(challengeId) : null;
    if (!challenge || challenge.ownerKey !== ownerKey || challenge.sessionId !== session.id) {
      throw new ToolError('PAIRING_INVALID', 'Pairing challenge was not found for this session. Start pairing again.');
    }
    if (challenge.expiresAt <= Date.now()) {
      this.challenges.delete(challengeId);
      throw new ToolError('PAIRING_EXPIRED', 'Pairing code expired. Start pairing again.');
    }

    const supplied = String(pairingCode || '').trim().toUpperCase();
    const expected = challenge.pairingCode;
    const matched =
      supplied.length === expected.length &&
      timingSafeEqual(Buffer.from(supplied, 'utf8'), Buffer.from(expected, 'utf8'));

    if (!matched) {
      challenge.attempts += 1;
      if (challenge.attempts >= 3) this.challenges.delete(challengeId);
      throw new ToolError('PAIRING_INVALID', 'Pairing code did not match.');
    }
    this.challenges.delete(challengeId);

    const info = await this.#ensureDaemon();
    const deviceId = randomUUID();
    const cleanName =
      typeof deviceName === 'string' && deviceName.trim()
        ? deviceName.trim().slice(0, 80)
        : this.config.deviceName || `${info.hostname} (Windows PC)`;
    const capabilityToken = randomBytes(32).toString('hex');
    const capabilityTokenHash = sha256Hex(capabilityToken);
    const scopes = { ...DEFAULT_SCOPES };
    const disabledApps = [];

    await this.#ipcRequest('/pair', {
      method: 'POST',
      body: { deviceId, ownerKey, capabilityTokenHash, scopes, disabledApps }
    });

    const now = Date.now();
    // Mark any prior paired DB row for this owner disconnected
    for (const prev of this.store.listCompanionDevices(ownerKey, 10)) {
      if (prev.state === 'paired') {
        this.store.updateCompanionDevice(ownerKey, prev.id, { state: 'disconnected', disconnectedAt: now });
      }
    }

    this.activePairings.set(ownerKey, {
      deviceId,
      deviceName: cleanName,
      hostname: info.hostname,
      platform: info.platform,
      capabilityToken,
      scopes,
      disabledApps
    });

    this.store.upsertCompanionDevice({
      id: deviceId,
      ownerKey,
      deviceName: cleanName,
      hostname: info.hostname,
      platform: info.platform,
      state: 'paired',
      permissions: scopes,
      disabledApps,
      pairedAt: now,
      lastSeenAt: now,
      disconnectedAt: null
    });

    this.recordAction(ownerKey, {
      deviceId,
      eventType: 'device_paired',
      toolName: 'companion_pair',
      summary: `Paired local device "${cleanName}" (${info.platform}) over authenticated loopback IPC.`,
      status: 'ok'
    });

    try {
      await this.auditEvent({
        event: 'OPERATION_SUCCEEDED',
        tool: 'companion_pair',
        sessionId: session.id,
        policyDecision: 'ALLOW',
        outcome: 'paired'
      });
    } catch {}

    const statusPayload = await this.status(ownerKey);
    this.publish(session, 'companionStatus', statusPayload);
    return statusPayload;
  }

  async updatePermissions(session, ownerKey, { scopes, disabledApps } = {}) {
    const pairing = this.requirePaired(ownerKey);
    const allowedScopeKeys = ['telemetry', 'apps', 'fileAnalysis', 'fileMutations'];
    const nextScopes = { ...pairing.scopes };
    if (scopes && typeof scopes === 'object') {
      for (const key of allowedScopeKeys) {
        if (key in scopes) {
          if (typeof scopes[key] !== 'boolean') {
            throw new ToolError('INVALID_ARGUMENTS', `Permission "${key}" must be true or false.`);
          }
          nextScopes[key] = scopes[key];
        }
      }
    }

    let nextDisabled = pairing.disabledApps || [];
    if (disabledApps !== undefined) {
      if (!Array.isArray(disabledApps)) {
        throw new ToolError('INVALID_ARGUMENTS', 'disabledApps must be an array of approved application IDs.');
      }
      const validIds = new Set((this.config.approvedApps || []).map((a) => a.appId));
      nextDisabled = [...new Set(disabledApps.map((x) => String(x)).filter((id) => validIds.has(id)))];
    }

    await this.#ipcRequest('/permissions', {
      method: 'POST',
      body: { ownerKey, deviceId: pairing.deviceId, scopes: nextScopes, disabledApps: nextDisabled }
    });

    pairing.scopes = nextScopes;
    pairing.disabledApps = nextDisabled;
    const now = Date.now();
    this.store.updateCompanionDevice(ownerKey, pairing.deviceId, {
      permissions: nextScopes,
      disabledApps: nextDisabled,
      lastSeenAt: now
    });

    this.recordAction(ownerKey, {
      deviceId: pairing.deviceId,
      eventType: 'permissions_updated',
      toolName: 'companion_permissions',
      summary: `Updated device permissions (telemetry=${nextScopes.telemetry}, apps=${nextScopes.apps}, analysis=${nextScopes.fileAnalysis}, mutations=${nextScopes.fileMutations}).`,
      status: 'ok'
    });

    try {
      await this.auditEvent({
        event: 'OPERATION_SUCCEEDED',
        tool: 'companion_permissions',
        sessionId: session?.id,
        policyDecision: 'ALLOW',
        outcome: 'updated'
      });
    } catch {}

    const statusPayload = await this.status(ownerKey);
    this.publish(session, 'companionStatus', statusPayload);
    return statusPayload;
  }

  async disconnect(session, ownerKey) {
    this.requireEnabled();
    const pairing = this.activePairings.get(ownerKey);
    const now = Date.now();
    if (pairing) {
      this.activePairings.delete(ownerKey);
      if (this.daemonInfo) {
        await this.#ipcRequest('/revoke', { method: 'POST', body: { ownerKey, deviceId: pairing.deviceId } }).catch(() => {});
      }
      this.store.updateCompanionDevice(ownerKey, pairing.deviceId, {
        state: 'disconnected',
        lastSeenAt: now,
        disconnectedAt: now
      });
      this.recordAction(ownerKey, {
        deviceId: pairing.deviceId,
        eventType: 'device_disconnected',
        toolName: 'companion_disconnect',
        summary: `Disconnected "${pairing.deviceName}" and revoked capability token.`,
        status: 'ok'
      });
    }
    if (this.activePairings.size === 0) {
      await this.#stopDaemon();
    }
    const statusPayload = await this.status(ownerKey);
    this.publish(session, 'companionStatus', statusPayload);
    return statusPayload;
  }

  async emergencyStop(session, ownerKey) {
    this.requireEnabled();
    const now = Date.now();
    for (const [id, ch] of this.challenges.entries()) {
      if (ch.ownerKey === ownerKey) this.challenges.delete(id);
    }

    const pairing = this.activePairings.get(ownerKey);
    if (pairing) {
      this.activePairings.delete(ownerKey);
    }
    if (this.daemonInfo) {
      await this.#ipcRequest('/emergency-stop', { method: 'POST', body: { ownerKey } }).catch(() => {});
    }

    for (const dev of this.store.listCompanionDevices(ownerKey, 10)) {
      if (dev.state === 'paired' || dev.id === pairing?.deviceId) {
        this.store.updateCompanionDevice(ownerKey, dev.id, {
          state: 'revoked',
          lastSeenAt: now,
          disconnectedAt: now
        });
      }
    }

    let cancelledSummary = { cancelledTasks: 0, cancelledApprovals: 0 };
    if (this.orchestratorRef?.emergencyCancelOwner) {
      cancelledSummary = this.orchestratorRef.emergencyCancelOwner(session, ownerKey);
    }

    this.recordAction(ownerKey, {
      deviceId: pairing?.deviceId || null,
      eventType: 'emergency_stop',
      toolName: 'companion_emergency_stop',
      summary: `Emergency Stop activated: revoked device tokens, cancelled ${cancelledSummary.cancelledTasks} active task(s) and ${cancelledSummary.cancelledApprovals} pending approval(s).`,
      status: 'revoked'
    });

    try {
      await this.auditEvent({
        event: 'OPERATION_SUCCEEDED',
        tool: 'companion_emergency_stop',
        sessionId: session?.id,
        policyDecision: 'ALLOW',
        outcome: 'emergency_stopped'
      });
    } catch {}

    if (this.activePairings.size === 0) {
      await this.#stopDaemon();
    }

    const statusPayload = await this.status(ownerKey);
    this.publish(session, 'companionStatus', statusPayload);
    return { ...statusPayload, emergency: cancelledSummary };
  }

  async getMetrics(ownerKey, { drive } = {}) {
    const pairing = this.requirePaired(ownerKey, 'telemetry');
    const data = await this.#ipcRequest('/rpc', {
      method: 'POST',
      body: { ownerKey, action: 'get_system_metrics', args: drive ? { drive } : {} },
      capabilityToken: pairing.capabilityToken
    });
    this.store.updateCompanionDevice(ownerKey, pairing.deviceId, { lastSeenAt: Date.now() });
    return data;
  }

  async listProcesses(ownerKey, { sortBy = 'memory', limit = 10 } = {}) {
    const pairing = this.requirePaired(ownerKey, 'telemetry');
    const data = await this.#ipcRequest('/rpc', {
      method: 'POST',
      body: { ownerKey, action: 'list_running_processes', args: { sortBy, limit } },
      capabilityToken: pairing.capabilityToken
    });
    this.store.updateCompanionDevice(ownerKey, pairing.deviceId, { lastSeenAt: Date.now() });
    return data;
  }

  async listApps(ownerKey) {
    const pairing = this.requirePaired(ownerKey, 'apps');
    const data = await this.#ipcRequest('/rpc', {
      method: 'POST',
      body: { ownerKey, action: 'list_installed_apps', args: {} },
      capabilityToken: pairing.capabilityToken
    });
    this.store.updateCompanionDevice(ownerKey, pairing.deviceId, { lastSeenAt: Date.now() });
    return data;
  }

  findConfiguredApp(appId) {
    return (this.config?.approvedApps || []).find((a) => a.appId === appId) || null;
  }

  async launchApprovedApp(ownerKey, appId) {
    const pairing = this.requirePaired(ownerKey, 'apps');
    const configured = this.findConfiguredApp(appId);
    if (!configured) {
      throw new ToolError('APP_NOT_APPROVED', `Application "${appId}" is not in the approved applications catalog.`);
    }
    const res = await this.#ipcRequest('/rpc', {
      method: 'POST',
      body: { ownerKey, action: 'launch_approved_app', args: { appId } },
      capabilityToken: pairing.capabilityToken
    });
    this.store.updateCompanionDevice(ownerKey, pairing.deviceId, { lastSeenAt: Date.now() });
    return res;
  }

  async recycleFilePath(ownerKey, filePath) {
    const pairing = this.requirePaired(ownerKey, 'fileMutations');
    const res = await this.#ipcRequest('/rpc', {
      method: 'POST',
      body: { ownerKey, action: 'recycle_file', args: { filePath } },
      capabilityToken: pairing.capabilityToken
    });
    this.store.updateCompanionDevice(ownerKey, pairing.deviceId, { lastSeenAt: Date.now() });
    return res;
  }

  recordAction(ownerKey, { deviceId = null, eventType = 'tool_action', toolName = null, summary, status = 'ok', detail = null }) {
    if (!ownerKey) return null;
    const active = this.activePairings.get(ownerKey);
    return this.store.addCompanionEvent({
      id: randomUUID(),
      ownerKey,
      deviceId: deviceId || active?.deviceId || null,
      eventType,
      toolName,
      summary,
      status,
      detail,
      createdAt: Date.now()
    });
  }

  recordReversibleAction(ownerKey, { taskId = null, actionType, status = 'available', undoAvailable = true, summary, payload = {} }) {
    if (!ownerKey) return null;
    const active = this.activePairings.get(ownerKey);
    return this.store.createReversibleAction({
      id: randomUUID(),
      ownerKey,
      deviceId: active?.deviceId || null,
      taskId,
      actionType,
      status,
      undoAvailable,
      summary,
      payload,
      createdAt: Date.now(),
      undoneAt: null
    });
  }

  getReversibleAction(ownerKey, actionId) {
    return ownerKey ? this.store.getReversibleAction(ownerKey, actionId) : null;
  }

  markActionUndone(ownerKey, actionId) {
    if (!ownerKey) return null;
    return this.store.updateReversibleAction(ownerKey, actionId, {
      status: 'undone',
      undoAvailable: false,
      undoneAt: Date.now()
    });
  }

  invalidateSession(session) {
    if (!session?.id) return;
    for (const [id, ch] of this.challenges.entries()) {
      if (ch.sessionId === session.id) this.challenges.delete(id);
    }
  }

  async close() {
    this.closed = true;
    this.challenges.clear();
    this.activePairings.clear();
    await this.#stopDaemon();
  }
}
