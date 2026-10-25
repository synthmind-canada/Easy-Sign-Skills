// 打包层的检查：每个 SKILL.md 的 frontmatter 合 Agent Skills 规范、插件清单列出的 skill 都在、
// 文档里引用的相对路径都存在。
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'plugins/easy-sign');
const SKILLS = join(PLUGIN, 'skills');

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'SKILL.md must start with YAML frontmatter');
  const fields = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2];
  }
  return fields;
}

const skillDirs = readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

test('there are skills to check', () => {
  assert.deepEqual(skillDirs.sort(), ['easy-sign-send', 'easy-sign-verify']);
});

for (const name of skillDirs) {
  test(`${name}: frontmatter follows the Agent Skills spec`, () => {
    const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    const fm = frontmatter(text);
    assert.equal(fm.name, name, 'name must match the folder');
    assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(fm.name.length <= 64);
    assert.ok(fm.description && fm.description.length <= 1024, 'description is required, at most 1024 characters');
    assert.ok(!fm.compatibility || fm.compatibility.length <= 500);
    assert.ok(text.split('\n').length < 500, 'keep SKILL.md under 500 lines');
  });

  test(`${name}: every relative link and script it mentions exists`, () => {
    const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    const paths = new Set();
    for (const m of text.matchAll(/\]\(((?:references|scripts|assets)\/[^)]+)\)/g)) paths.add(m[1]);
    for (const m of text.matchAll(/`((?:scripts|references)\/[\w./-]+)`/g)) paths.add(m[1]);
    for (const m of text.matchAll(/<this skill's folder>\/([\w./-]+)/g)) paths.add(m[1]);
    assert.ok(paths.size > 0);
    for (const p of paths) assert.ok(existsSync(join(SKILLS, name, p)), `${name}/${p} is missing`);
  });
}

test('plugin.json lists exactly the skills that exist', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8'));
  assert.deepEqual(manifest.skills.map((s) => s.replace('./skills/', '')).sort(), skillDirs.sort());
  for (const s of manifest.skills) assert.ok(existsSync(join(PLUGIN, s, 'SKILL.md')));
});

test('marketplace entry name matches the plugin manifest name', () => {
  const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, manifest.name);
  assert.ok(existsSync(join(ROOT, market.plugins[0].source, '.claude-plugin/plugin.json')));
});

test('versions agree across plugin.json and both SKILL.md files', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8'));
  for (const name of skillDirs) {
    const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`version: "${manifest.version.replaceAll('.', '\\.')}"`), name);
  }
});
