import { createChatRepository } from '../db/repos/chat.js';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  validateGraph,
  ModelSchema,
  type Message,
  type Schedule,
  type Run,
  type RunStep,
  type SSEEvent,
  type WorkflowGraph,
} from '@yuno/shared';
import type { openDatabase } from '../db/client.js';
import type { Completion } from '../db/repos/queue.js';
import { createExecutionRepository } from '../db/repos/execution.js';
import { createWorkflowsRepository } from '../db/repos/workflows.js';
import { createConfigurationRepository } from '../db/repos/configuration.js';
import type { EventHub } from '../events/hub.js';
import type { AgentRuntime, TurnResult } from '../runtime/types.js';
import { createDispatcher } from './dispatcher.js';
import { createAgentStatusService } from './agent-status.js';
import { compileAgent } from './compile.js';
import { parseReply } from './protocol.js';
import { createGuardrails } from './guardrails.js';
import { createApprovals } from './approvals.js';

const fail = (message: string, statusCode: number): never => {
  throw Object.assign(new Error(message), { statusCode });
};
const running = (run: Run) =>
  ['running', 'queued', 'waiting_approval'].includes(run.status);
function nextEdge(
  graph: WorkflowGraph,
  nodeId: string,
  text: string,
  verdict: RunStep['verdict'],
) {
  return graph.edges.find(
    (edge) =>
      edge.source === nodeId &&
      (edge.condition === 'always' ||
        (typeof edge.condition === 'object'
          ? text.toLowerCase().includes(edge.condition.contains.toLowerCase())
          : edge.condition === verdict)),
  );
}
export function createEngine({
  db,
  hub,
  runtime,
  dataDir,
}: {
  db: ReturnType<typeof openDatabase>['db'];
  hub: EventHub;
  runtime: AgentRuntime | undefined;
  dataDir: string;
}) {
  let chatDelivery: ((message: Message) => Promise<void>) | undefined;
  const repo = createExecutionRepository(db);
  const workflows = createWorkflowsRepository(db);
  const config = createConfigurationRepository(db);
  const statuses = createAgentStatusService(db, hub);
  const guardrails = createGuardrails(db);
  const approvals = createApprovals({
    db,
    hub,
    runtime,
    abortRun: (id) => dispatcher.cancelRun(id),
  });
  const publish = (events: SSEEvent[]) => {
    for (const event of events) hub.publish(event);
  };
  const eventRun = (run: Run): SSEEvent => ({
    type: 'run.updated',
    ts: Date.now(),
    data: run,
  });
  function stopSteps(
    store: ReturnType<typeof createExecutionRepository>,
    runId: string,
    error: string,
    now: number,
  ): SSEEvent[] {
    const stopped = store.stopSteps(runId, error, now);
    const events: SSEEvent[] = stopped.map((data) => ({
      type: 'step.updated',
      ts: now,
      data,
    }));
    for (const agentId of new Set(stopped.map((step) => step.agentId))) {
      const settled = store.settleAgentStatus(agentId, now);
      if (settled)
        events.push({
          type: 'agent.status',
          ts: now,
          data: { agentId, status: settled.status },
        });
    }
    return events;
  }
  function checkGraph(graph: WorkflowGraph) {
    const errors = validateGraph(
      graph,
      config.listAgents().map((agent) => agent.id),
    );
    if (errors.length) fail(`Invalid graph: ${errors.join('; ')}`, 400);
  }
  function standaloneGraph(agentId: string): WorkflowGraph {
    return {
      nodes: [
        {
          id: 'agent',
          agentId,
          label: 'Scheduled turn',
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      startNodeId: 'agent',
      maxIterations: 6,
    };
  }
  function begin(
    workflowId: string | null,
    input: string,
    trigger: Run['trigger'],
    graph: WorkflowGraph,
  ): Run;
  function begin(
    workflowId: string | null,
    input: string,
    trigger: Run['trigger'],
    graph: WorkflowGraph,
    chat: {
      conversationId: string;
      agentId: string;
      channel: 'slack' | 'ui';
      externalEventId: string;
      userId: string;
      userName?: string | undefined;
    },
  ): Run | undefined;
  function begin(
    workflowId: string | null,
    input: string,
    trigger: Run['trigger'],
    graph: WorkflowGraph,
    chat?: {
      conversationId: string;
      agentId: string;
      channel: 'slack' | 'ui';
      externalEventId: string;
      userId: string;
      userName?: string | undefined;
    },
  ) {
    if (!runtime) fail('guardrails_unavailable', 503);
    const run: Run = {
      id: crypto.randomUUID(),
      workflowId,
      graphSnapshot: workflowId ? graph : null,
      trigger,
      input,
      status: 'running',
      result: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      totalCostUsd: 0,
      totalTokens: 0,
    };
    const first = message(run, graph.startNodeId, input, undefined, graph);
    if (chat)
      Object.assign(first, {
        conversationId: chat.conversationId,
        channel: chat.channel,
        fromId: chat.userId,
        fromName: chat.userName ?? null,
      });
    const accepted = db.transaction((tx) => {
      if (chat && !createChatRepository(tx).accept(chat)) return false;
      const store = createExecutionRepository(tx);
      store.insertRun(run);
      store.insertMessage(first);
      return true;
    });
    if (!accepted) return undefined;
    publish([
      eventRun(run),
      { type: 'message.created', ts: Date.now(), data: first },
    ]);
    return run;
  }
  function message(
    run: Run,
    nodeId: string,
    content: string,
    predecessor?: RunStep,
    graph?: WorkflowGraph,
  ): Message {
    const workflow = run.workflowId ? workflows.get(run.workflowId) : undefined;
    const node = (graph ?? run.graphSnapshot ?? workflow?.graph)?.nodes.find(
      (candidate) => candidate.id === nodeId,
    );
    if (!node) throw new Error('node_missing');
    const now = Date.now();
    return {
      id: crypto.randomUUID(),
      runId: run.id,
      conversationId: null,
      fromKind: predecessor ? 'agent' : 'human',
      fromId: predecessor?.agentId ?? run.trigger,
      fromName: !predecessor && run.trigger === 'ui' ? 'You (UI)' : null,
      toAgentId: node.agentId,
      channel: predecessor
        ? 'internal'
        : run.trigger === 'schedule'
          ? 'schedule'
          : 'ui',
      content,
      verdict: predecessor?.verdict ?? null,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      idempotencyKey: predecessor
        ? `run:${run.id}:step:${predecessor.id}`
        : `run:${run.id}:start`,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
  }
  const dispatcher = createDispatcher({
    db,
    hub,
    processMessage: async (incoming, signal) => {
      const run = incoming.runId ? repo.getRun(incoming.runId) : undefined;
      if (!run || !running(run)) throw new Error('run_missing');
      const workflow = run.graphSnapshot
        ? { graph: run.graphSnapshot }
        : run.workflowId
          ? workflows.get(run.workflowId)
          : run.trigger === 'schedule' || run.trigger === 'chat'
            ? { graph: standaloneGraph(incoming.toAgentId) }
            : undefined;
      if (!workflow) throw new Error('workflow_missing');
      const previous = repo.steps(run.id);
      const predecessor = previous.find(
        (step) => incoming.idempotencyKey === `run:${run.id}:step:${step.id}`,
      );
      const nodeId =
        incoming.idempotencyKey === `run:${run.id}:start`
          ? workflow.graph.startNodeId
          : predecessor
            ? nextEdge(
                workflow.graph,
                predecessor.nodeId,
                predecessor.output ?? '',
                predecessor.verdict,
              )?.target
            : undefined;
      const node = workflow.graph.nodes.find(
        (candidate) => candidate.id === nodeId,
      );
      const agent = config.getAgent(incoming.toAgentId);
      const terminal =
        (error: string): Completion =>
        (tx) => {
          const store = createExecutionRepository(tx);
          const current = store.getRun(run.id);
          if (!current || !running(current)) return [];
          const failed: Run = {
            ...current,
            status: 'failed',
            error,
            finishedAt: Date.now(),
          };
          store.updateRun(failed);
          return [
            eventRun(failed),
            ...stopSteps(store, run.id, error, Date.now()),
          ];
        };
      if (!runtime) return terminal('guardrails_unavailable');
      if (!node || !agent || node.agentId !== incoming.toAgentId)
        return terminal('node_missing');
      const placeholder = previous.find(
        (step) =>
          step.nodeId === node.id &&
          step.status === 'blocked' &&
          step.finishedAt === null,
      );
      const iteration =
        placeholder?.iteration ??
        previous.filter((step) => step.nodeId === node.id).length + 1;
      if (iteration > workflow.graph.maxIterations)
        return terminal('loop_limit');
      if (!ModelSchema.safeParse(agent.model).success)
        return terminal('model_not_allowed');
      if (agent.status === 'disabled') return terminal('agent_disabled');
      // Close interrupted work before filesystem setup, which can fail before a turn starts.
      if (!placeholder)
        publish(
          db.transaction((tx) =>
            stopSteps(
              createExecutionRepository(tx),
              run.id,
              'turn_interrupted',
              Date.now(),
            ),
          ),
        );
      const workspaceDir = incoming.conversationId
        ? resolve(dataDir, 'workspaces', 'agents', agent.id)
        : resolve(dataDir, 'workspaces', `run-${run.id}`);
      mkdirSync(workspaceDir, { recursive: true });
      signal.throwIfAborted();
      const prompt = [
        node.instructions,
        `From ${incoming.fromKind}: ${incoming.fromId}\n${incoming.content}`,
        `Workspace: ${workspaceDir}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      const step: RunStep = {
        id: placeholder?.id ?? crypto.randomUUID(),
        runId: run.id,
        nodeId: node.id,
        agentId: agent.id,
        iteration,
        status: 'running',
        prompt,
        output: null,
        verdict: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
      };
      if (
        node.requiresApproval &&
        (!placeholder || !approvals.gateApproved(placeholder.id))
      ) {
        return {
          park: (tx) => {
            const store = createExecutionRepository(tx);
            const blocked: RunStep = { ...step, status: 'blocked' };
            store.insertStep(blocked);
            return [
              { type: 'step.updated', ts: Date.now(), data: blocked },
              ...approvals.gate(tx, blocked),
            ];
          },
        };
      }
      const budget = guardrails.check(agent, run.id);
      if (budget.error) {
        const blocked: RunStep = {
          ...step,
          status: 'blocked',
          error: budget.error,
          finishedAt: Date.now(),
        };
        return (tx) => {
          const store = createExecutionRepository(tx);
          if (placeholder) store.updateStep(blocked);
          else store.insertStep(blocked);
          return [
            { type: 'step.updated', ts: Date.now(), data: blocked },
            {
              type: 'log',
              ts: Date.now(),
              data: {
                id: crypto.randomUUID(),
                ts: Date.now(),
                level: 'warn',
                agentId: agent.id,
                runId: run.id,
                event: 'guardrail_blocked',
                data: { reason: budget.error },
              },
            },
            ...terminal(budget.error ?? 'guardrail_blocked')(tx),
          ];
        };
      }
      if (incoming.channel === 'slack') {
        try {
          if (!chatDelivery) return terminal('channel_unavailable');
          await chatDelivery(incoming);
          signal.throwIfAborted();
        } catch {
          return terminal('channel_delivery_failed');
        }
      }
      if (placeholder) repo.updateStep(step);
      else repo.insertStep(step);
      hub.publish({ type: 'step.updated', ts: Date.now(), data: step });
      statuses.setStatus(agent.id, 'working');
      let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      let result: TurnResult;
      let policyError: string | undefined;
      const policyAbort = new AbortController();
      const recordUsage = (nextUsage: typeof usage) => {
        const updated = db.transaction((tx) => {
          const store = createExecutionRepository(tx);
          const current = store.getRun(run.id);
          if (!current || !running(current)) return undefined;
          store.updateStep({ ...step, ...nextUsage });
          const updated: Run = {
            ...current,
            totalTokens:
              current.totalTokens +
              nextUsage.inputTokens +
              nextUsage.outputTokens -
              usage.inputTokens -
              usage.outputTokens,
            totalCostUsd:
              current.totalCostUsd + nextUsage.costUsd - usage.costUsd,
          };
          store.updateRun(updated);
          return updated;
        });
        usage = nextUsage;
        if (updated) hub.publish(eventRun(updated));
        hub.publish({
          type: 'usage',
          ts: Date.now(),
          data: { agentId: agent.id, runId: run.id, ...usage },
        });
        const currentBudget = guardrails.check(agent, run.id);
        // This step is already persisted, so compare remaining money to zero, not to its usage again.
        if (currentBudget.remainingRun < 0 || currentBudget.remainingDay < 0) {
          policyError =
            currentBudget.remainingRun < 0 ? 'run_cost_cap' : 'daily_cost_cap';
          policyAbort.abort(new Error(policyError));
        }
      };
      try {
        const turnSignal = AbortSignal.any([
          signal,
          policyAbort.signal,
          AbortSignal.timeout(agent.guardrails.turnTimeoutMs),
        ]);
        result = await runtime.runTurn(
          {
            agent: compileAgent(
              agent,
              config.listMemories(agent.id) ?? [],
              config.getAgentSkills(agent.id) ?? [],
              node.instructions,
              run.workflowId ? run.id : undefined,
            ),
            sessionKey: incoming.conversationId
              ? `chat:${incoming.conversationId}`
              : `run:${run.id}:node:${node.id}`,
            workspaceDir,
            prompt,
          },
          (event) => {
            if (turnSignal.aborted) return;
            if (event.type === 'usage') {
              recordUsage({
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                costUsd: event.costUsd,
              });
            } else if (event.type === 'permission_request') {
              approvals.tool(step, event);
            } else if (event.type === 'tool' || event.type === 'log') {
              const ts = Date.now();
              hub.publish({
                type: 'log',
                ts,
                data: {
                  id: crypto.randomUUID(),
                  ts,
                  level: event.type === 'log' ? event.level : 'info',
                  agentId: agent.id,
                  runId: run.id,
                  event:
                    event.type === 'tool' &&
                    guardrails.violation(agent, event.tool, event.title)
                      ? 'blocked_action_violation'
                      : `runtime_${event.type}`,
                  data:
                    event.type === 'tool'
                      ? { tool: event.tool, status: event.status }
                      : {},
                },
              });
            }
          },
          turnSignal,
        );
        await approvals.settled(step.id);
        recordUsage({
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
        });
        if (approvals.pending(step.id)) {
          policyError = 'permission_unresolved';
          policyAbort.abort(new Error(policyError));
        }
        turnSignal.throwIfAborted();
      } catch {
        const current = repo.getRun(run.id);
        if (current && running(current)) {
          const failed: RunStep = {
            ...step,
            ...usage,
            status: 'failed',
            error:
              policyError ??
              (signal.aborted ? 'turn_interrupted' : 'runtime_turn_failed'),
            finishedAt: Date.now(),
          };
          repo.updateStep(failed);
          hub.publish({ type: 'step.updated', ts: Date.now(), data: failed });
        }
        if (policyError) {
          hub.publish({
            type: 'log',
            ts: Date.now(),
            data: {
              id: crypto.randomUUID(),
              ts: Date.now(),
              level: 'warn',
              agentId: agent.id,
              runId: run.id,
              event: 'guardrail_blocked',
              data: { reason: policyError },
            },
          });
          return terminal(policyError);
        }
        throw new Error('runtime_turn_failed');
      } finally {
        if (approvals.pending(step.id))
          approvals.fail(run.id, policyError ?? 'approval_interrupted');
        approvals.clear(run.id);
        approvals.settleAgent(agent.id);
      }
      const parsed = parseReply(result.text);
      const outgoing = workflow.graph.edges.filter(
        (edge) => edge.source === node.id,
      );
      const missingVerdict =
        parsed.verdict === null &&
        outgoing.some(
          (edge) =>
            edge.condition === 'approved' || edge.condition === 'rejected',
        );
      const repeatedMissing =
        missingVerdict &&
        previous.some(
          (step) => step.nodeId === node.id && step.error === 'missing_verdict',
        );
      const completed: RunStep = {
        ...step,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        status: repeatedMissing ? 'failed' : 'completed',
        output: parsed.text,
        verdict: missingVerdict ? 'rejected' : parsed.verdict,
        finishedAt: Date.now(),
        error: missingVerdict ? 'missing_verdict' : null,
      };
      const edge = nextEdge(
        workflow.graph,
        node.id,
        parsed.text,
        completed.verdict,
      );
      return (tx) => {
        const store = createExecutionRepository(tx);
        const current = store.getRun(run.id);
        if (!current || !running(current)) throw new Error('run_terminal');
        store.updateStep(completed);
        store.addMemories(agent.id, parsed.memories, Date.now());
        const error = repeatedMissing
          ? 'missing_verdict'
          : outgoing.length && !edge
            ? 'no_matching_edge'
            : null;
        const updated: Run = {
          ...current,
          totalTokens:
            current.totalTokens +
            result.inputTokens +
            result.outputTokens -
            usage.inputTokens -
            usage.outputTokens,
          totalCostUsd: current.totalCostUsd + result.costUsd - usage.costUsd,
          status: error ? 'failed' : outgoing.length ? 'running' : 'completed',
          error,
          result: !error && !outgoing.length ? parsed.text : null,
          finishedAt: error || !outgoing.length ? Date.now() : null,
        };
        store.updateRun(updated);
        const events: SSEEvent[] = [
          { type: 'step.updated', ts: Date.now(), data: completed },
          eventRun(updated),
        ];
        const settled = store.settleAgentStatus(agent.id, Date.now());
        if (settled)
          events.push({
            type: 'agent.status',
            ts: Date.now(),
            data: { agentId: agent.id, status: settled.status },
          });
        if (!error && incoming.conversationId) {
          const reply: Message = {
            ...incoming,
            id: crypto.randomUUID(),
            fromKind: 'agent',
            fromId: agent.id,
            fromName: null,
            content: parsed.text,
            verdict: parsed.verdict,
            status: 'acked',
            attempts: 0,
            error: null,
            idempotencyKey: `chat:${run.id}:reply`,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          store.insertMessage(reply);
          events.push({ type: 'message.created', ts: Date.now(), data: reply });
        }
        if (!error && edge) {
          const next = message(run, edge.target, parsed.text, completed);
          store.insertMessage(next);
          events.push({ type: 'message.created', ts: Date.now(), data: next });
        }
        return events;
      };
    },
  });
  return {
    setChatDelivery(handler: typeof chatDelivery) {
      chatDelivery = handler;
    },
    startChat(input: {
      agentId: string;
      conversationId: string;
      channel: 'slack' | 'ui';
      externalEventId: string;
      userId: string;
      userName?: string | undefined;
      text: string;
    }) {
      if (!config.getAgent(input.agentId))
        return fail('Resource not found', 404);
      return begin(
        null,
        input.text,
        'chat',
        standaloneGraph(input.agentId),
        input,
      );
    },
    listRuns: repo.listRuns,
    detail: repo.detail,
    trail: repo.trail,
    usage: repo.usage,
    listApprovals: approvals.list,
    resolveApproval: approvals.resolve,
    start: async () => {
      await approvals.start();
      dispatcher.start();
    },
    stop: async () => {
      await Promise.all([approvals.stop(), dispatcher.stop()]);
    },
    listWorkflows: () => workflows.list(),
    getWorkflow: (id: string) => workflows.get(id),
    saveWorkflow(
      input: Parameters<typeof workflows.insert>[0],
      update = false,
    ) {
      checkGraph(input.graph);
      if (update && repo.hasActiveRun(input.id))
        fail('Workflow has active runs', 409);
      if (update) workflows.update(input);
      else workflows.insert(input);
      return input;
    },
    deleteWorkflow(id: string) {
      if (!workflows.get(id)) return false;
      if (repo.hasReferences(id))
        fail('Workflow has retained runs or schedules', 409);
      workflows.delete(id);
      return true;
    },
    startRun(workflowId: string, input: string) {
      const workflow = workflows.get(workflowId);
      if (!workflow) return fail('Resource not found', 404);
      checkGraph(workflow.graph);
      if (!runtime) fail('guardrails_unavailable', 503);
      return begin(workflowId, input, 'ui', workflow.graph);
    },
    startScheduled(schedule: Schedule) {
      if (schedule.workflowId) {
        const workflow = workflows.get(schedule.workflowId);
        if (!workflow) return fail('Resource not found', 404);
        checkGraph(workflow.graph);
        return begin(workflow.id, schedule.prompt, 'schedule', workflow.graph);
      }
      if (!config.getAgent(schedule.agentId))
        return fail('Resource not found', 404);
      return begin(
        null,
        schedule.prompt,
        'schedule',
        standaloneGraph(schedule.agentId),
      );
    },
    cancelRun(id: string) {
      const events = db.transaction((tx) => {
        const store = createExecutionRepository(tx);
        const current = store.getRun(id);
        if (!current) return undefined;
        if (!running(current)) return [];
        const now = Date.now();
        const cancelled: Run = {
          ...current,
          status: 'cancelled',
          error: null,
          finishedAt: now,
        };
        store.updateRun(cancelled);
        return [
          eventRun(cancelled),
          ...approvals.cancel(tx, id),
          ...store
            .stopMessages(id, 'run_cancelled', now)
            .map((data): SSEEvent => ({
              type: 'message.updated',
              ts: now,
              data,
            })),
          ...stopSteps(store, id, 'run_cancelled', now),
        ];
      });
      if (events === undefined) return undefined;
      dispatcher.cancelRun(id);
      publish(events);
      return repo.getRun(id);
    },
  };
}
