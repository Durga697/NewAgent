import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { FORBIDDEN_APP_EXECUTABLES } from './config.mjs';
import { ToolError } from '../tools/errors.mjs';

const exec = promisify(execFile);
const windowsPs = () =>
  path.win32.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export function isMockWindowsMode(mock) {
  if (typeof mock === 'boolean') return mock;
  return process.env.NODE_ENV === 'test' && process.env.EDITH_COMPANION_MOCK_WINDOWS === '1';
}

function round1(val) {
  return Math.round(val * 10) / 10;
}

function bytesToGb(bytes) {
  return Math.round((Number(bytes || 0) / (1024 ** 3)) * 10) / 10;
}

function cpuTotals() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const [k, v] of Object.entries(cpu.times || {})) {
      total += v;
      if (k === 'idle') idle += v;
    }
  }
  return { idle, total, cores: cpus.length || 1, model: cpus[0]?.model || 'Windows CPU' };
}

async function sampleCpuUsage() {
  const first = cpuTotals();
  await new Promise((r) => setTimeout(r, 110));
  const second = cpuTotals();
  const totalDelta = second.total - first.total;
  const idleDelta = second.idle - first.idle;
  const pct = totalDelta > 0 ? Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100)) : 0;
  return {
    cpuPercent: round1(pct),
    cpuCores: second.cores,
    cpuModel: second.model
  };
}

async function runFixedPowerShell(script, timeout = 6000) {
  if (process.platform !== 'win32') return null;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await exec(
    windowsPs(),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, timeout, maxBuffer: 256 * 1024 }
  );
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

const MOCK_DRIVES = [
  { drive: 'C:', label: 'Windows', totalBytes: 256 * 1024 ** 3, freeBytes: 112 * 1024 ** 3 },
  { drive: 'D:', label: 'Data', totalBytes: 512 * 1024 ** 3, freeBytes: 318 * 1024 ** 3 }
];

const MOCK_PROCESSES = [
  { pid: 4120, name: 'Code', memoryMb: 642.4, cpuSeconds: 48.2 },
  { pid: 3892, name: 'msedge', memoryMb: 518.7, cpuSeconds: 31.5 },
  { pid: 6204, name: 'node', memoryMb: 184.3, cpuSeconds: 12.1 },
  { pid: 1940, name: 'explorer', memoryMb: 96.8, cpuSeconds: 19.4 },
  { pid: 5512, name: 'WindowsTerminal', memoryMb: 74.2, cpuSeconds: 5.8 }
];

function formatDriveEntry(raw) {
  const totalBytes = Number(raw.Size ?? raw.totalBytes ?? 0);
  const freeBytes = Number(raw.FreeSpace ?? raw.freeBytes ?? 0);
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const driveId = String(raw.DeviceID || raw.drive || '').replace(/[\\/]+$/, '');
  return {
    drive: driveId,
    label: String(raw.VolumeName || raw.label || 'Local Disk'),
    totalBytes,
    freeBytes,
    usedBytes,
    totalGb: bytesToGb(totalBytes),
    freeGb: bytesToGb(freeBytes),
    usedPercent: totalBytes > 0 ? round1((usedBytes / totalBytes) * 100) : 0
  };
}

export async function collectSystemMetrics({ drive, mock } = {}) {
  const useMock = isMockWindowsMode(mock);
  const driveFilter = drive ? String(drive).trim().replace(/[:\\/]+$/, '').toUpperCase() : null;
  if (driveFilter && !/^[A-Z]$/.test(driveFilter)) {
    throw new ToolError('INVALID_ARGUMENTS', 'Drive must be a single Windows drive letter such as C or D.');
  }

  if (useMock) {
    const drivesAll = MOCK_DRIVES.map(formatDriveEntry);
    const drives = driveFilter ? drivesAll.filter((d) => d.drive === `${driveFilter}:`) : drivesAll;
    const totalBytes = 16 * 1024 ** 3;
    const freeBytes = Math.round(8.6 * 1024 ** 3);
    const usedBytes = totalBytes - freeBytes;
    return {
      collectedAt: new Date().toISOString(),
      hostname: os.hostname(),
      platform: 'win32',
      cpu: { cpuPercent: 28.4, cpuCores: 8, cpuModel: 'Simulated Windows Workstation CPU' },
      memory: {
        totalBytes,
        freeBytes,
        usedBytes,
        usedPercent: round1((usedBytes / totalBytes) * 100),
        totalGb: bytesToGb(totalBytes),
        usedGb: bytesToGb(usedBytes),
        freeGb: bytesToGb(freeBytes)
      },
      drives,
      battery: { supported: true, percent: 84, status: 'Charging', onAC: true }
    };
  }

  const cpu = await sampleCpuUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);

  let drives = [];
  try {
    const rawDrives = await runFixedPowerShell(
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress",
      6000
    );
    if (rawDrives) {
      const list = Array.isArray(rawDrives) ? rawDrives : [rawDrives];
      drives = list.map(formatDriveEntry);
    }
  } catch {
    drives = [];
  }
  if (driveFilter) {
    drives = drives.filter((d) => d.drive.toUpperCase() === `${driveFilter}:`);
  }

  let battery = { supported: false, percent: null, status: 'No battery detected', onAC: true };
  try {
    const rawBat = await runFixedPowerShell(
      'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress',
      4000
    );
    if (rawBat) {
      const first = Array.isArray(rawBat) ? rawBat[0] : rawBat;
      if (first && Number.isFinite(Number(first.EstimatedChargeRemaining))) {
        const bStatus = Number(first.BatteryStatus);
        const onAC = [2, 6, 7, 8, 9].includes(bStatus);
        battery = {
          supported: true,
          percent: Number(first.EstimatedChargeRemaining),
          status: bStatus === 1 ? 'Discharging' : onAC ? 'Charging / AC Power' : 'Connected',
          onAC
        };
      }
    }
  } catch {
    // Gracefully report unavailable battery info
  }

  return {
    collectedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: process.platform,
    cpu,
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: usedMem,
      usedPercent: totalMem > 0 ? round1((usedMem / totalMem) * 100) : 0,
      totalGb: bytesToGb(totalMem),
      usedGb: bytesToGb(usedMem),
      freeGb: bytesToGb(freeMem)
    },
    drives,
    battery
  };
}

export async function listRunningProcesses({ sortBy = 'memory', limit = 10, mock } = {}) {
  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
  const mode = sortBy === 'cpu' ? 'cpu' : 'memory';
  const useMock = isMockWindowsMode(mock);

  let rows;
  if (useMock) {
    rows = MOCK_PROCESSES.map((p) => ({ ...p }));
  } else {
    try {
      const raw = await runFixedPowerShell(
        'Get-Process | Select-Object Id,ProcessName,WorkingSet64,CPU | ConvertTo-Json -Compress',
        7000
      );
      const list = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
      rows = list.map((p) => ({
        pid: Number(p.Id || 0),
        name: String(p.ProcessName || 'unknown').slice(0, 80),
        memoryMb: round1(Number(p.WorkingSet64 || 0) / (1024 * 1024)),
        cpuSeconds: round1(Number(p.CPU || 0))
      }));
    } catch {
      throw new ToolError('COMPANION_UNAVAILABLE', 'Unable to query running Windows processes.');
    }
  }

  rows.sort((a, b) => (mode === 'cpu' ? b.cpuSeconds - a.cpuSeconds : b.memoryMb - a.memoryMb));
  return {
    collectedAt: new Date().toISOString(),
    sortBy: mode,
    processes: rows.slice(0, safeLimit)
  };
}

export async function discoverApprovedApps(config, { disabledApps = [], mock } = {}) {
  const useMock = isMockWindowsMode(mock);
  const disabledSet = new Set((disabledApps || []).map((x) => String(x).toLowerCase()));
  const results = [];

  for (const app of config.approvedApps || []) {
    const enabled = app.enabled !== false && !disabledSet.has(app.appId.toLowerCase());
    if (useMock) {
      const installed = app.appId !== 'paint';
      results.push({
        appId: app.appId,
        displayName: app.displayName,
        category: app.category,
        installed,
        enabled,
        resolvedPath: installed ? app.candidates[0] : null
      });
      continue;
    }

    let resolvedPath = null;
    for (const candidate of app.candidates || []) {
      try {
        const linfo = await lstat(candidate);
        if (linfo.isSymbolicLink()) continue;
        const finfo = await stat(candidate);
        if (finfo.isFile()) {
          resolvedPath = candidate;
          break;
        }
      } catch {
        // Candidate not present at this path
      }
    }
    results.push({
      appId: app.appId,
      displayName: app.displayName,
      category: app.category,
      installed: Boolean(resolvedPath),
      enabled,
      resolvedPath
    });
  }
  return results;
}

export async function launchApprovedAppExecutable(appEntry, { mock } = {}) {
  if (!appEntry) {
    throw new ToolError('APP_NOT_APPROVED', 'That application is not in the approved catalog.');
  }
  if (!appEntry.enabled) {
    throw new ToolError('APP_DISABLED', `${appEntry.displayName} is disabled in companion permissions.`);
  }
  if (!appEntry.installed || !appEntry.resolvedPath) {
    throw new ToolError('APP_NOT_INSTALLED', `${appEntry.displayName} was not found at any trusted install location.`);
  }
  const baseName = path.win32.basename(appEntry.resolvedPath).toLowerCase();
  if (FORBIDDEN_APP_EXECUTABLES.has(baseName)) {
    throw new ToolError('FORBIDDEN', 'Shell or administrative binaries cannot be launched.');
  }

  if (isMockWindowsMode(mock)) {
    return {
      launched: true,
      appId: appEntry.appId,
      displayName: appEntry.displayName,
      pid: 42420,
      mock: true
    };
  }

  const linfo = await lstat(appEntry.resolvedPath);
  if (linfo.isSymbolicLink() || !linfo.isFile()) {
    throw new ToolError('PATH_DENIED', 'Approved application path must resolve directly to a regular executable.');
  }

  await new Promise((resolve, reject) => {
    const child = spawn(appEntry.resolvedPath, [], {
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new ToolError('OPERATION_FAILED', `Failed to launch ${appEntry.displayName}: ${err.message}`));
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    }, 150);
  });

  return {
    launched: true,
    appId: appEntry.appId,
    displayName: appEntry.displayName,
    mock: false
  };
}
