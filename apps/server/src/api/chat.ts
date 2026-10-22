import { IdParamsSchema } from '@yuno/shared';
import type { FastifyInstance } from 'fastify';
import type { createChat } from '../domain/chat.js';

export function registerChatRoutes(
  app: FastifyInstance,
  chat: ReturnType<typeof createChat>,
) {
  app.post('/api/agents/:id/chat', (request, reply) =>
    reply
      .code(202)
      .send(
        chat.testChat(IdParamsSchema.parse(request.params).id, request.body),
      ),
  );
}
