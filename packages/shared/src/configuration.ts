import { z } from 'zod';
import { ChannelBindingSchema, MemorySchema, SkillSchema } from './agents.ts';

export const IdParamsSchema = z.strictObject({ id: z.uuid() });
export const MemoryParamsSchema = IdParamsSchema.extend({ memId: z.uuid() });
export const ScheduleParamsSchema = IdParamsSchema.extend({ sid: z.uuid() });
export const MemoryInputSchema = MemorySchema.pick({ fact: true });
export const SkillInputSchema = SkillSchema.omit({ id: true, createdAt: true });
export const AgentSkillsInputSchema = z.strictObject({
  skillIds: z
    .array(z.uuid())
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'Skill IDs must be unique',
    ),
});
export const ChannelInputSchema = ChannelBindingSchema.omit({
  id: true,
  agentId: true,
}).nullable();
