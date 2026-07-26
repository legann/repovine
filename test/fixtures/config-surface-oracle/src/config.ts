export const dotted = process.env.PLAIN_ENV;
export const quoted = process.env['QUOTED_ENV'];
const { DESTRUCTURED_ENV, ALIASED_ENV: localAlias } = process.env;
export const destructured = [DESTRUCTURED_ENV, localAlias];
export const mode = import.meta.env.MODE;
export const publicUrl = import.meta.env.VITE_PUBLIC_URL;
export const password = process.env.DATABASE_PASSWORD;

const envAlias = process.env;
export const aliasMiss = envAlias.ALIASED_CONTAINER_TOKEN;

const CONST_ENV_NAME = 'CONST_KEY_SECRET';
export const constMiss = process.env[CONST_ENV_NAME];

function readEnv(name: string): string | undefined {
  return process.env[name];
}
export const wrappedMiss = readEnv('WRAPPED_SECRET');
