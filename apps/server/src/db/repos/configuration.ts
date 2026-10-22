import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  AgentSchema,
  MemorySchema,
  SkillSchema,
  ScheduleSchema,
  ChannelBindingSchema,
  type AgentInput,
  type Skill,
  type Schedule,
  type ChannelBinding,
} from '@yuno/shared';
import type { openDatabase } from '../client.js';
import {
  agents,
  agentSkills,
  memories,
  skills,
  schedules,
  channelBindings,
  messages,
  runSteps,
} from '../schema.js';
import { createAgentsRepository } from './agents.js';
import { createWorkflowsRepository } from './workflows.js';

function conflict(message: string) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

// Keep constraint failures visible without returning SQL statements to callers.
function write<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
      throw conflict(
        'Configuration conflicts with an existing record or retained history',
      );
    }
    throw error;
  }
}

type ScheduleInput = Omit<
  Schedule,
  'id' | 'agentId' | 'lastRunAt' | 'nextRunAt'
>;
type ChannelInput = Omit<ChannelBinding, 'id' | 'agentId'>;
type SkillInput = Omit<Skill, 'id' | 'createdAt'>;

export function createConfigurationRepository(
  db: ReturnType<typeof openDatabase>['db'],
) {
  const agentRepo = createAgentsRepository(db);
  const workflowRepo = createWorkflowsRepository(db);
  const getSkill = (id: string) => {
    const row = db.select().from(skills).where(eq(skills.id, id)).get();
    return row === undefined ? undefined : SkillSchema.parse(row);
  };
  const getSchedule = (agentId: string, id: string) => {
    const row = db
      .select()
      .from(schedules)
      .where(and(eq(schedules.agentId, agentId), eq(schedules.id, id)))
      .get();
    return row === undefined ? undefined : ScheduleSchema.parse(row);
  };
  const getChannel = (agentId: string) => {
    if (!agentRepo.get(agentId)) return undefined;
    const row = db
      .select()
      .from(channelBindings)
      .where(eq(channelBindings.agentId, agentId))
      .get();
    return row === undefined ? null : ChannelBindingSchema.parse(row);
  };
  function checkWorkflow(input: ScheduleInput) {
    if (input.workflowId !== null && !workflowRepo.get(input.workflowId)) {
      throw Object.assign(new Error('Unknown workflow'), { statusCode: 400 });
    }
  }
  return {
    listAgents: () => agentRepo.list(),
    getAgent: (id: string) => agentRepo.get(id),
    createAgent(input: AgentInput) {
      const now = Date.now();
      const record = AgentSchema.parse({
        ...input,
        id: randomUUID(),
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      });
      write(() => agentRepo.insert(record));
      return record;
    },
    updateAgent(id: string, input: AgentInput) {
      const current = agentRepo.get(id);
      if (!current) return undefined;
      const record = AgentSchema.parse({
        ...current,
        ...input,
        updatedAt: Date.now(),
      });
      write(() => agentRepo.update(record));
      return record;
    },
    deleteAgent(id: string) {
      if (!agentRepo.get(id)) return false;
      const workflowNames = workflowRepo
        .list()
        .filter((workflow) =>
          workflow.graph.nodes.some((node) => node.agentId === id),
        )
        .map((workflow) => workflow.name);
      if (workflowNames.length)
        throw Object.assign(conflict('Agent is used by a workflow'), {
          workflowNames,
        });
      return write(() =>
        db.transaction((tx) => {
          tx.delete(memories).where(eq(memories.agentId, id)).run();
          tx.delete(schedules).where(eq(schedules.agentId, id)).run();
          tx.delete(channelBindings)
            .where(eq(channelBindings.agentId, id))
            .run();
          return tx.delete(agents).where(eq(agents.id, id)).run().changes > 0;
        }),
      );
    },
    listMemories(agentId: string) {
      if (!agentRepo.get(agentId)) return undefined;
      return db
        .select()
        .from(memories)
        .where(eq(memories.agentId, agentId))
        .all()
        .map((row) => MemorySchema.parse(row));
    },
    addMemory(agentId: string, input: { fact: string }) {
      if (!agentRepo.get(agentId)) return undefined;
      const record = MemorySchema.parse({
        ...input,
        id: randomUUID(),
        agentId,
        source: 'ui',
        createdAt: Date.now(),
      });
      db.insert(memories).values(record).run();
      return record;
    },
    deleteMemory(agentId: string, id: string) {
      return (
        db
          .delete(memories)
          .where(and(eq(memories.agentId, agentId), eq(memories.id, id)))
          .run().changes > 0
      );
    },
    listSkills: () =>
      db
        .select()
        .from(skills)
        .all()
        .map((row) => SkillSchema.parse(row)),
    getSkill,
    createSkill(input: SkillInput) {
      const record = SkillSchema.parse({
        ...input,
        id: randomUUID(),
        createdAt: Date.now(),
      });
      write(() => db.insert(skills).values(record).run());
      return record;
    },
    updateSkill(id: string, input: SkillInput) {
      const current = getSkill(id);
      if (!current) return undefined;
      const record = SkillSchema.parse({ ...current, ...input });
      write(() => db.update(skills).set(record).where(eq(skills.id, id)).run());
      return record;
    },
    deleteSkill(id: string) {
      return write(
        () => db.delete(skills).where(eq(skills.id, id)).run().changes > 0,
      );
    },
    getAgentSkills(agentId: string) {
      if (!agentRepo.get(agentId)) return undefined;
      return db
        .select({ skill: skills })
        .from(agentSkills)
        .innerJoin(skills, eq(agentSkills.skillId, skills.id))
        .where(eq(agentSkills.agentId, agentId))
        .all()
        .map((row) => SkillSchema.parse(row.skill));
    },
    setAgentSkills(agentId: string, skillIds: string[]) {
      if (!agentRepo.get(agentId)) return undefined;
      const records = skillIds.map((id) => {
        const skill = getSkill(id);
        if (!skill)
          throw Object.assign(new Error('Unknown skill'), { statusCode: 400 });
        return skill;
      });
      write(() =>
        db.transaction((tx) => {
          tx.delete(agentSkills).where(eq(agentSkills.agentId, agentId)).run();
          if (skillIds.length)
            tx.insert(agentSkills)
              .values(skillIds.map((skillId) => ({ agentId, skillId })))
              .run();
        }),
      );
      return records;
    },
    listSchedules(agentId: string) {
      if (!agentRepo.get(agentId)) return undefined;
      return db
        .select()
        .from(schedules)
        .where(eq(schedules.agentId, agentId))
        .all()
        .map((row) => ScheduleSchema.parse(row));
    },
    getSchedule,
    allSchedules: () =>
      db
        .select()
        .from(schedules)
        .all()
        .map((row) => ScheduleSchema.parse(row)),
    scheduleTiming(
      id: string,
      timing: { lastRunAt?: number; nextRunAt: number | null },
    ) {
      db.update(schedules).set(timing).where(eq(schedules.id, id)).run();
    },
    agentBusy(agentId: string) {
      const agent = agentRepo.get(agentId);
      return (
        !agent ||
        ['working', 'waiting_approval', 'disabled'].includes(agent.status) ||
        !!db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.toAgentId, agentId),
              inArray(messages.status, ['pending', 'processing', 'failed']),
            ),
          )
          .get() ||
        !!db
          .select({ id: runSteps.id })
          .from(runSteps)
          .where(
            and(eq(runSteps.agentId, agentId), isNull(runSteps.finishedAt)),
          )
          .get()
      );
    },
    createSchedule(agentId: string, input: ScheduleInput) {
      if (!agentRepo.get(agentId)) return undefined;
      checkWorkflow(input);
      const record = ScheduleSchema.parse({
        ...input,
        id: randomUUID(),
        agentId,
        lastRunAt: null,
        nextRunAt: null,
      });
      write(() => db.insert(schedules).values(record).run());
      return record;
    },
    updateSchedule(agentId: string, id: string, input: ScheduleInput) {
      const current = getSchedule(agentId, id);
      if (!current) return undefined;
      checkWorkflow(input);
      const record = ScheduleSchema.parse({
        ...current,
        ...input,
        nextRunAt: null,
      });
      write(() =>
        db.update(schedules).set(record).where(eq(schedules.id, id)).run(),
      );
      return record;
    },
    deleteSchedule(agentId: string, id: string) {
      return (
        db
          .delete(schedules)
          .where(and(eq(schedules.agentId, agentId), eq(schedules.id, id)))
          .run().changes > 0
      );
    },
    getChannel,
    setChannel(agentId: string, input: ChannelInput | null) {
      const current = getChannel(agentId);
      if (current === undefined) return undefined;
      if (input === null) {
        db.delete(channelBindings)
          .where(eq(channelBindings.agentId, agentId))
          .run();
        return null;
      }
      const record = ChannelBindingSchema.parse({
        ...input,
        id: current?.id ?? randomUUID(),
        agentId,
      });
      write(() => {
        if (current)
          db.update(channelBindings)
            .set(record)
            .where(eq(channelBindings.id, current.id))
            .run();
        else db.insert(channelBindings).values(record).run();
      });
      return record;
    },
  };
}
