import { extractTypeScriptFromSfc, isSfcFile } from '../../../packages/plugins/source-typescript/src/sfc-extractor.js';

describe('isSfcFile', () => {
  it('recognizes Vue / Svelte extensions', () => {
    expect(isSfcFile('foo.vue')).toBe(true);
    expect(isSfcFile('foo.svelte')).toBe(true);
    expect(isSfcFile('FOO.VUE')).toBe(true);
  });
  it('rejects other extensions', () => {
    expect(isSfcFile('foo.ts')).toBe(false);
    expect(isSfcFile('foo.tsx')).toBe(false);
    expect(isSfcFile('foo.html')).toBe(false);
  });
});

describe('extractTypeScriptFromSfc — Vue', () => {
  it('extracts <script setup lang="ts">', () => {
    const sfc = `<template><div>hi</div></template>
<script setup lang="ts">
import { ref } from 'vue';
const x = ref(0);
</script>
<style>div { color: red }</style>`;
    const r = extractTypeScriptFromSfc('a.vue', sfc);
    expect(r?.isTypeScript).toBe(true);
    expect(r?.ts).toContain("import { ref } from 'vue'");
    expect(r?.ts).toContain('const x = ref(0)');
  });

  it('extracts plain <script> when no lang attr (assumes JS but still returns the code)', () => {
    const sfc = `<script>export const Y = 1;</script>`;
    const r = extractTypeScriptFromSfc('a.vue', sfc);
    expect(r?.isTypeScript).toBe(false);
    expect(r?.ts).toContain('export const Y = 1');
  });

  it('concatenates regular and setup script blocks', () => {
    const sfc = `<script lang="ts">
export const MODULE_LEVEL = 1;
</script>
<script setup lang="ts">
import { ref } from 'vue';
const x = ref(0);
</script>`;
    const r = extractTypeScriptFromSfc('a.vue', sfc);
    expect(r?.ts).toContain('MODULE_LEVEL');
    expect(r?.ts).toContain('ref(0)');
    expect(r?.isTypeScript).toBe(true);
  });

  it('returns empty when no <script> block', () => {
    const sfc = `<template><div /></template><style>div{}</style>`;
    const r = extractTypeScriptFromSfc('a.vue', sfc);
    expect(r?.ts).toBe('');
    expect(r?.isTypeScript).toBe(false);
  });

  it('tolerates lang="typescript" alias', () => {
    const sfc = `<script setup lang="typescript">const x: number = 1;</script>`;
    const r = extractTypeScriptFromSfc('a.vue', sfc);
    expect(r?.isTypeScript).toBe(true);
  });
});

describe('extractTypeScriptFromSfc — Svelte', () => {
  it('extracts <script lang="ts">', () => {
    const sfc = `<script lang="ts">
import { onMount } from 'svelte';
let count = 0;
</script>
<button>{count}</button>`;
    const r = extractTypeScriptFromSfc('a.svelte', sfc);
    expect(r?.isTypeScript).toBe(true);
    expect(r?.ts).toContain('onMount');
  });

  it('extracts module + instance scripts', () => {
    const sfc = `<script context="module" lang="ts">
export const SHARED = 1;
</script>
<script lang="ts">
let count = 0;
</script>`;
    const r = extractTypeScriptFromSfc('a.svelte', sfc);
    expect(r?.ts).toContain('SHARED');
    expect(r?.ts).toContain('let count');
  });

  it('accepts legacy type="text/typescript" attribute', () => {
    const sfc = `<script type="text/typescript">const x: number = 1;</script>`;
    const r = extractTypeScriptFromSfc('a.svelte', sfc);
    expect(r?.isTypeScript).toBe(true);
  });

  it('keeps template-only components discoverable', () => {
    const r = extractTypeScriptFromSfc('a.svelte', '<h1>Route page</h1>');
    expect(r?.isTypeScript).toBe(false);
    expect(r?.ts).toContain('__REPOVINE_SFC_TEMPLATE__');
    expect(r?.ts).toContain('<h1>Route page</h1>');
  });
});

describe('extractTypeScriptFromSfc — null cases', () => {
  it('returns null for non-SFC extensions', () => {
    expect(extractTypeScriptFromSfc('foo.ts', 'export {}')).toBeNull();
  });
});
