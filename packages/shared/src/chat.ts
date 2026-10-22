import { z } from 'zod';

export const InboundMessageSchema = z.strictObject({
  channel: z.literal('slack'),
  externalEventId: z.string().min(1),
  conversationId: z
    .string()
    .regex(/^slack:[A-Za-z0-9]+:[A-Za-z0-9]+:(?:dm|\d+\.\d+)$/),
  userId: z.string().min(1),
  userName: z.string().optional(),
  text: z.string().trim().min(1),
});
export const ChatInputSchema = z.strictObject({
  text: z.string().trim().min(1),
  conversationId: z
    .string()
    .regex(/^ui:[0-9a-f-]{36}:[0-9a-f-]{36}$/)
    .optional(),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;
