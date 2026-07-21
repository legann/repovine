/**
 * Forward-call attribution shape inventory. One synthetic SourceFile per host shape; each asserts
 * the inner call is captured and attributed to the enclosing export (or, for top-level statements
 * and non-exported helpers, to the module bucket). This is the grep-parity floor: host shape must
 * not gate collection.
 */
import { Project, ScriptTarget } from 'ts-morph';
import { collectExports } from '../../../src/source-plugins/typescript/exports.js';

function makeSf(source: string, fileName = '/virtual/file.tsx') {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { target: ScriptTarget.ES2022, jsx: 2 } });
  return project.createSourceFile(fileName, source);
}

/** Calls attributed to a named export, or [] when the export is absent / has none. */
function callsOf(source: string, exportName: string): string[] {
  const { exports } = collectExports(makeSf(source));
  return exports.find(e => e.name === exportName)?.calls ?? [];
}

function moduleCalls(source: string): string[] {
  return collectExports(makeSf(source)).moduleCalls;
}

describe('collectExports — forward-call attribution per host shape', () => {
  it('function declaration', () => {
    expect(callsOf(`export function f() { inner(); }`, 'f')).toContain('inner');
  });

  it('arrow-const', () => {
    expect(callsOf(`export const f = () => { inner(); };`, 'f')).toContain('inner');
  });

  it('class method', () => {
    expect(callsOf(`export class C { m() { inner(); } }`, 'C')).toContain('inner');
  });

  it('class arrow-property (missed by getMethods today)', () => {
    expect(callsOf(`export class C { m = () => { inner(); }; }`, 'C')).toContain('inner');
  });

  it('class accessor', () => {
    expect(callsOf(`export class C { get x() { inner(); return 1; } }`, 'C')).toContain('inner');
  });

  it('class constructor', () => {
    expect(callsOf(`export class C { constructor() { inner(); } }`, 'C')).toContain('inner');
  });

  it('class static block', () => {
    expect(callsOf(`export class C { static { inner(); } }`, 'C')).toContain('inner');
  });

  it('HOC-wrapped const (memo)', () => {
    expect(callsOf(`export const F = memo(() => { useThing(); return null; });`, 'F')).toContain('useThing');
  });

  it('namespaced HOC-wrapped const (React.memo)', () => {
    expect(callsOf(`export const F = React.memo(() => { useThing(); return null; });`, 'F')).toContain('useThing');
  });

  it('object-literal method', () => {
    expect(callsOf(`export const svc = { run() { doWork(); } };`, 'svc')).toContain('doWork');
  });

  it('namespace member', () => {
    expect(callsOf(`export namespace N { export function f() { inner(); } }`, 'N')).toContain('inner');
  });

  it('default export function', () => {
    expect(callsOf(`export default function root() { inner(); }`, 'default')).toContain('inner');
  });

  it('top-level statement → module bucket', () => {
    expect(moduleCalls(`bootstrap();\nexport const x = 1;`)).toContain('bootstrap');
  });

  it('non-exported local helper → module bucket', () => {
    const src = `
      function omitZipUrlFields(m: unknown) { return validateMonitor(m); }
      export const x = 1;
    `;
    expect(moduleCalls(src)).toContain('validateMonitor');
  });

  it('member calls keep the object qualifier; this-calls keep this.', () => {
    const src = `export class C { m() { this.helper(); svc.fetch(); } }`;
    const calls = callsOf(src, 'C');
    expect(calls).toContain('this.helper');
    expect(calls).toContain('svc.fetch');
  });

  it('deep/computed member call resolves to the bare property name', () => {
    // a.b.c() and a[x].d() — the callee object is neither `this` nor a plain identifier,
    // so addCallName falls through to the bare property name.
    const calls = callsOf(`export function f() { a.b.c(); a[x].d(); }`, 'f');
    expect(calls).toContain('c');
    expect(calls).toContain('d');
    // Only the bare property is kept — no qualified form leaks through the fallback.
    expect(calls).not.toContain('a.b.c');
    expect(calls).not.toContain('b.c');
    expect(calls).not.toContain('a.b');
  });

  it('a bucket is capped at PER_BUCKET_CAP (50) distinct call names', () => {
    const body = Array.from({ length: 60 }, (_, i) => `  c${i}();`).join('\n');
    const calls = callsOf(`export function f() {\n${body}\n}`, 'f');
    expect(calls).toHaveLength(50);
  });

  it('IGNORED_CALLS are filtered out', () => {
    const calls = callsOf(`export function f() { console.log('x'); JSON.parse('{}'); real(); }`, 'f');
    expect(calls).toContain('real');
    expect(calls).not.toContain('console.log');
    expect(calls).not.toContain('JSON.parse');
  });

  it('a call inside an exported decl is not double-counted in the module bucket', () => {
    const src = `export function f() { inner(); }`;
    expect(moduleCalls(src)).not.toContain('inner');
  });

  it('captures rich export metadata for interfaces, enums, classes, and large functions', () => {
    const bigBody = Array.from({ length: 505 }, (_, i) => `  void ${i};`).join('\n');
    const src = `
      export interface ApiPort {
        id?: string;
        run(input: string): number;
      }

      export enum Status {
        Ready = 'ready',
        Done = 2,
      }

      export type Payload = { id: string; nested: { value: number } };

      export class Service implements ApiPort {
        private token: string = '';
        protected guard(value: string): boolean {
          return value.length > 0;
        }
        run(input: string): number {
          return input.length;
        }
      }

      export function big(input: { a: number; b: number }): void {
        function localHelper(value: string): number {
          return value.length;
        }
        const arrow = (flag: boolean): string => flag ? 'yes' : 'no';
        const count = 1;
        const { a, b } = input;
${bigBody}
        doWork();
      }
    `;
    const { exports } = collectExports(makeSf(src));
    const byName = new Map(exports.map(exp => [exp.name, exp]));

    expect(byName.get('ApiPort')).toMatchObject({
      kind: 'interface',
      typeValue: '{ id?: string; run(input: string): number }',
      fields: [
        { name: 'id', type: 'string', optional: true },
        { name: 'run', type: '(input: string) => number', optional: false },
      ],
    });
    expect(byName.get('Status')).toMatchObject({
      kind: 'enum',
      signature: 'enum Status',
      typeValue: 'Ready = "ready" | Done = 2',
    });
    expect(byName.get('Payload')).toMatchObject({
      kind: 'type',
      typeValue: '{ id: string; nested: { value: number } }',
    });
    expect(byName.get('Service')).toMatchObject({
      kind: 'class',
      implementsInterfaces: ['ApiPort'],
      privateMembers: expect.arrayContaining([
        expect.objectContaining({ name: 'guard', kind: 'method', access: 'protected' }),
        expect.objectContaining({ name: 'token', kind: 'property', access: 'private' }),
      ]),
    });
    expect(byName.get('big')).toMatchObject({
      kind: 'function',
      params: [{ name: 'input', type: '{ a: number; b: number }' }],
      internals: expect.arrayContaining([
        expect.objectContaining({ name: 'localHelper', kind: 'function' }),
        expect.objectContaining({ name: 'arrow', kind: 'function' }),
        expect.objectContaining({ name: 'count', kind: 'variable' }),
        expect.objectContaining({ name: 'a, b', kind: 'destructuring' }),
      ]),
    });
    expect(byName.get('big')?.calls).toBeUndefined();
  });
});
