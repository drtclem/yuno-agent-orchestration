import type { Approval, RunStep, SSEEvent } from '@yuno/shared';
import type { openDatabase, AppDatabase } from '../db/client.js';
import { createApprovalsRepository } from '../db/repos/approvals.js';
import { createExecutionRepository } from '../db/repos/execution.js';
import type { EventHub } from '../events/hub.js';
import type { AgentRuntime, RuntimeEvent } from '../runtime/types.js';

const EXPIRY = 30 * 60000;
const active = (status: string) =>
  ['running', 'queued', 'waiting_approval'].includes(status);
const conflict = (): never => {
  throw Object.assign(new Error('Approval is no longer pending'), {
    statusCode: 409,
  });
};
export function createApprovals({
  db,
  hub,
  runtime,
  abortRun,
}: {
  db: ReturnType<typeof openDatabase>['db'];
  hub: EventHub;
  runtime: AgentRuntime | undefined;
  abortRun: (runId: string) => void;
}) {
  const repo = createApprovalsRepository(db);
  const resolving = new Set<string>();
  const settlements = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | undefined;
  const publish = (events: SSEEvent[]) => {
    for (const event of events) hub.publish(event);
  };
  function statusEvents(tx: AppDatabase, agentId: string): SSEEvent[] {
    const agent = createExecutionRepository(tx).settleAgentStatus(
      agentId,
      Date.now(),
    );
    return agent
      ? [
          {
            type: 'agent.status',
            ts: Date.now(),
            data: { agentId, status: agent.status },
          },
        ]
      : [];
  }
  function finishPending(
    tx: AppDatabase,
    runId: string,
    status: 'rejected' | 'expired',
  ): SSEEvent[] {
    const store = createApprovalsRepository(tx);
    return store
      .list('pending')
      .filter((a) => a.runId === runId)
      .flatMap((a) => {
        const data = store.resolve(a.id, status, Date.now());
        return data
          ? [{ type: 'approval.resolved' as const, ts: Date.now(), data }]
          : [];
      });
  }
  function failRun(tx: AppDatabase, runId: string, error: string): SSEEvent[] {
    const store = createExecutionRepository(tx);
    const current = store.getRun(runId);
    if (!current || !active(current.status)) return [];
    const data = {
      ...current,
      status: 'failed' as const,
      error,
      finishedAt: Date.now(),
    };
    store.updateRun(data);
    const steps = store.stopSteps(runId, error, Date.now());
    return [
      { type: 'run.updated', ts: Date.now(), data },
      ...steps.map((data) => ({
        type: 'step.updated' as const,
        ts: Date.now(),
        data,
      })),
      ...store.stopMessages(runId, error, Date.now()).map((data) => ({
        type: 'message.updated' as const,
        ts: Date.now(),
        data,
      })),
      ...finishPending(tx, runId, 'rejected'),
      ...[...new Set(steps.map((s) => s.agentId))].flatMap((id) =>
        statusEvents(tx, id),
      ),
    ];
  }
  function create(
    tx: AppDatabase,
    step: RunStep,
    kind: Approval['kind'],
    detail: string,
    request?: Extract<RuntimeEvent, { type: 'permission_request' }>,
  ): SSEEvent[] {
    const store = createApprovalsRepository(tx);
    if (
      request &&
      store
        .list()
        .some(
          (a) =>
            a.stepId === step.id &&
            a.runtimePermissionId === request.permissionId,
        )
    )
      return [];
    const data: Approval = {
      id: crypto.randomUUID(),
      runId: step.runId,
      stepId: step.id,
      agentId: step.agentId,
      kind,
      detail: detail || 'Tool permission',
      runtimeSessionId: request?.sessionId ?? null,
      runtimePermissionId: request?.permissionId ?? null,
      status: 'pending',
      createdAt: Date.now(),
      resolvedAt: null,
    };
    store.insert(data);
    const execution = createExecutionRepository(tx);
    const run = execution.getRun(step.runId);
    if (!run || !active(run.status)) throw new Error('run_terminal');
    const waiting = { ...run, status: 'waiting_approval' as const };
    execution.updateRun(waiting);
    return [
      { type: 'approval.created', ts: Date.now(), data },
      { type: 'run.updated', ts: Date.now(), data: waiting },
      ...statusEvents(tx, step.agentId),
    ];
  }
  async function resolve(
    id: string,
    decision: 'approve' | 'reject',
    expired = false,
  ) {
    const approval = repo.get(id);
    if (!approval)
      throw Object.assign(new Error('Resource not found'), { statusCode: 404 });
    if (approval.status !== 'pending' || resolving.has(id)) return conflict();
    const run = createExecutionRepository(db).getRun(approval.runId);
    if (!run || !active(run.status)) return conflict();
    const timeout = expired || Date.now() >= approval.createdAt + EXPIRY;
    const allow = decision === 'approve' && !timeout;
    resolving.add(id);
    let settled: (() => void) | undefined;
    settlements.set(
      id,
      new Promise<void>((resolve) => {
        settled = resolve;
      }),
    );
    let deliveryFailed = false;
    try {
      if (approval.kind === 'tool_permission') {
        try {
          if (
            !runtime ||
            !approval.runtimeSessionId ||
            !approval.runtimePermissionId
          )
            throw new Error('permission_unavailable');
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              runtime.respondPermission(
                approval.runtimeSessionId,
                approval.runtimePermissionId,
                allow,
              ),
              new Promise<never>((_resolve, reject) => {
                deadline = setTimeout(
                  () => reject(new Error('permission_reply_failed')),
                  5000,
                );
              }),
            ]);
          } finally {
            clearTimeout(deadline);
          }
        } catch {
          deliveryFailed = true;
        }
      }
      const events = db.transaction((tx) => {
        const store = createApprovalsRepository(tx);
        const resolved = store.resolve(
          id,
          timeout
            ? 'expired'
            : allow && !deliveryFailed
              ? 'approved'
              : 'rejected',
          Date.now(),
        );
        if (!resolved) return [];
        const result: SSEEvent[] = [
          { type: 'approval.resolved', ts: Date.now(), data: resolved },
        ];
        const execution = createExecutionRepository(tx);
        const current = execution.getRun(approval.runId);
        if (!current || !active(current.status)) return result;
        if (!allow || deliveryFailed)
          return [
            ...result,
            ...failRun(
              tx,
              approval.runId,
              deliveryFailed
                ? 'permission_reply_failed'
                : timeout
                  ? 'approval_expired'
                  : 'approval_rejected',
            ),
          ];
        if (!store.list('pending').some((a) => a.runId === approval.runId)) {
          const resumed = { ...current, status: 'running' as const };
          execution.updateRun(resumed);
          result.push({ type: 'run.updated', ts: Date.now(), data: resumed });
        }
        result.push(...statusEvents(tx, approval.agentId));
        return result;
      });
      publish(events);
      if (!allow || deliveryFailed) abortRun(approval.runId);
      return repo.get(id);
    } finally {
      resolving.delete(id);
      settled?.();
      settlements.delete(id);
    }
  }
  async function sweep() {
    for (const approval of repo.list('pending')) {
      if (
        Date.now() >= approval.createdAt + EXPIRY &&
        !resolving.has(approval.id)
      )
        await resolve(approval.id, 'reject', true);
    }
  }
  return {
    list: repo.list,
    resolve,
    gate(tx: AppDatabase, step: RunStep) {
      return create(tx, step, 'step_gate', `Approve node ${step.nodeId}`);
    },
    gateApproved(stepId: string) {
      return repo
        .list('approved')
        .some((a) => a.stepId === stepId && a.kind === 'step_gate');
    },
    tool(
      step: RunStep,
      request: Extract<RuntimeEvent, { type: 'permission_request' }>,
    ) {
      publish(
        db.transaction((tx) =>
          create(tx, step, 'tool_permission', request.detail, request),
        ),
      );
    },
    async settled(stepId: string) {
      await Promise.all(
        repo
          .list('pending')
          .filter((a) => a.stepId === stepId)
          .map((a) => settlements.get(a.id)),
      );
    },
    pending(stepId: string) {
      return repo.list('pending').some((a) => a.stepId === stepId);
    },
    cancel(tx: AppDatabase, runId: string) {
      return finishPending(tx, runId, 'rejected');
    },
    settleAgent(agentId: string) {
      publish(db.transaction((tx) => statusEvents(tx, agentId)));
    },
    clear(runId: string) {
      publish(db.transaction((tx) => finishPending(tx, runId, 'rejected')));
    },
    fail(runId: string, error: string) {
      publish(db.transaction((tx) => failRun(tx, runId, error)));
      abortRun(runId);
    },
    async start() {
      // The adapter cannot reattach an interrupted invocation; never replay its pending tools.
      for (const approval of repo.list('pending')) {
        const run = createExecutionRepository(db).getRun(approval.runId);
        if (!run || !active(run.status)) {
          publish(
            db.transaction((tx) => {
              const events = finishPending(tx, approval.runId, 'rejected');
              const stopped = createExecutionRepository(tx).stopSteps(
                approval.runId,
                'run_terminal',
                Date.now(),
              );
              return [
                ...events,
                ...stopped.map((data) => ({
                  type: 'step.updated' as const,
                  ts: Date.now(),
                  data,
                })),
                ...statusEvents(tx, approval.agentId),
              ];
            }),
          );
        } else if (approval.kind === 'tool_permission') {
          publish(
            db.transaction((tx) =>
              failRun(tx, approval.runId, 'approval_interrupted'),
            ),
          );
        }
      }
      await sweep();
      timer = setInterval(() => {
        if (sweeping) return;
        sweeping = sweep()
          .catch(() => {
            // Database failures must stay visible without exposing runtime exception text.
            console.error('Approval expiry failed');
          })
          .finally(() => {
            sweeping = undefined;
          });
      }, 1000);
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await Promise.allSettled([...settlements.values(), sweeping]);
    },
  };
}
