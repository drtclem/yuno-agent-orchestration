import type { Agent } from '@yuno/shared';
import type { AppDatabase } from '../db/client.js';
import { createApprovalsRepository } from '../db/repos/approvals.js';

export function createGuardrails(db: AppDatabase) {
  const repo = createApprovalsRepository(db);
  return {
    check(agent: Agent, runId: string, now = Date.now()) {
      const usage = repo.budget(agent.id, runId, now);
      const remainingRun = agent.guardrails.runCostCapUsd - usage.runCost;
      const remainingDay = agent.guardrails.dailyCostCapUsd - usage.dailyCost;
      const error =
        remainingRun <= 0
          ? 'run_cost_cap'
          : remainingDay <= 0
            ? 'daily_cost_cap'
            : usage.turns >= agent.guardrails.maxTurnsPerHour
              ? 'rate_limit'
              : null;
      return { error, remainingRun, remainingDay };
    },
    violation(agent: Agent, tool: string, title?: string) {
      if (tool !== 'bash') return false;
      return agent.permissions.denyBash.some((pattern) => {
        const expression = pattern
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*');
        return new RegExp(`^${expression}$`, 's').test(title ?? tool);
      });
    },
  };
}
