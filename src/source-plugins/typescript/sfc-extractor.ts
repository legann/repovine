/**
 * Single File Component (SFC) script extractor.
 *
 * Vue (.vue) and Svelte (.svelte) put TypeScript inside a structured wrapper.
 * ts-morph cannot parse these files directly — it skips them. This module extracts the TS code
 * so the rest of the pipeline can treat each SFC as if it were a plain .ts file.
 *
 * Implementation note: regex-based on purpose. We accept that some non-standard syntax
 * (e.g. Vue 3.3+ `<script setup generic="...">` with awkward whitespace) may be missed.
 * The trade-off is zero external dependencies and no impact on non-SFC projects.
 */
import * as path from 'node:path';

/** Extensions we treat as SFC. Caller must check this before invoking extract*. */
export const SFC_EXTENSIONS = new Set(['.vue', '.svelte']);

export function isSfcFile(filePath: string): boolean {
  return SFC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export interface ExtractedScript {
  /** TS source extracted from the SFC. Empty string if the file has no script block. */
  ts: string;
  /** True when the original script block declared lang="ts" / lang="tsx" / lang="typescript". */
  isTypeScript: boolean;
}

const TEMPLATE_HINT_CONST = '__REPOVINE_SFC_TEMPLATE__';

function appendTemplateHint(ts: string, template: string | undefined): string {
  if (!template?.trim()) return ts;
  return `${ts}\nconst ${TEMPLATE_HINT_CONST} = ${JSON.stringify(template)};\n`;
}

/**
 * Extract TypeScript content from an SFC file. Returns null when the file is not an SFC
 * we know how to handle.
 */
export function extractTypeScriptFromSfc(filePath: string, content: string): ExtractedScript | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.vue': return extractFromVue(content);
    case '.svelte': return extractFromSvelte(content);
    default: return null;
  }
}

/**
 * Vue SFC: may have one regular `<script>` and one `<script setup>` block. Either can be lang="ts".
 * If both exist, concatenate (setup goes second — its identifiers may shadow regular script).
 *
 *   <script lang="ts">                   ← module-level imports/exports
 *   import { ref } from 'vue';
 *   export const COUNT = 10;
 *   </script>
 *
 *   <script setup lang="ts">             ← component setup block
 *   import { onMounted } from 'vue';
 *   const x = ref(0);
 *   </script>
 *
 * `<script setup generic="T">` is allowed but `generic` only affects type-checking, not extraction.
 */
function extractFromVue(content: string): ExtractedScript {
  const blocks: Array<{ content: string; isTs: boolean }> = [];
  // Match each <script ...>...</script> block. Tolerate self-closing tags and missing lang attr.
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const langMatch = attrs.match(/\blang\s*=\s*["']([^"']+)["']/i);
    const lang = langMatch?.[1].toLowerCase();
    const isTs = lang === 'ts' || lang === 'tsx' || lang === 'typescript';
    blocks.push({ content: body, isTs });
  }
  if (blocks.length === 0) return { ts: '', isTypeScript: false };
  const template = content.match(/<template\b[^>]*>([\s\S]*?)<\/template\s*>/i)?.[1];
  const ts = appendTemplateHint(blocks.map(b => b.content).join('\n'), template);
  const isTypeScript = blocks.some(b => b.isTs);
  return { ts, isTypeScript };
}

/**
 * Svelte SFC: one `<script>` for component logic, optional `<script context="module">` for
 * module-scoped code (re-exports, hoisted constants). Either may be lang="ts".
 */
function extractFromSvelte(content: string): ExtractedScript {
  const blocks: Array<{ content: string; isTs: boolean }> = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const langMatch = attrs.match(/\blang\s*=\s*["']([^"']+)["']/i);
    const lang = langMatch?.[1].toLowerCase();
    // Svelte allows lang="ts" or just type="text/typescript" (older convention).
    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    const type = typeMatch?.[1].toLowerCase();
    const isTs = lang === 'ts' || lang === 'typescript' || type === 'text/typescript';
    blocks.push({ content: body, isTs });
  }
  const template = content.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const ts = appendTemplateHint(blocks.map(b => b.content).join('\n'), template);
  const isTypeScript = blocks.some(b => b.isTs);
  return { ts, isTypeScript };
}
