import { describe, expect, it } from '@jest/globals';
import { SHORTENED_MARKER, shortenText } from '@repovine/plugin-sdk';
import { lastPathSegment } from '../../src/platform/paths.js';
import { omittedNote, shortenList, shortenWords, splitCamelCase } from '../../src/platform/text.js';
import { clampConfidence, detectorConfidence, evidenceAxisCount } from '../../src/analysis/architecture/finding.js';
import {
  ANNOTATION_EXCERPT,
  annotationExcerpt,
  buildAnnotationContext,
} from '../../src/analysis/architecture/annotation-context.js';
import { normalizeResponsibilityKey } from '../../src/analysis/architecture/heuristics.js';
import { searchTokenize } from '../../src/mcp/lib/search-index.js';
import { addNode, createEmptyGraph } from '../../src/graph/index.js';
import { codeFiles, codeLines } from './graph-law-helpers.js';
import type { AnnotationStore } from '../../src/annotations/store.js';
import type { ModuleInfo, StoredAnnotation } from '../../src/types.js';

// An answer that had to leave something out says so the same way everywhere. What this law holds:
//
//   - one marker, so a client recognizing "this continues" needs one rule, not one per tool
//     (`get_annotation_status` used to answer 180 chars and ASCII `...` where `analyze_architecture`
//     answered 151 and `…`);
//   - the budget covers the marker, so a field declared at 150 never arrives at 151 — and two fields
//     sharing one constant never arrive at 150 and 151, which is what they used to do two lines
//     apart in one function;
//   - one annotation quoted twice in one answer is quoted at one length;
//   - the last segment of a path comes from one function, and it answers about POSIX paths, so
//     `path.basename` never reads a repo-relative value (on win32 it treats `\` as a separator, and
//     a backslash inside a repo-relative path is a character in a filename);
//   - an identifier splits into words one way, acronyms included, so a module reachable by searching
//     for "http" is named after "http" in a finding too;
//   - detector confidence is assembled by one helper — base, contributions, penalties, ceiling and
//     rounding are roles, and written as one arithmetic expression per detector they are invisible;
//   - the evidence threshold has one name, and the axis gate one implementation.
//
// Text guards read source and catch a second declaration of a form just removed. Behavioural guards
// catch a declaration written in a shape the text does not know. There are five text guards
// that passed their own rollback, so every guard here was checked by applying the rollback it names.

/** A store that answers with one annotation, for the paths that take an AnnotationStore. */
function storeOf(entries: Record<string, StoredAnnotation>): AnnotationStore {
  return { get: (id: string) => entries[id] } as unknown as AnnotationStore;
}

function storedAnnotation(annotation: StoredAnnotation['annotation']): StoredAnnotation {
  return { nodeType: 'module', annotation } as StoredAnnotation;
}

describe('core-laws bounded answers', () => {
  // ── one marker, one budget ───────────────────────────────────────────────────────────────────

  it('builds the shortening marker in one place', () => {
    // Both spellings the repository used to carry: the ellipsis character and the ASCII triple dot,
    // appended to a value or interpolated at the end of a template.
    const appended = /\+\s*['"`](?:…|\.\.\.)['"`]/;
    const interpolated = /\}(?:…|\.\.\.)['"`]/;
    const offenders = codeFiles(['platform/text.ts', 'plugin-sdk/src/text.ts'])
      .filter(file => appended.test(file.text) || interpolated.test(file.text))
      .map(file => file.where);
    expect(offenders).toEqual([]);
  });

  it('cuts a value to a length in one place', () => {
    // The hand-written shortening as it was copied: a prefix slice with a marker glued on, whether
    // the budget was read as covering the marker (`slice(0, n - 1)`) or not (`slice(0, n)`).
    const handCut = /slice\(\s*0\s*,[^)]*\)\s*\}?\s*(?:\+\s*)?['"`]?(?:…|\.\.\.)/;
    const offenders = codeFiles(['platform/text.ts', 'plugin-sdk/src/text.ts'])
      .filter(file => handCut.test(file.text))
      .map(file => file.where);
    expect(offenders).toEqual([]);
  });

  it('keeps the whole result inside the budget, marker included', () => {
    const long = 'x'.repeat(500);
    for (const budget of [1, 2, 3, 10, 100, 150, 200, 499]) {
      expect(shortenText(long, budget).length).toBeLessThanOrEqual(budget);
    }
    // Below the marker's own width the answer is characters, not a value made entirely of marker.
    expect(shortenText(long, 1)).toBe('x');
    // At and under the budget the value is returned untouched — no marker on a value that fits.
    expect(shortenText('abc', 3)).toBe('abc');
    expect(shortenText('abcd', 3)).toBe(`ab${SHORTENED_MARKER}`);
  });

  it('says a list was bounded one way', () => {
    // The four spellings that were in the tree: ` …+4 more`, ` (+4 more)`, ` +4 more`, and a bare
    // marker with no count at all.
    const remainder = /\+\s*\$\{[^}]+\}\s*more|…\s*\+\s*\$\{/;
    const offenders = codeLines(['platform/text.ts'])
      .filter(line => remainder.test(line.text))
      .map(line => line.where);
    expect(offenders).toEqual([]);
    expect(omittedNote(0)).toBe('');
    expect(omittedNote(4)).toBe(' (+4 more)');
    expect(shortenList([1, 2, 3], 2)).toEqual({ shown: [1, 2], omitted: 1 });
    expect(shortenList([1, 2], 5)).toEqual({ shown: [1, 2], omitted: 0 });
  });

  it('shortens by words with the same marker', () => {
    expect(shortenWords('one two three', 5)).toBe('one two three');
    expect(shortenWords('one two three four five six', 5)).toBe(`one two three four five${SHORTENED_MARKER}`);
  });

  // ── one annotation, one length ───────────────────────────────────────────────────────────────

  it('quotes one annotation at one length wherever an architecture answer carries it', () => {
    const summary = 'S'.repeat(400);
    const risk = 'R'.repeat(400);
    const annotation = {
      summary,
      risks: [risk],
      assumptions: ['A'.repeat(400)],
      sideEffects: [{ kind: 'io-write' as const, description: 'D'.repeat(400) }],
    } as StoredAnnotation['annotation'];

    const graph = createEmptyGraph();
    addNode(graph, { id: 'mod:x', type: 'module', label: 'x', description: '' });
    const modulesById = new Map<string, ModuleInfo>();
    const store = storeOf({ 'mod:x': storedAnnotation(annotation) });

    const excerpt = annotationExcerpt(annotation);
    // A single-target question, so one annotated node is enough for the packet to be built.
    const context = buildAnnotationContext('real-side-effect', ['mod:x'], graph, modulesById, store);
    const contextNode = context?.nodes[0];
    expect(contextNode?.annotation).toBeTruthy();
    const contextSummary = contextNode?.annotation?.summary;

    // Detail mode quotes through the excerpt, the context packet through its field picker. The same
    // annotation reached both ways in one response must not come back at two lengths.
    expect(contextSummary).toBe(excerpt.summary);
    expect(excerpt.summary?.length).toBe(ANNOTATION_EXCERPT.summaryChars);
    expect(excerpt.risks[0]?.length).toBe(ANNOTATION_EXCERPT.entryChars);
    expect(excerpt.assumptions[0]?.length).toBe(ANNOTATION_EXCERPT.entryChars);
    // One constant, one interpretation: a list entry and a side-effect description share
    // `entryChars` and used to come back at 151 and 150.
    expect(excerpt.sideEffects[0]?.description?.length).toBe(ANNOTATION_EXCERPT.entryChars);
  });

  // ── the last path segment ────────────────────────────────────────────────────────────────────

  it('answers "last segment" in one place', () => {
    const handWritten = [
      /split\(\s*['"`]\/['"`]\s*\)[^;]{0,40}\.pop\(\)/,
      /split\(\s*\/\[\/\\\\\]\/[a-z]*\s*\)[^;]{0,60}\.pop\(\)/,
      /lastIndexOf\(\s*['"`]\/['"`]\s*\)\s*\+\s*1/,
    ];
    const offenders = codeFiles(['plugin-sdk/src/paths.ts'])
      .filter(file => handWritten.some(re => re.test(file.text)))
      .map(file => file.where);
    expect(offenders).toEqual([]);
  });

  it('never asks path.basename about a repo-relative value', () => {
    // `path.basename` is the host answer: on win32 it splits on `\` too, and a repo-relative path is
    // POSIX-normalized at its producers, so a backslash in one is part of a filename.
    const hostAnswerOnRelative =
      /basename\(\s*[^)]*\b(?:pkgRelPath|repoRelPath|repoRelDir|relativeFilePath|relPath|RelPath|repoRelative)/;
    const offenders = codeLines([])
      .filter(line => hostAnswerOnRelative.test(line.text))
      .map(line => line.where);
    expect(offenders).toEqual([]);
  });

  it('reads the last segment of a POSIX path, total on every shape', () => {
    expect(lastPathSegment('a/b/c.ts')).toBe('c.ts');
    expect(lastPathSegment('c.ts')).toBe('c.ts');
    expect(lastPathSegment('')).toBe('');
    expect(lastPathSegment('a/b/')).toBe('');
    // A backslash is a filename character in a repo-relative path, not a separator.
    expect(lastPathSegment('a/b\\c.ts')).toBe('b\\c.ts');
  });

  // ── one word split ───────────────────────────────────────────────────────────────────────────

  it('splits an identifier into words in one place', () => {
    const camelSplit = /\[a-z0-9\]\)\(\[A-Z\]|\[A-Z\]\+\)\(\[A-Z\]\[a-z\]/;
    const offenders = codeFiles(['platform/text.ts'])
      .filter(file => camelSplit.test(file.text))
      .map(file => file.where);
    expect(offenders).toEqual([]);
  });

  it('keeps acronyms split for search AND for the responsibility key', () => {
    // The reverse control: this fails if the split stops knowing acronyms, which is the property the
    // search index had and the responsibility key did not.
    expect(splitCamelCase('HTTPServerAdapter')).toBe('HTTP Server Adapter');
    expect(splitCamelCase('parseXMLDocument')).toBe('parse XML Document');
    expect(searchTokenize('HTTPServerAdapter')).toContain('http');
    expect(normalizeResponsibilityKey('src/net/HTTPServerAdapter.ts')).toContain('http');
  });

  // ── detector arithmetic ──────────────────────────────────────────────────────────────────────

  it('assembles detector confidence in one place', () => {
    // The form as it was written per detector: a ceiling and a base summed in one expression.
    const handSummed = /Math\.min\(\s*\n?\s*[01]?\.\d+\s*,[^;]*\+/;
    const offenders = codeFiles(['analysis/architecture/finding.ts'])
      .filter(file => /confidence/i.test(file.text) && handSummed.test(file.text))
      .map(file => file.where);
    expect(offenders).toEqual([]);
  });

  it('bounds confidence by its ceiling and rounds it once', () => {
    expect(detectorConfidence({ base: 0.55, ceiling: 0.9, add: [0.5] })).toBe(0.9);
    expect(detectorConfidence({ base: 0.5, ceiling: 0.9, add: [0.04, 0.08] })).toBe(0.62);
    expect(detectorConfidence({ base: 0.5, ceiling: 0.9, add: [0.1], subtract: [0.04] })).toBe(0.56);
    // Rounding is the helper's, not the caller's: every detector lands on the same two decimals.
    expect(detectorConfidence({ base: 0.5, ceiling: 1, add: [0.123456] })).toBe(clampConfidence(0.623456));
    // A base already past the ceiling still answers the ceiling; a negative sum still answers 0.
    expect(detectorConfidence({ base: 1.5, ceiling: 0.88 })).toBe(0.88);
    expect(detectorConfidence({ base: 0.1, ceiling: 0.9, subtract: [0.5] })).toBe(0);
  });

  it('counts evidence axes in one place', () => {
    // Both wrappings of the array literal: `].filter(Boolean).length` and `]).filter(Boolean).length`.
    // A `.filter(Boolean).length` with no bracket in front of it is a different question — dropping
    // empty segments of a split — and is not what this guard is aimed at.
    const inlineGate = /\]\s*\)?\s*\.filter\(\s*Boolean\s*\)\s*\.length/;
    const offenders = codeFiles(['analysis/architecture/finding.ts'])
      .filter(file => inlineGate.test(file.text))
      .map(file => file.where);
    expect(offenders).toEqual([]);
    expect(evidenceAxisCount([true, false, true, true])).toBe(3);
    expect(evidenceAxisCount([])).toBe(0);
  });

  it('names the evidence threshold one way', () => {
    // The second name the repository carried for "how much evidence is enough".
    const secondName = /\bminSignals\b|\bevidenceThreshold\b|\bMIN_EVIDENCE\b/;
    const offenders = codeFiles([])
      .filter(file => secondName.test(file.text))
      .map(file => file.where);
    expect(offenders).toEqual([]);
  });

  it('records why the two breadth detectors do not share a scale', () => {
    // There is no shared threshold knowledge behind `godModule` — it is a reused
    // settings key over two different scales. The finding is only closed while the code says so.
    const detectors = codeLines([]).filter(line => line.where.includes('architecture/detectors.ts'));
    expect(detectors.length).toBeGreaterThan(0);
    const source = codeFiles([]).find(file => file.where.includes('architecture/detectors.ts'));
    expect(source).toBeDefined();
    // The gate is a named constant, not a literal buried in the condition.
    expect(source?.text).toContain('SERVER_HANDLER_MIN_EVIDENCE_AXES');
  });
});
