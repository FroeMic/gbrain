import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { operations } from '../../src/core/operations.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

const PORT = 19132;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'a'.repeat(64);

describe('trusted-host HTTP MCP', () => {
  let home: string;
  let child: ChildProcess | undefined;
  let accessToken = '';
  let env: NodeJS.ProcessEnv;
  let uploadFixture = '';
  let clientId = '';

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-trusted-http-'));
    const configDir = join(home, '.gbrain');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      engine: 'pglite',
      database_path: join(configDir, 'brain.pglite'),
    }));
    env = { ...process.env, GBRAIN_HOME: home, GBRAIN_ADMIN_BOOTSTRAP_TOKEN: ADMIN_TOKEN };
    delete env.DATABASE_URL;
    delete env.GBRAIN_DATABASE_URL;
    uploadFixture = join(home, 'trusted-upload.txt');
    writeFileSync(uploadFixture, 'trusted host upload fixture');
    writeFileSync(join(home, 'fixture.md'), '---\ntitle: Fixture\ntype: note\n---\nTrusted sync fixture.\n');
    execFileSync('git', ['init'], { cwd: home, env, stdio: 'ignore' });
    execFileSync('git', ['add', 'fixture.md'], { cwd: home, env, stdio: 'ignore' });
    execFileSync('git', [
      '-c', 'user.name=Alice Example', '-c', 'user.email=alice@example.com',
      'commit', '-m', 'test fixture',
    ], { cwd: home, env, stdio: 'ignore' });

    execFileSync('bun', ['run', 'src/cli.ts', 'init', '--migrate-only', '--json'], {
      cwd: process.cwd(), env, encoding: 'utf8',
    });

    const seed = new PGLiteEngine();
    await seed.connect({ engine: 'pglite', database_path: join(configDir, 'brain.pglite') });
    const page = await seed.putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'Fixture', timeline: '', frontmatter: {},
    });
    await seed.addTakesBatch([
      { page_id: page.id, row_num: 1, claim: 'Public fixture take', kind: 'take', holder: 'world' },
      { page_id: page.id, row_num: 2, claim: 'Private fixture take', kind: 'take', holder: 'alice-example' },
    ]);
    await seed.insertFact(
      { fact: 'Private fixture fact', entity_slug: 'people/alice-example', source: 'test' },
      { source_id: 'default' },
    );
    await seed.disconnect();

    const registration = execFileSync(
      'bun',
      ['run', 'src/cli.ts', 'auth', 'register-client', 'trusted-http-test',
        '--grant-types', 'client_credentials', '--scopes', 'read'],
      { cwd: process.cwd(), env, encoding: 'utf8' },
    );
    clientId = registration.match(/Client ID:\s+(gbrain_cl_\S+)/)?.[1] ?? '';
    const clientSecret = registration.match(/Client Secret:\s+(gbrain_cs_\S+)/)?.[1];
    if (!clientId || !clientSecret) throw new Error('OAuth client registration failed');

    child = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http',
      '--port', String(PORT), '--bind', '127.0.0.1',
      '--execution-mode', 'trusted_host', '--source', 'default',
      '--suppress-bootstrap-token',
    ], { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    child.stderr?.on('data', data => { stderr += String(data); });
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break;
      } catch {}
      if (attempt === 59) throw new Error(`trusted HTTP server did not start: ${stderr.slice(-1000)}`);
      await Bun.sleep(250);
    }

    const tokenResponse = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials', client_id: clientId,
        client_secret: clientSecret, scope: 'read',
      }),
    });
    const token = await tokenResponse.json() as { access_token?: string };
    if (!token.access_token) throw new Error('OAuth token mint failed');
    accessToken = token.access_token;
  }, 30_000);

  afterAll(async () => {
    child?.kill('SIGTERM');
    await Bun.sleep(250);
    if (child && child.exitCode === null) child.kill('SIGKILL');
    if (home) rmSync(home, { recursive: true, force: true });
  });

  async function mcp(method: string, params?: Record<string, unknown>, token = accessToken) {
    return fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    });
  }

  test('authentication remains mandatory', async () => {
    const response = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  test('publishes the complete operation catalog', async () => {
    const body = await (await mcp('tools/list')).text();
    for (const operation of operations) expect(body).toContain(`"name":"${operation.name}"`);
  });

  test('a read token can call a local-only admin operation', async () => {
    const response = await mcp('tools/call', {
      name: 'purge_deleted_pages',
      arguments: { older_than_hours: 72 },
    });
    const body = await response.text();
    expect(body).not.toContain('insufficient_scope');
    expect(body).not.toContain('unknown_operation');
    expect(body).toContain('purged');
  });

  test('request metadata cannot lower or elevate the startup policy', async () => {
    const body = await (await mcp('tools/list', {
      _meta: { execution_mode: 'remote', remote: true },
    })).text();
    expect(body).toContain('"name":"purge_deleted_pages"');
  });

  test('trusted reads include private facts and all Takes holders', async () => {
    const facts = await (await mcp('tools/call', {
      name: 'recall', arguments: { entity: 'people/alice-example' },
    })).text();
    expect(facts).toContain('Private fixture fact');

    const takes = await (await mcp('tools/call', {
      name: 'takes_list', arguments: { page_slug: 'people/alice-example' },
    })).text();
    expect(takes).toContain('Public fixture take');
    expect(takes).toContain('Private fixture take');
  });

  test('trusted calls can submit a protected job', async () => {
    const body = await (await mcp('tools/call', {
      name: 'submit_job',
      arguments: { name: 'shell', data: { cmd: 'true', cwd: home } },
    })).text();
    expect(body).not.toContain('permission_denied');
    expect(body).toContain('shell');
  });

  test('trusted calls can read a sandbox-local path outside the server cwd', async () => {
    const body = await (await mcp('tools/call', {
      name: 'file_upload', arguments: { path: uploadFixture },
    })).text();
    expect(body).not.toContain('path_outside_root');
    expect(body).toContain('trusted-upload.txt');
  });

  test('all remaining local-only operations dispatch through trusted HTTP', async () => {
    const calls = [
      { name: 'sync_brain', arguments: { repo: home, dry_run: true, no_pull: true, no_embed: true } },
      { name: 'file_list', arguments: {} },
      { name: 'get_recent_transcripts', arguments: { days: 1, limit: 1 } },
      { name: 'chronicle_backfill', arguments: { dry_run: true, limit: 1 } },
      { name: 'code_traversal_cache_clear', arguments: { source_id: 'default' } },
    ];
    for (const call of calls) {
      const body = await (await mcp('tools/call', call)).text();
      expect(body).not.toContain('unknown_operation');
      expect(body).not.toContain('insufficient_scope');
      expect(body).not.toContain('permission_denied');
      expect(body).not.toContain('internal_error');
    }

    const listBody = await (await mcp('tools/call', {
      name: 'file_list', arguments: {},
    })).text();
    const storagePath = listBody.match(/unsorted\\?\/[a-z0-9-]+trusted-upload\.txt/)?.[0]
      ?.replaceAll('\\/', '/');
    expect(storagePath).toBeTruthy();
    const urlBody = await (await mcp('tools/call', {
      name: 'file_url', arguments: { storage_path: storagePath },
    })).text();
    expect(urlBody).toContain('gbrain:files/');
  });

  test('unexpected errors do not expose host paths or request content', async () => {
    const secretPath = join(home, 'missing-secret-name.txt');
    const body = await (await mcp('tools/call', {
      name: 'file_upload', arguments: { path: secretPath },
    })).text();
    expect(body).toContain('invalid_params');
    expect(body).toContain('Review the tool schema');
    expect(body).not.toContain(secretPath);
    expect(body).not.toContain('missing-secret-name');
  });

  test('trusted calls keep attribution and redacted audit parameters', async () => {
    const secret = 'private-request-body-value';
    const callBody = await (await mcp('tools/call', {
      name: 'put_page',
      arguments: {
        slug: 'notes/audit-fixture',
        content: `---\ntitle: Audit Fixture\ntype: note\n---\n${secret}`,
      },
    })).text();
    expect(callBody).not.toContain('insufficient_scope');

    const login = await fetch(`${BASE}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    expect(login.ok).toBe(true);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toBeTruthy();

    const auditResponse = await fetch(
      `${BASE}/admin/api/requests?agent=${encodeURIComponent(clientId)}&operation=put_page`,
      { headers: { cookie: cookie! } },
    );
    const audit = await auditResponse.json() as { rows: Array<Record<string, unknown>> };
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].agent_name).toBe('trusted-http-test');
    expect(audit.rows[0].params).toMatchObject({
      redacted: true,
      declared_keys: ['content', 'slug'],
    });
    expect(JSON.stringify(audit.rows[0])).not.toContain(secret);
  });
});
