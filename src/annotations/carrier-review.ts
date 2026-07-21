import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ARTIFACTS_DIR_NAME } from '../paths.js';
import { writeFileAtomicSync } from '../fs/atomic.js';
import type { AnnotationContent, StoredAnnotation } from '../types.js';
import { normalizeRisks } from './format.js';

/** Workspace-local carrier-link review state under `.repovine/` (not committed; triage does not travel with clones). */
export const CARRIER_REVIEW_FILENAME = 'carrier-review.json';

export interface CarrierReviewEntry {
  /** {@link carrierTargetRiskHash} of the target at decision time; a changed consumer-risk set re-surfaces the target. */
  riskHash: string;
  /** ISO timestamp of the decline decision. */
  decidedAt: string;
  reason?: string;
}

export interface CarrierReviewFile {
  version: 1;
  /** Consumer-risk SSOT node id → reviewed-not-a-gap decision. */
  reviewedTargets: Record<string, CarrierReviewEntry>;
}

export function carrierReviewFilePath(repoRoot: string): string {
  return path.join(repoRoot, ARTIFACTS_DIR_NAME, CARRIER_REVIEW_FILENAME);
}

/**
 * Suppression invalidation key: sha256[:16] over the target's consumer-scoped risk texts, sorted.
 * Shared by the decline tool (stamping) and validate (checking) so the two can never drift.
 */
export function carrierTargetRiskHash(content: AnnotationContent | undefined): string {
  const texts = normalizeRisks(content?.risks)
    .filter((risk) => risk.scope === 'consumer')
    .map((risk) => risk.text)
    .sort();
  return createHash('sha256').update(texts.join('\n')).digest('hex').slice(0, 16);
}

const EMPTY_CARRIER_REVIEW: CarrierReviewFile = { version: 1, reviewedTargets: {} };

/** Read review state; a missing, corrupt, or wrong-version file suppresses nothing (pairs re-surface). */
export function readCarrierReviewFile(repoRoot: string): CarrierReviewFile {
  try {
    const filePath = carrierReviewFilePath(repoRoot);
    if (!fs.existsSync(filePath)) return { ...EMPTY_CARRIER_REVIEW, reviewedTargets: {} };
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { version?: unknown; reviewedTargets?: unknown };
    if (raw.version !== 1 || typeof raw.reviewedTargets !== 'object' || raw.reviewedTargets === null) {
      return { ...EMPTY_CARRIER_REVIEW, reviewedTargets: {} };
    }
    const reviewedTargets: Record<string, CarrierReviewEntry> = {};
    for (const [targetId, entry] of Object.entries(raw.reviewedTargets as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const { riskHash, decidedAt, reason } = entry as Record<string, unknown>;
      if (typeof riskHash !== 'string' || typeof decidedAt !== 'string') continue;
      reviewedTargets[targetId] = { riskHash, decidedAt, ...(typeof reason === 'string' ? { reason } : {}) };
    }
    return { version: 1, reviewedTargets };
  } catch {
    return { ...EMPTY_CARRIER_REVIEW, reviewedTargets: {} };
  }
}

export function writeCarrierReviewFile(repoRoot: string, file: CarrierReviewFile): void {
  writeFileAtomicSync(carrierReviewFilePath(repoRoot), `${JSON.stringify(file, null, 2)}\n`);
}

/** Read-merge-write of reviewed entries. The atomic write prevents torn files; a concurrent
 * decline from another process can still be lost (accepted for v1, mirrors onboarding-state.json). */
export function mergeCarrierReviewEntries(
  repoRoot: string,
  entries: Record<string, CarrierReviewEntry>,
): CarrierReviewFile {
  const current = readCarrierReviewFile(repoRoot);
  const merged: CarrierReviewFile = {
    version: 1,
    reviewedTargets: { ...current.reviewedTargets, ...entries },
  };
  writeCarrierReviewFile(repoRoot, merged);
  return merged;
}

/** Reviewed target ids whose stored riskHash still matches the target's current consumer risks. */
export function readValidSuppressedTargets(
  repoRoot: string,
  annotations: Record<string, StoredAnnotation>,
): Set<string> {
  const out = new Set<string>();
  for (const [targetId, entry] of Object.entries(readCarrierReviewFile(repoRoot).reviewedTargets)) {
    if (entry.riskHash === carrierTargetRiskHash(annotations[targetId]?.annotation)) out.add(targetId);
  }
  return out;
}
