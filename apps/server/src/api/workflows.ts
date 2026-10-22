import type { FastifyInstance } from 'fastify';
import {
  IdParamsSchema,
  ApprovalDecisionSchema,
  ApprovalQuerySchema,
  MessageQuerySchema,
  RunInputSchema,
  UsageQuerySchema,
  WorkflowInputSchema,
} from '@yuno/shared';
import type { createEngine } from '../domain/engine.js';

function found<T>(value: T | undefined): T {
  if (value === undefined)
    throw Object.assign(new Error('Resource not found'), { statusCode: 404 });
  return value;
}
export function registerWorkflowRoutes(
  app: FastifyInstance,
  engine: ReturnType<typeof createEngine>,
) {
  app.get('/api/approvals', (request) =>
    engine.listApprovals(ApprovalQuerySchema.parse(request.query).status),
  );
  app.post('/api/approvals/:id', (request) =>
    engine.resolveApproval(
      IdParamsSchema.parse(request.params).id,
      ApprovalDecisionSchema.parse(request.body).decision,
    ),
  );
  app.get('/api/workflows', () => engine.listWorkflows());
  app.get('/api/workflows/:id', (request) =>
    found(engine.getWorkflow(IdParamsSchema.parse(request.params).id)),
  );
  app.post('/api/workflows', (request, reply) => {
    const now = Date.now();
    return reply.code(201).send(
      engine.saveWorkflow({
        ...WorkflowInputSchema.parse(request.body),
        id: crypto.randomUUID(),
        templateId: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
  });
  app.put('/api/workflows/:id', (request) => {
    const current = found(
      engine.getWorkflow(IdParamsSchema.parse(request.params).id),
    );
    return engine.saveWorkflow(
      {
        ...current,
        ...WorkflowInputSchema.parse(request.body),
        updatedAt: Date.now(),
      },
      true,
    );
  });
  app.delete('/api/workflows/:id', (request, reply) => {
    if (!engine.deleteWorkflow(IdParamsSchema.parse(request.params).id))
      found(undefined);
    return reply.code(204).send();
  });
  app.post('/api/workflows/:id/runs', (request, reply) =>
    reply
      .code(201)
      .send(
        engine.startRun(
          IdParamsSchema.parse(request.params).id,
          RunInputSchema.parse(request.body).input,
        ),
      ),
  );
  app.get('/api/runs', () => engine.listRuns());
  app.get('/api/runs/:id', (request) =>
    found(engine.detail(IdParamsSchema.parse(request.params).id)),
  );
  app.post('/api/runs/:id/cancel', (request) =>
    found(engine.cancelRun(IdParamsSchema.parse(request.params).id)),
  );
  app.get('/api/messages', (request) =>
    engine.trail(MessageQuerySchema.parse(request.query)),
  );
  app.get('/api/usage', (request) => {
    const query = UsageQuerySchema.parse(request.query);
    return engine.usage(query.groupBy, query.since);
  });
}
