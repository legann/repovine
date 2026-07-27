/**
 * Shared types and constants for architecture analysis detectors.
 */

import type { ScopeKind } from '../../scope/resolved.js';
import type { AnnotationContext } from './annotation-context.js';

export type RefactoringCategory =
  | 'duplicate-like'
  | 'boundary'
  | 'god-module'
  | 'god-domain'
  | 'low-cohesion'
  | 'client-business-logic'
  | 'flow-convergence'
  | 'state-fragmentation'
  | 'effect-spaghetti'
  | 'prop-drilling-orchestration'
  | 'service-wrapper-explosion'
  | 'ui-domain-coupling'
  | 'route-convergence'
  | 'duplicated-client-policy'
  | 'design-system-leakage'
  | 'event-driven-boundary'
  | 'secret-config-boundary'
  | 'authorization-policy-drift'
  | 'trust-boundary-validation'
  | 'privileged-client-side-effect'
  | 'sensitive-browser-storage'
  | 'server-client-boundary'
  | 'source-disclosure-surface'
  | 'annotation-secret-hygiene'
  | 'annotation-risk'
  | 'unclear-architecture';

export type RefactoringFinding = {
  id: string;
  category: RefactoringCategory;
  title: string;
  severity: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  confidence: number;
  nodes: string[];
  evidence: string[];
  suggestion: string;
  /**
   * Present only when the report was run with `annotationReasoning: 'on'` and the
   * affected nodes carry enough annotation material to compare. The caller is
   * expected to read `annotationContext.nodes[].annotation` and answer
   * `annotationContext.question` before reporting the finding to the user.
   */
  annotationContext?: AnnotationContext;
};

export const REFACTORING_CATEGORIES: RefactoringCategory[] = [
  'duplicate-like',
  'boundary',
  'god-module',
  'god-domain',
  'low-cohesion',
  'client-business-logic',
  'flow-convergence',
  'state-fragmentation',
  'effect-spaghetti',
  'prop-drilling-orchestration',
  'service-wrapper-explosion',
  'ui-domain-coupling',
  'route-convergence',
  'duplicated-client-policy',
  'design-system-leakage',
  'event-driven-boundary',
  'secret-config-boundary',
  'authorization-policy-drift',
  'trust-boundary-validation',
  'privileged-client-side-effect',
  'sensitive-browser-storage',
  'server-client-boundary',
  'source-disclosure-surface',
  'annotation-secret-hygiene',
  'annotation-risk',
  'unclear-architecture',
];

/**
 * Categories that failed the clean-code oracle: each emitted a finding on a
 * counterexample fixture built to carry none of its smell. A counterexample
 * refutes the universal claim "a finding is led by evidence", so these are off
 * by default and stay reachable through an explicit `categories` argument.
 *
 *   duplicate-like              two unrelated loggers reported as shared responsibility
 *   god-module                  a generated type-only surface reported as a god module
 *   authorization-policy-drift  distinct invariants sharing vocabulary reported as drift
 */
export const CLEAN_ORACLE_FAILING_CATEGORIES: RefactoringCategory[] = [
  'duplicate-like',
  'god-module',
  'authorization-policy-drift',
];

/** Categories a report runs when the caller names none. */
export const DEFAULT_REFACTORING_CATEGORIES: RefactoringCategory[] =
  REFACTORING_CATEGORIES.filter(c => !CLEAN_ORACLE_FAILING_CATEGORIES.includes(c));

export type RefactoringScope = {
  moduleIds: Set<string>;
  serviceIds: Set<string>;
  domainIds: Set<string>;
  scope: string;
  kind: 'all' | 'package' | 'domain' | 'module' | 'runtime-resource' | 'unsupported';
  packageId?: string;
  /** Which scope kind was refused; set only when `kind` is `unsupported`. */
  unsupportedKind?: ScopeKind;
};
