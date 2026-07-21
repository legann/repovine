/**
 * WS A (finding F4): the architecture report fails loud on a cold detector registry instead of
 * silently returning zero findings. The guard lives at the shared entry (collectSortedFindings),
 * so both runRefactoringReport and runRefactoringOpportunityDetail are covered.
 */
import {
  runRefactoringReport,
  runRefactoringOpportunityDetail,
  type RefactoringState,
} from '../../../../src/analysis/architecture/index.js';
import { setDetectorsForTest } from '../../../../src/analysis/architecture/detector-registry.js';

// The guard runs before any state field is read, so a placeholder state is sufficient.
const placeholderState = {} as unknown as RefactoringState;

describe('architecture analysis: empty-registry guard', () => {
  it('runRefactoringReport throws a clear error when no detectors are registered', () => {
    const restore = setDetectorsForTest([]);
    try {
      expect(() => runRefactoringReport(placeholderState, {})).toThrow(/detector/i);
    } finally {
      restore();
    }
  });

  it('runRefactoringOpportunityDetail throws too on an empty registry', () => {
    const restore = setDetectorsForTest([]);
    try {
      expect(() => runRefactoringOpportunityDetail(placeholderState, { findingId: 'god-module:x' })).toThrow(/detector/i);
    } finally {
      restore();
    }
  });

  it('names the bootstrap import in the error so the fix is obvious', () => {
    const restore = setDetectorsForTest([]);
    try {
      expect(() => runRefactoringReport(placeholderState, {})).toThrow(/detector-bootstrap/);
    } finally {
      restore();
    }
  });
});
