import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

// Run against an isolated RUNTIME=fake Docker stack: node scripts/check-docker.mjs
const base = process.argv[2] ?? 'http://127.0.0.1:3000';
async function api(path, body) {
  const response = await fetch(new URL(path, base), {
    signal: AbortSignal.timeout(5000),
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}

assert.equal((await api('/api/health')).runtime.version, 'fake');
const html = await fetch(new URL('/', base), {
  signal: AbortSignal.timeout(5000),
});
assert.equal(html.status, 200);
assert.match(await html.text(), /<div id="root">/);
const workflow = await api('/api/templates/dev-pipeline/load', {});
const run = await api(`/api/workflows/${workflow.id}/runs`, {
  input: 'Build a small static web page',
});
const deadline = Date.now() + 60000;
let result;
while (Date.now() < deadline) {
  result = await api(`/api/runs/${run.id}`);
  if (result.status === 'completed') break;
  assert(!['failed', 'cancelled'].includes(result.status), 'run failed');
  for (const approval of await api('/api/approvals?status=pending')) {
    if (approval.runId === run.id)
      await api(`/api/approvals/${approval.id}`, { decision: 'approve' });
  }
  await setTimeout(250);
}
assert.equal(result?.status, 'completed', 'fake pipeline timed out');
assert.deepEqual(
  result.steps.filter((step) => step.verdict).map((step) => step.verdict),
  ['rejected', 'approved'],
);
assert.equal(result.steps.length, 5);
console.log(
  'Docker acceptance passed: built web, fake health, rejection loop, approval, completed run.',
);
