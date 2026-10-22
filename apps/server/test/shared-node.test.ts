import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('T3 native Node shared schemas (R-28 persistence startup)', () => {
  it('loads database validation schemas through the package export without a bundler', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { AgentSchema, WorkflowSchema } from '@yuno/shared';
      const id = '00000000-0000-4000-8000-000000000001';
      const agent = AgentSchema.parse({ id, name: 'Writer', role: 'Writer', systemPrompt: 'Write.', status: 'idle', createdAt: 1, updatedAt: 1 });
      assert.equal(agent.model, 'openai/gpt-5.4-mini');
      const workflow = WorkflowSchema.parse({ id, name: 'Draft', description: '', templateId: null, createdAt: 1, updatedAt: 1, graph: { nodes: [{ id: 'write', agentId: id, label: 'Write', position: { x: 0, y: 0 } }], edges: [], startNodeId: 'write' } });
      assert.equal(workflow.graph.maxIterations, 6);
      process.stdout.write('schemas loaded');
    `,
      ],
      {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    expect(output).toBe('schemas loaded');
  });
});
