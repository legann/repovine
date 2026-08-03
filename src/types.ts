/**
 * Compatibility barrel. The core types were split into focused modules; this re-exports them so the
 * existing `'../types'` imports keep resolving unchanged. New code may import directly from the
 * focused modules:
 *
 * | Concern                          | Module                     |
 * |----------------------------------|----------------------------|
 * | graph taxonomy + facts snapshot  | `./graph/model.ts`         |
 * | MCP node-view projection         | `./graph/node-view.ts`     |
 * | annotation memory schema         | `./annotations/types.ts`   |
 * | plugin-sdk fact re-exports       | `./api/plugin-sdk-types.ts` |
 */
export * from './graph/model.js';
export * from './graph/node-view.js';
export * from './annotations/types.js';
export * from './api/plugin-sdk-types.js';
