import { describe, it, expect } from 'vitest';
import { generateSystemPrompt } from './prompt';

describe('generateSystemPrompt', () => {
  it('assembles all filled sections', () => {
    const p = generateSystemPrompt({
      role: 'code reviewer', task: 'review pull requests', tone: 'concise',
      constraints: 'Never approve untested code', outputFormat: 'bullet list',
    });
    expect(p).toBe([
      '# Role\nYou are code reviewer.',
      '# Task\nreview pull requests',
      '# Tone\nconcise',
      '# Constraints\n- Never approve untested code',
      '# Output Format\nbullet list',
    ].join('\n\n'));
  });
  it('omits empty optional sections', () => {
    const p = generateSystemPrompt({ role: 'assistant', task: 'answer questions' });
    expect(p).toContain('# Role');
    expect(p).not.toContain('Constraints');
  });
  it('bulletizes multi-line constraints', () => {
    const p = generateSystemPrompt({ role: 'r', task: 't', constraints: 'a\nb' });
    expect(p).toContain('- a\n- b');
  });
  it('omits whitespace-only tone', () => {
    const p = generateSystemPrompt({ role: 'r', task: 't', tone: '  ' });
    expect(p).not.toContain('# Tone');
  });
});
