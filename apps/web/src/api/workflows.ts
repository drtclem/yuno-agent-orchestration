import {
  AgentSchema,
  WorkflowSchema,
  WorkflowInputSchema,
  TemplateSchema,
  RunSchema,
  RunInputSchema,
} from '@yuno/shared';
import { configurationApi } from './configuration.js';

export const workflowApi = {
  list: (signal: AbortSignal) =>
    configurationApi.get('/workflows', WorkflowSchema.array(), signal),
  get: (id: string, signal: AbortSignal) =>
    configurationApi.get(
      `/workflows/${encodeURIComponent(id)}`,
      WorkflowSchema,
      signal,
    ),
  agents: (signal: AbortSignal) =>
    configurationApi.get('/agents', AgentSchema.array(), signal),
  templates: (signal: AbortSignal) =>
    configurationApi.get('/templates', TemplateSchema.array(), signal),
  load: (id: string) =>
    configurationApi.write(
      `/templates/${encodeURIComponent(id)}/load`,
      WorkflowSchema,
    ),
  save: (id: string | undefined, input: unknown) =>
    configurationApi.write(
      id ? `/workflows/${encodeURIComponent(id)}` : '/workflows',
      WorkflowSchema,
      WorkflowInputSchema.parse(input),
      id ? 'PUT' : 'POST',
    ),
  run: (id: string, input: string) =>
    configurationApi.write(
      `/workflows/${encodeURIComponent(id)}/runs`,
      RunSchema,
      RunInputSchema.parse({ input }),
    ),
};
