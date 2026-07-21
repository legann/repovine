// Example third-party repovine source plugin (OSS-plugin plan Phase 3/Path B).
//
// A deliberately tiny Go parser built on regex — NO `go` toolchain required — so it runs anywhere.
// It demonstrates the whole contract a third-party plugin honors:
//   • discover() finds the artifacts it owns (no AST);
//   • extract() emits SEMANTICS ONLY (imports/exports/semanticHints) keyed back to the
//     engine-minted moduleId — it never sets id/filePath/contentHash; the engine stamps those;
//   • routes go into `semanticHints.routes`, which the CORE projects into API entrypoints with no
//     new interpreter (a new language gets backend interpretation for free).
//
// Authored as a plain object on purpose: the loader validates a plugin's SHAPE structurally, so
// examples can run without importing the SDK at runtime. Real packages should use the SDK factory:
//   import { defineSourcePlugin } from '@repovine/plugin-sdk';
//   export default defineSourcePlugin({ ...the object below... });
// which additionally stamps `apiVersion` and gives you types + the conformance kit.

import * as fs from 'node:fs';
import * as path from 'node:path';

const GO_RE = /\.go$/;

function walkGoFiles(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkGoFiles(full, acc);
    else if (GO_RE.test(entry.name)) acc.push(full);
  }
}

export default {
  id: 'go',
  apiVersion: 1,
  fileMatch: { extensions: ['.go'] },
  capabilities: { extensions: ['.go'] },

  // Pass 1 — discovery (no parsing). Return packages + candidate files keyed by absolute path.
  discover(repoRoot) {
    const pkg = { name: 'go-app', path: '.', sourcePluginId: 'go' };
    const files = [];
    walkGoFiles(repoRoot, files);
    const pendingByPath = new Map();
    for (const filePath of files) {
      const rel = path.relative(repoRoot, filePath);
      pendingByPath.set(filePath, {
        filePath,
        pkg,
        relPath: rel,
        moduleId: 'mod:go-app/' + rel.replace(/\\/g, '/').replace(GO_RE, ''),
        sourcePluginId: 'go',
      });
    }
    return { packages: [pkg], pendingByPath };
  },

  // Pass 2 — emit semantics. The engine hands us raw text + hash via input.sourceByModuleId.
  extract(input) {
    const deltas = input.pendingModules.map(pm => {
      const src = input.sourceByModuleId.get(pm.moduleId);
      const text = src ? src.content : '';

      // imports: single `import "x"` and block `import ( "x" "y" )`
      const imports = [];
      for (const m of text.matchAll(/import\s+"([^"]+)"/g)) imports.push(m[1]);
      for (const block of text.matchAll(/import\s*\(([\s\S]*?)\)/g)) {
        for (const m of block[1].matchAll(/"([^"]+)"/g)) imports.push(m[1]);
      }

      // exports: capitalized (exported) func names
      const exports = [];
      for (const m of text.matchAll(/func\s+([A-Z]\w*)\s*\(/g)) {
        exports.push({ name: m[1], kind: 'function', lineRange: { start: 0, end: 0 }, isDefault: false });
      }

      // routes: gin/mux/http router calls — r.GET("/path", Handler)
      const usesGin = imports.some(i => i.includes('gin'));
      const routes = [];
      for (const m of text.matchAll(/\.(GET|POST|PUT|DELETE|PATCH)\(\s*"([^"]+)"/g)) {
        routes.push({
          path: m[2],
          component: pm.relPath,
          method: m[1],
          kind: 'api',
          framework: usesGin ? 'gin' : 'go',
          source: 'ast',
        });
      }

      const semanticHints = {};
      if (routes.length) {
        semanticHints.hasRoutes = true;
        semanticHints.routes = routes;
        semanticHints.webFramework = usesGin ? 'gin' : 'go';
      }

      return {
        moduleId: pm.moduleId,
        imports: imports.map(s => ({ moduleSpecifier: s, importedNames: [], isTypeOnly: false, isExternal: true })),
        exports,
        ...(Object.keys(semanticHints).length ? { semanticHints } : {}),
      };
    });
    return { deltas, reused: 0, rescanned: deltas.length };
  },
};
