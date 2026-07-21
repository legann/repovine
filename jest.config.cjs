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
  globalSetup: '<rootDir>/test/jest.global-setup.cjs',
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  testTimeout: 120000,
  workerIdleMemoryLimit: '1G',
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'text', 'html'],
};
