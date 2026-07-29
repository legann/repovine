import { describe, expect, it } from '@jest/globals';
import { Project } from 'ts-morph';
import { collectSemanticHints } from '../../../packages/plugins/source-typescript/src/semantic-hints.js';

/**
 * Two hint detectors used to key on raw file text with no position check, so a module could be
 * marked as something it is not purely by mentioning it in prose. Both feed advisory surfaces —
 * `ssr.qwikServer` reaches architecture analysis, and a `ui` object can flip a `.tsx` module in a
 * backend package from `generic` to `api-handler` — so a false hint contradicts an accurate
 * annotation rather than merely under-reporting.
 */
describe('prose does not set hints', () => {
  let counter = 0;
  const hintsFor = (source: string, fileName = 'probe.ts'): ReturnType<typeof collectSemanticHints> => {
    const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true });
    const sf = project.createSourceFile(`d${counter++}/${fileName}`, source);
    return collectSemanticHints(sf, `src/${fileName}`);
  };

  describe('Qwik macros', () => {
    it('ignores a macro named inside a string literal', () => {
      const hints = hintsFor('export const DOC = "call routeLoader$( ) to load";\n');
      expect(hints?.ssr?.qwikServer).toBeUndefined();
    });

    it('ignores a macro named inside a template literal or a comment', () => {
      const hints = hintsFor(
        '// use routeAction$( ) for mutations\n'
        + 'export const DOC = `server$( ) runs on the server`;\n',
      );
      expect(hints?.ssr?.qwikServer).toBeUndefined();
    });

    it('still detects a genuine macro call', () => {
      const hints = hintsFor('export const useItems = routeLoader$(() => []);\n');
      expect(hints?.ssr?.qwikServer).toBe(true);
    });

    it('still detects a macro call inside a template interpolation', () => {
      // `${…}` is real code, not a template part — the guard must not swallow it.
      const hints = hintsFor('export const OUT = `${server$(() => 1)}`;\n');
      expect(hints?.ssr?.qwikServer).toBe(true);
    });

    it('detects a real call in a module whose prose also names the macro', () => {
      // The guard skips prose matches and must keep scanning rather than stop at the first one.
      const hints = hintsFor(
        'export const DOC = "routeLoader$( ) explained";\n'
        + 'export const useItems = routeLoader$(() => []);\n',
      );
      expect(hints?.ssr?.qwikServer).toBe(true);
    });
  });

  describe('React detection in .tsx', () => {
    it('ignores an angle-bracket example written inside a string', () => {
      const hints = hintsFor('export const DOC = "render <Widget> inside a page";\n', 'a.tsx');
      expect(hints?.ui?.framework).toBeUndefined();
    });

    it('detects a real element', () => {
      const hints = hintsFor('export const C = () => <div>hi</div>;\n', 'a.tsx');
      expect(hints?.ui?.framework).toBe('react');
    });

    it('detects a self-closing element and a fragment', () => {
      expect(hintsFor('export const C = () => <Widget />;\n', 'a.tsx')?.ui?.framework).toBe('react');
      expect(hintsFor('export const F = () => <>hi</>;\n', 'b.tsx')?.ui?.framework).toBe('react');
    });

    it('still detects react from an import in a non-tsx file', () => {
      const hints = hintsFor('import React from "react";\nexport const x = 1;\n');
      expect(hints?.ui?.framework).toBe('react');
    });
  });

  describe('Angular framework label', () => {
    const frameworkFor = (source: string, fileName: string): string | undefined => {
      const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true });
      const sf = project.createSourceFile(`f${counter++}/${fileName}`, source);
      return collectSemanticHints(sf, `src/${fileName}`)?.ui?.framework;
    };

    it('does not label a NestJS service as Angular', () => {
      // `.service.ts` and `.module.ts` are NestJS convention as much as Angular's.
      const framework = frameworkFor(
        "import { Injectable } from '@nestjs/common';\n"
        + '@Injectable()\n'
        + 'export class UsersService { findAll() { return []; } }\n',
        'users.service.ts',
      );
      expect(framework).not.toBe('angular');
    });

    it('does not label a bare class as Angular on the filename alone', () => {
      expect(frameworkFor('export class UsersService {}\n', 'users.service.ts')).not.toBe('angular');
      expect(frameworkFor('export class AppModule {}\n', 'app.module.ts')).not.toBe('angular');
    });

    it('still labels a genuine Angular module', () => {
      const framework = frameworkFor(
        "import { Injectable } from '@angular/core';\n@Injectable()\nexport class UsersService {}\n",
        'users.service.ts',
      );
      expect(framework).toBe('angular');
    });

    it('labels an Angular file whose name carries no suffix', () => {
      const framework = frameworkFor(
        "import { Component } from '@angular/core';\nexport class Widget {}\n",
        'widget.ts',
      );
      expect(framework).toBe('angular');
    });
  });

  describe('validation/mapping count', () => {
    // The count crosses a `> 0` threshold downstream and becomes a `validation/mapping` label, so
    // one prose occurrence is enough to label a component as doing work it does not do.
    const vmFor = (memberSource: string): number | undefined => {
      const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true });
      const sf = project.createSourceFile(
        `v${counter++}/x.component.ts`,
        "import { Component } from '@angular/core';\n"
        + "@Component({ selector: 'a', template: '<p>x</p>' })\n"
        + `export class XComponent {\n${memberSource}  title = 'a';\n}\n`,
      );
      return collectSemanticHints(sf, 'src/x.component.ts')?.ui?.components?.[0]?.localSignals?.validationOrMapping;
    };

    it('counts nothing for a component whose members are plain', () => {
      expect(vmFor('')).toBe(0);
    });

    it('counts nothing when the names appear only in a comment', () => {
      expect(vmFor('  // normalizeUser and mapper live upstream\n')).toBe(0);
    });

    it('counts nothing when they appear only in a string', () => {
      expect(vmFor('  DOC = "validateInput then isAllowedNow";\n')).toBe(0);
    });

    it('still counts a real call', () => {
      expect(vmFor('  ping() { return this.validateInput(); }\n  validateInput() { return 1; }\n')).toBeGreaterThan(0);
    });
  });

  describe('service-wrapper delegate count', () => {
    const wrapperFor = (source: string): { delegateCallCount?: number } | undefined => {
      const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true });
      const sf = project.createSourceFile(`w${counter++}/api.service.ts`, source);
      return collectSemanticHints(sf, 'src/api.service.ts')?.ui?.serviceWrapper;
    };

    const CLASS = 'export class Api {\n  load() { return 1; }\n}\n';

    it('counts nothing when the delegate names appear only in a comment', () => {
      const wrapper = wrapperFor('// wraps .get( ), .post( ) and fetch( ) upstream\n' + CLASS);
      expect(wrapper?.delegateCallCount).toBe(0);
    });

    it('counts nothing when they appear only in a string', () => {
      const wrapper = wrapperFor(`export const DOC = "delegates to .get( ) and fetch( )";\n${CLASS}`);
      expect(wrapper?.delegateCallCount).toBe(0);
    });

    it('still counts real delegate calls', () => {
      const wrapper = wrapperFor(
        'declare const http: { get(u: string): void; post(u: string): void };\n'
        + 'export class Api {\n'
        + '  load() { http.get("/a"); }\n'
        + '  save() { http.post("/a"); }\n'
        + '}\n',
      );
      expect(wrapper?.delegateCallCount).toBe(2);
    });

    it('counts real calls in a module whose prose also names them', () => {
      const wrapper = wrapperFor(
        '// this wrapper hides .post( ) behind load()\n'
        + 'declare const http: { get(u: string): void };\n'
        + 'export class Api {\n'
        + '  load() { http.get("/a"); }\n'
        + '}\n',
      );
      expect(wrapper?.delegateCallCount).toBe(1);
    });
  });
});
