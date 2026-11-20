import { ToolError } from '../tools/errors.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])])
    );
  }
  return value;
}

export class ExecutionGuard {
  constructor({
    maxSteps = 12,
    maxToolCalls = 16,
    maxIdenticalCalls = 2,
    maxTotalDurationMs = 60000,
    now = () => Date.now()
  } = {}) {
    this.maxSteps = maxSteps;
    this.maxToolCalls = maxToolCalls;
    this.maxIdenticalCalls = maxIdenticalCalls;
    this.maxTotalDurationMs = maxTotalDurationMs;
    this.now = now;
    this.startedAt = now();
    this.steps = 0;
    this.calls = 0;
    this.fingerprints = new Map();
  }

  checkTime() {
    if (this.now() - this.startedAt > this.maxTotalDurationMs) {
      throw new ToolError('RESOURCE_LIMIT', 'Task execution exceeded the maximum allowed runtime.');
    }
  }

  beforeStep() {
    this.checkTime();
    this.steps += 1;
    if (this.steps > this.maxSteps) {
      throw new ToolError('RESOURCE_LIMIT', `Task exceeded the maximum of ${this.maxSteps} execution steps.`);
    }
  }

  beforeCall(toolName, args = {}) {
    this.checkTime();
    this.calls += 1;
    if (this.calls > this.maxToolCalls) {
      throw new ToolError('RESOURCE_LIMIT', `Execution exceeded the maximum of ${this.maxToolCalls} tool calls.`);
    }
    const fingerprint = `${toolName}:${JSON.stringify(canonical(args))}`;
    const count = (this.fingerprints.get(fingerprint) || 0) + 1;
    this.fingerprints.set(fingerprint, count);
    if (count > this.maxIdenticalCalls) {
      throw new ToolError('LOOP_DETECTED', `Repeated identical call to ${toolName} was blocked to prevent an execution loop.`);
    }
  }
}
