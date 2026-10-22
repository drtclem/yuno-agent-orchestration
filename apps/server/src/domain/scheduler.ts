import { Cron } from 'croner';
import type { Schedule } from '@yuno/shared';
import type { openDatabase } from '../db/client.js';
import { createConfigurationRepository } from '../db/repos/configuration.js';
import type { EventHub } from '../events/hub.js';
import type { createEngine } from './engine.js';

type Input = Pick<Schedule, 'kind' | 'expr'>;
// Croner owns cron parsing and timers; UTC makes container and local execution agree.
// https://github.com/Hexagon/croner#documentation
export function validateSchedule(input: Input) {
  if (input.kind !== 'cron') return;
  try {
    const job = new Cron(input.expr, { timezone: 'UTC', paused: true });
    job.stop();
    if (job.getOnce()) throw new Error('Cron must recur');
  } catch {
    throw Object.assign(new Error('Invalid cron expression'), {
      statusCode: 400,
    });
  }
}

export function createScheduler({
  db,
  hub,
  engine,
}: {
  db: ReturnType<typeof openDatabase>['db'];
  hub: EventHub;
  engine: ReturnType<typeof createEngine>;
}) {
  const repo = createConfigurationRepository(db);
  const jobs = new Map<string, { signature: string; job: Cron }>();
  let started = false;
  function log(schedule: Schedule, event: string, reason: string) {
    const ts = Date.now();
    hub.publish({
      type: 'log',
      ts,
      data: {
        id: crypto.randomUUID(),
        ts,
        level: event === 'schedule_failed' ? 'error' : 'info',
        agentId: schedule.agentId,
        runId: null,
        event,
        data: { scheduleId: schedule.id, reason },
      },
    });
  }
  function arm(schedule: Schedule, signature: string) {
    const pattern =
      schedule.kind === 'interval'
        ? new Date(Date.now() + Number(schedule.expr) * 1000)
        : schedule.expr;
    const job = new Cron(pattern, { timezone: 'UTC' }, () => {
      if (!started) return;
      try {
        const workflow = schedule.workflowId
          ? engine.getWorkflow(schedule.workflowId)
          : undefined;
        const startAgent =
          workflow?.graph.nodes.find(
            (node) => node.id === workflow.graph.startNodeId,
          )?.agentId ?? schedule.agentId;
        if (
          repo.agentBusy(schedule.agentId) ||
          (startAgent && repo.agentBusy(startAgent))
        ) {
          log(schedule, 'schedule_skipped', 'agent_busy');
        } else {
          engine.startScheduled(schedule);
          repo.scheduleTiming(schedule.id, {
            lastRunAt: Date.now(),
            nextRunAt: null,
          });
        }
      } catch {
        log(schedule, 'schedule_failed', 'schedule_start_failed');
      } finally {
        if (schedule.kind === 'interval') arm(schedule, signature);
        else
          repo.scheduleTiming(schedule.id, {
            nextRunAt: job.nextRun()?.getTime() ?? null,
          });
      }
    });
    jobs.set(schedule.id, { signature, job });
    repo.scheduleTiming(schedule.id, {
      nextRunAt: job.nextRun()?.getTime() ?? null,
    });
  }
  function reload() {
    if (!started) return;
    const schedules = repo.allSchedules();
    const enabled = new Set(
      schedules.filter((s) => s.enabled).map((s) => s.id),
    );
    for (const [id, entry] of jobs) {
      if (!enabled.has(id)) {
        entry.job.stop();
        jobs.delete(id);
      }
    }
    for (const schedule of schedules) {
      if (!schedule.enabled) {
        repo.scheduleTiming(schedule.id, { nextRunAt: null });
        continue;
      }
      const signature = JSON.stringify([
        schedule.kind,
        schedule.expr,
        schedule.prompt,
        schedule.workflowId,
        schedule.agentId,
      ]);
      const previous = jobs.get(schedule.id);
      if (previous?.signature === signature) {
        repo.scheduleTiming(schedule.id, {
          nextRunAt: previous.job.nextRun()?.getTime() ?? null,
        });
        continue;
      }
      previous?.job.stop();
      jobs.delete(schedule.id);
      try {
        validateSchedule(schedule);
        arm(schedule, signature);
      } catch {
        repo.scheduleTiming(schedule.id, { nextRunAt: null });
        log(schedule, 'schedule_failed', 'invalid_schedule');
      }
    }
  }
  return {
    reload,
    start() {
      if (started) return;
      started = true;
      reload();
    },
    stop() {
      started = false;
      for (const { job } of jobs.values()) job.stop();
      jobs.clear();
    },
  };
}
