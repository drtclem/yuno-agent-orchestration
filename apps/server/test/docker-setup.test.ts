import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const setup = fileURLToPath(
  new URL('../../../scripts/setup.sh', import.meta.url),
);
const reset = fileURLToPath(
  new URL('../../../scripts/reset.sh', import.meta.url),
);

async function resetFixture(failCleanup = false) {
  const directory = await mkdtemp(join(tmpdir(), 'yuno-reset-'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'docker'),
    `#!/bin/sh\nprintf '%s\\n' \"$*\" >> docker-calls\n${failCleanup ? '[ \"$2\" != run ] || exit 1\n' : ''}`,
    { mode: 0o755 },
  );
  async function answer(value: string) {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'sh',
        [reset],
        {
          cwd: directory,
          timeout: 5000,
          env: { PATH: `${bin}:/usr/bin:/bin` },
        },
        (error, _stdout, stderr) => {
          if (error) reject(new Error(stderr));
          else resolve();
        },
      );
      child.stdin?.end(value + '\n');
    });
  }
  return { directory, answer };
}

describe('T14 one-command setup safety (R-30)', () => {
  it('R-30 clean-clone setup creates missing env and data without printing credentials or replacing existing env', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yuno-setup-'));
    try {
      const example =
        'RUNTIME=fake\nOPENAI_API_KEY=\nSLACK_BOT_TOKEN=\nSLACK_APP_TOKEN=\n';
      await writeFile(join(directory, '.env.example'), example);
      await execute('sh', [setup], { cwd: directory, timeout: 5000 });
      expect(await readFile(join(directory, '.env'), 'utf8')).toBe(example);
      expect(
        (await stat(join(directory, 'data', 'workspaces'))).isDirectory(),
      ).toBe(true);
      expect(
        (await stat(join(directory, 'data', 'deployments'))).isDirectory(),
      ).toBe(true);
      const configured =
        'RUNTIME=fake\nOPENAI_API_KEY=test-secret-do-not-print\n';
      await writeFile(join(directory, '.env'), configured);
      const result = await execute('sh', [setup], {
        cwd: directory,
        timeout: 5000,
      });
      expect(await readFile(join(directory, '.env'), 'utf8')).toBe(configured);
      expect(result.stdout + result.stderr).not.toContain(
        'test-secret-do-not-print',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('R-30 reset preserves data on refusal and deletes it only after explicit confirmation', async () => {
    const { directory, answer } = await resetFixture();
    try {
      await mkdir(join(directory, 'data'));
      await writeFile(join(directory, 'data', 'sentinel'), 'persisted');
      await answer('n');
      expect(await readFile(join(directory, 'data', 'sentinel'), 'utf8')).toBe(
        'persisted',
      );
      await expect(
        readFile(join(directory, 'docker-calls')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await answer('yes');
      const calls = (await readFile(join(directory, 'docker-calls'), 'utf8'))
        .trim()
        .split('\n');
      expect(calls).toHaveLength(3);
      expect(calls[0]).toBe('compose down');
      expect(calls[1]).toContain(
        'compose run --rm --no-deps --entrypoint node app -e ',
      );
      expect(calls[1]).toContain('readdirSync');
      expect(calls[1]).toContain('rmSync');
      expect(calls[1]).toContain('/data');
      expect(calls[2]).toBe('compose down --volumes');
      await expect(
        readFile(join(directory, 'data', 'sentinel')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('R-30 reset preserves host data if container cleanup fails', async () => {
    const { directory, answer } = await resetFixture(true);
    try {
      await mkdir(join(directory, 'data'));
      await writeFile(join(directory, 'data', 'sentinel'), 'persisted');
      await expect(answer('yes')).rejects.toThrow();
      expect(await readFile(join(directory, 'data', 'sentinel'), 'utf8')).toBe(
        'persisted',
      );
      const calls = (await readFile(join(directory, 'docker-calls'), 'utf8'))
        .trim()
        .split('\n');
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe('compose down');
      expect(calls[1]).toContain('compose run ');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('R-30 reset refuses a symlinked data directory before stopping containers or deleting files', async () => {
    const { directory, answer } = await resetFixture();
    try {
      const target = join(directory, 'unrelated');
      await mkdir(target);
      await writeFile(join(target, 'sentinel'), 'persisted');
      await symlink(target, join(directory, 'data'));
      await expect(answer('yes')).rejects.toMatchObject({
        message: expect.stringMatching(/symlink|symbolic link/i),
      });
      expect(await readFile(join(target, 'sentinel'), 'utf8')).toBe(
        'persisted',
      );
      await expect(
        readFile(join(directory, 'docker-calls')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
