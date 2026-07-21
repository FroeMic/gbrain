import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function topChangelogVersion(): string {
  const match = read('CHANGELOG.md').match(/^## \[([^\]]+)]/m);
  if (!match) throw new Error('CHANGELOG.md has no release header');
  return match[1];
}

describe('release contract', () => {
  test('upstream release metadata agrees', () => {
    const version = read('VERSION').trim();
    const packageMetadata = JSON.parse(read('package.json')) as { name: string; version: string };
    const lock = Bun.JSONC.parse(read('bun.lock')) as {
      workspaces: { '': { name?: string } };
    };

    expect(version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(packageMetadata.version).toBe(version);
    expect(lock.workspaces[''].name).toBe(packageMetadata.name);
    expect(topChangelogVersion()).toBe(version);
  });

  test('fork release version evolves independently from upstream metadata', () => {
    const upstreamVersion = read('VERSION').trim();
    const forkVersion = read('FORK_VERSION').trim();

    expect(forkVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(forkVersion).not.toBe(upstreamVersion);
  });
});
