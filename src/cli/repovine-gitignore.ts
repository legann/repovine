import { ARTIFACTS_DIR_NAME } from '../paths.js';

/** Header line written by `setup` into the workspace `.gitignore`. */
export const REPOVINE_GITIGNORE_HEADER =
  '# repovine engine cache (commit repovine.annots.json at repo root, ignore .repovine/)';

/** Single ignore entry for the engine cache directory. */
export const REPOVINE_GITIGNORE_ENTRY = `${ARTIFACTS_DIR_NAME}/`;

/** Header lines recognized by `clear` when removing the repovine-managed gitignore block. */
export const REPOVINE_GITIGNORE_HEADERS = new Set([REPOVINE_GITIGNORE_HEADER]);

/** Entry lines recognized by `clear` when removing the repovine-managed gitignore block. */
export const REPOVINE_GITIGNORE_ENTRIES = new Set([REPOVINE_GITIGNORE_ENTRY]);

export function formatRepovineGitignoreBlock(): string {
  return `\n${REPOVINE_GITIGNORE_HEADER}\n${REPOVINE_GITIGNORE_ENTRY}\n`;
}
