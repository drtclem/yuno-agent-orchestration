import { describe, expect, it } from 'vitest';
import { AgentSchema, type Memory, type Skill } from '@yuno/shared';
import { compileAgent } from '../src/domain/compile.js';
import { REPLY_PROTOCOL } from '../src/domain/protocol.js';

const id = '00000000-0000-4000-8000-000000000001';
const agent = AgentSchema.parse({
  id,
  name: 'Editor',
  role: 'Careful reviewer',
  systemPrompt: 'Review all submitted changes.',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
});

describe('T6 compiler (R-04, R-05, R-09)', () => {
  it('R-09 T22 rejects traversal and malformed deployment run IDs', () => {
    const deployer = AgentSchema.parse({
      ...agent,
      permissions: { canDeploy: true },
    });
    for (const runId of ['../../other-run', '/etc', 'run*', 'not-a-uuid']) {
      expect(() => compileAgent(deployer, [], [], '', runId)).toThrow(
        'invalid_deployment_run',
      );
    }
  });

  it('R-09 R-27 T22 grants only the current run deployment directory and defaults to no grant', () => {
    const runId = '00000000-0000-4000-8000-000000000099';
    const deployer = AgentSchema.parse({
      ...agent,
      permissions: { canDeploy: true },
    });
    expect(
      compileAgent(deployer, [], [], '', runId).permissions.deploymentDir,
    ).toBe(`/deployments/${runId}/`);
    expect(
      compileAgent(agent, [], [], '', runId).permissions.deploymentDir,
    ).toBeUndefined();
    expect(
      compileAgent(deployer, [], []).permissions.deploymentDir,
    ).toBeUndefined();
  });

  it('R-04 R-05 compiled system contains role, prompt, every fact, every attached skill, workflow instructions and reply protocol', () => {
    const memories: Memory[] = [
      'Prefer concise answers 🌍',
      'Use accessible labels',
    ].map((fact) => ({
      id,
      agentId: id,
      fact,
      source: 'ui',
      createdAt: 1,
    }));
    const skills: Skill[] = [
      {
        id,
        name: 'Review',
        description: 'Review procedure',
        stepsMd: '1. Inspect each change',
        createdAt: 1,
      },
      {
        id,
        name: 'Report',
        description: 'Reporting procedure',
        stepsMd: '1. Write specific feedback',
        createdAt: 1,
      },
    ];
    const compiled = compileAgent(
      agent,
      memories,
      skills,
      'Check the current workflow output.',
    );
    for (const value of [
      agent.role,
      agent.systemPrompt,
      ...memories.map((memory) => memory.fact),
      ...skills.flatMap((skill) => [
        skill.name,
        skill.description,
        skill.stepsMd,
      ]),
      'Check the current workflow output.',
      REPLY_PROTOCOL,
    ]) {
      expect(compiled.systemPrompt).toContain(value);
    }
    expect(REPLY_PROTOCOL).toContain('VERDICT:');
    expect(REPLY_PROTOCOL).toContain('REMEMBER:');
    expect(compiled).toMatchObject({
      agentId: id,
      name: agent.name,
      model: { providerID: 'openai', modelID: 'gpt-5.4-mini' },
      turnTimeoutMs: 600000,
    });
  });

  it('R-09 tool map and effective permissions follow config; blocked commands appear in denyBash', () => {
    const configured = AgentSchema.parse({
      ...agent,
      tools: { bash: true, edit: false, webfetch: true },
      permissions: {
        bash: 'ask',
        edit: 'allow',
        webfetch: 'deny',
        denyBash: ['rm -rf *', 'git push*', 'curl*'],
      },
      guardrails: { turnTimeoutMs: 1234 },
    });
    const compiled = compileAgent(configured, [], []);
    expect(compiled.tools).toEqual(configured.tools);
    expect(compiled.permissions).toEqual({
      bash: 'ask',
      edit: 'deny',
      webfetch: 'deny',
      denyBash: configured.permissions.denyBash,
    });
    expect(compiled.turnTimeoutMs).toBe(1234);
    expect(configured.permissions.edit).toBe('allow');
  });

  it('R-09 compiled mutable config does not mutate the stored agent config', () => {
    const configured = AgentSchema.parse({
      ...agent,
      permissions: { denyBash: ['curl*'] },
    });
    const compiled = compileAgent(configured, [], []);
    compiled.tools.bash = true;
    compiled.permissions.bash = 'allow';
    compiled.permissions.denyBash.push('git push*');
    expect(configured.tools.bash).toBe(false);
    expect(configured.permissions.bash).toBe('deny');
    expect(configured.permissions.denyBash).toEqual(['curl*']);
  });

  it('R-09 preserves allow and ask for enabled tools and denies every disabled tool', () => {
    for (const permission of ['allow', 'ask', 'deny'] as const) {
      for (const enabled of [false, true]) {
        const configured = AgentSchema.parse({
          ...agent,
          tools: { bash: enabled, edit: enabled, webfetch: enabled },
          permissions: {
            bash: permission,
            edit: permission,
            webfetch: permission,
          },
        });
        expect(compileAgent(configured, [], []).permissions).toEqual({
          bash: enabled ? permission : 'deny',
          edit: enabled ? permission : 'deny',
          webfetch: enabled ? permission : 'deny',
          denyBash: [],
        });
      }
    }
  });
});
