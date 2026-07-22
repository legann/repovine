/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^@repovine/plugin-sdk$': '<rootDir>/packages/plugin-sdk/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true, tsconfig: { isolatedModules: true } }],
  },
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  // The client-projections integration harness runs as its own in-band jest
  // invocation (`npm run test:projections`): inside a jest-worker child on
  // Windows it dies with a silent native crash (no JS stack ever reaches the
  // log; every async surface in the suite is exception-guarded). In-band there
  // is no worker child to kill, and a real crash would surface as the step's
  // own native exit code.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/integration/client-projections.test.ts'],
  globalSetup: '<rootDir>/test/jest.global-setup.cjs',
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  testTimeout: 120000,
  workerIdleMemoryLimit: '1G',
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'text', 'html'],
};
