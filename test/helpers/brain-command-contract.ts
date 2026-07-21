import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { dispatchToolCall, type ToolResult } from '../../src/mcp/dispatch.ts';
import { buildToolDefs } from '../../src/mcp/tool-defs.ts';

export interface CommandTool {
  name: string;
  inputSchema: Record<string, unknown>;
}

export interface CommandError {
  code: string;
  context?: Record<string, boolean | number | string>;
  effect: 'nothing_changed' | 'partial' | 'unknown';
  message: string;
  remediation: string;
}

export type CommandOutcome =
  | { status: 'success'; result: unknown }
  | { status: 'expected_failure'; error: CommandError }
  | { status: 'unknown_effect'; error: CommandError & { effect: 'unknown' } };

export interface BrainCommandCaller {
  listTools(): Promise<CommandTool[]>;
  call(name: string, input: Record<string, unknown>): Promise<CommandOutcome>;
}

type FetchRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CommandCaseClassification {
  deterministic: boolean;
  destructive: boolean;
  fileDependent: boolean;
  modelDependent: boolean;
}

export interface BrainCommandCase {
  name: string;
  operation: string;
  input: Record<string, unknown>;
  classification: CommandCaseClassification;
  setup?: () => Promise<unknown>;
  observeBefore?: () => Promise<unknown>;
  observeAfter?: () => Promise<unknown>;
  cleanup?: () => Promise<unknown>;
  verify(input: { before: unknown; after: unknown; outcome: CommandOutcome }): void | Promise<void>;
}

export function createTrustedLocalCommandCaller(input: {
  engine: BrainEngine;
  sourceId: string;
}): BrainCommandCaller {
  return {
    async listTools() {
      return buildToolDefs(operations);
    },
    async call(name, params) {
      const result = await dispatchToolCall(input.engine, name, params, {
        redactInternalErrors: true,
        remote: false,
        sourceId: input.sourceId,
      });
      return normalizeToolResult(name, result);
    },
  };
}

export function createTrustedHttpCommandCaller(input: {
  accessToken: string;
  baseUrl: string;
  fetch?: FetchRequest;
}): BrainCommandCaller {
  const request = input.fetch ?? fetch;
  let requestId = 0;
  const send = async (method: string, params?: Record<string, unknown>) => {
    requestId += 1;
    const response = await request(`${input.baseUrl.replace(/\/$/, '')}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: requestId, jsonrpc: '2.0', method, ...(params ? { params } : {}) }),
    });
    if (!response.ok) throw new Error('The authenticated GBrain HTTP request failed.');
    return readEnvelope(await response.text(), response.headers.get('content-type') ?? '', requestId);
  };
  return {
    async listTools() {
      const envelope = await send('tools/list');
      const tools = asRecord(asRecord(envelope).result).tools;
      if (!Array.isArray(tools)) throw new Error('The GBrain tools/list response is malformed.');
      return tools.map((value) => {
        const tool = asRecord(value);
        if (typeof tool.name !== 'string' || !isRecord(tool.inputSchema)) {
          throw new Error('The GBrain tools/list response is malformed.');
        }
        return { name: tool.name, inputSchema: tool.inputSchema };
      });
    },
    async call(name, params) {
      const envelope = await send('tools/call', { name, arguments: params });
      const result = asRecord(asRecord(envelope).result) as unknown as ToolResult;
      return normalizeToolResult(name, result);
    },
  };
}

export async function runCommandCase(caller: BrainCommandCaller, commandCase: BrainCommandCase) {
  try {
    await commandCase.setup?.();
    const before = await commandCase.observeBefore?.();
    const outcome = await caller.call(commandCase.operation, commandCase.input);
    const after = await commandCase.observeAfter?.();
    await commandCase.verify({ before, after, outcome });
    return outcome;
  } finally {
    await commandCase.cleanup?.();
  }
}

export type CommandTestGroup = 'pr' | 'merge' | 'nightly' | 'release';

export function groupsForCommandCase(classification: CommandCaseClassification): CommandTestGroup[] {
  const groups: CommandTestGroup[] = [];
  if (classification.deterministic && !classification.destructive &&
      !classification.fileDependent && !classification.modelDependent) groups.push('pr');
  if (classification.deterministic && !classification.destructive &&
      !classification.modelDependent) groups.push('merge');
  if (!classification.deterministic || classification.destructive ||
      classification.modelDependent) groups.push('nightly');
  groups.push('release');
  return groups;
}

export function selectCommandCases(
  commandCases: readonly BrainCommandCase[],
  group: CommandTestGroup,
): BrainCommandCase[] {
  return commandCases.filter(commandCase =>
    groupsForCommandCase(commandCase.classification).includes(group));
}

function normalizeToolResult(name: string, result: ToolResult): CommandOutcome {
  const content = result.content[0]?.text;
  const value = typeof content === 'string' ? parseText(content) : null;
  if (!result.isError) return { status: 'success', result: value };
  const payload = asRecord(value);
  const code = typeof payload.error === 'string' ? payload.error.slice(0, 64) : 'internal_error';
  const operation = operations.find(candidate => candidate.name === name);
  const nothingChanged = !operation?.mutating ||
    code === 'unknown_tool' || code === 'invalid_params' || code === 'permission_denied';
  const effect = nothingChanged ? 'nothing_changed' : 'unknown';
  const error: CommandError = {
    code,
    context: { operation: name.slice(0, 64) },
    effect,
    message: typeof payload.message === 'string'
      ? payload.message.slice(0, 512)
      : 'The brain operation failed.',
    remediation: typeof payload.remediation === 'string'
      ? payload.remediation.slice(0, 512)
      : nothingChanged
        ? 'Check the tool inputs, then try again.'
        : 'Inspect durable brain state before you try the operation again.',
  };
  return effect === 'unknown'
    ? { status: 'unknown_effect', error: { ...error, effect: 'unknown' } }
    : { status: 'expected_failure', error };
}

function readEnvelope(body: string, contentType: string, expectedId: number): unknown {
  let text = body;
  if (contentType.toLowerCase().includes('text/event-stream')) {
    text = body.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5).trim() ?? '';
  }
  const envelope = parseText(text);
  if (!isRecord(envelope) || envelope.jsonrpc !== '2.0' || envelope.id !== expectedId) {
    throw new Error('The GBrain HTTP response is malformed.');
  }
  return envelope;
}

function parseText(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
