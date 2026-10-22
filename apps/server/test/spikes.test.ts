import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const reportPath = new URL('../../../docs/spikes.md', import.meta.url);

function section(report: string, heading: string): string {
  const start = report.indexOf(`## ${heading}`);
  expect(start, `missing spike section: ${heading}`).toBeGreaterThanOrEqual(0);
  const end = report.indexOf('\n## ', start + 1);
  return report.slice(start, end === -1 ? undefined : end);
}

describe('T1 OpenCode spike evidence (R-26, D5, D7)', () => {
  it('answers spike items 1–3 and item 4 or records not run: no key (R-26)', async () => {
    const report = await readFile(reportPath, 'utf8');
    const api = section(report, '2. Live OpenAPI');
    for (const field of [
      'system',
      'model',
      'tools',
      'directory',
      'tokens',
      'cost',
    ]) {
      expect(api).toContain(field);
    }
    expect(api).toContain('/doc');
    expect(api).toMatch(/message\.\w+/u);
    expect(api).toMatch(/permission\.\w+/u);
    expect(api).toMatch(/```json\s*\{/u);

    const permissions = section(report, '3. Per-directory permissions');
    expect(permissions).toContain('opencode.json');
    expect(permissions).toContain('permission');
    expect(permissions).toMatch(/(?:observed|confirmed|honored|fallback)/iu);

    const prompts = section(report, '4. Live prompts');
    if (!prompts.includes('not run: no key')) {
      expect(prompts).toContain('gpt-5.4-mini');
      expect(prompts).toMatch(/file/iu);
      expect(prompts).toMatch(/permission/iu);
      expect(prompts).toMatch(/(?:tokens|usage)/iu);
    }
    expect(section(report, 'Adapter design')).toMatch(/(?:session|runTurn)/u);
  });

  it('records an exact pinned runtime version for later tasks (R-26)', async () => {
    const report = await readFile(reportPath, 'utf8');
    const version = section(report, '1. Version');
    expect(version).toMatch(/opencode-ai@\d+\.\d+\.\d+(?![\d.-])/u);
    expect(version).toMatch(/(?:pin|exact)/iu);
  });
});
