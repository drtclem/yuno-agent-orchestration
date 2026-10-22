import { describe, expect, it } from 'vitest';
import { normalizeSlackText } from '../src/channels/slack/normalize.js';

describe('T24 Slack markup normalization (R-19/R-23)', () => {
  it.each([
    ['<https://x|label>', 'label (https://x)'],
    ['<https://x>', 'https://x'],
    ['Hi <@U123> <@U404>', 'Hi @Taylor Clements @U404'],
    ['&amp; &lt; &gt;', '& < >'],
    ['Plain Unicode 🌍 使用', 'Plain Unicode 🌍 使用'],
    ['&lt;@U123&gt;', '<@U123>'],
  ])('R-19/R-23 normalizes %s to %s', (input, output) => {
    expect(normalizeSlackText(input, { U123: 'Taylor Clements' })).toBe(output);
  });
});
