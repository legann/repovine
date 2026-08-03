import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  colorEnabled,
  cli,
  formatFileLine,
  formatPackageProgressLine,
  formatPipelineDetail,
  formatPipelineStage,
  formatPipelineStageDone,
  getPipelineLogSink,
  logPipeline,
  setPipelineLogSink,
  styleMcpPreflight,
  styleNextStepLine,
} from '../../../src/cli/ui.js';

const ORIGINAL_ENV = { ...process.env };

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  for (const key of Object.keys(overrides)) {
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    process.env = { ...ORIGINAL_ENV };
  }
}

describe('cli/ui colorEnabled', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('FORCE_COLOR overrides NO_COLOR', () => {
    withEnv({ NO_COLOR: '1', FORCE_COLOR: '1' }, () => {
      expect(colorEnabled()).toBe(true);
    });
  });

  it('disables color when NO_COLOR is set without FORCE_COLOR', () => {
    withEnv({ NO_COLOR: '1', FORCE_COLOR: undefined }, () => {
      expect(colorEnabled()).toBe(false);
    });
  });

  it('enables color when FORCE_COLOR=1 even without TTY', () => {
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => {
      expect(colorEnabled({ isTTY: false } as NodeJS.WriteStream)).toBe(true);
    });
  });

  it('disables color when FORCE_COLOR=0', () => {
    withEnv({ FORCE_COLOR: '0' }, () => {
      expect(colorEnabled({ isTTY: true } as NodeJS.WriteStream)).toBe(false);
    });
  });

  it('follows stream TTY when env is neutral', () => {
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined }, () => {
      expect(colorEnabled({ isTTY: true } as NodeJS.WriteStream)).toBe(true);
      expect(colorEnabled({ isTTY: false } as NodeJS.WriteStream)).toBe(false);
    });
  });
});

describe('cli/ui formatters', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns plain text when color is disabled', () => {
    withEnv({ NO_COLOR: '1' }, () => {
      expect(cli.bold('hello')).toBe('hello');
      expect(formatFileLine('created', 'foo/bar')).toBe('  ✓ foo/bar');
    });
  });

  it('wraps text in ANSI when color is forced', () => {
    withEnv({ FORCE_COLOR: '1' }, () => {
      expect(cli.bold('hello')).toContain('hello');
      expect(cli.bold('hello')).toMatch(/\x1b\[/);
    });
  });

  it('styles MCP preflight lines', () => {
    withEnv({ FORCE_COLOR: '1' }, () => {
      const plain = '  Cursor (mcp.json): not found → create (no MCP config file yet)';
      const styled = styleMcpPreflight(plain);
      expect(styled).toContain('Cursor');
      expect(styled).toContain('create');
      expect(styled).toMatch(/\x1b\[/);
    });
  });

  it('highlights slash commands in next-step lines', () => {
    withEnv({ FORCE_COLOR: '1' }, () => {
      const styled = styleNextStepLine('    2. type /repovine-refresh in Cursor Chat.');
      expect(styled).toContain('/repovine-refresh');
      expect(styled).toMatch(/\x1b\[/);
    });
  });

  it('styles pipeline stage headings and progress', () => {
    withEnv({ FORCE_COLOR: '1' }, () => {
      expect(formatPipelineStage('Stage 1: Repository facts snapshot...')).toMatch(/\x1b\[/);
      expect(formatPipelineStageDone('  Stage 1 DONE in 0.1s — 578 modules, 27 infra modules')).toMatch(/\x1b\[/);
      expect(formatPackageProgressLine(1, 10, 'pkg-a', 3, 0, 238, '(reused 3, parsed 0)')).toMatch(/\x1b\[/);
      expect(formatPipelineDetail('  Discovered 578 unique modules across 10 packages')).toContain('578');
    });
  });

  // Both streams, because the sink picks stderr only by name: any other value writes to stdout, and
  // stdout is the stream `silent` exists for — MCP stdio carries JSON-RPC there, where one stray
  // line of build chatter breaks the frame.
  it('suppresses pipeline logs on stdout and stderr alike when sink is silent', () => {
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const previous = getPipelineLogSink();
    setPipelineLogSink('silent');
    try {
      logPipeline('hidden');
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      setPipelineLogSink(previous);
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });
});
