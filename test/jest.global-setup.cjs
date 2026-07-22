const { runNpm } = require('../scripts/lib/spawn.cjs');

module.exports = async () => {
  const build = runNpm(['run', 'build'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (build.status !== 0) {
    throw new Error(`npm run build failed before Jest tests\nSTDOUT:\n${build.stdout}\nSTDERR:\n${build.stderr}`);
  }
};
