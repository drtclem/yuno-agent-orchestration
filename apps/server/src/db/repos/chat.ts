import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../client.js';
import { conversations, processedEvents, channelBindings } from '../schema.js';

export function createChatRepository(db: AppDatabase) {
  return {
    binding: () =>
      db
        .select()
        .from(channelBindings)
        .where(eq(channelBindings.enabled, true))
        .get(),
    accept(input: {
      conversationId: string;
      agentId: string;
      channel: 'slack' | 'ui';
      externalEventId: string;
    }) {
      const current = db
        .select()
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .get();
      if (
        current &&
        (current.agentId !== input.agentId || current.channel !== input.channel)
      )
        throw Object.assign(new Error('conversation_binding_changed'), {
          statusCode: 409,
        });
      const accepted = db
        .insert(processedEvents)
        .values({
          externalEventId: input.externalEventId,
          createdAt: Date.now(),
        })
        .onConflictDoNothing()
        .returning()
        .get();
      if (!accepted) return false;
      if (!current)
        db.insert(conversations)
          .values({
            id: input.conversationId,
            agentId: input.agentId,
            channel: input.channel,
            externalRef: input.conversationId,
            createdAt: Date.now(),
          })
          .run();
      return true;
    },
  };
}
