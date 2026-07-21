import type { Interpreter } from '../../interpreter/types.js';

const interpreters: Interpreter[] = [];

export function registerInterpreter(interpreter: Interpreter): void {
  interpreters.push(interpreter);
}

export function getInterpreterRegistrations(): readonly Interpreter[] {
  return interpreters;
}

export function setInterpretersForTest(next: Interpreter[]): () => void {
  const previous = [...interpreters];
  interpreters.splice(0, interpreters.length, ...next);
  return () => {
    interpreters.splice(0, interpreters.length, ...previous);
  };
}
