import { describe, expect, test } from 'bun:test';
import type { Operation, AuthInfo } from '../src/core/operations.ts';
import {
  createHttpExecutionPolicy,
  parseHttpExecutionMode,
} from '../src/mcp/http-execution-policy.ts';

const remoteOperation = { name: 'search', scope: 'read' } as Operation;
const localOperation = { name: 'sync_brain', scope: 'write', localOnly: true } as Operation;
const catalog = [remoteOperation, localOperation];

const auth = {
  token: 'redacted',
  clientId: 'client-example',
  scopes: ['read'],
  sourceId: 'token-source',
  takesHoldersAllowList: ['world'],
} as AuthInfo & { takesHoldersAllowList: string[] };

describe('HTTP execution policy', () => {
  test('remote is the default and preserves HTTP restrictions', () => {
    expect(parseHttpExecutionMode(undefined)).toBe('remote');
    const policy = createHttpExecutionPolicy('remote', 'company-source');

    expect(policy.publishedOperations(catalog)).toEqual([remoteOperation]);
    expect(policy.admitsOperation(auth.scopes, remoteOperation)).toBe(true);
    expect(policy.admitsOperation(auth.scopes, localOperation)).toBe(false);
    expect(policy.dispatchOptions(auth)).toMatchObject({
      remote: true,
      sourceId: 'token-source',
      takesHoldersAllowList: ['world'],
      auth,
    });
  });

  test('trusted_host gives authenticated callers local-owner behavior', () => {
    const policy = createHttpExecutionPolicy('trusted_host', 'company-source');

    expect(policy.publishedOperations(catalog)).toEqual(catalog);
    expect(policy.admitsOperation([], localOperation)).toBe(true);
    expect(policy.dispatchOptions(auth)).toEqual({
      remote: false,
      sourceId: 'company-source',
      auth,
      redactInternalErrors: true,
    });
  });

  test('rejects an invalid startup mode', () => {
    expect(() => parseHttpExecutionMode('owner')).toThrow(
      "Invalid --execution-mode 'owner'. Expected remote or trusted_host.",
    );
  });
});
