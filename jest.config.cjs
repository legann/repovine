/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^@repovine/plugin-sdk$': '<rootDir>/packages/plugin-sdk/src/index.ts',
    // `/internal` maps to source for the same reason the root does, and for one more: the layout
    // table is module state. Root resolved to source and `/internal` resolved to `dist` would be two
    // copies of `dir-layout.js`, and the table the host installs would not be the one discovery reads.
    '^@repovine/plugin-sdk/internal$': '<rootDir>/packages/plugin-sdk/src/internal/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true, tsconfig: { isolatedModules: true } }],
  },
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  globalSetup: '<rootDir>/test/jest.global-setup.cjs',
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  testTimeout: 120000,
  workerIdleMemoryLimit: '1G',
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'text', 'html'],
};
