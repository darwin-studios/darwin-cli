import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('prints concise help', () => {
  const result = spawnSync(process.execPath, ['dist/index.js', '--help'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /darwin agent message/);
  assert.match(result.stdout, /darwin tools execute/);
  assert.match(result.stdout, /DARWIN_API_KEY/);
});

test('prints its package version', () => {
  const result = spawnSync(process.execPath, ['dist/index.js', '--version'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0.1.0');
});

test('stores configuration in the XDG config directory with redacted output', async (t) => {
  const configRoot = await mkdtemp(join(tmpdir(), 'darwin-cli-config-'));
  t.after(() => rm(configRoot, { recursive: true, force: true }));

  const environment = {
    ...process.env,
    DARWIN_API_KEY: '',
    DARWIN_API_URL: '',
    XDG_CONFIG_HOME: configRoot,
  };
  const configureResult = spawnSync(
    process.execPath,
    ['dist/index.js', 'configure', '--api-key', 'darwin_test_1234567890', '--base-url', 'https://example.test/api/v1/'],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: environment,
    },
  );
  assert.equal(configureResult.status, 0, configureResult.stderr);

  const stored = JSON.parse(await readFile(join(configRoot, 'darwin', 'config.json'), 'utf8'));
  assert.deepEqual(stored, {
    apiKey: 'darwin_test_1234567890',
    baseUrl: 'https://example.test/api/v1',
  });

  const showResult = spawnSync(process.execPath, ['dist/index.js', 'config', 'show'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(showResult.status, 0, showResult.stderr);
  assert.doesNotMatch(showResult.stdout, /darwin_test_1234567890/);
  assert.match(showResult.stdout, /darwin_\.\.\.7890/);
});

test('accepts conversation options without changing command dispatch', async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/agent/conversation?limit=7&cursor=next-page');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ messages: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/index.js', 'conversation', '--limit', '7', '--cursor', 'next-page'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        DARWIN_API_KEY: 'test-key',
        DARWIN_API_URL: `http://127.0.0.1:${address.port}`,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { messages: [] });
});

test('gets a goal by ID', async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/goals/goal%2F123');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'goal/123', status: 'ACTIVE' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/index.js', 'goals', 'get', 'goal/123'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        DARWIN_API_KEY: 'test-key',
        DARWIN_API_URL: `http://127.0.0.1:${address.port}`,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    id: 'goal/123',
    status: 'ACTIVE',
  });
});

test('executes a reviewed Darwin tool with JSON input', async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/tools/create_goal/executions');
    assert.equal(request.headers.authorization, 'Bearer test-key');

    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      assert.deepEqual(JSON.parse(body), {
        input: { intent: 'Plan the launch', kind: 'PRIVATE' },
      });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ tool: 'create_goal', result: { status: 'ready' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['dist/index.js', 'tools', 'execute', 'create_goal', '--input', '{"intent":"Plan the launch","kind":"PRIVATE"}'],
      {
        cwd: new URL('..', import.meta.url),
        env: {
          ...process.env,
          DARWIN_API_KEY: 'test-key',
          DARWIN_API_URL: `http://127.0.0.1:${address.port}`,
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    tool: 'create_goal',
    result: { status: 'ready' },
  });
});
