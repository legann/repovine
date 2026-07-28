import tseslint from 'typescript-eslint';

/**
 * Standalone ESLint for the repovine package.
 * Lives in repovine/ only — not inherited from a monorepo root.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'packages/*/dist/**',
      'packages/plugins/*/dist/**',
      'node_modules/**',
      'examples/**',
      'coverage/**',
      'test/fixtures/**',
      'jest.config.cjs',
      'eslint.config.js',
      // Generated client setup output (self-dogfood `setup` projections, not source).
      '.claude/**',
      '.cursor/**',
      '.codex/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: [
      'src/**/*.ts',
      'packages/plugin-sdk/src/**/*.ts',
      'packages/plugins/*/src/**/*.ts',
      'test/**/*.test.ts',
      'test/helpers/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Physical plugin-package boundary. The total law in
    // test/laws/plugin-workspace-boundary.test.ts is authoritative; this rule
    // gives immediate editor/CI feedback for the forbidden spellings.
    files: ['packages/plugins/*/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'repovine',
                'repovine/*',
                'repovine/**',
                '@repovine/plugin-sdk/src',
                '@repovine/plugin-sdk/src/*',
                '@repovine/plugin-sdk/src/**',
                '@repovine/plugin-sdk/dist',
                '@repovine/plugin-sdk/dist/*',
                '@repovine/plugin-sdk/dist/**',
                '**/../../../../src/*',
                '**/../../../../src/**',
                '**/../../../plugin-sdk/src/*',
                '**/../../../plugin-sdk/src/**',
                '**/../../*/src/*',
                '**/../../*/src/**',
                '../../../../src/*',
                '../../../../src/**',
                '../../../plugin-sdk/src/*',
                '../../../plugin-sdk/src/**',
                '../../*/src/*',
                '../../*/src/**',
              ],
              message:
                'Plugin workspaces use public package entrypoints only; core, SDK source/dist, and sibling-source bypasses are forbidden.',
            },
          ],
        },
      ],
    },
  },
  {
    // Plugin SDK boundary: built-in source/IaC plugins are authored
    // against the public contract only. They must get fact types + factories from `@repovine/plugin-sdk` and
    // must never reach into the ontology/projection/consumer layers (the layer-2/3 kept
    // core-only). A small set of mechanical engine utilities (hashing, scan filters, id helpers,
    // logging) stays allowlisted — those are not the contract, just shared plumbing. This eslint rule
    // is a fast denylist of the core layers for editor feedback; the authoritative check is the
    // runtime law `test/laws/plugin-sdk-boundary.test.ts`, a strict allowlist (only the SDK + those
    // utils pass; every other core import fails), so it also catches core modules this list omits.
    files: ['src/source-plugins/**/*.ts', 'src/iac-plugins/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/types.js',
                '**/types',
                '**/stage1/iac/registry.js',
                '**/stage2/**',
                '**/interpreter/**',
                '**/interpreters/**',
                '**/analysis/**',
                '**/mcp/**',
                '**/graph.js',
                '**/graph/**',
              ],
              message:
                'Plugins import the contract from `@repovine/plugin-sdk`, never core types/ontology/projection layers directly. Add a missing fact type to `@repovine/plugin-sdk` instead.',
            },
          ],
        },
      ],
    },
  },
  {
    // `.cjs` files (e.g. test/jest.global-setup.cjs) are CommonJS by extension — `require()` is the
    // native module system there, not a TS anti-pattern. Keep other rules; allow require.
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
