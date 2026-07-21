import { describe, expect, it } from '@jest/globals';
import { Project } from 'ts-morph';
import { collectSemanticHints } from '../../../src/source-plugins/typescript/semantic-hints.js';

/**
 * Runtime-action patterns are bare identifier regexes (`/\b(?:InvokeCommand|invoke)\b/`), so a
 * literal-position guard is the only thing separating a real call from the same word written as
 * prose. The guard used to be a hand-rolled character scanner that toggled on `'` and `"` only —
 * backticks were never entered, so a module built out of template strings had every such word in
 * its prose counted as a runtime action, which then produced a false `io-write` side-effect hint
 * and a hard "declared pure; detected io-write" contradiction on a module that performs no I/O.
 */
describe('runtime-action literal guard', () => {
  const hintsFor = (source: string): ReturnType<typeof collectSemanticHints> => {
    const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true });
    const sf = project.createSourceFile('probe.ts', source);
    return collectSemanticHints(sf, 'src/probe.ts');
  };

  it('ignores a runtime-action word inside a template literal', () => {
    const hints = hintsFor(
      'export const DOC = `Agents do not invoke them directly; the engine does.`;\n',
    );
    expect(hints?.runtimeActions ?? []).toHaveLength(0);
  });

  it('ignores it inside a quoted string and a comment', () => {
    const hints = hintsFor(
      'export const NOTE = "the parser is invoke-adjacent";\n'
      + '// the handler is invoke-shaped\n',
    );
    expect(hints?.runtimeActions ?? []).toHaveLength(0);
  });

  it('still detects a genuine call', () => {
    const hints = hintsFor(
      'declare const client: { invoke(x: unknown): void };\n'
      + 'export function run(): void { client.invoke({ FunctionName: "worker" }); }\n',
    );
    expect((hints?.runtimeActions ?? []).length).toBeGreaterThan(0);
  });

  it('still detects a call written inside a template interpolation', () => {
    // `${…}` is real code, not a template part — the AST guard must not swallow it.
    const hints = hintsFor(
      'declare const client: { invoke(x: unknown): string };\n'
      + 'export const OUT = `result: ${client.invoke({ FunctionName: "worker" })}`;\n',
    );
    expect((hints?.runtimeActions ?? []).length).toBeGreaterThan(0);
  });
});
