import { eq } from 'drizzle-orm';
import { MessageSchema, type Message } from '@yuno/shared';
import type { AppDatabase } from '../client.js';
import { messages } from '../schema.js';

export function createMessagesRepository(db: AppDatabase) {
  return {
    insert(record: Message) {
      db.insert(messages).values(MessageSchema.parse(record)).run();
    },
    get(id: string): Message | undefined {
      const row = db.select().from(messages).where(eq(messages.id, id)).get();
      return row === undefined ? undefined : MessageSchema.parse(row);
    },
    list(): Message[] {
      return db
        .select()
        .from(messages)
        .all()
        .map((row) => MessageSchema.parse(row));
    },
    update(record: Message) {
      const parsed = MessageSchema.parse(record);
      db.update(messages).set(parsed).where(eq(messages.id, parsed.id)).run();
    },
    delete(id: string) {
      db.delete(messages).where(eq(messages.id, id)).run();
    },
  };
}
