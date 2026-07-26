import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { TemplateFileInfo } from '../types.js';
import { shouldScanSourcePath, type CompiledScanPatterns } from '../scan-filters.js';
import { readDirSorted } from '../fs/read-dir-sorted.js';

/**
 * Stage 1 template artifact discovery for the built-in server-templates producer (no AST).
 * Walks the repo for template files under a `templates/` directory and emits one TemplateFileInfo
 * per file. It also extracts static template body hints (parent, include, block) so stage2 can
 * materialize template-to-template edges. Projected to `template` graph nodes in stage2, mirroring
 * `collectInfraModules` -> `runtime-resource`. The `templates/` anchor keeps this precise (it does
 * not capture stray `.html` in static/docs/coverage output).
 */

/** Template file extensions recognized by the current built-in server-template producer. */
const TEMPLATE_EXTENSIONS = new Set(['.html', '.htm', '.jinja', '.jinja2', '.j2']);

const SKIP_DIRS = new Set([
  '__pycache__', '.venv', 'venv', 'env', '.env', '.git', 'node_modules', 'dist', 'build',
  '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.eggs', 'site-packages',
  '.repovine', '.cache', '.nox', 'coverage', 'htmlcov',
]);

/** Engine/dialect inferable from the extension alone. `.html`/`.htm` is ambiguous across engines;
 * explicit Jinja-family extensions are unambiguous. */
function engineFromExtension(ext: string): string | undefined {
  if (ext === '.jinja' || ext === '.jinja2' || ext === '.j2') return 'jinja2';
  return undefined;
}

/** True when the repo-relative path sits under a `templates/` directory. */
function underTemplatesDir(relPath: string): boolean {
  return relPath === 'templates' || relPath.startsWith('templates/') || relPath.includes('/templates/');
}

interface TemplateBodyHints {
  extendsTemplate?: string;
  includesTemplate?: string[];
  blocks?: string[];
}

export function parseTemplateBodyHints(content: string): TemplateBodyHints {
  const source = stripIgnoredTemplateSections(content);
  let extendsTemplate: string | undefined;
  const includesTemplate: string[] = [];
  const blocks: string[] = [];

  const tagRe = /\{%-?\s*(extends|include|block)\b([\s\S]*?)-?%\}/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(source)) !== null) {
    const directive = match[1];
    const body = match[2] ?? '';
    if (directive === 'extends') {
      extendsTemplate ??= firstQuotedLiteral(body);
    } else if (directive === 'include') {
      for (const name of quotedLiterals(body)) pushUnique(includesTemplate, name);
    } else {
      const blockName = body.trim().match(/^([A-Za-z_][\w-]*)\b/)?.[1];
      if (blockName) pushUnique(blocks, blockName);
    }
  }

  return {
    ...(extendsTemplate ? { extendsTemplate } : {}),
    ...(includesTemplate.length > 0 ? { includesTemplate } : {}),
    ...(blocks.length > 0 ? { blocks } : {}),
  };
}

function stripIgnoredTemplateSections(content: string): string {
  return content
    .replace(/\{%-?\s*(raw|verbatim)\s*-?%\}[\s\S]*?\{%-?\s*end\1\s*-?%\}/g, '')
    .replace(/\{#[\s\S]*?#\}/g, '');
}

function firstQuotedLiteral(text: string): string | undefined {
  return quotedLiterals(text)[0];
}

function quotedLiterals(text: string): string[] {
  const out: string[] = [];
  const literalRe = /(['"])(.*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = literalRe.exec(text)) !== null) {
    const value = match[2]?.trim();
    if (value) out.push(value);
  }
  return out;
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function readTemplateContent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

export function collectTemplates(opts: {
  repoRoot: string;
  scanPatterns: CompiledScanPatterns;
}): TemplateFileInfo[] {
  const { repoRoot, scanPatterns } = opts;
  const out = new Map<string, TemplateFileInfo>();

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = readDirSorted(dir);
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      const relPath = path.normalize(path.relative(repoRoot, full)).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!TEMPLATE_EXTENSIONS.has(ext)) continue;
      if (!underTemplatesDir(relPath)) continue;
      if (!shouldScanSourcePath(relPath, scanPatterns)) continue;
      if (out.has(relPath)) continue;

      const engine = engineFromExtension(ext);
      const content = readTemplateContent(full);
      const bodyHints = parseTemplateBodyHints(content);
      out.set(relPath, {
        id: `template:${relPath}`,
        relPath,
        contentHash: contentHash(content),
        ...(engine ? { engine } : {}),
        ...bodyHints,
      });
    }
  };
  walk(repoRoot);

  return [...out.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
}
