import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { buildToolDefs } from '../../src/mcp/tool-defs.ts';
import {
  createTrustedHttpCommandCaller,
  createTrustedLocalCommandCaller,
  groupsForCommandCase,
  runCommandCase,
  selectCommandCases,
  type BrainCommandCase,
} from './brain-command-contract.ts';
import { addTagCommandCase, identityCommandCase } from './command-cases/core.ts';

describe('brain command contract harness', () => {
  test('normalizes the same semantic success for trusted local and HTTP callers', async () => {
    const result = {
      version: '0.42.63.0', engine: 'pglite', page_count: 2,
      pages_by_type: { note: 2 }, chunk_count: 3, last_sync_iso: null,
      update_available: false, latest_version: null,
    };
    const local = createTrustedLocalCommandCaller({
      engine: { kind: 'pglite', getStats: async () => ({
        page_count: 2, pages_by_type: { note: 2 }, chunk_count: 3,
      }) } as unknown as BrainEngine,
      sourceId: 'default',
    });
    const http = createTrustedHttpCommandCaller({
      accessToken: 'access-token',
      baseUrl: 'http://127.0.0.1:3131',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number; method: string };
        return Response.json({
          id: request.id, jsonrpc: '2.0',
          result: request.method === 'tools/list'
            ? { tools: buildToolDefs(operations) }
            : { content: [{ type: 'text', text: JSON.stringify(result) }] },
        });
      },
    });

    expect(await local.call('get_brain_identity', {})).toEqual({ status: 'success', result });
    expect(await http.call('get_brain_identity', {})).toEqual({ status: 'success', result });
    expect((await local.listTools()).length).toBe((await http.listTools()).length);
  });

  test('distinguishes expected failures from unknown write effects', async () => {
    const caller = createTrustedLocalCommandCaller({
      engine: {} as BrainEngine,
      sourceId: 'default',
    });

    expect(await caller.call('get_page', {})).toMatchObject({
      status: 'expected_failure', error: { code: 'invalid_params', effect: 'nothing_changed' },
    });
    expect(await caller.call('put_page', { slug: 'notes/a' })).toMatchObject({
      status: 'expected_failure', error: { code: 'invalid_params', effect: 'nothing_changed' },
    });
    expect(await caller.call('not_a_tool', {})).toMatchObject({
      status: 'expected_failure', error: { code: 'unknown_tool' },
    });
  });

  test('runs one domain case unchanged against any caller', async () => {
    const events: string[] = [];
    const commandCase: BrainCommandCase = {
      ...identityCommandCase,
      setup: async () => { events.push('setup'); },
      cleanup: async () => { events.push('cleanup'); },
    };
    const caller = createTrustedLocalCommandCaller({
      engine: { kind: 'pglite', getStats: async () => ({
        page_count: 0, pages_by_type: {}, chunk_count: 0,
      }) } as unknown as BrainEngine,
      sourceId: 'default',
    });

    await runCommandCase(caller, commandCase);
    await runCommandCase(createTrustedLocalCommandCaller({
      engine: { addTag: async () => undefined } as unknown as BrainEngine,
      sourceId: 'default',
    }), addTagCommandCase);
    expect(events).toEqual(['setup', 'cleanup']);
    expect(groupsForCommandCase(commandCase.classification)).toEqual(['pr', 'merge', 'release']);
    expect(selectCommandCases([commandCase], 'pr')).toEqual([commandCase]);
    expect(selectCommandCases([commandCase], 'nightly')).toEqual([]);
  });
});
