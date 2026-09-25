import { describe, it, expect } from 'vitest';
import { generateSystemPrompt } from './prompt';

describe('generateSystemPrompt', () => {
  it('assembles all filled sections', () => {
    const p = generateSystemPrompt({
      role: 'code reviewer', task: 'review pull requests', tone: 'concise',
      constraints: 'Never approve untested code', outputFormat: 'bullet list',
    });
    expect(p).toContain('# Role');
    expect(p).toContain('code reviewer');
    expect(p).toContain('review pull requests');
    expect(p).toContain('concise');
    expect(p).toContain('Never approve untested code');
    expect(p).toContain('bullet list');
  });
  it('omits empty optional sections', () => {
    const p = generateSystemPrompt({ role: 'assistant', task: 'answer questions' });
    expect(p).toContain('# Role');
    expect(p).not.toContain('Constraints');
  });
});
