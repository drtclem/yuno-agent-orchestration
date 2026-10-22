import { describe, expect, it } from 'vitest';
import {
  AgentSchema,
  AgentInputSchema,
  PermissionsSchema,
  GuardrailsSchema,
  SkillSchema,
  MemorySchema,
  ScheduleSchema,
  ChannelBindingSchema,
  WorkflowGraphSchema,
  WorkflowSchema,
  RunSchema,
  RunStepSchema,
  MessageSchema,
  ApprovalSchema,
  TemplateSchema,
  SSEEventSchema,
  ALLOWED_MODELS,
  validateGraph,
} from './index.js';

const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const agentInput = {
  name: 'Coder',
  role: 'Developer',
  systemPrompt: 'Build things.',
};
const agent = { ...agentInput, id, status: 'idle', createdAt: 0, updatedAt: 1 };
const node = (nodeId: string) => ({
  id: nodeId,
  agentId: id,
  label: nodeId,
  position: { x: 0, y: 0 },
});
const graph = {
  nodes: [node('start'), node('end')],
  edges: [
    {
      id: 'edge',
      source: 'start',
      target: 'end',
      condition: 'always' as const,
    },
  ],
  startNodeId: 'start',
  maxIterations: 6,
};
const run = {
  id,
  workflowId: null,
  trigger: 'ui',
  input: 'Build',
  status: 'queued',
  result: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  totalCostUsd: 0,
  totalTokens: 0,
};
const step = {
  id,
  runId: otherId,
  nodeId: 'start',
  agentId: id,
  iteration: 1,
  status: 'running',
  prompt: 'Build',
  output: null,
  verdict: null,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  startedAt: 0,
  finishedAt: null,
  error: null,
};
const message = {
  id,
  runId: null,
  conversationId: 'slack:team:dm',
  fromKind: 'human',
  fromId: 'user',
  toAgentId: id,
  channel: 'slack',
  content: 'Hello 🌍',
  verdict: null,
  status: 'pending',
  attempts: 0,
  nextAttemptAt: 0,
  idempotencyKey: 'event:1',
  error: null,
  createdAt: 0,
  updatedAt: 0,
};
const approval = {
  id,
  runId: otherId,
  stepId: id,
  agentId: id,
  kind: 'step_gate',
  detail: 'Deploy?',
  runtimeSessionId: null,
  runtimePermissionId: null,
  status: 'pending',
  createdAt: 0,
  resolvedAt: null,
};

// Fixtures describe the public record contract, independently of persistence or runtime code.
const cases = [
  [
    'AgentInput',
    AgentInputSchema,
    agentInput,
    { ...agentInput, model: 'unapproved/model' },
  ],
  ['Agent', AgentSchema, agent, { ...agent, status: 'sleeping' }],
  [
    'Permissions',
    PermissionsSchema,
    { bash: 'ask', edit: 'deny', webfetch: 'allow', denyBash: ['rm *'] },
    { bash: 'yes' },
  ],
  [
    'Guardrails',
    GuardrailsSchema,
    {
      runCostCapUsd: 0.5,
      dailyCostCapUsd: 2,
      maxTurnsPerHour: 30,
      turnTimeoutMs: 600000,
    },
    { runCostCapUsd: -1 },
  ],
  [
    'Skill',
    SkillSchema,
    {
      id,
      name: 'Review',
      description: 'Review code',
      stepsMd: 'Read files',
      createdAt: 0,
    },
    { id: 'bad' },
  ],
  [
    'Memory',
    MemorySchema,
    { id, agentId: id, fact: 'Uses TypeScript', source: 'ui', createdAt: 0 },
    { id, agentId: id, fact: 'x', source: 'internet', createdAt: 0 },
  ],
  [
    'Schedule',
    ScheduleSchema,
    {
      id,
      agentId: id,
      kind: 'interval',
      expr: '60',
      prompt: 'Check',
      workflowId: null,
      enabled: true,
      lastRunAt: null,
      nextRunAt: null,
    },
    {
      id,
      agentId: id,
      kind: 'interval',
      expr: '0',
      prompt: 'Check',
      workflowId: null,
      enabled: true,
      lastRunAt: null,
      nextRunAt: null,
    },
  ],
  [
    'ChannelBinding',
    ChannelBindingSchema,
    {
      id,
      agentId: id,
      type: 'slack',
      config: { respondTo: 'dm_and_mentions' },
      enabled: true,
    },
    { id, agentId: id, type: 'email', config: {}, enabled: true },
  ],
  ['WorkflowGraph', WorkflowGraphSchema, graph, { ...graph, maxIterations: 0 }],
  [
    'Workflow',
    WorkflowSchema,
    {
      id,
      name: 'Build',
      description: 'Pipeline',
      graph,
      templateId: null,
      createdAt: 0,
      updatedAt: 0,
    },
    { id, name: 'Build', graph: {} },
  ],
  ['Run', RunSchema, run, { ...run, totalTokens: -1 }],
  ['RunStep', RunStepSchema, step, { ...step, iteration: 0 }],
  ['Message', MessageSchema, message, { ...message, attempts: -1 }],
  ['Approval', ApprovalSchema, approval, { ...approval, status: 'ignored' }],
  [
    'Template',
    TemplateSchema,
    {
      id: 'dev-pipeline',
      name: 'Build',
      description: 'Pipeline',
      agents: [agentInput],
      graph: {
        ...graph,
        nodes: [
          {
            id: 'start',
            agentName: 'Coder',
            label: 'Coder',
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      },
    },
    { id: 'bad', name: 'Bad', description: '', agents: [], graph },
  ],
  [
    'SSEEvent',
    SSEEventSchema,
    { type: 'agent.status', ts: 0, data: { agentId: id, status: 'idle' } },
    { type: 'unknown', ts: 0, data: {} },
  ],
] as const;

describe('T2 shared schemas (R-02)', () => {
  for (const [name, schema, valid, invalid] of cases) {
    it(`R-02 ${name} accepts a valid example and rejects an invalid example`, () => {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse(invalid).success).toBe(false);
    });
  }

  it('R-02 defaults match architecture §8 and D4', () => {
    const parsed = AgentInputSchema.parse(agentInput);
    expect(parsed.model).toBe('openai/gpt-5.4-mini');
    expect(parsed.tools).toEqual({ bash: false, edit: false, webfetch: false });
    expect(parsed.permissions).toEqual({
      bash: 'deny',
      edit: 'deny',
      webfetch: 'deny',
      denyBash: [],
      canDeploy: false,
    });
    expect(parsed.guardrails).toEqual({
      runCostCapUsd: 0.5,
      dailyCostCapUsd: 2,
      maxTurnsPerHour: 30,
      turnTimeoutMs: 600000,
    });
    const withoutLimit = {
      nodes: graph.nodes,
      edges: graph.edges,
      startNodeId: graph.startNodeId,
    };
    expect(WorkflowGraphSchema.parse(withoutLimit).maxIterations).toBe(6);
    expect(ALLOWED_MODELS).toEqual([
      { id: 'openai/gpt-5.4-mini', pool: '2.5M/day pool' },
      { id: 'openai/gpt-5.4-nano', pool: '2.5M/day pool' },
      { id: 'openai/gpt-5-mini', pool: '2.5M/day pool' },
      { id: 'openai/gpt-5.4', pool: '250K/day pool' },
    ]);
  });

  it('R-02 accepts every documented SSE discriminant with its own payload', () => {
    const payloads = [
      ['run.updated', run],
      ['step.updated', step],
      ['message.created', message],
      ['message.updated', message],
      ['approval.created', approval],
      ['approval.resolved', approval],
      [
        'usage',
        {
          agentId: id,
          runId: null,
          inputTokens: 1,
          outputTokens: 2,
          costUsd: 0.01,
        },
      ],
      [
        'channel.status',
        { type: 'slack', connected: false, detail: 'not configured' },
      ],
      [
        'log',
        {
          id,
          ts: 0,
          level: 'info',
          agentId: null,
          runId: null,
          event: 'started',
          data: { attempts: 1 },
        },
      ],
    ] as const;
    for (const [type, data] of payloads) {
      expect(
        SSEEventSchema.safeParse({ type, ts: 0, data }).success,
        type,
      ).toBe(true);
      expect(
        SSEEventSchema.safeParse({ type, ts: 0, data: {} }).success,
        type,
      ).toBe(false);
    }
  });

  it('R-02 keeps epoch milliseconds integral and UUID record identifiers validated', () => {
    expect(AgentSchema.safeParse({ ...agent, id: 'not-a-uuid' }).success).toBe(
      false,
    );
    expect(AgentSchema.safeParse({ ...agent, createdAt: 0.5 }).success).toBe(
      false,
    );
    expect(
      MessageSchema.safeParse({ ...message, content: '🙂'.repeat(10000) })
        .success,
    ).toBe(true);
  });
});

describe('T2 validateGraph architecture §6 (R-02)', () => {
  it('R-02 accepts a valid graph and a bounded cycle with a reachable end', () => {
    expect(validateGraph(graph, [id])).toEqual([]);
    expect(
      validateGraph(
        {
          ...graph,
          edges: [
            ...graph.edges,
            {
              id: 'loop',
              source: 'start',
              target: 'start',
              condition: 'rejected',
            },
          ],
        },
        [id],
      ),
    ).toEqual([]);
  });
  it('R-02 catches a startNodeId that does not exist', () => {
    expect(validateGraph({ ...graph, startNodeId: 'missing' }, [id])).toEqual(
      expect.arrayContaining([expect.stringMatching(/start/i)]),
    );
  });
  it.each(['source', 'target'] as const)(
    'R-02 catches a missing edge %s endpoint',
    (endpoint) => {
      expect(
        validateGraph(
          {
            ...graph,
            edges: [
              {
                id: 'edge',
                source: 'start',
                target: 'end',
                condition: 'always',
                [endpoint]: 'missing',
              },
            ],
          },
          [id],
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.stringMatching(new RegExp(endpoint, 'i')),
        ]),
      );
    },
  );
  it('R-02 catches an agentId that does not exist', () => {
    expect(validateGraph(graph, [otherId])).toEqual(
      expect.arrayContaining([expect.stringMatching(/agent/i)]),
    );
  });
  it('R-02 catches more than one always edge from the same node', () => {
    expect(
      validateGraph(
        {
          ...graph,
          edges: [
            ...graph.edges,
            {
              id: 'duplicate-always',
              source: 'start',
              target: 'end',
              condition: 'always',
            },
          ],
        },
        [id],
      ).length,
    ).toBeGreaterThan(0);
  });
  it('R-02 catches an unreachable end even if a disconnected end exists', () => {
    expect(
      validateGraph(
        {
          ...graph,
          edges: [
            {
              id: 'loop',
              source: 'start',
              target: 'start',
              condition: 'always',
            },
          ],
        },
        [id],
      ).length,
    ).toBeGreaterThan(0);
  });
  it('R-02 catches a graph with no end node', () => {
    expect(
      validateGraph(
        {
          ...graph,
          nodes: [node('start')],
          edges: [
            {
              id: 'loop',
              source: 'start',
              target: 'start',
              condition: 'always',
            },
          ],
        },
        [id],
      ).length,
    ).toBeGreaterThan(0);
  });
  it('R-02 catches duplicate node and edge identifiers', () => {
    expect(
      validateGraph({ ...graph, nodes: [...graph.nodes, node('start')] }, [id])
        .length,
    ).toBeGreaterThan(0);
    expect(
      validateGraph(
        {
          ...graph,
          edges: [
            ...graph.edges,
            {
              id: 'edge',
              source: 'end',
              target: 'start',
              condition: 'rejected',
            },
          ],
        },
        [id],
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('T2 additional boundary examples (R-02)', () => {
  const template = {
    id: 'dev-pipeline',
    name: 'Build',
    description: 'Pipeline',
    agents: [agentInput],
    graph: {
      nodes: [
        {
          id: 'start',
          agentName: 'Coder',
          label: 'Coder',
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      startNodeId: 'start',
      maxIterations: 6,
    },
  };
  const schedule = {
    id,
    agentId: id,
    kind: 'cron',
    expr: '*/5 * * * *',
    prompt: 'Check',
    workflowId: null,
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
  };

  it('R-02 rejects template references to an unknown agent name', () => {
    expect(
      TemplateSchema.safeParse({
        ...template,
        agents: [{ ...agentInput, name: 'Other' }],
      }).success,
    ).toBe(false);
  });
  it('R-02 rejects duplicate template agent names', () => {
    expect(
      TemplateSchema.safeParse({
        ...template,
        agents: [agentInput, agentInput],
      }).success,
    ).toBe(false);
  });
  it('R-02 rejects a structurally valid template with an invalid graph', () => {
    expect(
      TemplateSchema.safeParse({
        ...template,
        graph: { ...template.graph, startNodeId: 'missing' },
      }).success,
    ).toBe(false);
  });
  it.each(['always', 'approved', 'rejected', { contains: 'ready' }])(
    'R-02 accepts the documented edge condition %j',
    (condition) => {
      expect(
        WorkflowGraphSchema.safeParse({
          ...graph,
          edges: [{ ...graph.edges[0], condition }],
        }).success,
      ).toBe(true);
    },
  );
  it.each([{ contains: '' }, { contains: '   ' }, 'sometimes'])(
    'R-02 rejects invalid edge condition %j',
    (condition) => {
      expect(
        WorkflowGraphSchema.safeParse({
          ...graph,
          edges: [{ ...graph.edges[0], condition }],
        }).success,
      ).toBe(false);
    },
  );
  it('R-02 accepts a nonempty cron schedule and rejects an empty cron expression', () => {
    expect(ScheduleSchema.safeParse(schedule).success).toBe(true);
    expect(ScheduleSchema.safeParse({ ...schedule, expr: ' ' }).success).toBe(
      false,
    );
  });
  it.each(['0.5', '-1', '9007199254740992'])(
    'R-02 rejects fractional, negative, or unsafe interval seconds %s',
    (expr) => {
      expect(
        ScheduleSchema.safeParse({ ...schedule, kind: 'interval', expr })
          .success,
      ).toBe(false);
    },
  );
  it.each([
    { ...agentInput, apiKey: 'placeholder' },
    { ...agentInput, tools: { shell: true } },
    { ...agentInput, permissions: { shell: 'allow' } },
    { ...agentInput, guardrails: { unlimited: true } },
  ])('R-02 rejects unknown agent configuration fields %j', (input) => {
    expect(AgentInputSchema.safeParse(input).success).toBe(false);
  });
  it.each([
    null,
    {},
    { ...graph, nodes: 'invalid' },
    { ...graph, maxIterations: 0 },
  ])('R-02 validateGraph returns errors for malformed input %j', (input) => {
    const errors = validateGraph(input, [id]);
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.every((error) => typeof error === 'string' && error.length > 0),
    ).toBe(true);
  });
});
