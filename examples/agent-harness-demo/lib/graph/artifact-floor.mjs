// Referenced-artifact existence floor (deterministic).
//
// Declared file references are contracts: a compose service that names a
// Dockerfile which does not exist fails at `docker compose up --build`, and no
// LLM review reliably checks file existence. This floor scans a SMALL, fixed
// taxonomy of machine-readable references with tolerant line-level parsing (no
// YAML dependency — the files are agent-authored with conventional formatting;
// a miss produces a false NEGATIVE, never a false blocker). Missing targets
// become fix-ledger blockers, like the grounded test floor.
import fs from 'node:fs';
import path from 'node:path';

const unquote = (s) => String(s ?? '').trim().replace(/^['"]|['"]$/g, '');

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}

/**
 * compose: every `dockerfile:` resolved against the nearest preceding `context:`;
 * `env_file:` entries in both syntaxes. The long map form
 * (`- path: .env` + `required: false`) is compose's sanctioned optional-env
 * pattern — a missing optional file is not a defect, so those entries are skipped;
 * `required: true` (or an absent `required`) keeps the reference.
 */
function composeReferences(repoRoot, composeFile) {
  const lines = readLines(path.join(repoRoot, composeFile));
  if (!lines) return [];
  const refs = [];
  let lastContext = '.';
  let inEnvFileList = false;
  // Long-syntax env_file entry awaiting its `required:` verdict.
  let pendingEnvRef = null;
  const flushPendingEnvRef = () => {
    if (pendingEnvRef) refs.push(pendingEnvRef);
    pendingEnvRef = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '');
    const context = line.match(/^\s*context:\s*(\S.*)$/);
    if (context) {
      lastContext = unquote(context[1]);
      flushPendingEnvRef();
      inEnvFileList = false;
      continue;
    }
    const dockerfile = line.match(/^\s*dockerfile:\s*(\S.*)$/);
    if (dockerfile) {
      refs.push({ source: composeFile, target: path.join(lastContext, unquote(dockerfile[1])) });
      flushPendingEnvRef();
      inEnvFileList = false;
      continue;
    }
    const envInline = line.match(/^\s*env_file:\s*(\S.*)$/);
    if (envInline) {
      refs.push({ source: composeFile, target: unquote(envInline[1]) });
      flushPendingEnvRef();
      inEnvFileList = false;
      continue;
    }
    if (/^\s*env_file:\s*$/.test(line)) {
      flushPendingEnvRef();
      inEnvFileList = true;
      continue;
    }
    if (inEnvFileList) {
      const item = line.match(/^\s*-\s*(\S.*)$/);
      if (item) {
        flushPendingEnvRef();
        const mapPath = item[1].match(/^path:\s*(\S.*)$/);
        if (mapPath) pendingEnvRef = { source: composeFile, target: unquote(mapPath[1]) };
        else refs.push({ source: composeFile, target: unquote(item[1]) });
      } else if (/^\s*required:\s*(false|'false'|"false")\s*$/i.test(line)) {
        pendingEnvRef = null;
      } else if (pendingEnvRef && /^\s*[A-Za-z_-]+:/.test(line)) {
        // Other map continuation keys (required: true, format: …) keep the entry.
      } else if (line.trim()) {
        flushPendingEnvRef();
        inEnvFileList = false;
      }
    }
  }
  flushPendingEnvRef();
  return refs;
}

/** tsconfig `extends` with a relative path (bare package specifiers are skipped). */
function tsconfigReferences(repoRoot, tsconfigFile) {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, tsconfigFile), 'utf8');
    const m = raw.match(/"extends"\s*:\s*"([^"]+)"/);
    if (!m || !m[1].startsWith('.')) return [];
    const dir = path.dirname(tsconfigFile);
    const target = path.join(dir, m[1]);
    return [{ source: tsconfigFile, target, tryJsonExt: true }];
  } catch {
    return [];
  }
}

const COMPOSE_NAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

function shallowTsconfigs(repoRoot) {
  const out = [];
  const scan = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isFile() && /^tsconfig(\..+)?\.json$/.test(ent.name)) out.push(path.join(dir, ent.name));
    }
  };
  scan('.');
  for (const ent of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== 'node_modules') scan(ent.name);
  }
  return out;
}

/** package dirs = every dir with a package.json, shallow (root + one level). */
function packageDirs(repoRoot) {
  const out = [];
  if (fs.existsSync(path.join(repoRoot, 'package.json'))) out.push('.');
  let entries;
  try {
    entries = fs.readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    if (fs.existsSync(path.join(repoRoot, ent.name, 'package.json'))) out.push(ent.name);
  }
  return out;
}

/** `RUN npm ci` in a Dockerfile whose build context has no lockfile → fails at build. */
function npmCiWithoutLockfile(repoRoot) {
  const out = [];
  for (const dir of packageDirs(repoRoot)) {
    const dockerfile = path.join(repoRoot, dir, 'Dockerfile');
    const lines = readLines(dockerfile);
    if (!lines) continue;
    const usesCi = lines.some((l) => /^\s*RUN\s+.*\bnpm\s+ci\b/.test(l.replace(/#.*$/, '')));
    if (!usesCi) continue;
    const hasLock = ['package-lock.json', 'npm-shrinkwrap.json'].some((f) => fs.existsSync(path.join(repoRoot, dir, f)));
    if (!hasLock) {
      out.push(`referenced artifact missing: ${path.join(dir, 'Dockerfile')} runs \`npm ci\` but no package-lock.json exists in ${dir === '.' ? 'the repo root' : dir}`);
    }
  }
  return out;
}

/** `import.meta.env` used in a TS file while no `vite/client` type reference exists. */
function importMetaEnvWithoutViteClient(repoRoot) {
  const out = [];
  for (const dir of packageDirs(repoRoot)) {
    const srcDir = path.join(repoRoot, dir, 'src');
    let usesEnv = false;
    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(ent.name)) {
          const lines = readLines(full);
          if (lines && lines.some((l) => /import\.meta\.env/.test(l))) usesEnv = true;
        }
      }
    };
    walk(srcDir);
    if (!usesEnv) continue;
    // vite/client is declared via a `/// <reference types="vite/client" />` in any
    // .d.ts, or `"types": [... "vite/client" ...]` in the package tsconfig.
    let hasRef = false;
    const dtsWalk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) dtsWalk(full);
        else if (ent.name.endsWith('.d.ts')) {
          const raw = (readLines(full) || []).join('\n');
          if (/reference\s+types=["']vite\/client["']/.test(raw)) hasRef = true;
        }
      }
    };
    dtsWalk(path.join(repoRoot, dir));
    if (!hasRef) {
      const tsconfig = readLines(path.join(repoRoot, dir, 'tsconfig.json'));
      if (tsconfig && /vite\/client/.test(tsconfig.join('\n'))) hasRef = true;
    }
    if (!hasRef) {
      out.push(`referenced artifact missing: ${path.join(dir, 'src')} uses import.meta.env but no \`vite/client\` type reference exists (add ${path.join(dir, 'src', 'vite-env.d.ts')})`);
    }
  }
  return out;
}

/** Blockers for declared file references whose targets do not exist. */
export function missingReferencedArtifacts(repoRoot) {
  const refs = [];
  for (const name of COMPOSE_NAMES) refs.push(...composeReferences(repoRoot, name));
  for (const ts of shallowTsconfigs(repoRoot)) refs.push(...tsconfigReferences(repoRoot, ts));

  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    const abs = path.join(repoRoot, ref.target);
    const exists = fs.existsSync(abs) || (ref.tryJsonExt && fs.existsSync(`${abs}.json`));
    if (exists) continue;
    const key = `${ref.source}:${ref.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`referenced artifact missing: ${ref.source} declares "${ref.target}" but the file does not exist`);
  }
  out.push(...npmCiWithoutLockfile(repoRoot));
  out.push(...importMetaEnvWithoutViteClient(repoRoot));
  return out;
}
