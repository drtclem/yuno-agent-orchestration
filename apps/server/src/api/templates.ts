import type { FastifyInstance } from 'fastify';
import { TemplateParamsSchema } from '@yuno/shared';
import type { createTemplates } from '../domain/templates.js';

export function registerTemplateRoutes(
  app: FastifyInstance,
  templates: ReturnType<typeof createTemplates>,
) {
  app.get('/api/templates', () => templates.list());
  app.post('/api/templates/:id/load', (request, reply) =>
    reply
      .code(201)
      .send(templates.load(TemplateParamsSchema.parse(request.params).id)),
  );
}
