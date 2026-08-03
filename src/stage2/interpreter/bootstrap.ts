/**
 * Internal interpreter bootstrap.
 *
 * Built-in interpreters live in `src/interpreters/` and are registered directly into the layer
 * registry — no manifest/setup ceremony. The composer is a no-op when nothing is registered.
 */

import { INTERNAL_INTERPRETERS } from '../../interpreters/index.js';
import { registerInterpreter } from './registry.js';

let bootstrapped = false;

export function bootstrapInternalInterpreters(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  for (const interpreter of INTERNAL_INTERPRETERS) {
    registerInterpreter(interpreter);
  }
}

bootstrapInternalInterpreters();
