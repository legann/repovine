import { describe, expect, it, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectTemplates, parseTemplateBodyHints } from '../../../src/stage1/templates.js';
import { compileScanPatterns } from '../../../src/scan-filters.js';

function makeRepo(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-tpl-'));
  for (const rel of files) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '<!-- t -->');
  }
  return root;
}

const createdRoots: string[] = [];
function repo(files: string[]): string {
  const root = makeRepo(files);
  createdRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of createdRoots) fs.rmSync(root, { recursive: true, force: true });
});

const scanPatterns = compileScanPatterns([], []);

describe('collectTemplates (stage1 server-rendered discovery)', () => {
  it('discovers template files under templates/ dirs and skips stray .html', () => {
    const root = repo([
      'app/templates/home.html',
      'app/templates/users/profile.html',
      'app/templates/layout.jinja2',
      'static/report.html', // not under templates/ → excluded
      'docs/index.html', // not under templates/ → excluded
    ]);

    const templates = collectTemplates({ repoRoot: root, scanPatterns });

    expect(templates.map(t => t.relPath)).toEqual([
      'app/templates/home.html',
      'app/templates/layout.jinja2',
      'app/templates/users/profile.html',
    ]);
    expect(templates.map(t => t.id)).toEqual([
      'template:app/templates/home.html',
      'template:app/templates/layout.jinja2',
      'template:app/templates/users/profile.html',
    ]);
    expect(templates.every(t => /^[a-f0-9]{16}$/.test(t.contentHash))).toBe(true);
  });

  it('derives contentHash from body: distinct bodies differ, identical bodies match', () => {
    const root = makeRepo([]);
    createdRoots.push(root);
    const files: Record<string, string> = {
      'app/templates/alpha.html': '<p>alpha body</p>',
      'app/templates/beta.html': '<p>beta body differs</p>',
      'app/templates/alpha-copy.html': '<p>alpha body</p>',
    };
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }

    const byRel = new Map(collectTemplates({ repoRoot: root, scanPatterns }).map(t => [t.relPath, t]));
    const alpha = byRel.get('app/templates/alpha.html')?.contentHash;
    const beta = byRel.get('app/templates/beta.html')?.contentHash;
    const alphaCopy = byRel.get('app/templates/alpha-copy.html')?.contentHash;

    expect(alpha).not.toBe(beta); // different body → different hash
    expect(alphaCopy).toBe(alpha); // identical body → identical hash
  });

  it('infers jinja2 engine from extension, omits it for ambiguous .html', () => {
    const root = repo(['app/templates/a.html', 'app/templates/b.j2', 'app/templates/c.jinja']);
    const byRel = new Map(collectTemplates({ repoRoot: root, scanPatterns }).map(t => [t.relPath, t]));

    expect(byRel.get('app/templates/a.html')?.engine).toBeUndefined();
    expect(byRel.get('app/templates/b.j2')?.engine).toBe('jinja2');
    expect(byRel.get('app/templates/c.jinja')?.engine).toBe('jinja2');
  });

  it('skips vendored/build dirs even when they contain templates/', () => {
    const root = repo([
      'app/templates/keep.html',
      'node_modules/pkg/templates/skip.html',
      '.venv/lib/templates/skip.html',
      'dist/templates/skip.html',
    ]);

    expect(collectTemplates({ repoRoot: root, scanPatterns }).map(t => t.relPath)).toEqual([
      'app/templates/keep.html',
    ]);
  });

  it('returns empty for a repo with no templates/ dir', () => {
    const root = repo(['src/index.ts', 'README.md']);
    expect(collectTemplates({ repoRoot: root, scanPatterns })).toEqual([]);
  });

  it('extracts static extends/includes/block hints from template bodies', () => {
    const root = makeRepo([]);
    createdRoots.push(root);
    const files: Record<string, string> = {
      'app/templates/home.html': [
        '{% extends "base.html" %}',
        '{% include "partials/nav.html" %}',
        "{% include ['partials/card.html', 'partials/extra.html'] %}",
        '{% block content %}hello{% endblock %}',
      ].join('\n'),
      'app/templates/base.html': '{% block shell %}{% endblock %}',
      'app/templates/partials/nav.html': '<nav></nav>',
      'app/templates/partials/card.html': '<article></article>',
      'app/templates/partials/extra.html': '<aside></aside>',
    };
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }

    const byRel = new Map(collectTemplates({ repoRoot: root, scanPatterns }).map(t => [t.relPath, t]));

    expect(byRel.get('app/templates/home.html')).toMatchObject({
      extendsTemplate: 'base.html',
      includesTemplate: ['partials/nav.html', 'partials/card.html', 'partials/extra.html'],
      blocks: ['content'],
    });
    expect(byRel.get('app/templates/base.html')?.blocks).toEqual(['shell']);
  });
});

describe('parseTemplateBodyHints', () => {
  it('ignores comments, raw blocks, and dynamic template names', () => {
    expect(parseTemplateBodyHints([
      '{# {% include "commented.html" %} #}',
      '{% raw %}{% include "raw.html" %}{% endraw %}',
      '{% extends layout_name %}',
      '{% include partial_name %}',
    ].join('\n'))).toEqual({});
  });

  it('strips {% verbatim %} blocks (the alternation branch of the raw-block regex)', () => {
    expect(parseTemplateBodyHints([
      '{% verbatim %}{% include "verbatim.html" %}{% endverbatim %}',
    ].join('\n'))).toEqual({});
  });
});
