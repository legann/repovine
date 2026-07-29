// The build checks that it emitted what it promises.
//
// `npm run build` starts by deleting `dist`, so anything that reads the tree while it runs sees an
// absent or half-written one. That has surfaced twice as an `ENOENT` from the middle of a test run
// and once from `npm pack` — always naming a file nobody had checked for, because the checks that
// existed named a handful of entry points and a partially emitted `dist` passes those.
//
// The rule is mechanical: every compiled source module has an emitted counterpart. It belongs to the
// build rather than to the test harness, because the build is what promises the artifacts and every
// consumer — `npm pack`, the smoke gates, a CI job, Jest — inherits the promise.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Source files that compile to nothing: declarations are inputs to the checker, not to the emitter. */
function isCompiledSource(name) {
  return name.endsWith('.ts') && !name.endsWith('.d.ts');
}

function walk(dir, onFile, base = dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, onFile, base);
    else if (entry.isFile()) onFile(path.relative(base, abs));
  }
}

/** Every workspace that compiles TypeScript, as `{ name, srcDir, outDir }`. */
export function compiledProjects(root = ROOT) {
  const projects = [{ name: 'repovine', srcDir: path.join(root, 'src'), outDir: path.join(root, 'dist') }];
  const add = (dir, name) => {
    const srcDir = path.join(dir, 'src');
    if (fs.existsSync(srcDir)) projects.push({ name, srcDir, outDir: path.join(dir, 'dist') });
  };
  add(path.join(root, 'packages', 'plugin-sdk'), '@repovine/plugin-sdk');
  const pluginsRoot = path.join(root, 'packages', 'plugins');
  for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) add(path.join(pluginsRoot, entry.name), `packages/plugins/${entry.name}`);
  }
  return projects;
}

/**
 * Source modules with no emitted JavaScript beside them, as `"<project>: <relative path>"`.
 *
 * Empty means the build emitted a counterpart for every module it compiled. A missing `dist`
 * directory reports every module of that project rather than one line about the directory: the
 * reader wants to know the build did not run, and the count says so.
 */
export function missingBuildOutput(root = ROOT) {
  const missing = [];
  for (const project of compiledProjects(root)) {
    walk(project.srcDir, rel => {
      if (!isCompiledSource(rel)) return;
      const emitted = path.join(project.outDir, rel.replace(/\.ts$/, '.js'));
      if (!fs.existsSync(emitted)) {
        missing.push(`${project.name}: ${path.relative(root, emitted).split(path.sep).join('/')}`);
      }
    });
  }
  return missing;
}

/** Throws with every missing artifact named. `context` says which command is making the promise. */
export function assertBuildOutput(context, root = ROOT) {
  const missing = missingBuildOutput(root);
  if (missing.length === 0) return;
  const shown = missing.slice(0, 20);
  const omitted = missing.length - shown.length;
  throw new Error(
    `${context} did not emit ${missing.length} artifact(s) it promises:\n`
    + shown.map(entry => `  ${entry}`).join('\n')
    + (omitted > 0 ? `\n  … and ${omitted} more` : ''),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertBuildOutput('npm run build');
}
