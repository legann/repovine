// Example third-party repovine source plugin.
//
// A deliberately tiny Go parser built on regex — NO `go` toolchain required — so it runs anywhere.
// It demonstrates the whole contract a third-party plugin honors:
//   • discover() finds the artifacts it owns (no AST);
//   • extract() emits SEMANTICS ONLY (imports/exports/semanticHints) keyed back to the
//     engine-minted moduleId — discover() reports pkg + relPath and the engine mints the id, so a
//     plugin never spells `mod:<pkg>/<path>` itself and never sets id/filePath/contentHash;
//   • routes go into `semanticHints.routes`, the normalized route fact the core reads — in a graph
//     build the built-in `server-entrypoints` interpreter reads that slot for the `typescript` and
//     `python` source plugins.
//
// Authored through the SDK, which is what a real package does: `defineSourcePlugin` stamps the
// contract major, and `walkRepository` is the discovery traversal — it prunes the directories the
// graph never indexes (`vendor/`, `node_modules/`, build output, test layouts) and enumerates in an
// order that does not depend on the host filesystem. A plugin that walked the tree itself would
// carry a second copy of both rules and drift from the engine on the first one that changed.

import { defineSourcePlugin, hostPathKey, walkRepository } from '@repovine/plugin-sdk';

const GO_RE = /\.go$/;

export default defineSourcePlugin({
  id: 'go',
  fileMatch: { extensions: ['.go'] },
  // `moduleIdNormalize` states this ecosystem's facts; the ENGINE applies them when it mints ids.
  capabilities: {
    extensions: ['.go'],
    moduleIdNormalize: { stripSuffixes: ['.go'] },
  },

  // Pass 1 — discovery (no parsing). Return packages + candidate files keyed by absolute path.
  discover(repoRoot) {
    const pkg = { name: 'go-app', path: '.', sourcePluginId: 'go' };
    const pendingByPath = new Map();
    walkRepository(repoRoot, {
      onFile: ({ absPath, relFromRoot, name }) => {
        if (!GO_RE.test(name)) return;
        // Canonical key, not the raw path: the engine merges every producer's drafts on one key
        // form, and on win32 the same file spelled two ways would register twice.
        pendingByPath.set(hostPathKey(absPath), {
          filePath: absPath,
          pkg,
          relPath: relFromRoot,
          sourcePluginId: 'go',
        });
      },
    });
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
});
