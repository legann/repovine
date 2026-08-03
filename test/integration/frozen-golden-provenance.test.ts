/**
 * Correctness audit for the code-generated phase6 goldens.
 *
 * The parity snapshots prove regression stability, not truth. This test independently checks that
 * every non-domain node frozen into them has primary evidence in the fixture tree:
 *
 *  - package nodes point at a real package marker or a path-derived package;
 *  - module nodes point at a real file;
 *  - export labels occur at their frozen source line;
 *  - runtime resources point at real declarations, with their label present in the declaration
 *    or represented by the declared file itself.
 *
 * The frozen corpus carries no composed `default (<local>)` label — the fixture producing that
 * shape has no `expected.json` and so stays outside the freeze. The last describe block builds that
 * fixture live and runs the same export check over it, so the composed-label decode has a witness.
 *
 * Domain labels have their stronger tree-name invariant in domain-label-provenance.test.ts.
 */
import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compareCodeUnits } from '../../src/platform/ordering.js';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';

interface GoldenNode {
  id: string;
  type: string;
  label: string;
  data?: {
    path?: string;
    absPath?: string;
    lineRange?: { start: number; end: number };
    declaredIn?: string[];
    provider?: string;
  };
}

interface GoldenProjection {
  nodes: GoldenNode[];
}

const FIXTURES_ROOT = path.resolve(process.cwd(), 'test', 'fixtures');
const GOLDENS_ROOT = path.resolve(process.cwd(), 'test', 'unit', 'stage2', '__phase6_parity__');
const PACKAGE_MARKERS = ['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'tsconfig.json'];

const GOLDEN_FILES = fs
  .readdirSync(GOLDENS_ROOT)
  .filter(name => name.endsWith('.json'))
  .sort();

function sourcePath(fixtureRoot: string, absPath: string | undefined): string | undefined {
  if (!absPath?.startsWith('<FIXTURE>')) return undefined;
  return path.resolve(fixtureRoot, absPath.slice('<FIXTURE>'.length).replace(/^[/\\]/, ''));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function packageLabelHasEvidence(fixtureRoot: string, node: GoldenNode): boolean {
  const relativePath = node.data?.path;
  if (relativePath === undefined) return false;
  if (relativePath === '.' && node.label === 'root') return true;

  const packageRoot = path.resolve(fixtureRoot, relativePath);
  const markerText = PACKAGE_MARKERS
    .map(marker => path.join(packageRoot, marker))
    .filter(marker => fs.existsSync(marker))
    .map(marker => fs.readFileSync(marker, 'utf8'))
    .join('\n');
  const pathLabel = relativePath.split(/[\\/]/).filter(Boolean).join('-');
  return markerText.includes(node.label) || pathLabel === node.label;
}

/**
 * Text the frozen source window must contain for a label. A signature-less default export is
 * displayed as `default (<local declaration>)` and its line range covers that declaration, so the
 * local name carries the evidence; every other label is its own evidence.
 */
function labelEvidenceText(label: string): string {
  const composedDefault = /^default \((.+)\)$/.exec(label);
  return composedDefault ? composedDefault[1] : label;
}

function exportLabelHasEvidence(
  fixtureRoot: string,
  node: GoldenNode,
  modules: ReadonlyMap<string, GoldenNode>,
): boolean {
  const rest = node.id.slice('export:'.length);
  const separator = rest.lastIndexOf('/');
  if (separator <= 0) return false;
  const owner = modules.get(`mod:${rest.slice(0, separator)}`);
  const ownerPath = sourcePath(fixtureRoot, owner?.data?.absPath);
  const range = node.data?.lineRange;
  if (!ownerPath || !range || !fs.existsSync(ownerPath)) return false;

  const lines = fs.readFileSync(ownerPath, 'utf8').split(/\r?\n/);
  const start = Math.max(0, range.start - 2);
  const end = Math.min(lines.length, range.end + 1);
  return lines.slice(start, end).join('\n').includes(labelEvidenceText(node.label));
}

function runtimeResourceHasEvidence(fixtureRoot: string, node: GoldenNode): boolean {
  const declaredIn = node.data?.declaredIn ?? [];
  if (declaredIn.length === 0) return false;

  const declarationPaths = declaredIn.map(relativePath => path.resolve(fixtureRoot, relativePath));
  if (declarationPaths.some(candidate => !isInside(fixtureRoot, candidate) || !fs.existsSync(candidate))) {
    return false;
  }

  const declarationText = declarationPaths.map(candidate => fs.readFileSync(candidate, 'utf8')).join('\n');
  const unqualifiedLabel = node.label.replace(/^(?:secret|function|cron|rewrite):/, '');
  const declaredByFilename = declaredIn.some(relativePath =>
    relativePath === node.label || relativePath.endsWith(`/${node.label}`));
  const providerRoot =
    node.data?.provider === 'vercel'
    && node.label === 'project'
    && declaredIn.some(relativePath => relativePath.endsWith('vercel.json'));
  return declarationText.includes(node.label)
    || declarationText.includes(unqualifiedLabel)
    || declaredByFilename
    || providerRoot;
}

describe.each(GOLDEN_FILES)('frozen golden provenance: %s', (goldenFile) => {
  it('backs every frozen non-domain node with fixture evidence', () => {
    const fixtureName = goldenFile.slice(0, -'.json'.length);
    const fixtureRoot = path.join(FIXTURES_ROOT, fixtureName);
    const projection = JSON.parse(
      fs.readFileSync(path.join(GOLDENS_ROOT, goldenFile), 'utf8'),
    ) as GoldenProjection;
    const modules = new Map(
      projection.nodes.filter(node => node.type === 'module').map(node => [node.id, node]),
    );
    const gaps: string[] = [];

    for (const node of projection.nodes) {
      switch (node.type) {
        case 'root':
          if (node.id !== 'root' || node.label !== 'Repository') gaps.push(`${node.id}: invalid root`);
          break;
        case 'domain':
          // Covered against tree names for every fixture by domain-label-provenance.test.ts.
          break;
        case 'package': {
          const packageRoot = path.resolve(fixtureRoot, node.data?.path ?? '');
          if (
            !isInside(fixtureRoot, packageRoot)
            || !fs.existsSync(packageRoot)
            || node.id !== `pkg:${node.label}`
            || !packageLabelHasEvidence(fixtureRoot, node)
          ) {
            gaps.push(`${node.id}: package has no marker/path evidence`);
          }
          break;
        }
        case 'module': {
          const candidate = sourcePath(fixtureRoot, node.data?.absPath);
          if (!candidate || !isInside(fixtureRoot, candidate) || !fs.existsSync(candidate)) {
            gaps.push(`${node.id}: module file is absent`);
          }
          break;
        }
        case 'export-symbol':
          if (!exportLabelHasEvidence(fixtureRoot, node, modules)) {
            gaps.push(`${node.id}: export label is absent at the frozen source line`);
          }
          break;
        case 'runtime-resource':
          if (!runtimeResourceHasEvidence(fixtureRoot, node)) {
            gaps.push(`${node.id}: resource has no declaration evidence`);
          }
          break;
        default:
          gaps.push(`${node.id}: unreviewed node type ${node.type}`);
      }
    }

    expect(gaps).toEqual([]);
  });
});

/**
 * Fixture whose default export is a signature-less re-export of a named local declaration, the only
 * shape that produces a composed label. It carries no `expected.json`, so no golden freezes it.
 */
const COMPOSED_DEFAULT_FIXTURE = 'basic-typescript';

/** The composed export node that fixture must produce, as `<id> -> <label>`. */
const COMPOSED_DEFAULT_EXPORTS = ['export:basic-typescript/src/plugin-descriptor/default -> default (namedDescriptor)'];

/** Golden `data.absPath` form: fixture-root-relative behind the `<FIXTURE>` marker, `/`-separated. */
function fixtureMarkerPath(pkgRelPath: string): string {
  return `<FIXTURE>/${pkgRelPath.split(path.sep).join('/')}`;
}

describe(`composed default export label: ${COMPOSED_DEFAULT_FIXTURE}`, () => {
  it('backs a composed label through the local declaration it names', async () => {
    const fixtureRoot = path.join(FIXTURES_ROOT, COMPOSED_DEFAULT_FIXTURE);
    const snapshot = await collectRepositoryFactsAsync(fixtureRoot);
    const graph = composeRepositoryGraph(snapshot);

    const modules = new Map<string, GoldenNode>();
    for (const node of graph.nodes.values()) {
      if (node.type !== 'module') continue;
      const pkgRelPath = node.data?.pkgRelPath;
      if (pkgRelPath === undefined) continue;
      modules.set(node.id, {
        id: node.id,
        type: node.type,
        label: node.label,
        data: { absPath: fixtureMarkerPath(pkgRelPath) },
      });
    }

    const composed: GoldenNode[] = [...graph.nodes.values()]
      .filter(node => node.type === 'export-symbol' && /^default \(.+\)$/.test(node.label))
      .map(node => ({
        id: node.id,
        type: node.type,
        label: node.label,
        data: { lineRange: node.type === 'export-symbol' ? node.data?.lineRange : undefined },
      }))
      // Node ids collate by UTF-16 code unit, the same order the engine ships. The expectation
      // below is a frozen literal, and a locale-sensitive comparator would reorder ids that differ
      // by case or by `-` vs `_` from one ICU build to the next.
      .sort((a, b) => compareCodeUnits(a.id, b.id));

    // Without this the checks below are vacuous: a producer that stopped composing the label leaves
    // nothing to check, and the composed decode would go unwitnessed again.
    expect(composed.map(node => `${node.id} -> ${node.label}`)).toEqual(COMPOSED_DEFAULT_EXPORTS);

    for (const node of composed) {
      // The line range covers the local declaration, not the `export default …` statement, so the
      // composed label is absent from the source window and the local name carries the evidence.
      expect(`${node.id}: ${exportLabelHasEvidence(fixtureRoot, node, modules)}`).toBe(`${node.id}: true`);

      // A local name the window does not carry stays unbacked — evidence text that decays to
      // something every window contains would pass the case above too.
      const unnamed = { ...node, label: 'default (absentLocalDeclaration)' };
      expect(`${node.id}: ${exportLabelHasEvidence(fixtureRoot, unnamed, modules)}`).toBe(`${node.id}: false`);
    }
  });
});
