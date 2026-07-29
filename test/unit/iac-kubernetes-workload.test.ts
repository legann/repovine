import { enrichK8sResourceAttributes } from '../../packages/plugins/iac-kubernetes/src/k8s-workload.js';

describe('enrichK8sResourceAttributes workload extraction', () => {
  it('extracts container images and env image refs from Deployment', () => {
    const doc = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      spec: {
        template: {
          spec: {
            containers: [{
              name: 'operator',
              image: 'demo/operator:local',
              env: [{ name: 'WORKER_IMAGE', value: 'demo/worker:local' }],
            }],
          },
        },
      },
    };
    const attrs: Record<string, string> = { kind: 'Deployment' };
    enrichK8sResourceAttributes(doc, attrs);
    expect(attrs.containerImage0).toBe('demo/operator:local');
    expect(attrs.containerImages).toBe('demo/operator:local');
    expect(attrs.containerEnvImage_WORKER_IMAGE).toBe('demo/worker:local');
  });

  it('extracts container images from CronJob jobTemplate', () => {
    const doc = {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      spec: {
        schedule: '0 * * * *',
        jobTemplate: {
          spec: {
            template: {
              spec: {
                containers: [{ name: 'scheduler', image: 'demo/scheduler:local' }],
              },
            },
          },
        },
      },
    };
    const attrs: Record<string, string> = { kind: 'CronJob' };
    enrichK8sResourceAttributes(doc, attrs);
    expect(attrs.containerImage0).toBe('demo/scheduler:local');
    expect(attrs.containerImages).toBe('demo/scheduler:local');
  });

  it('extracts Kubernetes secret references from env, envFrom, and volumes', () => {
    const doc = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      spec: {
        template: {
          spec: {
            containers: [{
              name: 'operator',
              image: 'demo/operator:local',
              env: [
                {
                  name: 'API_TOKEN',
                  valueFrom: { secretKeyRef: { name: 'operator-secrets', key: 'api-token' } },
                },
              ],
              envFrom: [
                { secretRef: { name: 'operator-env' } },
              ],
            }],
            volumes: [
              { name: 'certs', secret: { secretName: 'operator-certs' } },
            ],
          },
        },
      },
    };
    const attrs: Record<string, string> = { kind: 'Deployment' };
    const envRefs = enrichK8sResourceAttributes(doc, attrs);
    expect(envRefs).toEqual(expect.arrayContaining([
      { varName: 'API_TOKEN', refType: 'literal', targetLogicalId: 'operator-secrets' },
      { varName: 'envFrom:operator-env', refType: 'literal', targetLogicalId: 'operator-env' },
      { varName: 'volume:certs', refType: 'literal', targetLogicalId: 'operator-certs' },
    ]));
  });

  it('extracts Kubernetes ConfigMap references from env configMapKeyRef and envFrom configMapRef', () => {
    const doc = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      spec: {
        template: {
          spec: {
            containers: [{
              name: 'operator',
              image: 'demo/operator:local',
              env: [
                {
                  name: 'LOG_LEVEL',
                  valueFrom: { configMapKeyRef: { name: 'operator-config', key: 'log-level' } },
                },
              ],
              envFrom: [
                { configMapRef: { name: 'operator-defaults' } },
              ],
            }],
          },
        },
      },
    };
    const attrs: Record<string, string> = { kind: 'Deployment' };
    const envRefs = enrichK8sResourceAttributes(doc, attrs);
    expect(envRefs).toEqual(expect.arrayContaining([
      { varName: 'LOG_LEVEL', refType: 'literal', targetLogicalId: 'operator-config' },
      { varName: 'envFrom:operator-defaults', refType: 'literal', targetLogicalId: 'operator-defaults' },
    ]));
  });

  it('extracts probes and merges initContainer image/name facts', () => {
    const doc = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      spec: {
        template: {
          spec: {
            containers: [{
              name: 'operator',
              image: 'demo/operator:local',
              livenessProbe: { httpGet: { path: '/healthz', port: 8080 } },
              readinessProbe: { httpGet: { path: '/ready', port: 8080 } },
            }],
            initContainers: [{
              name: 'migrate',
              image: 'demo/migrate:local',
            }],
          },
        },
      },
    };
    const attrs: Record<string, string> = { kind: 'Deployment' };
    enrichK8sResourceAttributes(doc, attrs);
    // Probe extraction (appendProbes), indexed by container position.
    expect(attrs.livenessProbe0Path).toBe('/healthz');
    expect(attrs.livenessProbe0Port).toBe('8080');
    expect(attrs.readinessProbe0Path).toBe('/ready');
    expect(attrs.readinessProbe0Port).toBe('8080');
    // initContainers merge onto the container list after the primary containers.
    expect(attrs.containerName1).toBe('migrate');
    expect(attrs.containerImage1).toBe('demo/migrate:local');
    expect(attrs.containerImages).toBe('demo/operator:local,demo/migrate:local');
  });

  it('extracts ingress backend service names', () => {
    const doc = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      spec: {
        rules: [{
          host: 'demo.local',
          http: {
            paths: [{
              path: '/',
              pathType: 'Prefix',
              backend: { service: { name: 'demo-worker', port: { number: 8080 } } },
            }],
          },
        }],
      },
    };
    const attrs: Record<string, string> = { kind: 'Ingress' };
    enrichK8sResourceAttributes(doc, attrs);
    expect(attrs.ingressBackend0).toBe('demo-worker');
    expect(attrs.ingressBackends).toBe('demo-worker');
  });
});
