import type { AgentRuntime } from '../runtime/types.js';

export function createRuntimeHealth(runtime: AgentRuntime) {
  return () => runtime.health();
}
