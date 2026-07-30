#!/usr/bin/env node
/**
 * Inventory the public plugin API and write it down where a reviewer can read a diff.
 *
 * The report is generated from the built `.d.ts` of every subpath the SDK's `exports` map publishes,
 * so it is the surface a plugin author can actually reach — not a hand-kept list beside it. Every
 * name carries its kind, because the two halves age differently: a value export is code a plugin
 * calls, a type export only has to keep its shape.
 *
 * Generating the inventory declares nothing stable. It makes a change to the surface visible in a
 * pull request, which is the precondition for deciding what to freeze.
 *
 *   node scripts/generate-plugin-api-report.mjs           # write docs/plugin-api-report.md
 *   node scripts/generate-plugin-api-report.mjs --check   # exit 1 if the file is out of date
 *
 * Requires a built SDK (npm run build:sdk).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

const sdkRoot = path.join(engineRoot, 'packages', 'plugin-sdk');
const REPORT_PATH = path.join(engineRoot, 'docs', 'plugin-api-report.md');
const check = process.argv.includes('--check');

const sdkManifest = JSON.parse(readFileSync(path.join(sdkRoot, 'package.json'), 'utf-8'));

/** The kind of a declaration, in the terms an author cares about. */
function declarationKind(node) {
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isVariableStatement(node)) return 'const';
  return undefined;
}

function isExported(node) {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0
    || node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) === true;
}

/**
 * Every name a declaration file re-exports, followed through relative `export … from` chains.
 *
 * A barrel is the normal shape here, so a scan that only read the entry file would report four
 * subpaths publishing nothing.
 */
function collectExports(entryDts, seen = new Set()) {
  const found = new Map();
  const visitFile = file => {
    const resolved = existsSync(file) ? file : undefined;
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    const source = ts.createSourceFile(resolved, readFileSync(resolved, 'utf-8'), ts.ScriptTarget.ES2022, true);
    for (const statement of source.statements) {
      // `export { a, b } from './x.js'` / `export * from './x.js'`
      if (ts.isExportDeclaration(statement)) {
        const spec = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const name = element.name.text;
            const typeOnly = statement.isTypeOnly || element.isTypeOnly;
            found.set(name, { name, kind: typeOnly ? 'type' : 'value' });
          }
          continue;
        }
        if (spec?.startsWith('.')) {
          visitFile(path.resolve(path.dirname(resolved), spec.replace(/\.js$/, '.d.ts')));
        }
        continue;
      }
      const kind = declarationKind(statement);
      if (kind === undefined || !isExported(statement)) continue;
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) found.set(declaration.name.text, { name: declaration.name.text, kind });
        }
        continue;
      }
      if (statement.name && ts.isIdentifier(statement.name)) {
        found.set(statement.name.text, { name: statement.name.text, kind });
      }
    }
  };
  visitFile(entryDts);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a subpath's `.d.ts` through the manifest's own `exports` map.
 *
 * Reading the map rather than guessing `dist/<subpath>/index.d.ts` is the point: a subpath the map
 * stops publishing disappears from the report, and one it starts publishing appears.
 */
function typesEntryFor(subpath) {
  const entry = sdkManifest.exports?.[subpath];
  const types = entry && typeof entry === 'object' ? entry.types : undefined;
  if (typeof types !== 'string') return undefined;
  return path.join(sdkRoot, types);
}

const subpaths = Object.keys(sdkManifest.exports ?? {}).sort();
const sections = [];
for (const subpath of subpaths) {
  const entry = typesEntryFor(subpath);
  if (!entry) {
    sections.push({ subpath, error: 'no "types" condition in the exports map' });
    continue;
  }
  if (!existsSync(entry)) {
    sections.push({ subpath, error: `declaration file missing: ${path.relative(engineRoot, entry)}` });
    continue;
  }
  sections.push({ subpath, entry, exports: collectExports(entry) });
}

const missing = sections.filter(section => section.error);
if (missing.length > 0) {
  console.error('Cannot inventory the API surface:');
  for (const section of missing) console.error(`  ${section.subpath}: ${section.error}`);
  console.error('\nRun `npm run build:sdk` first.');
  process.exit(1);
}

const total = sections.reduce((sum, section) => sum + section.exports.length, 0);

const lines = [
  '# Public plugin API report',
  '',
  '<!-- GENERATED by scripts/generate-plugin-api-report.mjs — do not edit by hand. -->',
  '',
  `\`@repovine/plugin-sdk@${sdkManifest.version}\`, runtime contract \`apiVersion: 1\`.`,
  '',
  'Every name a plugin author can reach, by the subpath that publishes it. Generated from the built',
  'declaration files through the manifest\'s own `exports` map, so this is the reachable surface rather',
  'than a list kept beside it.',
  '',
  'This report declares nothing stable. It exists so a change to the surface shows up as a diff.',
  'Whether API 1 is stable or preview is recorded in [plugin-api-compatibility.md](plugin-api-compatibility.md).',
  '',
  '## Summary',
  '',
  '| Subpath | Exports |',
  '|---|---|',
  ...sections.map(section => `| \`@repovine/plugin-sdk${section.subpath.slice(1)}\` | ${section.exports.length} |`),
  `| **total** | **${total}** |`,
  '',
];

for (const section of sections) {
  const specifier = `@repovine/plugin-sdk${section.subpath.slice(1)}`;
  lines.push(`## \`${specifier}\``, '');
  lines.push(`Declarations: \`${path.relative(engineRoot, section.entry).split(path.sep).join('/')}\``, '');
  lines.push('| Export | Kind |', '|---|---|');
  for (const item of section.exports) lines.push(`| \`${item.name}\` | ${item.kind} |`);
  lines.push('');
}

const report = `${lines.join('\n')}`;

if (check) {
  const current = existsSync(REPORT_PATH) ? readFileSync(REPORT_PATH, 'utf-8') : '';
  if (current !== report) {
    console.error('docs/plugin-api-report.md is out of date with the built SDK declarations.');
    console.error('The public plugin API changed. Run:');
    console.error('  node scripts/generate-plugin-api-report.mjs');
    console.error('and review the diff against docs/plugin-api-compatibility.md before committing.');
    process.exit(1);
  }
  console.log(`Public plugin API report is current: ${total} exports across ${sections.length} subpaths.`);
} else {
  writeFileSync(REPORT_PATH, report);
  console.log(`Wrote ${path.relative(engineRoot, REPORT_PATH)}: ${total} exports across ${sections.length} subpaths.`);
}
