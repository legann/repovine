import * as fs from 'node:fs';
import type { RepovineState } from '../mcp/types.js';
import { domainsConfigFilePath } from '../paths.js';
import {
  applyDomainsKeep,
  applyDomainsSuggestion,
  computeDomainsSuggestion,
  formatDomainsConfigFile,
  readDomainsConfigFile,
  type DomainsSuggestionAddition,
} from '../stage2/domains-advisor.js';
import { mergeDeclinedDomainsSuggestions, readDeclinedDomainsSuggestions, writeOnboardingState } from '../mcp/onboarding-state.js';
import { promptLineSync } from './prompt.js';
import { cli } from './ui.js';

export interface DomainsAdvisorCliResult {
  count: number;
  applied: boolean;
  declined: boolean;
  acceptedCount: number;
  declinedCount: number;
  keptCount: number;
  pendingCount: number;
  backupPath?: string;
}

type DomainsAdvisorPrompt = (prompt: string, nonTtyMessage: string) => string;

type SuggestionDecision = 'accept' | 'keep' | 'hide' | 'quit';

/** Keep-committed only makes sense for infra-noise suggestions (suffix/pattern axes). */
function isKeepableAxis(axis: DomainsSuggestionAddition['axis']): boolean {
  return axis === 'infra.excludeSuffixes' || axis === 'infra.excludePatterns';
}

export function runDomainsAdvisorAfterBuild(
  repoRoot: string,
  state: RepovineState,
  options: { interactive?: boolean; prompt?: DomainsAdvisorPrompt } = {},
): DomainsAdvisorCliResult {
  const suggestion = state.domainsSuggestions;
  if (suggestion.count === 0) {
    return { count: 0, applied: false, declined: false, acceptedCount: 0, declinedCount: 0, keptCount: 0, pendingCount: 0 };
  }

  if (!options.interactive) {
    // Non-interactive setup leaves suggestions pending in onboarding-state.json;
    // agents review the structured diff through suggest_domains_config.
    return { count: suggestion.count, applied: false, declined: false, acceptedCount: 0, declinedCount: 0, keptCount: 0, pendingCount: suggestion.count };
  }

  const prompt = options.prompt ?? promptLineSync;
  const accepted: DomainsSuggestionAddition[] = [];
  const kept: DomainsSuggestionAddition[] = [];
  const declinedIds: string[] = [];
  let quitAt: number | undefined;

  printDomainsSuggestionHeader(suggestion.count);
  for (let i = 0; i < suggestion.additions.length; i += 1) {
    const addition = suggestion.additions[i];
    const decision = promptForSuggestion(addition, i + 1, suggestion.count, prompt);
    if (decision === 'accept') accepted.push(addition);
    if (decision === 'keep') kept.push(addition);
    if (decision === 'hide') declinedIds.push(addition.id);
    if (decision === 'quit') {
      quitAt = i;
      break;
    }
  }

  const pendingCount = suggestion.count - accepted.length - kept.length - declinedIds.length;
  const filePath = domainsConfigFilePath(repoRoot);
  let backupPath: string | undefined;

  if (accepted.length > 0 || kept.length > 0) {
    // accept (exclude) and keep both write the committed repovine.domains.json — back it up once,
    // then layer both decisions onto the same on-disk config.
    backupPath = fs.existsSync(filePath) ? `${filePath}.bak` : undefined;
    if (backupPath) fs.copyFileSync(filePath, backupPath);
    let mergedConfig = readDomainsConfigFile(repoRoot);
    if (accepted.length > 0) mergedConfig = applyDomainsSuggestion(mergedConfig, accepted);
    if (kept.length > 0) mergedConfig = applyDomainsKeep(mergedConfig, kept);
    fs.writeFileSync(filePath, formatDomainsConfigFile(mergedConfig), 'utf-8');
    if (accepted.length > 0) {
      console.log(`Domains advisor: merged ${accepted.length} addition(s) into repovine.domains.json${backupPath ? ' (.bak written)' : ''}. Refresh the graph to apply.`);
    }
    if (kept.length > 0) {
      console.log(`Domains advisor: wrote ${kept.length} keep marker(s) into repovine.domains.json${backupPath && accepted.length === 0 ? ' (.bak written)' : ''}. These resources stay materialized and are no longer suggested.`);
    }
  }

  const declined = declinedIds.length > 0
    ? mergeDeclinedDomainsSuggestions(repoRoot, declinedIds)
    : readDeclinedDomainsSuggestions(repoRoot);
  if (declinedIds.length > 0) {
    console.log(cli.dim(`Domains advisor: ${declinedIds.length} suggestion(s) skipped and hidden for this repo.`));
  }
  state.domainsSuggestions = computeDomainsSuggestion(state.snapshot, state.graph, readDomainsConfigFile(repoRoot), declined);
  writeOnboardingState(repoRoot, state, { declined });
  if (pendingCount > 0) {
    console.log(cli.dim(`Domains advisor: ${pendingCount} suggestion(s) left pending${quitAt === undefined ? '' : ' for later'}.`));
  }

  return {
    count: suggestion.count,
    applied: accepted.length > 0,
    declined: declinedIds.length > 0,
    acceptedCount: accepted.length,
    declinedCount: declinedIds.length,
    keptCount: kept.length,
    pendingCount,
    backupPath,
  };
}

function printDomainsSuggestionHeader(count: number): void {
  console.log(`\n${cli.bold('Domains advisor:')} ${count} additive suggestion(s)`);
  console.log(cli.dim('Review one suggestion at a time. Apply writes only that addition; skip/hide stores only that suggestion locally; quit leaves the rest pending.'));
}

function promptForSuggestion(
  addition: DomainsSuggestionAddition,
  index: number,
  total: number,
  prompt: DomainsAdvisorPrompt,
): SuggestionDecision {
  printDomainsSuggestionDetail(addition, index, total);
  const keepable = isKeepableAxis(addition.axis);
  const promptText = keepable
    ? 'Apply? [y]es / [k]eep-committed / [s]kip-hide / [q]uit domains advisor: '
    : 'Apply? [y]es / [s]kip-hide / [q]uit domains advisor: ';
  for (;;) {
    const answer = prompt(promptText, 'Interactive setup requires a TTY.').trim().toLowerCase();
    if (answer === 'y' || answer === 'yes' || answer === 'a' || answer === 'apply') return 'accept';
    if (keepable && (answer === 'k' || answer === 'keep')) return 'keep';
    if (answer === 's' || answer === 'skip' || answer === 'h' || answer === 'hide' || answer === 'n' || answer === 'no' || answer === 'd' || answer === 'decline') return 'hide';
    if (answer === 'q' || answer === 'quit') return 'quit';
    console.log(cli.dim(keepable ? 'Choose y, k, s, or q.' : 'Choose y, s, or q.'));
  }
}

function printDomainsSuggestionDetail(addition: DomainsSuggestionAddition, index: number, total: number): void {
  console.log(`\n${cli.bold(`Suggestion ${index}/${total}`)}`);
  if (addition.axis === 'infra.excludeSuffixes') {
    console.log(`  proposed infra.excludeSuffixes: ${addition.value}`);
    console.log(`  effect: hide runtime-resource nodes whose labels end with "${addition.value}" from graph/search/flow`);
    console.log(`  labels: ${addition.labels.join(', ')}`);
    return;
  }
  if (addition.axis === 'infra.excludePatterns') {
    console.log(`  proposed infra.excludePatterns: ${addition.value}`);
    console.log(`  effect: hide ${addition.labels.length} inert runtime-resource node(s) matching this pattern from graph/search/flow`);
    console.log(`  labels: ${addition.labels.join(', ')}`);
    console.log(`  spared (witnessed, kept visible): ${addition.spared.join(', ') || 'none'}`);
    return;
  }
  if (addition.axis === 'basename.pascalCase') {
    console.log(`  proposed basename.pascalCase: reject`);
    console.log(`  effect: stop promoting PascalCase filenames to domains automatically (${addition.count} basename(s), ratio ${addition.ratio})`);
    return;
  }
  console.log(`  proposed domain "${addition.domain}" <- ${addition.paths.join(', ')}`);
  console.log(`  effect: tag matching modules as domain "${addition.domain}"; this does not move files or merge modules`);
  console.log(`  modules: ${addition.count}`);
}
