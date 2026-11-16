import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-owned packaging transform. Do not hand-edit the copied SDK output.
// Navigator has its own distribution and Python namespace; released Darwin
// packages are neither dependencies nor overwritten by this build.
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const standalone = await readFile(join(scriptDirectory, 'package.json'), 'utf8')
  .then(JSON.parse)
  .catch(
    async () =>
      await readFile(join(scriptDirectory, 'pyproject.toml'), 'utf8')
        .then(() => ({ name: 'darwin-navigator' }))
        .catch(() => undefined),
  );
const base = standalone ? resolve(scriptDirectory, '..') : resolve(scriptDirectory, '../apps/navigator/api');
const kinds = standalone
  ? [
      standalone.name === '@darwinso/navigator'
        ? 'sdk'
        : standalone.name === '@darwinso/navigator-cli'
          ? 'cli'
          : 'python',
    ]
  : ['sdk', 'cli', 'python'];
if (!standalone) {
  const result = spawnSync('pnpm', ['--filter', '@darwinso/cli', 'build'], {
    cwd: resolve(scriptDirectory, '..'),
    stdio: 'inherit',
  });
  if (result.status !== 0) throw Error('Build the checked CLI before packaging Navigator.');
}
for (const kind of kinds) {
  const source = standalone ? base : join(base, kind === 'python' ? 'python-sdk' : kind);
  const target = standalone ? scriptDirectory : join(base, `navigator-${kind === 'python' ? 'python' : kind}`);
  if (kind === 'python') {
    const project = await readFile(join(target, 'pyproject.toml'), 'utf8');
    const sourceProject = await readFile(join(source, 'pyproject.toml'), 'utf8');
    if (project.match(/^version = "([^"]+)"/m)?.[1] !== sourceProject.match(/^version = "([^"]+)"/m)?.[1])
      throw Error('Python versions must match.');
    const output = join(target, 'generated');
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    await cp(join(source, 'src/darwin_sdk'), join(output, 'darwin_navigator'), {
      recursive: true,
      filter: (path) => !path.includes('__pycache__'),
    });
    async function rewrite(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await rewrite(path);
        else if (entry.name.endsWith('.py'))
          await writeFile(path, (await readFile(path, 'utf8')).replace(/\bdarwin_sdk\b/g, 'darwin_navigator'));
      }
    }
    await rewrite(join(output, 'darwin_navigator'));
    const init = join(output, 'darwin_navigator/__init__.py');
    await writeFile(
      init,
      `${await readFile(init, 'utf8')}\nfrom .client import Darwin as Navigator, AsyncDarwin as AsyncNavigator\n__all__.extend(["Navigator", "AsyncNavigator"])\n`,
    );
    await writeFile(join(output, 'darwin_navigator/openai.py'), 'from .act_openai import *\n');
  } else {
    const sourcePackage = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const targetPackage = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    if (sourcePackage.version !== targetPackage.version) throw Error(`${kind} versions must match.`);
    const directory = kind === 'sdk' ? 'generated' : 'dist';
    await rm(join(target, directory), { recursive: true, force: true });
    await cp(join(source, directory), join(target, directory), { recursive: true });
    if (kind === 'sdk') await writeFile(join(target, 'generated/cjs/package.json'), '{"type":"commonjs"}\n');
  }
}
console.log('Built independent Navigator packages; existing Darwin distributions are unchanged.');
