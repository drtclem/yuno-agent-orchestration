import { ModelSchema, type Agent, type Memory, type Skill } from '@yuno/shared';
import type { CompiledAgent } from '../runtime/types.js';
import { REPLY_PROTOCOL } from './protocol.js';

export function compileAgent(
  agent: Agent,
  memories: readonly Memory[],
  skills: readonly Skill[],
  instructions = '',
  runId?: string,
): CompiledAgent {
  if (!ModelSchema.safeParse(agent.model).success)
    throw new Error('model_not_allowed');
  const deploymentDir =
    agent.permissions.canDeploy && runId ? `/deployments/${runId}/` : undefined;
  if (
    deploymentDir &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      runId ?? '',
    )
  )
    throw new Error('invalid_deployment_run');
  const separator = agent.model.indexOf('/');
  return {
    agentId: agent.id,
    name: agent.name,
    systemPrompt: [
      `Role: ${agent.role}`,
      agent.systemPrompt,
      ...memories.map((memory) => `Memory: ${memory.fact}`),
      ...skills.map(
        (skill) =>
          `Skill: ${skill.name}\n${skill.description}\n${skill.stepsMd}`,
      ),
      instructions,
      deploymentDir
        ? REPLY_PROTOCOL.replace(
            'Work only inside the workspace directory you are given.',
            `Work only inside the workspace directory you are given, except you may copy approved output to ${deploymentDir}. No other outside directory is allowed.`,
          )
        : REPLY_PROTOCOL,
    ]
      .filter(Boolean)
      .join('\n\n'),
    model: {
      providerID: agent.model.slice(0, separator),
      modelID: agent.model.slice(separator + 1),
    },
    tools: { ...agent.tools },
    permissions: {
      bash: agent.tools.bash ? agent.permissions.bash : 'deny',
      edit: agent.tools.edit ? agent.permissions.edit : 'deny',
      webfetch: agent.tools.webfetch ? agent.permissions.webfetch : 'deny',
      denyBash: [...agent.permissions.denyBash],
      ...(deploymentDir ? { deploymentDir } : {}),
    },
    turnTimeoutMs: agent.guardrails.turnTimeoutMs,
  };
}
