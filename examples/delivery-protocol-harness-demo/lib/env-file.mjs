import fs from 'node:fs';

/**
 * Parse a minimal KEY=value .env file and merge it into process.env. A var that is
 * unset OR set to an empty string is filled from the file; a non-empty existing
 * value is preserved (the operator's explicit non-empty setting wins). Treating an
 * empty value as unset lets `docker compose`'s `${VAR:-}` placeholders be filled
 * from the file. Returns key names only.
 */
export function loadEnvFile(file) {
  const loaded = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return loaded;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
    loaded.push(key);
  }
  return loaded;
}
