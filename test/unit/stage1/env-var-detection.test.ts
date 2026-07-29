import { describe, expect, it } from '@jest/globals';
import { Project } from 'ts-morph';
import { collectSemanticHints } from '../../../packages/plugins/source-typescript/src/semantic-hints.js';

/**
 * Env vars used to be scanned out of the raw file text by `/process\.env\.([A-Z][A-Z0-9_]+)/` plus a
 * `VITE_`-only `import.meta.env` pattern, with no literal or comment guard. That carried both bug
 * classes at once: it missed quoted-key access, destructuring, and every non-`VITE_`
 * `import.meta.env` name, and it captured names written inside comments and strings. The captured
 * set is annotation ground truth — `computeConsistency` raises `envDependencies:unknown-name` for a
 * declared name the detector did not find — so both halves put false state in front of an agent.
 *
 * 13 of these 28 fail against the pre-fix detector and are the regression coverage. The rest are
 * guards, and each block says which kind it is: behaviour the rewrite had to carry over, or
 * over-capture the tree walk introduces and a text scan could not have reached.
 */
describe('env-var detection', () => {
  const hintsFor = (source: string): ReturnType<typeof collectSemanticHints> => {
    const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true });
    const sf = project.createSourceFile('probe.ts', source);
    return collectSemanticHints(sf, 'src/probe.ts');
  };
  const envVarsFor = (source: string): string[] => hintsFor(source)?.envVars ?? [];

  describe('forms the text scan could not see', () => {
    it('reads a quoted-key access', () => {
      expect(envVarsFor('export const p = process.env["DATABASE_URL"];\n')).toEqual(['DATABASE_URL']);
    });

    it('reads a destructured binding, and takes the env name over the local alias', () => {
      const vars = envVarsFor('const { PORT, API_HOST: host } = process.env;\nexport const out = [PORT, host];\n');
      expect(vars).toEqual(['API_HOST', 'PORT']);
    });

    it('reads an import.meta.env name without the VITE_ prefix', () => {
      expect(envVarsFor('export const mode = import.meta.env.MODE;\n')).toEqual(['MODE']);
    });

    it('reads a member chain broken across lines', () => {
      // Any formatter wraps a long chain; the old scan required the characters to be adjacent.
      expect(envVarsFor('export const t = process\n  .env\n  .OTEL_EXPORTER_OTLP_ENDPOINT;\n'))
        .toEqual(['OTEL_EXPORTER_OTLP_ENDPOINT']);
    });

    it('reads a chain carrying an interior comment', () => {
      expect(envVarsFor('export const r = process./* injected in CI */env.RELEASE_SHA;\n'))
        .toEqual(['RELEASE_SHA']);
    });

    it('reads a backtick-quoted key', () => {
      expect(envVarsFor('export const p = process.env[`DATABASE_URL`];\n')).toEqual(['DATABASE_URL']);
    });
  });

  // A tree walk reaches nodes a `process\.env\.NAME` scan could not, so it can also emit names that
  // are not env vars — a class the scan did not have. Each case here produced a fabricated name
  // against the first draft of this walk; three of them also fail against the pre-fix detector,
  // which resolved the same source to a different wrong answer.
  describe('names the source does not actually fix', () => {
    it('drops a rest element, which binds the remaining names rather than one of them', () => {
      expect(envVarsFor('const { PORT, ...rest } = process.env;\nexport const o = [PORT, rest];\n'))
        .toEqual(['PORT']);
    });

    it('raises no secret signal for a secret-shaped rest binding', () => {
      const hints = hintsFor('const { ...AUTH_TOKEN } = process.env;\nexport const o = AUTH_TOKEN;\n');
      expect(hints?.envVars).toBeUndefined();
      expect((hints?.security ?? []).filter(s => s.kind === 'secret-env')).toEqual([]);
    });

    it('drops a computed destructuring key, as the element-access path already did', () => {
      expect(envVarsFor('declare const k: string;\nconst { [k]: v } = process.env;\nexport const o = v;\n'))
        .toEqual([]);
    });

    it('resolves a quoted destructuring key to its value, without the quotes', () => {
      expect(envVarsFor("const { 'DATABASE_URL': u } = process.env;\nexport const o = u;\n"))
        .toEqual(['DATABASE_URL']);
    });

    it('keeps the public/secret verdict identical across quoted-key syntaxes', () => {
      // A name carrying quote characters misses the anchored `isPublicEnvName` prefix test and is
      // then classified secret — opposite verdicts for one variable.
      const viaBinding = hintsFor("const { 'VITE_AUTH_TOKEN': t } = process.env;\nexport const o = t;\n");
      const viaElement = hintsFor('export const o = process.env["VITE_AUTH_TOKEN"];\n');
      const kinds = (h: ReturnType<typeof hintsFor>): string[] =>
        (h?.security ?? []).filter(s => s.kind.endsWith('-env')).map(s => `${s.kind}:${s.name ?? ''}`).sort();
      expect(kinds(viaBinding)).toEqual(['public-env:VITE_AUTH_TOKEN']);
      expect(kinds(viaBinding)).toEqual(kinds(viaElement));
    });

    it('drops a method called on the container object', () => {
      expect(envVarsFor('export const b = process.env.hasOwnProperty("DATABASE_URL");\n')).toEqual([]);
    });

    it('still reads a variable whose value is then called', () => {
      expect(envVarsFor('export const parts = process.env.PATH!.split(":");\n')).toEqual(['PATH']);
    });

    it('drops the empty name a chain left incomplete mid-edit produces', () => {
      expect(hintsFor('export const x = process.env.\n')?.envVars).toBeUndefined();
    });
  });

  describe('positions that are not reads', () => {
    it('ignores a name written in a comment', () => {
      expect(envVarsFor('// reads process.env.STRIPE_SECRET_KEY at boot\nexport const x = 1;\n')).toEqual([]);
    });

    it('ignores a name written in a quoted string or a template', () => {
      expect(envVarsFor(
        'export const DOC = "set process.env.ADMIN_TOKEN before running";\n'
        + 'export const HOOK = `exec: process.env.CLAUDE_PROJECT_DIR`;\n',
      )).toEqual([]);
    });

    it('still reads a genuine access inside a template interpolation (no-break guard)', () => {
      // `${…}` is code, not a template part — the guard against prose must not swallow it.
      expect(envVarsFor('export const url = `host: ${process.env.API_HOST}`;\n')).toEqual(['API_HOST']);
    });
  });

  // These pass on the pre-fix code too, for the reason that it could not reach these nodes at all.
  // They cover over-capture, which is a risk the tree walk introduces and the text scan did not have.
  describe('what the container has to be', () => {
    it('ignores an env-shaped property on some other object', () => {
      expect(envVarsFor('declare const cfg: { env: { SECRET: string } };\nexport const s = cfg.env.SECRET;\n'))
        .toEqual([]);
    });

    it('ignores new.target, which is the other MetaProperty', () => {
      expect(envVarsFor('export function F(): unknown { return new.target; }\n')).toEqual([]);
    });

    it('yields no name for a computed key', () => {
      // `process.env[k]` is unknowable from source text; a guess would enter annotation ground truth.
      expect(envVarsFor('declare const k: string;\nexport const v = process.env[k];\n')).toEqual([]);
    });

    it('yields the static keys of a module that also uses a computed one', () => {
      const vars = envVarsFor(
        'declare const role: string;\n'
        + 'const BY_ROLE: Record<string, string> = { planner: "PLANNER_MODEL" };\n'
        + 'export const a = process.env[BY_ROLE[role]];\n'
        + 'export const b = process.env.CLAUDE_AGENT_MODEL;\n',
      );
      expect(vars).toEqual(['CLAUDE_AGENT_MODEL']);
    });
  });

  describe('carried over from the text scan (no-break guard)', () => {
    it('reads a plain dotted access', () => {
      expect(envVarsFor('export const u = process.env.DATABASE_URL;\n')).toEqual(['DATABASE_URL']);
    });

    it('reads a VITE_ name off import.meta.env', () => {
      expect(envVarsFor('export const api = import.meta.env.VITE_API_URL;\n')).toEqual(['VITE_API_URL']);
    });

    it('emits names deduped and sorted', () => {
      expect(envVarsFor(
        'export const a = process.env.ZULU;\n'
        + 'export const b = process.env.ALPHA;\n'
        + 'export const c = process.env.ZULU;\n',
      )).toEqual(['ALPHA', 'ZULU']);
    });

    it('omits envVars entirely when the module reads none', () => {
      expect(hintsFor('export const x = 1;\n')?.envVars).toBeUndefined();
    });
  });

  describe('security signals ride the same reads', () => {
    it('classifies a secret-like and a public name from real accesses', () => {
      const security = hintsFor(
        'export const k = process.env["STRIPE_SECRET_KEY"];\n'
        + 'export const u = import.meta.env.VITE_API_URL;\n',
      )?.security ?? [];
      expect(security).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'secret-env', name: 'STRIPE_SECRET_KEY' }),
        expect.objectContaining({ kind: 'public-env', name: 'VITE_API_URL' }),
      ]));
    });

    it('raises no env signal for a secret-like name that only appears in prose', () => {
      const security = hintsFor('// never log process.env.STRIPE_SECRET_KEY\nexport const x = 1;\n')?.security ?? [];
      expect(security.filter(s => s.kind === 'secret-env')).toEqual([]);
    });

    it('reports the line the access sits on (no-break guard)', () => {
      const security = hintsFor('export const a = 1;\nexport const k = process.env.GITHUB_TOKEN;\n')?.security ?? [];
      expect(security).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'secret-env', name: 'GITHUB_TOKEN', lineRange: { start: 2, end: 2 } }),
      ]));
    });
  });
});
