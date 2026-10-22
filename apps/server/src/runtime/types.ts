import type { Permission as Perm } from '@yuno/shared';

export interface CompiledAgent {
  agentId: string;
  name: string;
  systemPrompt: string; // role + prompt + memory + skills + reply protocol
  model: { providerID: string; modelID: string };
  tools: Record<string, boolean>; // e.g. { bash: true, edit: true, webfetch: false }
  permissions: {
    bash: Perm;
    edit: Perm;
    webfetch: Perm;
    denyBash: string[];
    deploymentDir?: string;
  }; // Perm = 'allow'|'ask'|'deny'
  turnTimeoutMs: number;
}
export interface TurnInput {
  agent: CompiledAgent;
  sessionKey: string; // our key: `run:<runId>:node:<nodeId>` or `chat:<conversationId>`
  workspaceDir: string; // absolute path, identical inside app and opencode containers
  prompt: string;
}
export type RuntimeEvent =
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | {
      type: 'tool';
      tool: string;
      status: 'started' | 'completed' | 'failed';
      title?: string;
    }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    } // running totals for this turn
  | {
      type: 'permission_request';
      permissionId: string;
      sessionId: string;
      tool: string;
      detail: string;
    };
export interface TurnResult {
  text: string; // final assistant text
  sessionId: string; // runtime's session id (persisted for reuse)
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCalls: { tool: string; status: 'completed' | 'failed' }[];
}
export interface AgentRuntime {
  health(): Promise<{ ok: boolean; version?: string }>;
  runTurn(
    input: TurnInput,
    onEvent: (e: RuntimeEvent) => void,
    signal: AbortSignal,
  ): Promise<TurnResult>;
  respondPermission(
    sessionId: string,
    permissionId: string,
    allow: boolean,
  ): Promise<void>;
}
