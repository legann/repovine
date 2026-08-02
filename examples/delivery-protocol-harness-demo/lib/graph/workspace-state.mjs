import fs from 'node:fs';
import path from 'node:path';

// Product source markers — repovine workspace stubs alone do NOT count as product memory.
// After /reset the harness writes empty repovine.annots.json; that must not flip
// "continuation" and block greenfield planning.
export const PRODUCT_SOURCE_MARKERS = [
  'package.json',
  'src',
  'app',
  'apps',
  'packages',
  'lib',
  'backend',
  'frontend',
  'server',
  'client',
  'docs',
  'README.md',
];

export function hasProductSourceMarkers(repoRoot, markers = PRODUCT_SOURCE_MARKERS) {
  const root = repoRoot || '.';
  return markers.some((rel) => {
    try {
      return fs.existsSync(path.join(root, rel));
    } catch {
      return false;
    }
  });
}

/** Sandbox has no app/package layout yet (typical immediately after /reset). */
export function isGreenfieldSandbox(repoRoot) {
  if (process.env.HARNESS_FORCE_MULTI === '1') return false;
  return !hasProductSourceMarkers(repoRoot);
}

/** True when repovine.annots.json is missing or only the harness empty stub. */
export function hasOnlyStubAnnotations(repoRoot) {
  const annPath = path.join(repoRoot || '.', 'repovine.annots.json');
  if (!fs.existsSync(annPath)) return true;
  try {
    const parsed = JSON.parse(fs.readFileSync(annPath, 'utf8'));
    const bucket = parsed?.annotations && typeof parsed.annotations === 'object'
      ? parsed.annotations
      : parsed;
    return Object.keys(bucket ?? {}).length === 0;
  } catch {
    return true;
  }
}

/**
 * New-project run: greenfield sandbox and/or empty orient graph with no real annotations.
 * Used by planner, orient brief, and process gate (weak orient must not fail greenfield).
 */
export function isGreenfieldContext({ repoRoot, orientTrail } = {}) {
  if (isGreenfieldSandbox(repoRoot)) return true;
  const graphEmpty = !(orientTrail?.graphNodes?.length);
  return graphEmpty && hasOnlyStubAnnotations(repoRoot);
}

export function describeWorkspaceState(repoRoot, opts = {}) {
  const greenfield = opts.greenfield ?? isGreenfieldSandbox(repoRoot);
  if (greenfield) {
    return [
      'GREENFIELD: no product source in sandbox (no package.json / backend / frontend yet).',
      'Normal after /reset. Plan scaffolding from the user task — do not assume an existing app or repovine annotations.',
      'Orient may return graphNodes: (none); implement sub-agents create the stack; defer annotations to post-review.',
    ].join(' ');
  }
  return 'Product source markers were detected; treat this as a continuation. Plan a delta over the current repovine graph and preserve graph-observed behavior/contracts unless the user explicitly asked to remove or replace them.';
}
