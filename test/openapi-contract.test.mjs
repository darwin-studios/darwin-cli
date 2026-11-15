import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

async function contractBytes() {
  for (const candidate of [
    new URL('../openapi.json', import.meta.url),
    new URL('../../../../website/docs/openapi-v2.json', import.meta.url),
  ]) {
    try {
      return await readFile(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw Error('CLI contract fixture unavailable');
}

async function check(mutate = () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'darwin-cli-contract-'));
  try {
    const contract = JSON.parse((await contractBytes()).toString('utf8'));
    mutate(contract);
    const contractPath = path.join(directory, 'openapi.json');
    await writeFile(contractPath, JSON.stringify(contract));
    return spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-openapi.mjs', import.meta.url))], {
      env: { ...process.env, DARWIN_OPENAPI_PATH: contractPath },
      encoding: 'utf8',
      timeout: 5000,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a clean current monorepo locates the contract without retired layout paths or environment overrides', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'darwin-cli-layout-'));
  try {
    const scripts = path.join(root, 'apps/navigator/api/cli/scripts'),
      docs = path.join(root, 'apps/website/docs');
    await mkdir(scripts, { recursive: true });
    await mkdir(docs, { recursive: true });
    await copyFile(new URL('../scripts/check-openapi.mjs', import.meta.url), path.join(scripts, 'check-openapi.mjs'));
    await writeFile(path.join(docs, 'openapi-v2.json'), await contractBytes());
    const env = { ...process.env };
    delete env.DARWIN_OPENAPI_PATH;
    const result = spawnSync(process.execPath, [path.join(scripts, 'check-openapi.mjs')], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the real contract keeps owner discovery and download helpers separate from the seven CLI thread commands', async () => {
  const result = await check((contract) => {
    assert.equal(contract.paths['/act/processing-context'].get.operationId, 'get_owner_processing_context');
  });
  assert.equal(result.status, 0, result.stderr);
});

test('owner metadata identity cannot hide a new callable method or path', async () => {
  for (const change of ['method', 'path']) {
    const result = await check((contract) => {
      const metadata = contract.paths['/act/processing-context'].get;
      delete contract.paths['/act/processing-context'];
      contract.paths[change === 'path' ? '/act/unreviewed-context' : '/act/processing-context'] = {
        [change === 'method' ? 'post' : 'get']: metadata,
      };
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected exactly 8 callable Search\/Act operations, received 9/u);
  }
});

test('an unexpected callable Act operation still fails the exact CLI inventory', async () => {
  const result = await check((contract) => {
    contract.paths['/act/unreviewed'] = { post: { operationId: 'unreviewed_operation', responses: {} } };
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected exactly 8 callable Search\/Act operations, received 9/u);
});

test('a duplicated download helper does not evade unique operation identity checks', async () => {
  const result = await check((contract) => {
    contract.paths['/act/duplicate-download'] = {
      post: { operationId: 'get_result_artifact_download_url', responses: {} },
    };
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /all public operations must have unique operation IDs/u);
});
