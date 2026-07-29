import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { helmValuesParser } from '../../packages/plugins/iac-helm/src/parsers/values.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const valuesDoc = {
  app: { image: { repository: 'example/app', tag: '1.0.0' } },
};

describe('helmValuesParser chart detection', () => {
  it('accepts a standard chart root identified by a sibling Chart.yaml', () => {
    const chartDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-chart-root-'));
    tempDirs.push(chartDir);
    fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: demo\n');

    expect(helmValuesParser.supports(path.join(chartDir, 'values.yaml'), valuesDoc)).toBe(true);
  });

  it('accepts charts/<name> and keeps the existing helm/<name> layouts', () => {
    expect(helmValuesParser.supports('/repo/charts/demo/values.yaml', valuesDoc)).toBe(true);
    expect(helmValuesParser.supports('/repo/helm/demo/values.yaml', valuesDoc)).toBe(true);
  });

  it('rejects an unrelated values.yaml without a chart marker', () => {
    expect(helmValuesParser.supports('/repo/config/values.yaml', valuesDoc)).toBe(false);
  });

  it('rejects a values doc whose own content is Chart.yaml metadata even with an image signal', () => {
    // Under a chart path AND carrying an image signal, so only the Chart.yaml-lookalike
    // guard can make this false: dropping the guard would let the image signal return true.
    const chartLookalike = {
      apiVersion: 'v2',
      name: 'demo',
      version: '1.0.0',
      app: { image: { repository: 'example/app', tag: '1.0.0' } },
    };
    expect(helmValuesParser.supports('/repo/charts/demo/values.yaml', chartLookalike)).toBe(false);
  });

  it('rejects a values doc under a chart with no image or secret signal', () => {
    const noSignal = { replicaCount: 3, service: { type: 'ClusterIP', port: 8080 } };
    expect(helmValuesParser.supports('/repo/charts/demo/values.yaml', noSignal)).toBe(false);
  });
});
