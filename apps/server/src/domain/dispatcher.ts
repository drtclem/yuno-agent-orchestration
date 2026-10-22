import type { Message } from '@yuno/shared';
import type { openDatabase } from '../db/client.js';
import {
  createQueueRepository,
  type ProcessingResult,
} from '../db/repos/queue.js';
import type { EventHub } from '../events/hub.js';

export function createDispatcher({
  db,
  hub,
  processMessage,
}: {
  db: ReturnType<typeof openDatabase>['db'];
  hub: EventHub;
  processMessage: (
    message: Message,
    signal: AbortSignal,
  ) => Promise<ProcessingResult>;
}) {
  const queue = createQueueRepository(db);
  const active = new Map<
    string,
    { controller: AbortController; done: Promise<void>; runId: string | null }
  >();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | undefined;
  const updated = (message: Message) =>
    hub.publish({ type: 'message.updated', ts: Date.now(), data: message });

  async function execute(message: Message, controller: AbortController) {
    let committed: ReturnType<typeof queue.complete> | undefined;
    try {
      const completion = await processMessage(message, controller.signal);
      controller.signal.throwIfAborted();
      committed = queue.complete(message, Date.now(), completion);
    } catch {
      if (controller.signal.aborted) {
        const released = queue.release(message, Date.now());
        if (released) updated(released);
      } else {
        const result = queue.fail(message, Date.now());
        if (result.message) updated(result.message);
        if (result.run)
          hub.publish({
            type: 'run.updated',
            ts: Date.now(),
            data: result.run,
          });
      }
    } finally {
      active.delete(message.toAgentId);
    }
    if (committed) {
      updated(committed.message);
      for (const event of committed.events) hub.publish(event);
    }
  }
  function pump() {
    if (!timer) return;
    try {
      while (active.size < 4) {
        const message = queue.claim(Date.now(), new Set(active.keys()));
        if (!message) break;
        const controller = new AbortController();
        // Defer execution until its slot is registered, including synchronous processor failures.
        const done = Promise.resolve().then(() => execute(message, controller));
        active.set(message.toAgentId, {
          controller,
          done,
          runId: message.runId,
        });
        updated(message);
        void done.catch(() => halt('dispatcher_persistence_failed'));
      }
    } catch {
      halt('dispatcher_claim_failed');
    }
  }
  function halt(event: string) {
    clearInterval(timer);
    timer = undefined;
    try {
      const ts = Date.now();
      hub.publish({
        type: 'log',
        ts,
        data: {
          id: crypto.randomUUID(),
          ts,
          level: 'error',
          agentId: null,
          runId: null,
          event,
          data: {},
        },
      });
    } catch {
      // Persistence may be unavailable; keep this failure visible without leaking exception text.
      console.error('Dispatcher stopped: persistence unavailable');
    }
  }
  return {
    enqueue(message: Message) {
      const result = queue.enqueue(message);
      if (result.created)
        hub.publish({
          type: 'message.created',
          ts: Date.now(),
          data: result.message,
        });
      return result.message;
    },
    start() {
      if (timer) return;
      if (stopping || active.size) throw new Error('dispatcher_stopping');
      const recovered = queue.recover(Date.now());
      for (const message of recovered) updated(message);
      timer = setInterval(pump, 100);
      pump();
    },
    cancelRun(runId: string) {
      for (const task of active.values())
        if (task.runId === runId)
          task.controller.abort(new Error('run_cancelled'));
    },
    stop() {
      if (stopping) return stopping;
      clearInterval(timer);
      timer = undefined;
      for (const task of active.values())
        task.controller.abort(new Error('dispatcher_stopped'));
      stopping = Promise.allSettled(
        [...active.values()].map((task) => task.done),
      ).then(() => {
        stopping = undefined;
      });
      return stopping;
    },
  };
}
