import { validateSchedule } from '../domain/scheduler.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AgentInputSchema,
  AgentSkillsInputSchema,
  ALLOWED_MODELS,
  ChannelInputSchema,
  IdParamsSchema,
  MemoryInputSchema,
  MemoryParamsSchema,
  ScheduleInputSchema,
  ScheduleParamsSchema,
  SkillInputSchema,
} from '@yuno/shared';
import type { openDatabase } from '../db/client.js';
import { createConfigurationRepository } from '../db/repos/configuration.js';

function found<T>(value: T | undefined): T {
  if (value === undefined)
    throw Object.assign(new Error('Resource not found'), { statusCode: 404 });
  return value;
}

export function registerConfigurationRoutes(
  app: FastifyInstance,
  db: ReturnType<typeof openDatabase>['db'],
  reloadSchedules: () => void = () => {},
  reloadChannels: () => Promise<void> = async () => {},
) {
  const repo = createConfigurationRepository(db);
  // https://fastify.dev/docs/latest/Reference/Server/#seterrorhandler
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        message: 'Validation failed',
        errors: error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const status =
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    if (
      status === 503 &&
      error instanceof Error &&
      error.message === 'guardrails_unavailable'
    )
      return reply.code(503).send({ message: 'guardrails_unavailable' });
    if (status >= 500)
      return reply.code(500).send({ message: 'Request failed' });
    return reply.code(status).send({
      message: error instanceof Error ? error.message : 'Request failed',
      ...(error instanceof Error && 'workflowNames' in error
        ? { workflowNames: error.workflowNames }
        : {}),
    });
  });
  app.get('/api/models', () => ALLOWED_MODELS);
  app.get('/api/agents', () => repo.listAgents());
  app.post('/api/agents', (request, reply) =>
    reply
      .code(201)
      .send(repo.createAgent(AgentInputSchema.parse(request.body))),
  );
  app.get('/api/agents/:id', (request) =>
    found(repo.getAgent(IdParamsSchema.parse(request.params).id)),
  );
  app.put('/api/agents/:id', (request) =>
    found(
      repo.updateAgent(
        IdParamsSchema.parse(request.params).id,
        AgentInputSchema.parse(request.body),
      ),
    ),
  );
  app.delete('/api/agents/:id', async (request, reply) => {
    if (!repo.deleteAgent(IdParamsSchema.parse(request.params).id))
      found(undefined);
    reloadSchedules();
    await reloadChannels();
    return reply.code(204).send();
  });
  app.get('/api/agents/:id/memories', (request) =>
    found(repo.listMemories(IdParamsSchema.parse(request.params).id)),
  );
  app.post('/api/agents/:id/memories', (request, reply) =>
    reply
      .code(201)
      .send(
        found(
          repo.addMemory(
            IdParamsSchema.parse(request.params).id,
            MemoryInputSchema.parse(request.body),
          ),
        ),
      ),
  );
  app.delete('/api/agents/:id/memories/:memId', (request, reply) => {
    const { id, memId } = MemoryParamsSchema.parse(request.params);
    if (!repo.deleteMemory(id, memId)) found(undefined);
    return reply.code(204).send();
  });
  app.get('/api/skills', () => repo.listSkills());
  app.post('/api/skills', (request, reply) =>
    reply
      .code(201)
      .send(repo.createSkill(SkillInputSchema.parse(request.body))),
  );
  app.get('/api/skills/:id', (request) =>
    found(repo.getSkill(IdParamsSchema.parse(request.params).id)),
  );
  app.put('/api/skills/:id', (request) =>
    found(
      repo.updateSkill(
        IdParamsSchema.parse(request.params).id,
        SkillInputSchema.parse(request.body),
      ),
    ),
  );
  app.delete('/api/skills/:id', (request, reply) => {
    if (!repo.deleteSkill(IdParamsSchema.parse(request.params).id))
      found(undefined);
    return reply.code(204).send();
  });
  app.get('/api/agents/:id/skills', (request) =>
    found(repo.getAgentSkills(IdParamsSchema.parse(request.params).id)),
  );
  app.put('/api/agents/:id/skills', (request) =>
    found(
      repo.setAgentSkills(
        IdParamsSchema.parse(request.params).id,
        AgentSkillsInputSchema.parse(request.body).skillIds,
      ),
    ),
  );
  app.get('/api/agents/:id/schedules', (request) =>
    found(repo.listSchedules(IdParamsSchema.parse(request.params).id)),
  );
  app.post('/api/agents/:id/schedules', (request, reply) => {
    const input = ScheduleInputSchema.parse(request.body);
    validateSchedule(input);
    const result = found(
      repo.createSchedule(IdParamsSchema.parse(request.params).id, input),
    );
    reloadSchedules();
    return reply.code(201).send(repo.getSchedule(result.agentId, result.id));
  });
  app.get('/api/agents/:id/schedules/:sid', (request) => {
    const { id, sid } = ScheduleParamsSchema.parse(request.params);
    return found(repo.getSchedule(id, sid));
  });
  app.put('/api/agents/:id/schedules/:sid', (request) => {
    const { id, sid } = ScheduleParamsSchema.parse(request.params);
    const input = ScheduleInputSchema.parse(request.body);
    validateSchedule(input);
    found(repo.updateSchedule(id, sid, input));
    reloadSchedules();
    return found(repo.getSchedule(id, sid));
  });
  app.delete('/api/agents/:id/schedules/:sid', (request, reply) => {
    const { id, sid } = ScheduleParamsSchema.parse(request.params);
    if (!repo.deleteSchedule(id, sid)) found(undefined);
    reloadSchedules();
    return reply.code(204).send();
  });
  app.get('/api/agents/:id/channels', (request) =>
    found(repo.getChannel(IdParamsSchema.parse(request.params).id)),
  );
  app.put('/api/agents/:id/channels', async (request) => {
    const result = found(
      repo.setChannel(
        IdParamsSchema.parse(request.params).id,
        ChannelInputSchema.parse(request.body),
      ),
    );
    await reloadChannels();
    return result;
  });
}
