import { expect, test } from 'vitest';
import { listSkills, composeSkills, parseSkillFile, skillsDir } from './compose.js';

test('skillsDir resolves to an existing catalog with the two authoring skills', () => {
  const skills = listSkills(skillsDir());
  const names = skills.map((s) => s.name).sort();
  expect(names).toEqual(['authoring-centraid-apps', 'automation-authoring']);
  for (const s of skills) {
    expect(s.description.length > 0).toBeTruthy();
  }
});

test('parseSkillFile strips YAML frontmatter and returns the body', () => {
  const { meta, body } = parseSkillFile(
    '---\nname: foo\ndescription: bar baz\n---\n# Heading\n\ntext',
  );
  expect(meta.name).toBe('foo');
  expect(meta.description).toBe('bar baz');
  expect(body).toBe('# Heading\n\ntext');
});

test('composeSkills returns the authoring contract body, frontmatter removed', () => {
  const composed = composeSkills(['authoring-centraid-apps']);
  expect(composed.startsWith('## Centraid app authoring')).toBeTruthy();
  expect(!composed.includes('---\nname:')).toBeTruthy();
  expect(composed.includes('### Folder layout (canonical)')).toBeTruthy();
});

test('composeSkills joins multiple skills with a blank line', () => {
  const composed = composeSkills(['authoring-centraid-apps', 'automation-authoring']);
  expect(composed.includes('## Centraid app authoring')).toBeTruthy();
  expect(composed.includes('## Centraid automation authoring')).toBeTruthy();
});
