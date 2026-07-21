import {
  searchAnnotationEscalation,
  topResultsHaveAnnotationMatch,
} from '../../../src/mcp/lib/search-annotation-escalation.js';

describe('searchAnnotationEscalation', () => {
  it('flags top-1 annotated hits as escalation and top1 annotated', () => {
    expect(searchAnnotationEscalation({
      topResults: [
        { id: 'mod:app/src/auth', annotationMatched: true },
        { id: 'mod:app/src/other' },
      ],
    })).toEqual({ shouldEscalate: true, top1Annotated: true });
  });

  it('flags annotated top-2/top-3 hits without changing the top-1 nav signal', () => {
    expect(searchAnnotationEscalation({
      topResults: [
        { id: 'mod:app/src/plain' },
        { id: 'mod:app/src/annotated', annotationMatched: true },
      ],
    })).toEqual({ shouldEscalate: true, top1Annotated: false });
  });

  it('does not escalate when no top hit matched annotation text', () => {
    expect(searchAnnotationEscalation({
      topResults: [
        { id: 'mod:app/src/plain' },
        { id: 'mod:app/src/other', annotationMatched: false },
      ],
    })).toEqual({ shouldEscalate: false, top1Annotated: false });
  });

  it('falls back to array results when topResults is absent', () => {
    expect(topResultsHaveAnnotationMatch({
      results: [
        { id: 'mod:app/src/plain' },
        { id: 'mod:app/src/annotated', annotationMatched: true },
      ],
    })).toBe(true);
  });

  it('caps escalation checks to the first three hits', () => {
    expect(topResultsHaveAnnotationMatch({
      topResults: [
        { id: 'mod:app/src/one' },
        { id: 'mod:app/src/two' },
        { id: 'mod:app/src/three' },
        { id: 'mod:app/src/four', annotationMatched: true },
      ],
    })).toBe(false);
  });
});
