export function contextSessionIdFromArgs(
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const envId = typeof env.REPOVINE_CONTEXT_SESSION_ID === 'string'
    ? env.REPOVINE_CONTEXT_SESSION_ID.trim()
    : '';
  if (envId.length > 0) return envId;

  if (typeof args.contextSessionId === 'string' && args.contextSessionId.trim().length > 0) {
    return args.contextSessionId.trim();
  }
  return undefined;
}
