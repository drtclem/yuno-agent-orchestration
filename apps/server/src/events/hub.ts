import { SSEEventSchema, type SSEEvent } from '@yuno/shared';
import type { createLogsRepository } from '../db/repos/logs.js';

export function createEventHub(logs: ReturnType<typeof createLogsRepository>) {
  const subscribers = new Set<(event: SSEEvent) => void>();
  return {
    get subscriberCount() {
      return subscribers.size;
    },
    subscribe(listener: (event: SSEEvent) => void) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    publish(input: SSEEvent) {
      const event = SSEEventSchema.parse(input);
      if (event.type === 'log') logs.insert(event.data);
      for (const listener of [...subscribers]) {
        try {
          listener(event);
        } catch {
          // A failed client must not prevent delivery to other clients.
          subscribers.delete(listener);
        }
      }
    },
  };
}
export type EventHub = ReturnType<typeof createEventHub>;
