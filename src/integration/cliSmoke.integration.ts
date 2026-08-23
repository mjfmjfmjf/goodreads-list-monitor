import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── CLI smoke tests ───────────────────────────────────────────────────────
// These spawn the REAL entry point under the production loader (ts-node/esm)
// instead of vitest's own transformer. Vitest compiles TypeScript permissively,
// so a module-graph type error can pass every unit test yet crash
// `node src/index.ts` at load time for every command. Loading --help here
// exercises the whole import graph exactly like production does.
//
// Offline: --help never hits Goodreads; author-top-stats reads only the local
// SQLite db.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runCli(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      'node',
      ['src/index.ts', ...args],
      {
        cwd: repoRoot,
        timeout: 120_000,
        env: { ...process.env, NODE_OPTIONS: '--loader ts-node/esm --no-warnings' },
      },
      (error, stdout) => {
        resolve({ code: error && (error as any).code ? Number((error as any).code) : 0, stdout });
      }
    );
  });
}

describe('CLI smoke (production ts-node loader)', () => {
  it('loads the full command graph without crashing', async () => {
    const { code, stdout } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('author-top-stats');
    expect(stdout).toContain('author-list-diff');
  }, 180_000);

  it('runs an offline command end to end', async () => {
    const { code, stdout } = await runCli(['author-top-stats', '--limit', '1', '--minRatings', '1000000']);
    expect(code).toBe(0);
    expect(stdout).toContain('Top Authors by');
  }, 180_000);
});
