import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
const root = resolve(import.meta.dir, '..');
const required = [
  'README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTEXT.md', '.impeccable.md',
  'docs/PRD.md', 'docs/ARCHITECTURE.md', 'docs/CONTRACTS.md', 'docs/BACKLOG.md',
  'docs/ACCEPTANCE.md', 'docs/HANDOFF-CLAUDE.md', 'docs/AGENT-INTEGRATION.md',
  'docs/adr/0001-desktop-stack.md',
  'docs/superpowers/plans/2026-10-28-first-desktop-slice.md',
  'reference/README.md', 'reference/design/index.html', 'reference/design/app.js',
  'reference/prototype/live.html', 'reference/prototype/live.js',
  'reference/prototype/agent-ui.js', 'reference/prototype/live-server.ts',
  'reference/prototype/agent-review.ts', 'reference/prototype/review-core.ts',
  'reference/prototype/agent-review.test.ts', 'reference/prototype/review-core.test.ts',
];
const errors: string[] = [];
for (const file of required) {
  try { await access(join(root, file)); } catch { errors.push(`Missing: ${file}`); }
}
async function inspect(directory: string) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '.review-data', 'node_modules', '.local'].includes(item.name)) continue;
    const path = join(directory, item.name);
    if (item.isDirectory()) { await inspect(path); continue; }
    if (!item.name.endsWith('.md')) continue;
    const content = await readFile(path, 'utf8');
    for (const match of content.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('/')) continue;
      try { await access(resolve(dirname(path), decodeURIComponent(target))); }
      catch { errors.push(`Broken link: ${path.slice(root.length + 1)} → ${target}`); }
    }
  }
}
await inspect(root);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const command of ['check:prep', 'test:reference', 'prototype:design', 'prototype:live']) {
  if (!pkg.scripts?.[command]) errors.push(`Missing script: ${command}`);
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Preparation OK: ${required.length} required files, local documentation links and commands verified.`);
