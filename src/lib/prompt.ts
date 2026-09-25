export interface PromptFields {
  role: string;
  task: string;
  constraints?: string;
  outputFormat?: string;
  tone?: string;
}

export function generateSystemPrompt(f: PromptFields): string {
  const sections: string[] = [
    `# Role\nYou are ${f.role.trim()}.`,
    `# Task\n${f.task.trim()}`,
  ];
  if (f.tone?.trim()) sections.push(`# Tone\n${f.tone.trim()}`);
  if (f.constraints?.trim()) sections.push(`# Constraints\n- ${f.constraints.trim().split('\n').join('\n- ')}`);
  if (f.outputFormat?.trim()) sections.push(`# Output Format\n${f.outputFormat.trim()}`);
  return sections.join('\n\n');
}
