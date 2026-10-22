import type { Agent } from '@yuno/shared';
import type { AppDatabase } from '../db/client.js';
import { createAgentsRepository } from '../db/repos/agents.js';
import type { EventHub } from '../events/hub.js';

export function createAgentStatusService(db: AppDatabase, hub: EventHub) {
  const agents = createAgentsRepository(db);
  return {
    setStatus(id: string, status: Agent['status']) {
      const current = agents.get(id);
      if (current === undefined || current.status === status) return current;
      const ts = Date.now();
      const updated = agents.setStatus(id, status, ts);
      if (updated)
        hub.publish({
          type: 'agent.status',
          ts,
          data: { agentId: id, status },
        });
      return updated;
    },
  };
}
