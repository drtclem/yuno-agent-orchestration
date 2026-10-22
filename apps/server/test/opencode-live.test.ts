import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AgentSchema } from '@yuno/shared';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/client.js';
import { createAgentsRepository } from '../src/db/repos/agents.js';
import { createOpenCodeRuntime } from '../src/runtime/opencode/index.js';
import type { TurnInput } from '../src/runtime/types.js';

it.skipIf(config.LIVE_TESTS !== '1')(
  'R-26 opt-in real OpenCode writes a workspace file and returns positive usage',
  async () => {
    expect(
      Boolean(config.OPENAI_API_KEY),
      'Live OpenCode requires the server to inherit OPENAI_API_KEY',
    ).toBe(true);
    const database = openDatabase(':memory:');
    const workspaceDir = mkdtempSync(join(tmpdir(), 'yuno-opencode-live-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'yuno-opencode-outside-'));
    try {
      const agent = AgentSchema.parse({
        id: '00000000-0000-4000-8000-000000000007',
        name: 'Live writer',
        role: 'Writer',
        systemPrompt: 'Do exactly the requested single action, no exploration.',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      });
      createAgentsRepository(database.db).insert(agent);
      const runtime = createOpenCodeRuntime({
        db: database.db,
        baseUrl: config.OPENCODE_URL,
      });
      expect(await runtime.health()).toMatchObject({ ok: true });
      const input: TurnInput = {
        agent: {
          agentId: agent.id,
          name: agent.name,
          systemPrompt: agent.systemPrompt,
          model: { providerID: 'openai', modelID: 'gpt-5.4-mini' },
          tools: { bash: false, edit: true, webfetch: false },
          permissions: {
            bash: 'deny',
            edit: 'allow',
            webfetch: 'deny',
            denyBash: [],
          },
          turnTimeoutMs: 120000,
        },
        sessionKey: 'live:file',
        workspaceDir,
        prompt:
          'Use the edit/apply_patch tool to create hello.txt containing exactly Yuno T7 passed followed by a newline. Do no other work.',
      };
      const result = await runtime.runTurn(
        input,
        () => undefined,
        new AbortController().signal,
      );
      expect(readFileSync(join(workspaceDir, 'hello.txt'), 'utf8')).toBe(
        'Yuno T7 passed\n',
      );
      expect(result.inputTokens + result.outputTokens).toBeGreaterThan(0);
      expect(result.costUsd).toBeGreaterThan(0);
      expect(result.toolCalls).toContainEqual(
        expect.objectContaining({ status: 'completed' }),
      );
      input.agent.tools.edit = false;
      input.agent.permissions.edit = 'deny';
      input.prompt =
        'Use apply_patch to create denied.txt containing denied. Do not use another tool or explore.';
      const deniedEdit = await runtime.runTurn(
        input,
        () => undefined,
        new AbortController().signal,
      );
      expect(deniedEdit.sessionId).toBe(result.sessionId);
      expect(existsSync(join(workspaceDir, 'denied.txt'))).toBe(false);

      input.agent.tools.bash = true;
      input.agent.permissions.bash = 'ask';
      input.prompt =
        'Run exactly this bash command: printf rejected > rejected.txt . Do not use another tool or explore.';
      const replies: Promise<void>[] = [];
      await runtime.runTurn(
        input,
        (event) => {
          if (event.type === 'permission_request')
            replies.push(
              runtime.respondPermission(
                event.sessionId,
                event.permissionId,
                false,
              ),
            );
        },
        new AbortController().signal,
      );
      await Promise.all(replies);
      expect(replies.length).toBeGreaterThan(0);
      expect(existsSync(join(workspaceDir, 'rejected.txt'))).toBe(false);

      input.agent.permissions.bash = 'allow';
      input.agent.permissions.denyBash = ['printf *'];
      input.prompt =
        'Run exactly this bash command: printf blocked > blocked.txt . Do not use another tool or explore.';
      await runtime.runTurn(
        input,
        () => undefined,
        new AbortController().signal,
      );
      expect(existsSync(join(workspaceDir, 'blocked.txt'))).toBe(false);

      input.agent.tools.bash = false;
      input.agent.tools.edit = true;
      input.agent.permissions.edit = 'allow';
      input.prompt = `Use apply_patch to create ${join(outsideDir, 'outside.txt')} containing outside. Do not use another tool or explore.`;
      await runtime.runTurn(
        input,
        () => undefined,
        new AbortController().signal,
      );
      expect(existsSync(join(outsideDir, 'outside.txt'))).toBe(false);
    } finally {
      database.close();
      rmSync(outsideDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  },
  660000,
);
