import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { guardedRoots, repoRoot, sourceFiles } from './graph-law-helpers.js';

/**
 * Law: `node:path` is applied to host paths, never to the repo-relative ones the graph compares.
 *
 * Two path vocabularies meet in this codebase and the contract already separates them by name. A
 * host path is whatever the filesystem spelled — absolute, `\` on Windows — and `node:path` is what
 * reads it. A repo-relative path is the form module ids, annotation keys and hashes compare: POSIX
 * by construction, produced and read by the SDK's own helpers.
 *
 * Handing a repo-relative path to `node:path` breaks on Windows only. `path.normalize('a/b')` there
 * returns `a\b`, and the result then fails every comparison against the POSIX form that minted the
 * id — on a machine no one runs the suite on. The mistake is invisible to a green run, which is why
 * it needs a law rather than a review.
 *
 * The rule is by argument, not by import: forbidding `node:path` outright would be false, because
 * reading a host path is exactly what it is for.
 */

/** Parameter and field names the contract gives a repo-relative POSIX path. */
const REPO_RELATIVE_NAMES = new Set([
  'relPath',
  'relFromRoot',
  'relativeFilePath',
  'infraRelPath',
  'relDirPath',
]);

/**
 * Call sites reviewed and found safe, with the reason each is.
 *
 * An entry is not an excuse to add another: it records that a human read this one and why it holds.
 * A new site has to earn its own line, which is the point of registering rather than silencing.
 */
const REVIEWED = new Map<string, string>([
  [
    'packages/plugins/source-typescript/src/discover.ts::pathPrefixLength',
    'Both sides go through the same `path.normalize` and are compared with the same `path.sep`, so '
    + 'the host spelling is self-consistent; only a character length leaves the function, and the '
    + 'separator count normalization does not change it.',
  ],
]);

interface Offender {
  site: string;
  code: string;
}

/** The nearest named function or method around a node, for a site name a reader can find. */
function enclosingName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    // A variable names the site only when it holds the function: `const norm = path.normalize(...)`
    // is a step inside a function, not the function a reader would go looking for.
    if (
      ts.isVariableDeclaration(current)
      && ts.isIdentifier(current.name)
      && current.initializer !== undefined
      && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    ) return current.name.text;
  }
  return '<top-level>';
}

/** True for a call of the form `path.something(...)`. */
function isHostPathCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.expression)
    && callee.expression.text === 'path';
}

function scan(root: string, dir: string, offenders: Offender[]): void {
  for (const file of sourceFiles(dir)) {
    if (file.endsWith('.d.ts')) continue;
    const text = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const rel = path.relative(root, file).replace(/\\/g, '/');

    const visit = (node: ts.Node): void => {
      if (isHostPathCall(node)) {
        for (const argument of node.arguments) {
          if (!ts.isIdentifier(argument) || !REPO_RELATIVE_NAMES.has(argument.text)) continue;
          const site = `${rel}::${enclosingName(node)}`;
          if (REVIEWED.has(site)) continue;
          offenders.push({ site, code: node.getText().replace(/\s+/g, ' ').slice(0, 100) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

describe('core-laws host paths stay host paths', () => {
  it('never hands a repo-relative path to node:path', () => {
    const offenders: Offender[] = [];
    for (const { root, dir } of guardedRoots()) {
      if (fs.existsSync(dir)) scan(root, dir, offenders);
    }

    expect(offenders.map(offender => `${offender.site}: ${offender.code}`).sort()).toEqual([]);
  });

  it('keeps every reviewed carve-out live, so a stale entry cannot hide a new site', () => {
    const live = new Set<string>();
    for (const { root, dir } of guardedRoots()) {
      if (!fs.existsSync(dir)) continue;
      for (const file of sourceFiles(dir)) {
        if (file.endsWith('.d.ts')) continue;
        const rel = path.relative(root, file).replace(/\\/g, '/');
        const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
        const visit = (node: ts.Node): void => {
          if (isHostPathCall(node)) {
            for (const argument of node.arguments) {
              if (ts.isIdentifier(argument) && REPO_RELATIVE_NAMES.has(argument.text)) {
                live.add(`${rel}::${enclosingName(node)}`);
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }

    expect([...REVIEWED.keys()].filter(site => !live.has(site)).sort()).toEqual([]);
    expect([...REVIEWED.values()].filter(reason => reason.trim().length < 40)).toEqual([]);
  });

  it('reads the trees it claims to read', () => {
    const dirs = guardedRoots().map(entry => entry.dir).filter(dir => fs.existsSync(dir));
    expect(dirs.some(dir => dir.endsWith(path.join('repovine', 'src')) || dir === path.join(repoRoot(), 'src'))).toBe(true);
    expect(dirs.some(dir => dir.includes(path.join('packages', 'plugins')))).toBe(true);
  });
});
