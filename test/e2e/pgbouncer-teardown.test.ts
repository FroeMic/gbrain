/**
 * v0.43 (#2084 / eng-review TD1) — PgBouncer transaction-mode teardown E2E.
 *
 * Three consecutive waves (#1972 → #2015 → #2084) fixed pooler-teardown bugs
 * that were verified only against one production deployment, because CI had
 * no transaction-mode pooler. This file pins the bug CLASS, not exact
 * timings: a CLI op against a txn-mode pooled URL must
 *
 *   1. exit zero with intact stdout, and
 *   2. NOT ride the 10s hard-deadline backstop (the
 *      "[cli] engine.disconnect() did not return within 10000ms" banner is
 *      the smoking gun — pre-#2084 it printed on 100% of query-shaped ops).
 *
 * Topology: docker-compose.ci.yml runs `pgbouncer` (transaction mode) in
 * front of postgres-1. The test uses a DEDICATED database
 * (`gbrain_pgbouncer`) created via the direct URL, so it never races the
 * TRUNCATE-based fixtures any shard runs against `gbrain_test`.
 *
 * Gated by GBRAIN_PGBOUNCER_URL + GBRAIN_PGBOUNCER_DIRECT_URL — skips
 * gracefully outside the docker CI gate. Run manually:
 *
 *   GBRAIN_PGBOUNCER_URL=postgresql://postgres:postgres@localhost:6543/gbrain_pgbouncer \
 *   GBRAIN_PGBOUNCER_DIRECT_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
 *   bun test test/e2e/pgbouncer-teardown.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import postgres from 'postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';

const POOLED_URL = process.env.GBRAIN_PGBOUNCER_URL;
const DIRECT_ADMIN_URL = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
const PGBOUNCER_TIMEOUT_SECONDS = Number(process.env.GBRAIN_PGBOUNCER_QUERY_TIMEOUT_SECONDS ?? '1');
const EXPECT_POOL_TIMEOUT = Number.isFinite(PGBOUNCER_TIMEOUT_SECONDS) && PGBOUNCER_TIMEOUT_SECONDS <= 2;
const SKIP = !POOLED_URL || !DIRECT_ADMIN_URL;
const describePooled = SKIP ? describe.skip : describe;

const REPO = resolve(import.meta.dir, '..', '..');
const TEST_DB = 'gbrain_pgbouncer';
const SLUG = 'test/pgbouncer-teardown-fixture';
const MARKER = 'pgbouncer-teardown-marker-content-7c4f';

/** Direct URL pointing at the dedicated test database (same server). */
function directTestDbUrl(): string {
  const u = new URL(DIRECT_ADMIN_URL!);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/** Pooled URL pointing at the dedicated test database. */
function pooledTestDbUrl(): string {
  const u = new URL(POOLED_URL!);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

async function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; wallMs: number }> {
  const t0 = Date.now();
  const proc = Bun.spawn(['bun', 'run', join(REPO, 'src', 'cli.ts'), ...args], {
    cwd: REPO,
    env: { ...process.env, ...env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, wallMs: Date.now() - t0 };
  } finally {
    clearTimeout(killer);
  }
}

describePooled('pgbouncer txn-mode teardown (#2084 / TD1)', () => {
  let home: string;

  beforeAll(async () => {
    // Dedicated database on the same server, created via the DIRECT url
    // (CREATE DATABASE cannot run through a transaction-mode pooler).
    const admin = postgres(DIRECT_ADMIN_URL!, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    } finally {
      await admin.end({ timeout: 5 });
    }

    // Schema + fixture via the direct connection (DDL stays off the pooler,
    // matching the production split-pool discipline).
    const initializeDirectSchema = async () => {
      const engine = new PostgresEngine();
      await engine.connect({ engine: 'postgres', database_url: directTestDbUrl(), poolSize: 1 });
      await engine.initSchema();
      await engine.disconnect();
    };

    // Fresh bootstrap, a no-op activation, and concurrent activation all stay
    // on the direct route because initSchema owns a session advisory lock.
    await initializeDirectSchema();
    await initializeDirectSchema();
    await Promise.all([initializeDirectSchema(), initializeDirectSchema()]);

    const eng = new PostgresEngine();
    await eng.connect({ engine: 'postgres', database_url: directTestDbUrl() });
    await eng.putPage(SLUG, {
      type: 'note',
      title: 'PgBouncer teardown fixture',
      compiled_truth: MARKER,
      timeline: '',
    });
    await eng.disconnect();

    // Brain config pointing the CLI at the POOLED url.
    home = mkdtempSync(join(tmpdir(), 'gbrain-pgbouncer-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const pooled = new URL(POOLED_URL!);
    pooled.pathname = `/${TEST_DB}`;
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: pooled.toString() }) + '\n',
    );
  }, 240_000);

  afterAll(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('op against the pooled URL exits clean — output intact, no force-exit banner', async () => {
    const env = {
      HOME: home,
      GBRAIN_HOME: home,
      // ci-local also supplies DATABASE_URL for the shard database. The
      // namespaced override must win so this test stays on its dedicated
      // transaction-pooled database.
      GBRAIN_DATABASE_URL: pooledTestDbUrl(),
      // The test creates a dedicated database after beforeAll starts. Keep
      // the runtime's direct route on that database rather than the admin URL
      // used only for CREATE DATABASE.
      GBRAIN_DIRECT_DATABASE_URL: directTestDbUrl(),
    };
    const res = await runCli(['get', SLUG], env, 90_000);

    if (res.exitCode !== 0 || /force-exiting/.test(res.stderr)) {
      console.error('--- stdout ---\n' + res.stdout);
      console.error('--- stderr ---\n' + res.stderr);
    }
    expect(res.exitCode).toBe(0);
    // Output is complete — the #1959 truncation class.
    expect(res.stdout).toContain(MARKER);
    // The smoking gun: pre-#2084 the hard-deadline banner printed every time
    // a query-shaped op ran against a txn-mode pooler.
    expect(res.stderr).not.toMatch(/force-exiting/);
    expect(res.stderr).not.toMatch(/did not return within/);
    // Generous CLASS bound (cold bun parse on CI is 10-20s): the op itself is
    // milliseconds; anything that ALSO waited out a 10s teardown backstop
    // lands well past this.
    expect(res.wallMs).toBeLessThan(60_000);
  }, 120_000);

  test('second run (warm schema probe) also exits clean through the pooler', async () => {
    const env = {
      HOME: home,
      GBRAIN_HOME: home,
      GBRAIN_DATABASE_URL: pooledTestDbUrl(),
      GBRAIN_DIRECT_DATABASE_URL: directTestDbUrl(),
    };
    const res = await runCli(['get', SLUG], env, 90_000);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(MARKER);
    expect(res.stderr).not.toMatch(/force-exiting/);
  }, 120_000);

  test('pooled writes, search/query, Minion enqueue, and dream phase remain usable', async () => {
    const previousDirectUrl = process.env.GBRAIN_DIRECT_DATABASE_URL;
    const previousPoolSize = process.env.GBRAIN_POOL_SIZE;
    process.env.GBRAIN_DIRECT_DATABASE_URL = directTestDbUrl();
    process.env.GBRAIN_POOL_SIZE = '2';

    const engine = new PostgresEngine();
    try {
      await engine.connect({
        engine: 'postgres',
        database_url: pooledTestDbUrl(),
        poolSize: 8,
      });

      await engine.putPage('pgbouncer-pooled-write', {
        type: 'note',
        title: 'Pooled write fixture',
        compiled_truth: 'transaction advisory lock through PgBouncer',
        timeline: '',
      });

      const pooledPage = await engine.getPage('pgbouncer-pooled-write', { sourceId: 'default' });
      expect(pooledPage?.title).toBe('Pooled write fixture');
      await engine.upsertChunks('pgbouncer-pooled-write', [{
        chunk_index: 0,
        chunk_text: 'PgBouncer teardown fixture indexed text',
        chunk_source: 'compiled_truth',
      }], { sourceId: 'default' });

      const keywordResults = await engine.searchKeyword('PgBouncer teardown fixture', {
        sourceId: 'default',
        limit: 10,
      });
      expect(keywordResults.some(result => result.slug === 'pgbouncer-pooled-write')).toBe(true);

      const queryResults = await hybridSearch(engine, 'PgBouncer teardown fixture', {
        sourceId: 'default',
        expansion: false,
        relationalRetrieval: false,
        limit: 10,
      });
      expect(queryResults.some(result => result.slug === 'pgbouncer-pooled-write')).toBe(true);

      const queue = new MinionQueue(engine);
      const job = await queue.add('sync', { sourceId: 'default', noEmbed: true }, {
        queue: 'pgbouncer-smoke',
        max_attempts: 1,
      });
      expect((await queue.getJob(job.id))?.id).toBe(job.id);
    } finally {
      await engine.disconnect();
      if (previousDirectUrl === undefined) delete process.env.GBRAIN_DIRECT_DATABASE_URL;
      else process.env.GBRAIN_DIRECT_DATABASE_URL = previousDirectUrl;
      if (previousPoolSize === undefined) delete process.env.GBRAIN_POOL_SIZE;
      else process.env.GBRAIN_POOL_SIZE = previousPoolSize;
    }

    const home = mkdtempSync(join(tmpdir(), 'gbrain-pgbouncer-dream-'));
    try {
      const res = await runCli(['dream', '--phase', 'lint', '--dry-run', '--json', '--dir', home], {
        HOME: home,
        GBRAIN_HOME: home,
        GBRAIN_DATABASE_URL: pooledTestDbUrl(),
        GBRAIN_DIRECT_DATABASE_URL: directTestDbUrl(),
      }, 90_000);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toMatch(/lint|phase|dry/i);
      expect(res.stderr).not.toMatch(/force-exiting|did not return within/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  test('hosted read-pool ceiling limits concurrent PgBouncer backends', async () => {
    const originalPoolSize = process.env.GBRAIN_POOL_SIZE;
    const originalDirectUrl = process.env.GBRAIN_DIRECT_DATABASE_URL;
    process.env.GBRAIN_POOL_SIZE = '2';
    process.env.GBRAIN_DIRECT_DATABASE_URL = directTestDbUrl();
    const pooled = new URL(POOLED_URL!);
    pooled.pathname = `/${TEST_DB}`;
    const engine = new PostgresEngine();
    try {
      // Request more than the hosted ceiling. If the worker-instance path
      // bypasses resolvePoolSize, all eight transactions reach the pooler at
      // once; with the policy, at most two backend queries are active.
      await engine.connect({
        engine: 'postgres',
        database_url: pooled.toString(),
        poolSize: 8,
      });
      const startedAt = performance.now();
      const queries = Array.from({ length: 8 }, () =>
        engine.sql.unsafe('SELECT pg_sleep(0.3)'),
      );
      await Promise.all(queries);
      const elapsedMs = performance.now() - startedAt;
      // Eight 300ms transactions take four waves through a two-connection
      // client pool. An uncapped eight-connection pool finishes in one wave.
      expect(elapsedMs).toBeGreaterThan(750);
    } finally {
      await engine.disconnect();
      if (originalPoolSize === undefined) delete process.env.GBRAIN_POOL_SIZE;
      else process.env.GBRAIN_POOL_SIZE = originalPoolSize;
      if (originalDirectUrl === undefined) delete process.env.GBRAIN_DIRECT_DATABASE_URL;
      else process.env.GBRAIN_DIRECT_DATABASE_URL = originalDirectUrl;
    }
  }, 120_000);

  test('pool-owned timeout contract survives reassignment', async () => {
    const pooled = new URL(POOLED_URL!);
    pooled.pathname = `/${TEST_DB}`;
    const poolUrl = pooled.toString();
    // CI config sets PgBouncer query_timeout=1. Production sets it to 300;
    // the production-shaped run must therefore prove that a normal two-second
    // operation is not accidentally governed by a stale one-second client
    // timeout. Repeating the short-contract branch after each cancellation
    // proves the timeout is owned by the pooler, not one backend.
    for (let i = 0; i < 2; i++) {
      const pool = postgres(poolUrl, { max: 1, prepare: false });
      try {
        let queryError: unknown;
        try {
          await pool.unsafe(`SELECT pg_sleep(${EXPECT_POOL_TIMEOUT ? 2 : 0.1})`);
        } catch (error) {
          queryError = error;
        }
        if (EXPECT_POOL_TIMEOUT) expect(String(queryError)).toMatch(/timeout|cancel|closed|terminat/i);
        else expect(queryError).toBeUndefined();
      } finally {
        await pool.end({ timeout: 5 });
      }
    }

    const pool = postgres(poolUrl, { max: 1, prepare: false });
    try {
      let idleError: unknown;
      try {
        await pool.begin(async tx => {
          await tx`SELECT 1`;
          await new Promise(resolve => setTimeout(resolve, EXPECT_POOL_TIMEOUT ? 1_500 : 100));
          await tx`SELECT 1`;
        });
      } catch (error) {
        idleError = error;
      }
      if (EXPECT_POOL_TIMEOUT) expect(String(idleError)).toMatch(/timeout|idle|closed|terminat/i);
      else expect(idleError).toBeUndefined();
    } finally {
      await pool.end({ timeout: 5 });
    }
  }, 120_000);
});
