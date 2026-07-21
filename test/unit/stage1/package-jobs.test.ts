import { buildPackageJobs } from '../../../src/stage1/index.js';
import { packageJobKey } from '../../../src/stage1/utils.js';
import type { PackageInfo, PendingModule } from '../../../src/types.js';

function pkg(name: string, path: string, sourcePluginId: string): PackageInfo {
  return { name, path, sourcePluginId };
}

function pending(
  filePath: string,
  moduleId: string,
  packageInfo: PackageInfo,
  sourcePluginId: string,
): PendingModule {
  return {
    filePath,
    relPath: filePath,
    moduleId,
    pkg: packageInfo,
    sourcePluginId,
  };
}

describe('buildPackageJobs — polyglot package collision', () => {
  it('schedules separate jobs for same name+path across source plugins', () => {
    const tsPkg = pkg('myapp', '.', 'typescript');
    const pyPkg = pkg('myapp', '.', 'python');
    const packages = [tsPkg, pyPkg];
    const pendingModules = [
      pending('/repo/static/app/index.tsx', 'mod:myapp/static/app/index', tsPkg, 'typescript'),
      pending('/repo/src/myapp/urls.py', 'mod:myapp/src/myapp/urls', pyPkg, 'python'),
    ];

    const { jobs } = buildPackageJobs(packages, pendingModules, new Map(), 800);

    expect(jobs).toHaveLength(2);
    const byPlugin = new Map(jobs.map(j => [j.sourcePluginId, j]));
    expect(byPlugin.get('typescript')?.pendingModules.map(m => m.moduleId)).toEqual([
      'mod:myapp/static/app/index',
    ]);
    expect(byPlugin.get('python')?.pendingModules.map(m => m.moduleId)).toEqual([
      'mod:myapp/src/myapp/urls',
    ]);
  });

  it('deduplicates duplicate package entries with the same job key', () => {
    const tsPkg = pkg('myapp', '.', 'typescript');
    const packages = [tsPkg, { ...tsPkg }];
    const pendingModules = [
      pending('/repo/static/app/index.tsx', 'mod:myapp/static/app/index', tsPkg, 'typescript'),
    ];

    const { jobs } = buildPackageJobs(packages, pendingModules, new Map(), 800);
    expect(jobs).toHaveLength(1);
  });

  it('keeps distinct paths with the same package name as separate jobs', () => {
    const tsA = pkg('shared', 'packages/a', 'typescript');
    const pyB = pkg('shared', 'packages/b', 'python');
    const packages = [tsA, pyB];
    const pendingModules = [
      pending('/repo/packages/a/src/index.ts', 'mod:shared/src/index', tsA, 'typescript'),
      pending('/repo/packages/b/app.py', 'mod:shared/app', pyB, 'python'),
    ];

    const { jobs } = buildPackageJobs(packages, pendingModules, new Map(), 800);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map(j => packageJobKey(j.pkg)))).toEqual(
      new Set([packageJobKey(tsA), packageJobKey(pyB)]),
    );
  });
});
