import { describe, expect, it } from 'vitest';
import { parseReply } from '../src/domain/protocol.js';

describe('T6 reply protocol (R-04, R-05, R-09)', () => {
  it('R-09 parses VERDICT case-insensitively and the last valid standalone verdict wins', () => {
    const text =
      'Feedback\n  verdict: rejected  \nVERDICT: APPROVED\nVERDICT: maybe';
    expect(parseReply(text)).toEqual({
      text,
      verdict: 'approved',
      memories: [],
    });
    expect(parseReply('VERDICT: APPROVED\nVeRdIcT: ReJeCtEd').verdict).toBe(
      'rejected',
    );
  });

  it.each([
    '',
    'VERDICT:',
    'VERDICT: maybe',
    'VERDICT: APPROVED extra',
    'Feedback VERDICT: APPROVED',
    '> VERDICT: REJECTED',
  ])('R-09 missing or malformed verdict yields null: %s', (text) => {
    expect(parseReply(text)).toEqual({ text, verdict: null, memories: [] });
  });

  it('R-04 extracts and strips REMEMBER lines, preserving visible text and verdict', () => {
    expect(
      parseReply(
        'Hello 🌍\r\n REMEMBER: Taylor prefers short answers  \r\nremember: 使用标签\r\nREMEMBER:   \r\nVERDICT: APPROVED',
      ),
    ).toEqual({
      text: 'Hello 🌍\nVERDICT: APPROVED',
      verdict: 'approved',
      memories: ['Taylor prefers short answers', '使用标签'],
    });
    expect(parseReply('A sentence with REMEMBER: inline')).toEqual({
      text: 'A sentence with REMEMBER: inline',
      verdict: null,
      memories: [],
    });
  });

  it('R-04 stripping invariant holds across protocol casing, whitespace and arbitrary surrounding lines', () => {
    for (const prefix of ['', ' ', '\t']) {
      for (const marker of ['REMEMBER:', 'remember:', 'ReMeMbEr:']) {
        for (const fact of ['', 'hello', '🌍 使用', 'VERDICT: APPROVED']) {
          const parsed = parseReply(
            `before\n${prefix}${marker} ${fact}\nafter`,
          );
          expect(parsed.text).toBe('before\nafter');
          expect(
            parsed.text.split('\n').some((line) => /^\s*REMEMBER:/i.test(line)),
          ).toBe(false);
          expect(parsed.memories).toEqual(fact ? [fact] : []);
          expect(parsed.verdict).toBeNull();
        }
      }
    }
  });

  it('R-04 strips protocol-only replies and handles long Unicode facts without truncation', () => {
    const fact = 'Keep 🌍 café 使用'.repeat(10000);
    expect(parseReply(`REMEMBER: ${fact}\nREMEMBER:`)).toEqual({
      text: '',
      verdict: null,
      memories: [fact],
    });
  });
});
