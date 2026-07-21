/**
 * Render IDE marketplace plugin bundles from onboarding SSoT into repovine-client-plugins/.
 *
 * Output layout (under --out, default: ../repovine-client-plugins):
 *   .cursor-plugin/marketplace.json
 *   .claude-plugin/marketplace.json
 *   .agents/plugins/marketplace.json
 *   repovine-plugins/{cursor,claude,codex}/…
 *
 * Wipes all generated output under outRoot before writing (preserves assets/ only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECTION_VERSION } from './agent-projection.js';
import {
  AGENTS,
  COMMANDS,
  CLAUDE_SHARED_SKILLS,
  CODEX_SHARED_SKILLS,
  CURSOR_RULES,
  CURSOR_SHARED_SKILLS,
  PROJECT_SAMPLE_SUBAGENT_MD,
  PROJECT_SUBAGENT_SAMPLE_FILENAME,
  PROJECT_SUBAGENT_TEMPLATE_FILENAME,
  PROJECT_SUBAGENT_SAMPLE_FILENAME_CODEX,
  PROJECT_SUBAGENT_TEMPLATE_FILENAME_CODEX,
  PROJECT_SUBAGENT_TEMPLATE_MD,
  renderClaudeFrontmatter,
  renderCursorAgentFrontmatter,
  renderCursorBody,
  renderCodexAgentToml,
  renderProjectSampleSubagentToml,
  renderProjectSubagentTemplateToml,
  renderSkillMarkdown,
  type OnboardingAsset,
} from './onboarding-assets.js';
import {
  CLAUDE_HOOKS_SETTINGS,
  CLAUDE_MCP_JSON,
  CLAUDE_SESSION_MCP_HINT_JS,
  CLAUDE_STALE_GRAPH_NOTICE_JS,
  CLAUDE_BOUNDARY_NOTICE_JS,
  CLAUDE_MD,
  CODEX_CONFIG_TOML,
  CODEX_SESSION_MCP_HINT_JS,
  CODEX_STALE_GRAPH_NOTICE_JS,
  CODEX_BOUNDARY_NOTICE_JS,
  CURSOR_HOOKS_SETTINGS,
  CURSOR_MCP_JSON,
  CURSOR_SESSION_MCP_HINT_JS,
  CURSOR_STALE_GRAPH_NOTICE_JS,
  CURSOR_BOUNDARY_NOTICE_JS,
} from './templates.js';
import { REPOVINE_MCP_SERVER_NAME } from './merge-config.js';

export type PluginClient = 'cursor' | 'claude' | 'codex';

/** Publish repo for marketplace installs (plugin bundles). */
export const REPOVINE_PLUGIN_REPOSITORY = 'https://github.com/legann/repovine-client-plugins';

/** Engine source repo (npm package). */
export const REPOVINE_ENGINE_REPOSITORY = 'https://github.com/legann/repovine';

const CURSOR_PLUGIN_SCHEMA = 'https://cursor.com/schemas/cursor-plugin/plugin.json';
const CLAUDE_PLUGIN_SCHEMA = 'https://json.schemastore.org/claude-code-plugin-manifest.json';
const CLAUDE_MARKETPLACE_SCHEMA = 'https://json.schemastore.org/claude-code-marketplace.json';

/**
 * Entries under outRoot that wipe never deletes: hand-placed `assets/` (logos),
 * and the repo's own VCS metadata — `repovine-client-plugins` is now its own git
 * repo, so a render must not nuke its `.git`/`.gitignore`.
 */
const PRESERVE_OUTROOT_ENTRIES = new Set(['assets', '.git', '.gitignore']);

/** Clients a full render projects. */
const ALL_PLUGIN_CLIENTS: readonly PluginClient[] = ['cursor', 'claude', 'codex'];

/**
 * Entries under outRoot that a single client's projection owns: its bundle tree and
 * its marketplace manifest. A scoped render rewrites exactly these, so rendering one
 * client leaves the other bundles in the plugins repo intact.
 */
const CLIENT_OWNED_ENTRIES: Record<PluginClient, readonly string[]> = {
  cursor: [path.join('repovine-plugins', 'cursor'), '.cursor-plugin'],
  claude: [path.join('repovine-plugins', 'claude'), '.claude-plugin'],
  codex: [path.join('repovine-plugins', 'codex'), path.join('.agents', 'plugins')],
};

export interface RenderPluginRepoOptions {
  /** repovine package root (contains package.json). */
  engineRoot: string;
  /** repovine-client-plugins root (marketplace + repovine-plugins/). */
  outRoot: string;
  version?: string;
  clients?: PluginClient[];
}

export interface RenderPluginRepoResult {
  version: string;
  projectionVersion: string;
  engineRoot: string;
  outRoot: string;
  clients: PluginClient[];
  filesWritten: number;
  paths: string[];
  wiped: string[];
}

interface RenderedAssetTarget {
  relativeDir: string;
  extension?: string;
  fileName?: string;
  render: (asset: OnboardingAsset) => string;
}

const CLIENT_ASSET_TARGETS = {
  claudePluginAgents: {
    relativeDir: 'agents',
    extension: 'md',
    render: renderClaudeFrontmatter,
  },
  claudePluginSkills: {
    relativeDir: 'skills',
    fileName: 'SKILL.md',
    render: renderSkillMarkdown,
  },
  claudeAgents: {
    relativeDir: path.join('.claude', 'agents'),
    extension: 'md',
    render: renderClaudeFrontmatter,
  },
  claudeSkills: {
    relativeDir: path.join('.claude', 'skills'),
    fileName: 'SKILL.md',
    render: renderSkillMarkdown,
  },
  cursorAgents: {
    relativeDir: path.join('.cursor', 'agents'),
    extension: 'md',
    render: renderCursorAgentFrontmatter,
  },
  cursorRules: {
    relativeDir: path.join('.cursor', 'rules'),
    extension: 'mdc',
    render: renderCursorBody,
  },
  codexAgents: {
    relativeDir: path.join('.codex', 'agents'),
    extension: 'toml',
    render: renderCodexAgentToml,
  },
  sharedAgentSkills: {
    relativeDir: path.join('.agents', 'skills'),
    fileName: 'SKILL.md',
    render: renderSkillMarkdown,
  },
} as const satisfies Record<string, RenderedAssetTarget>;

function defaultEngineRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function defaultOutRoot(engineRoot: string): string {
  return path.resolve(engineRoot, '..', 'repovine-client-plugins');
}

function readEngineVersion(engineRoot: string): string {
  const pkgPath = path.join(engineRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
  if (!pkg.version) throw new Error(`Missing version in ${pkgPath}`);
  return pkg.version;
}

function removeIfExists(target: string): void {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Remove prior generator output under outRoot. Keeps assets/ (logos, screenshots).
 *
 * A full render (every client) wipes outRoot, so files dropped from the projection
 * disappear with it. A scoped render (clients subset) removes only the selected
 * clients' owned entries and leaves the other bundles and marketplaces in place.
 */
export function wipePluginOutRoot(outRoot: string, clients?: PluginClient[]): string[] {
  const removed: string[] = [];
  if (!fs.existsSync(outRoot)) {
    fs.mkdirSync(outRoot, { recursive: true });
    return removed;
  }

  const selected = clients ? new Set(clients) : undefined;
  if (selected && !ALL_PLUGIN_CLIENTS.every(client => selected.has(client))) {
    for (const client of selected) {
      for (const entry of CLIENT_OWNED_ENTRIES[client]) {
        const target = path.join(outRoot, entry);
        if (!fs.existsSync(target)) continue;
        removeIfExists(target);
        removed.push(entry);
      }
    }
    return removed.sort();
  }

  for (const entry of fs.readdirSync(outRoot, { withFileTypes: true })) {
    if (PRESERVE_OUTROOT_ENTRIES.has(entry.name)) continue;
    const target = path.join(outRoot, entry.name);
    removeIfExists(target);
    removed.push(entry.name);
  }

  return removed.sort();
}

function renderedAssetPath(bundleRoot: string, asset: OnboardingAsset, target: RenderedAssetTarget): string {
  if (target.fileName) {
    return path.join(bundleRoot, target.relativeDir, asset.name, target.fileName);
  }
  if (!target.extension) {
    throw new Error('Rendered asset target requires either extension or fileName');
  }
  return path.join(bundleRoot, target.relativeDir, `${asset.name}.${target.extension}`);
}

function writeRenderedAssets(
  bundleRoot: string,
  assets: OnboardingAsset[],
  target: RenderedAssetTarget,
  written: string[],
): void {
  for (const asset of assets) {
    const filePath = renderedAssetPath(bundleRoot, asset, target);
    writeUtf8(filePath, target.render(asset), written);
  }
}

function writeUtf8(filePath: string, content: string, written: string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  written.push(filePath);
}

function writeJson(filePath: string, value: unknown, written: string[]): void {
  writeUtf8(filePath, `${JSON.stringify(value, null, 2)}\n`, written);
}

function pinMcpJson(baseJson: string, version: string): string {
  const parsed = JSON.parse(baseJson) as {
    mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  };
  const server = parsed.mcpServers[REPOVINE_MCP_SERVER_NAME];
  if (server) {
    server.args = ['-y', `repovine@${version}`];
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function pinCodexConfigToml(toml: string, version: string): string {
  return toml.replace(
    /args = \["-y", "repovine"\]/g,
    `args = ["-y", "repovine@${version}"]`,
  );
}

function claudePluginHooksSettings(): Record<string, unknown> {
  const hooks = JSON.parse(JSON.stringify(CLAUDE_HOOKS_SETTINGS)) as {
    PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }>;
    PostToolUse?: Array<{ hooks?: Array<{ command?: string }> }>;
    SessionStart?: Array<{ hooks?: Array<{ command?: string }> }>;
  };
  const replacements: Record<string, string> = {
    'node "$CLAUDE_PROJECT_DIR/.claude/hooks/boundary-notice.js"':
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/boundary-notice.js"',
    'node "$CLAUDE_PROJECT_DIR/.claude/hooks/stale-graph-notice.js"':
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/stale-graph-notice.js"',
    'node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-mcp-hint.js"':
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-mcp-hint.js"',
  };
  for (const entries of [hooks.PreToolUse, hooks.PostToolUse, hooks.SessionStart]) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        if (hook.command && replacements[hook.command]) {
          hook.command = replacements[hook.command];
        }
      }
    }
  }
  return hooks as Record<string, unknown>;
}

function resolveLogoRelative(outRoot: string): string | undefined {
  const candidates = ['assets/logo.svg', 'assets/logo.png', 'assets/icon.png'];
  for (const rel of candidates) {
    if (fs.existsSync(path.join(outRoot, rel))) return rel;
  }
  return undefined;
}

function basePluginFields(version: string, description: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    name: 'repovine',
    description,
    version,
    author: { name: 'legann' },
    license: 'MIT',
    homepage: REPOVINE_ENGINE_REPOSITORY,
    repository: REPOVINE_PLUGIN_REPOSITORY,
    keywords: [
      'mcp',
      'repovine',
      'codebase-navigation',
      'semantic-graph',
      'dependency-analysis',
      'code-intelligence',
      'annotations',
    ],
  };
  return fields;
}

function cursorPluginManifest(outRoot: string, version: string): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    $schema: CURSOR_PLUGIN_SCHEMA,
    ...basePluginFields(
      version,
      'repovine — graph-backed codebase context for Cursor (MCP, skills, agents, hooks).',
    ),
    rules: '.cursor/rules',
    agents: '.cursor/agents',
    skills: '.agents/skills',
    hooks: '.cursor/hooks.json',
    mcpServers: '.cursor/mcp.json',
  };
  const logo = resolveLogoRelative(outRoot);
  if (logo) manifest.logo = logo;
  return manifest;
}

function claudePluginManifest(outRoot: string, version: string): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    $schema: CLAUDE_PLUGIN_SCHEMA,
    ...basePluginFields(
      version,
      'repovine — graph-backed codebase context for Claude Code (MCP, skills, agents, hooks).',
    ),
  };
  const logo = resolveLogoRelative(outRoot);
  if (logo) manifest.logo = logo;
  return manifest;
}

function codexPluginManifest(outRoot: string, version: string): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    ...basePluginFields(
      version,
      'repovine — graph-backed codebase context for Codex (MCP, skills, agents, hooks).',
    ),
    mcpServers: '.mcp.json',
  };
  const logo = resolveLogoRelative(outRoot);
  if (logo) manifest.logo = logo;
  return manifest;
}

function renderCursorBundle(
  bundleRoot: string,
  outRoot: string,
  version: string,
  written: string[],
): void {
  fs.mkdirSync(bundleRoot, { recursive: true });

  writeJson(
    path.join(bundleRoot, '.cursor-plugin', 'plugin.json'),
    cursorPluginManifest(outRoot, version),
    written,
  );
  writeUtf8(path.join(bundleRoot, '.cursor', 'mcp.json'), pinMcpJson(CURSOR_MCP_JSON, version), written);
  writeJson(path.join(bundleRoot, '.cursor', 'hooks.json'), CURSOR_HOOKS_SETTINGS, written);
  writeUtf8(path.join(bundleRoot, '.cursor', 'hooks', 'boundary-notice.js'), CURSOR_BOUNDARY_NOTICE_JS, written);
  writeUtf8(path.join(bundleRoot, '.cursor', 'hooks', 'stale-graph-notice.js'), CURSOR_STALE_GRAPH_NOTICE_JS, written);
  writeUtf8(path.join(bundleRoot, '.cursor', 'hooks', 'session-mcp-hint.js'), CURSOR_SESSION_MCP_HINT_JS, written);

  writeRenderedAssets(bundleRoot, AGENTS, CLIENT_ASSET_TARGETS.cursorAgents, written);
  // Cursor gets the build/lifecycle workflows as skills (no .cursor/commands surface).
  writeRenderedAssets(bundleRoot, [...COMMANDS, ...CURSOR_SHARED_SKILLS], CLIENT_ASSET_TARGETS.sharedAgentSkills, written);
  writeRenderedAssets(bundleRoot, CURSOR_RULES, CLIENT_ASSET_TARGETS.cursorRules, written);

  writeUtf8(
    path.join(bundleRoot, '.cursor', 'agents', PROJECT_SUBAGENT_SAMPLE_FILENAME),
    PROJECT_SAMPLE_SUBAGENT_MD,
    written,
  );
  writeUtf8(
    path.join(bundleRoot, '.cursor', 'agents', PROJECT_SUBAGENT_TEMPLATE_FILENAME),
    PROJECT_SUBAGENT_TEMPLATE_MD,
    written,
  );
  writeUtf8(path.join(bundleRoot, 'INSTALL.md'), cursorInstallMd(version), written);
}

function renderClaudeBundle(bundleRoot: string, outRoot: string, version: string, written: string[]): void {
  fs.mkdirSync(bundleRoot, { recursive: true });

  writeJson(
    path.join(bundleRoot, '.claude-plugin', 'plugin.json'),
    claudePluginManifest(outRoot, version),
    written,
  );
  writeUtf8(path.join(bundleRoot, '.mcp.json'), pinMcpJson(CLAUDE_MCP_JSON, version), written);
  writeJson(path.join(bundleRoot, 'hooks', 'hooks.json'), claudePluginHooksSettings(), written);
  writeUtf8(path.join(bundleRoot, 'hooks', 'boundary-notice.js'), CLAUDE_BOUNDARY_NOTICE_JS, written);
  writeUtf8(path.join(bundleRoot, 'hooks', 'stale-graph-notice.js'), CLAUDE_STALE_GRAPH_NOTICE_JS, written);
  writeUtf8(path.join(bundleRoot, 'hooks', 'session-mcp-hint.js'), CLAUDE_SESSION_MCP_HINT_JS, written);
  writeUtf8(path.join(bundleRoot, 'CLAUDE.md'), CLAUDE_MD, written);

  writeRenderedAssets(bundleRoot, AGENTS, CLIENT_ASSET_TARGETS.claudePluginAgents, written);
  writeRenderedAssets(
    bundleRoot,
    [...COMMANDS, ...CLAUDE_SHARED_SKILLS],
    CLIENT_ASSET_TARGETS.claudePluginSkills,
    written,
  );

  writeUtf8(
    path.join(bundleRoot, 'agents', PROJECT_SUBAGENT_SAMPLE_FILENAME),
    PROJECT_SAMPLE_SUBAGENT_MD,
    written,
  );
  writeUtf8(
    path.join(bundleRoot, 'agents', PROJECT_SUBAGENT_TEMPLATE_FILENAME),
    PROJECT_SUBAGENT_TEMPLATE_MD,
    written,
  );
  writeUtf8(path.join(bundleRoot, 'INSTALL.md'), claudeInstallMd(version), written);
}

function renderCodexBundle(bundleRoot: string, outRoot: string, version: string, written: string[]): void {
  fs.mkdirSync(bundleRoot, { recursive: true });

  writeJson(
    path.join(bundleRoot, '.codex-plugin', 'plugin.json'),
    codexPluginManifest(outRoot, version),
    written,
  );
  writeUtf8(path.join(bundleRoot, '.mcp.json'), pinMcpJson(CLAUDE_MCP_JSON, version), written);
  writeUtf8(
    path.join(bundleRoot, '.codex', 'config.toml'),
    pinCodexConfigToml(CODEX_CONFIG_TOML, version),
    written,
  );
  writeUtf8(path.join(bundleRoot, '.codex', 'hooks', 'boundary-notice.js'), CODEX_BOUNDARY_NOTICE_JS, written);
  writeUtf8(path.join(bundleRoot, '.codex', 'hooks', 'stale-graph-notice.js'), CODEX_STALE_GRAPH_NOTICE_JS, written);
  writeUtf8(path.join(bundleRoot, '.codex', 'hooks', 'session-mcp-hint.js'), CODEX_SESSION_MCP_HINT_JS, written);

  writeRenderedAssets(bundleRoot, AGENTS, CLIENT_ASSET_TARGETS.codexAgents, written);
  writeRenderedAssets(
    bundleRoot,
    [...COMMANDS, ...CODEX_SHARED_SKILLS],
    CLIENT_ASSET_TARGETS.sharedAgentSkills,
    written,
  );

  writeUtf8(
    path.join(bundleRoot, '.codex', 'agents', PROJECT_SUBAGENT_SAMPLE_FILENAME_CODEX),
    renderProjectSampleSubagentToml(),
    written,
  );
  writeUtf8(
    path.join(bundleRoot, '.codex', 'agents', PROJECT_SUBAGENT_TEMPLATE_FILENAME_CODEX),
    renderProjectSubagentTemplateToml(),
    written,
  );
  writeUtf8(path.join(bundleRoot, 'INSTALL.md'), codexInstallMd(version), written);
}

function renderMarketplaces(
  outRoot: string,
  version: string,
  clients: PluginClient[],
  written: string[],
): void {
  const generatedNote = `Generated from repovine@${version} (projection ${PROJECTION_VERSION}). Do not edit by hand.`;

  if (clients.includes('cursor')) {
    writeJson(path.join(outRoot, '.cursor-plugin', 'marketplace.json'), {
      name: 'repovine',
      owner: { name: 'legann' },
      metadata: { description: generatedNote },
      plugins: [
        {
          name: 'repovine',
          displayName: 'repovine',
          version,
          description: 'Graph-backed codebase context for AI agents (MCP + skills + agents).',
          source: './repovine-plugins/cursor',
          repository: REPOVINE_PLUGIN_REPOSITORY,
          license: 'MIT',
        },
      ],
    }, written);
  }

  if (clients.includes('claude')) {
    writeJson(path.join(outRoot, '.claude-plugin', 'marketplace.json'), {
      $schema: CLAUDE_MARKETPLACE_SCHEMA,
      name: 'repovine',
      owner: { name: 'legann' },
      metadata: { description: generatedNote },
      plugins: [
        {
          name: 'repovine',
          description: 'Graph-backed codebase context for AI agents (MCP + skills + agents).',
          version,
          source: './repovine-plugins/claude',
          repository: REPOVINE_PLUGIN_REPOSITORY,
          license: 'MIT',
        },
      ],
    }, written);
  }

  if (clients.includes('codex')) {
    writeJson(path.join(outRoot, '.agents', 'plugins', 'marketplace.json'), {
      name: 'repovine',
      interface: { displayName: 'repovine' },
      metadata: { description: generatedNote },
      plugins: [
        {
          name: 'repovine',
          version,
          description: 'Graph-backed codebase context for AI agents (MCP + skills + agents).',
          source: {
            source: 'local',
            path: './repovine-plugins/codex',
          },
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
          category: 'Development',
        },
      ],
    }, written);
  }
}

function renderLicense(outRoot: string, written: string[]): void {
  writeUtf8(
    path.join(outRoot, 'LICENSE'),
    `MIT License

Copyright (c) legann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
    written,
  );
}

function renderRootReadme(outRoot: string, version: string, written: string[]): void {
  writeUtf8(
    path.join(outRoot, 'README.md'),
    `# repovine-client-plugins

⚠️ **Auto-generated** from [legann/repovine](${REPOVINE_ENGINE_REPOSITORY}) @ \`v${version}\` (projection \`${PROJECTION_VERSION}\`).

Do not edit \`repovine-plugins/\` or marketplace manifests by hand. Change \`src/cli/onboarding-assets.ts\` (and related templates) in the engine repo, then re-render from there:

\`\`\`bash
# in the repovine engine repo (sibling checkout)
npm run render-client-plugins
\`\`\`

Validate the generated bundles:

\`\`\`bash
npm run render-client-plugins:validate
\`\`\`

## Layout

| Path | Role |
|------|------|
| \`.cursor-plugin/marketplace.json\` | Cursor marketplace catalog |
| \`.claude-plugin/marketplace.json\` | Claude Code marketplace catalog |
| \`.agents/plugins/marketplace.json\` | Codex marketplace catalog |
| \`repovine-plugins/cursor/\` | Cursor plugin bundle |
| \`repovine-plugins/claude/\` | Claude Code plugin bundle |
| \`repovine-plugins/codex/\` | Codex plugin bundle |
| \`assets/\` | Optional logos (preserved across renders) |

## Install (git marketplace)

- **Cursor:** add \`${REPOVINE_PLUGIN_REPOSITORY}\` as marketplace source, install \`repovine\`.
- **Claude:** \`/plugin marketplace add legann/repovine-client-plugins\` then \`/plugin install repovine@repovine\`
- **Codex:** \`codex plugin marketplace add legann/repovine-client-plugins\`

MCP in each bundle is pinned to \`npx -y repovine@${version}\`.

## Project workspace files

Plugin bundles ship agents, skills, hooks, and MCP. For workspace-local \`repovine.config.json\`, \`repovine.domains.json\`, \`.repovine/\`, and \`.gitignore\` cache entries, run in the **target repository**:

\`\`\`bash
npx repovine@${version} setup
\`\`\`

Use \`npx repovine@${version} setup <cursor|claude|codex|all>\` to also scaffold a client directly when you are not installing the marketplace plugin.

## Engine

${REPOVINE_ENGINE_REPOSITORY}

MIT — see [LICENSE](LICENSE).
`,
    written,
  );
}

/**
 * The plugin MCP starts through `npx`, so repovine runs from the npx cache and the ML package
 * is looked up in the workspace. Every INSTALL.md carries the one command that turns it on.
 */
const SEMANTIC_SEARCH_INSTALL_NOTE = `## Semantic search (optional)

\`search_context\` runs on the token index out of the box. In-process embeddings need one more
package in the repository:

\`\`\`bash
npm install @huggingface/transformers
\`\`\`

Installing repovine does not pull it: its ONNX runtime weighs ~700 MB. Without it the build logs
one warning and search stays on the token index.
`;

function cursorInstallMd(version: string): string {
  return `# repovine Cursor plugin

Bundled from repovine@${version}. MCP server: \`${REPOVINE_MCP_SERVER_NAME}\` (\`npx -y repovine@${version}\`).

After installing from the marketplace, open a workspace and run:

\`\`\`bash
npx repovine@${version} setup
\`\`\`

to create \`repovine.config.json\`, \`repovine.domains.json\`, \`.repovine/\`, and cache \`.gitignore\` entries. \`setup\` builds the graph by default so the first MCP start is warm.

${SEMANTIC_SEARCH_INSTALL_NOTE}`;
}

function claudeInstallMd(version: string): string {
  return `# repovine Claude Code plugin

Bundled from repovine@${version}. MCP server: \`${REPOVINE_MCP_SERVER_NAME}\` (\`npx -y repovine@${version}\`).

In the target repository:

\`\`\`bash
npx repovine@${version} setup
\`\`\`

\`setup\` builds the graph by default so the first MCP start is warm. The marketplace plugin supplies Claude agents, skills, hooks, and MCP.

${SEMANTIC_SEARCH_INSTALL_NOTE}`;
}

function codexInstallMd(version: string): string {
  return `# repovine Codex plugin

Bundled from repovine@${version}. MCP server: \`${REPOVINE_MCP_SERVER_NAME}\` (\`npx -y repovine@${version}\`).

In the target repository:

\`\`\`bash
npx repovine@${version} setup
\`\`\`

\`setup\` builds the graph by default so the first MCP start is warm. The marketplace plugin supplies Codex agents, skills, hooks, and MCP.

${SEMANTIC_SEARCH_INSTALL_NOTE}`;
}

export function renderPluginRepo(options: Partial<RenderPluginRepoOptions> = {}): RenderPluginRepoResult {
  const engineRoot = path.resolve(options.engineRoot ?? defaultEngineRoot());
  const outRoot = path.resolve(options.outRoot ?? defaultOutRoot(engineRoot));
  const version = options.version ?? readEngineVersion(engineRoot);
  const clients: PluginClient[] = options.clients ?? [...ALL_PLUGIN_CLIENTS];

  const wiped = wipePluginOutRoot(outRoot, clients);
  const written: string[] = [];
  const pluginsDir = path.join(outRoot, 'repovine-plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  if (clients.includes('cursor')) {
    renderCursorBundle(path.join(pluginsDir, 'cursor'), outRoot, version, written);
  }
  if (clients.includes('claude')) {
    renderClaudeBundle(path.join(pluginsDir, 'claude'), outRoot, version, written);
  }
  if (clients.includes('codex')) {
    renderCodexBundle(path.join(pluginsDir, 'codex'), outRoot, version, written);
  }

  fs.mkdirSync(path.join(outRoot, '.agents', 'plugins'), { recursive: true });
  renderMarketplaces(outRoot, version, clients, written);
  renderLicense(outRoot, written);
  renderRootReadme(outRoot, version, written);

  return {
    version,
    projectionVersion: PROJECTION_VERSION,
    engineRoot,
    outRoot,
    clients,
    filesWritten: written.length,
    paths: written.map(p => path.relative(outRoot, p)).sort(),
    wiped,
  };
}

export { defaultEngineRoot, defaultOutRoot, readEngineVersion };
