/** Check local Markdown links/images and heading anchors without a network call. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve, relative } from 'node:path';
import { LAB_ROOT } from '../src/lab/paths.mjs';

const files = readdirSync(LAB_ROOT).filter((name) => name.endsWith('.md')).map((name) => resolve(LAB_ROOT, name));
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith('.md')) files.push(file);
  }
}
walk(resolve(LAB_ROOT, 'docs'));

const source = (file) => readFileSync(file, 'utf8').replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
const anchors = new Map();
for (const file of files) {
  const counts = new Map();
  const ids = new Set();
  for (const match of source(file).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const text = match[1].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    ids.add(count ? `${base}-${count}` : base);
  }
  anchors.set(file, ids);
}

const failures = [];
let checked = 0;
for (const file of files) {
  for (const match of source(file).matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1].replace(/^<|>$/g, '');
    if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith('//')) continue;
    const [path, anchor] = href.split('#');
    const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
    checked++;
    if (!existsSync(target)) failures.push(`${relative(LAB_ROOT, file)}: missing ${href}`);
    else if (anchor && extname(target) === '.md' && !anchors.get(target)?.has(decodeURIComponent(anchor))) {
      failures.push(`${relative(LAB_ROOT, file)}: missing heading ${href}`);
    }
  }
}
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`PASS ${files.length} Markdown files, ${checked} local links/images/anchors\n`);
}
