const TIMESTAMPS = process.env.HARNESS_LOG_TIMESTAMPS !== '0';

function prefix() {
  return TIMESTAMPS ? `${new Date().toISOString()} ` : '';
}

export function logLine(scope, message, {
  enabled = true,
  indent = '',
  stream = process.stderr,
} = {}) {
  if (!enabled) return;
  for (const line of String(message ?? '').split(/\r?\n/)) {
    stream.write(`${indent}${prefix()}[${scope}] ${line}\n`);
  }
}

export function logBullet(message, {
  enabled = true,
  indent = '    ',
  scope = 'worker',
  stream = process.stderr,
} = {}) {
  if (!enabled) return;
  for (const line of String(message ?? '').split(/\r?\n/)) {
    stream.write(`${indent}${prefix()}[${scope}] · ${line}\n`);
  }
}
