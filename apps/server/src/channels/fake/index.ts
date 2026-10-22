import type { ChannelAdapter, InboundMessage } from '../types.js';

export function createFakeChannel() {
  let receive: ((message: InboundMessage) => Promise<void>) | undefined;
  const messages: { conversationId: string; handle: string; text: string }[] =
    [];
  return {
    type: 'slack',
    messages,
    async start(handler) {
      receive = handler;
    },
    async stop() {
      receive = undefined;
    },
    status: () => ({ connected: receive !== undefined }),
    async receive(message: InboundMessage) {
      await receive?.(message);
    },
    async postPlaceholder(conversationId, text) {
      const handle = crypto.randomUUID();
      messages.push({ conversationId, handle, text });
      return handle;
    },
    async updateMessage(conversationId, handle, text) {
      const message = messages.find(
        (m) => m.conversationId === conversationId && m.handle === handle,
      );
      if (!message) throw new Error('message_missing');
      message.text = text;
    },
  } satisfies ChannelAdapter & {
    messages: typeof messages;
    receive(message: InboundMessage): Promise<void>;
  };
}
