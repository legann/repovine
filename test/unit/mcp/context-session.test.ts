import { describe, expect, it } from '@jest/globals';
import { contextSessionIdFromArgs } from '../../../src/mcp/context-session.js';

describe('MCP context session attribution', () => {
  it('prefers the harness-pinned env session over model-supplied args', () => {
    const sessionId = contextSessionIdFromArgs(
      { contextSessionId: 'model-ctx' },
      { REPOVINE_CONTEXT_SESSION_ID: 'harness-ctx' } as NodeJS.ProcessEnv,
    );

    expect(sessionId).toBe('harness-ctx');
  });

  it('uses explicit contextSessionId when the harness did not pin one', () => {
    expect(contextSessionIdFromArgs(
      { contextSessionId: 'model-ctx' },
      {} as NodeJS.ProcessEnv,
    )).toBe('model-ctx');
  });

  it('does not resolve a sessionId arg; only contextSessionId attributes context', () => {
    expect(contextSessionIdFromArgs(
      { sessionId: 'alias-ctx' },
      {} as NodeJS.ProcessEnv,
    )).toBeUndefined();
  });

  it('falls through an empty env session to the model-supplied contextSessionId', () => {
    expect(contextSessionIdFromArgs(
      { contextSessionId: 'model-ctx' },
      { REPOVINE_CONTEXT_SESSION_ID: '' } as NodeJS.ProcessEnv,
    )).toBe('model-ctx');
  });

  it('falls through a whitespace-only env session to the model-supplied contextSessionId', () => {
    expect(contextSessionIdFromArgs(
      { contextSessionId: 'model-ctx' },
      { REPOVINE_CONTEXT_SESSION_ID: '   ' } as NodeJS.ProcessEnv,
    )).toBe('model-ctx');
  });

  it('resolves to undefined when a whitespace env session has no arg fallback', () => {
    expect(contextSessionIdFromArgs(
      {},
      { REPOVINE_CONTEXT_SESSION_ID: '   ' } as NodeJS.ProcessEnv,
    )).toBeUndefined();
  });
});
