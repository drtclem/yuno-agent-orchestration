export type { InboundMessage } from '@yuno/shared';
import type { InboundMessage } from '@yuno/shared';

export interface ChannelAdapter {
  readonly type: 'slack';
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  postPlaceholder(conversationId: string, text: string): Promise<string>;
  updateMessage(
    conversationId: string,
    handle: string,
    text: string,
  ): Promise<void>;
  stop(): Promise<void>;
  status(): { connected: boolean; detail?: string };
}
