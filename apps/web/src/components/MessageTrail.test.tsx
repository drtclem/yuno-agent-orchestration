// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { AgentSchema, MessageSchema } from '@yuno/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageTrail } from './MessageTrail.js';

const id = '00000000-0000-4000-8000-000000000001';
const agent = AgentSchema.parse({
  id,
  name: 'Yuno Assistant',
  role: 'helper',
  systemPrompt: 'Help',
  status: 'idle',
  createdAt: 0,
  updatedAt: 0,
});
const human = (fromName: string | null) =>
  MessageSchema.parse({
    id,
    runId: null,
    conversationId: 'slack:T1:D1:dm',
    fromKind: 'human',
    fromId: 'U123',
    fromName,
    toAgentId: id,
    channel: 'slack',
    content: 'Hello',
    verdict: null,
    status: 'acked',
    attempts: 0,
    nextAttemptAt: 0,
    idempotencyKey: 'human',
    error: null,
    createdAt: 0,
    updatedAt: 0,
  });
afterEach(cleanup);
describe('T24 human message display (R-16/R-23)', () => {
  it('R-16/R-23 a human message shows its from_name', () => {
    render(
      <MessageTrail messages={[human('Taylor Clements')]} agents={[agent]} />,
    );
    expect(screen.getByText(/Taylor Clements.*→ Yuno Assistant/)).toBeTruthy();
  });
  it('R-16/R-23 an agent reply shows → human name and the Slack badge', () => {
    const reply = MessageSchema.parse({
      ...human(null),
      id: '00000000-0000-4000-8000-000000000002',
      fromKind: 'agent',
      fromId: id,
      idempotencyKey: 'reply',
      content: 'Hi Taylor',
    });
    render(
      <MessageTrail
        messages={[human('Taylor Clements'), reply]}
        agents={[agent]}
      />,
    );
    expect(screen.getByText('Yuno Assistant → Taylor Clements')).toBeTruthy();
    expect(screen.getAllByText('Slack')).toHaveLength(2);
  });
  it('R-16/R-23 a recent reply resolves its human from full conversation history', () => {
    const reply = MessageSchema.parse({
      ...human(null),
      id: '00000000-0000-4000-8000-000000000002',
      fromKind: 'agent',
      fromId: id,
      idempotencyKey: 'reply',
      content: 'Hi Taylor',
    });
    render(
      <MessageTrail
        messages={[reply]}
        conversationMessages={[human('Taylor Clements'), reply]}
        agents={[agent]}
      />,
    );
    expect(screen.getByText('Yuno Assistant → Taylor Clements')).toBeTruthy();
    expect(screen.queryByText('Hello')).toBeNull();
  });
  it('R-16/R-23 old messages with null from_name display their old ID as fallback', () => {
    render(<MessageTrail messages={[human(null)]} agents={[agent]} />);
    expect(screen.getByText(/U123.*→ Yuno Assistant/)).toBeTruthy();
  });
  it('R-10 rejected edge paths have fill none in dark theme', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(
      resolve(process.cwd(), 'src/styles.css'),
      'utf8',
    );
    document.head.append(style);
    document.documentElement.dataset.theme = 'dark';
    const { container } = render(
      <div className="workflow-canvas">
        <svg>
          <g className="condition-rejected">
            <path className="react-flow__edge-path" />
          </g>
        </svg>
      </div>,
    );
    try {
      const path = container.querySelector('path');
      if (!path) throw new Error('missing_edge');
      // jsdom does not compute SVG fill reliably; inspect every matching stylesheet rule.
      const rules = Array.from(style.sheet?.cssRules ?? []).filter(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && path.matches(rule.selectorText),
      );
      const fills = rules
        .map((rule) => rule.style.getPropertyValue('fill'))
        .filter(Boolean);
      expect(fills.length).toBeGreaterThan(0);
      expect(fills.every((fill) => fill === 'none')).toBe(true);
    } finally {
      style.remove();
      delete document.documentElement.dataset.theme;
    }
  });
});
