import { test } from 'vitest';
import assert from 'node:assert/strict';
import { listSkills, composeSkills, parseSkillFile, skillsDir } from './compose.js';

test('skillsDir resolves to an existing catalog with the two authoring skills', () => {
  const skills = listSkills(skillsDir());
  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ['authoring-centraid-apps', 'automation-authoring']);
  for (const s of skills) {
    assert.ok(s.description.length > 0, `skill ${s.name} has a description`);
  }
});

test('parseSkillFile strips YAML frontmatter and returns the body', () => {
  const { meta, body } = parseSkillFile(
    '---\nname: foo\ndescription: bar baz\n---\n# Heading\n\ntext',
  );
  assert.equal(meta.name, 'foo');
  assert.equal(meta.description, 'bar baz');
  assert.equal(body, '# Heading\n\ntext');
});

test('composeSkills returns the authoring contract body, frontmatter removed', () => {
  const composed = composeSkills(['authoring-centraid-apps']);
  assert.ok(composed.startsWith('## Centraid app authoring'), 'starts at the body heading');
  assert.ok(!composed.includes('---\nname:'), 'frontmatter is stripped');
  assert.ok(composed.includes('### Folder layout (canonical)'));
});

test('composeSkills joins multiple skills with a blank line', () => {
  const composed = composeSkills(['authoring-centraid-apps', 'automation-authoring']);
  assert.ok(composed.includes('## Centraid app authoring'));
  assert.ok(composed.includes('## Centraid automation authoring'));
});
