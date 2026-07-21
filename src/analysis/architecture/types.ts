/**
 * Shared types and constants for architecture analysis detectors.
 */

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

export type RefactoringScope = {
  moduleIds: Set<string>;
  serviceIds: Set<string>;
  domainIds: Set<string>;
  scope: string;
  kind: 'all' | 'package' | 'domain' | 'unknown';
  packageId?: string;
};
