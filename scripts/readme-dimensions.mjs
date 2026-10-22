import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { AGENT_DIMENSIONS } from '../packages/shared/src/dimensions.ts';

const file = new URL('../README.md', import.meta.url);
const content = await readFile(file, 'utf8');
const marker = /<!-- dimensions:start -->[\s\S]*?<!-- dimensions:end -->/;
assert(marker.test(content), 'README dimensions markers are missing');
const section = (
  await format(
    `<!-- dimensions:start -->\nYuno exposes **${AGENT_DIMENSIONS.length} configurable dimensions per agent**, defined in [the shared list](packages/shared/src/dimensions.ts). The editor shows the same count, grouped by setting, and how many are set on the current agent.\n<!-- dimensions:end -->`,
    { parser: 'markdown' },
  )
).trimEnd();
const updated = content.replace(marker, section);
if (process.argv.includes('--check')) {
  assert.equal(
    content,
    updated,
    'Run pnpm dimensions:update to sync README with the shared list',
  );
} else {
  await writeFile(file, updated);
}
