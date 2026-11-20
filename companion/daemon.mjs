import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, rename } from 'node:fs/promises';
import { promisify } from 'node:util';
import { loadCompanionConfig } from './config.mjs';
import {
  collectSystemMetrics,
  listRunningProcesses,
  discoverApprovedApps,
  launchApprovedAppExecutable,
  isMockWindowsMode
} from './telemetry.mjs';
import { validatePathText } from '../tools/pathGuard.mjs';
import { ToolError } from '../tools/errors.mjs';
import { errorStatus, failure } from '../safety/errors.mjs';

const exec = promisify(execFile);
const secret = process.env.EDITH_COMPANION_SECRET || '';
if (secret.length < 32) {
  console.error('EDITH companion daemon requires EDITH_COMPANION_SECRET.');
  process.exit(1);
}

const config = await loadCompanionConfig();
const pairings = new Map(); // ownerKey -> { deviceId, capabilityTokenHash, scopes, disabledApps }
const seenNonces = new Map(); // nonce -> timestamp

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function constantEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function signCheck(req, rawBody) {
  const remote = req.socket?.remoteAddress || '';
  if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(remote)) {
    throw new ToolError('ORIGIN_DENIED', 'Companion daemon accepts loopback IPC only.');
  }
  const tsHeader = req.headers['x-edith-companion-timestamp'];
  const nonce = req.headers['x-edith-companion-nonce'];
  const sig = req.headers['x-edith-companion-sig'];
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || typeof nonce !== 'string' || nonce.length < 16 || typeof sig !== 'string' || sig.length !== 64) {
    throw new ToolError('AUTH_DENIED', 'Missing companion IPC signature.');
  }
  const now = Date.now();
  if (Math.abs(now - ts) > 30000) {
    throw new ToolError('AUTH_DENIED', 'Expired companion IPC timestamp.');
  }
  if (seenNonces.has(nonce)) {
    throw new ToolError('AUTH_DENIED', 'Replayed companion IPC nonce.');
  }
  const expected = createHmac('sha256', secret)
    .update(`${tsHeader}\0${nonce}\0${req.method}\0${req.url}\0${rawBody}`)
    .digest('hex');
  if (!constantEqualHex(expected, sig)) {
    throw new ToolError('AUTH_DENIED', 'Invalid companion IPC signature.');
  }
  seenNonces.set(nonce, now);
  if (seenNonces.size > 2000) {
    const cutoff = now - 60000;
    for (const [k, v] of seenNonces.entries()) {
      if (v < cutoff) seenNonces.delete(k);
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 65536) {
        reject(new ToolError('INVALID_ARGUMENTS', 'Companion IPC payload too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function recycleInWindows(targetPath) {
  validatePathText(targetPath);
  const resolved = path.resolve(targetPath);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ToolError('LINK_BLOCKED', 'Only regular files (never symlinks or junctions) can be sent to the Recycle Bin.');
  }

  if (isMockWindowsMode() && process.env.EDITH_COMPANION_TEST_RECYCLE_DIR) {
    const trashRoot = path.resolve(process.env.EDITH_COMPANION_TEST_RECYCLE_DIR);
    await mkdir(trashRoot, { recursive: true });
    const trashedPath = path.join(trashRoot, `${Date.now()}-${path.basename(resolved)}`);
    await rename(resolved, trashedPath);
    return { recycled: true, mock: true };
  }

  if (process.platform !== 'win32') {
    throw new ToolError('UNSUPPORTED_OPERATION', 'Windows Recycle Bin requires Windows.');
  }

  // Static non-interpolated script; target path passes solely via EDITH_RECYCLE_TARGET env var.
  const psPath = path.win32.join(
    process.env.SystemRoot || process.env.windir || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const script =
    "Add-Type -AssemblyName Microsoft.VisualBasic; " +
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:EDITH_RECYCLE_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')";
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await exec(
    psPath,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      windowsHide: true,
      timeout: 12000,
      env: { ...process.env, EDITH_RECYCLE_TARGET: resolved }
    }
  );
  return { recycled: true, mock: false };
}

async function handleRpc(req, body) {
  const token = req.headers['x-edith-capability-token'];
  const ownerKey = body.ownerKey;
  if (typeof token !== 'string' || !token || typeof ownerKey !== 'string' || !ownerKey) {
    throw new ToolError('AUTH_DENIED', 'Scoped capability token and ownerKey are required.');
  }
  const pairing = pairings.get(ownerKey);
  if (!pairing) {
    throw new ToolError('COMPANION_NOT_PAIRED', 'Local Windows companion is not paired for this account.');
  }
  if (!constantEqualHex(sha256Hex(token), pairing.capabilityTokenHash)) {
    throw new ToolError('AUTH_DENIED', 'Invalid or revoked companion capability token.');
  }

  const { action, args = {} } = body;
  const requiredScope = {
    get_system_metrics: 'telemetry',
    list_running_processes: 'telemetry',
    list_installed_apps: 'apps',
    launch_approved_app: 'apps',
    recycle_file: 'fileMutations'
  }[action];

  if (!requiredScope) {
    throw new ToolError('TOOL_NOT_FOUND', `Unsupported companion RPC action "${action}".`);
  }
  if (!pairing.scopes?.[requiredScope]) {
    throw new ToolError('CAPABILITY_DENIED', `Companion permission "${requiredScope}" is disabled for this device.`);
  }

  switch (action) {
    case 'get_system_metrics':
      return collectSystemMetrics({ drive: args.drive });
    case 'list_running_processes':
      return listRunningProcesses({ sortBy: args.sortBy, limit: args.limit });
    case 'list_installed_apps': {
      const apps = await discoverApprovedApps(config, { disabledApps: pairing.disabledApps });
      return {
        apps: apps.map(({ appId, displayName, category, installed, enabled }) => ({
          appId,
          displayName,
          category,
          installed,
          enabled
        }))
      };
    }
    case 'launch_approved_app': {
      const apps = await discoverApprovedApps(config, { disabledApps: pairing.disabledApps });
      const target = apps.find((a) => a.appId === args.appId);
      return launchApprovedAppExecutable(target);
    }
    case 'recycle_file':
      return recycleInWindows(args.filePath);
    default:
      throw new ToolError('TOOL_NOT_FOUND', 'Unsupported companion action.');
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const rawBody = await readBody(req);
    signCheck(req, rawBody);
    const body = rawBody ? JSON.parse(rawBody) : {};

    if (req.method === 'GET' && req.url === '/health') {
      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: true,
        pid: process.pid,
        hostname: os.hostname(),
        platform: process.platform,
        activeDevices: pairings.size
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/pair') {
      const { ownerKey, deviceId, capabilityTokenHash, scopes, disabledApps } = body;
      if (!ownerKey || !deviceId || !capabilityTokenHash) {
        throw new ToolError('INVALID_ARGUMENTS', 'Invalid pairing registration payload.');
      }
      pairings.set(ownerKey, {
        deviceId,
        capabilityTokenHash,
        scopes: { telemetry: true, apps: true, fileAnalysis: true, fileMutations: true, ...(scopes || {}) },
        disabledApps: Array.isArray(disabledApps) ? disabledApps : []
      });
      res.statusCode = 200;
      res.end(JSON.stringify({ paired: true, deviceId }));
      return;
    }

    if (req.method === 'POST' && req.url === '/permissions') {
      const { ownerKey, scopes, disabledApps } = body;
      const existing = pairings.get(ownerKey);
      if (!existing) {
        throw new ToolError('COMPANION_NOT_PAIRED', 'Device is not currently paired.');
      }
      if (scopes) existing.scopes = { ...existing.scopes, ...scopes };
      if (Array.isArray(disabledApps)) existing.disabledApps = disabledApps;
      res.statusCode = 200;
      res.end(JSON.stringify({ updated: true, scopes: existing.scopes, disabledApps: existing.disabledApps }));
      return;
    }

    if (req.method === 'POST' && req.url === '/revoke') {
      const { ownerKey } = body;
      if (ownerKey) pairings.delete(ownerKey);
      res.statusCode = 200;
      res.end(JSON.stringify({ revoked: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/emergency-stop') {
      const { ownerKey } = body;
      if (ownerKey) pairings.delete(ownerKey);
      else pairings.clear();
      res.statusCode = 200;
      res.end(JSON.stringify({ stopped: true, activeDevices: pairings.size }));
      return;
    }

    if (req.method === 'POST' && req.url === '/rpc') {
      const result = await handleRpc(req, body);
      res.statusCode = 200;
      res.end(JSON.stringify(result));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify(failure(new ToolError('NOT_FOUND', 'Unknown companion daemon route.'))));
  } catch (err) {
    const toolErr = err instanceof ToolError ? err : new ToolError('OPERATION_FAILED', err.message || 'Companion error.');
    res.statusCode = errorStatus(toolErr.code);
    res.end(JSON.stringify(failure(toolErr)));
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  pairings.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('disconnect', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (typeof process.send === 'function') {
    process.send({
      type: 'ready',
      port: addr.port,
      pid: process.pid,
      hostname: os.hostname(),
      platform: process.platform
    });
  }
});
