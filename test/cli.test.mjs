import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function runCli(args, baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/index.js', ...args], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        DARWIN_API_KEY: 'test-key',
        DARWIN_API_URL: baseUrl,
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
}

test('prints concise help', () => {
  const result = spawnSync(process.execPath, ['dist/index.js', '--help'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /darwin ais <list\|get\|create\|update\|activity>/);
  assert.match(result.stdout, /darwin ais skills/);
  assert.match(result.stdout, /darwin ais integrations/);
  assert.match(result.stdout, /darwin requests <list\|action>/);
  assert.match(result.stdout, /darwin conversations <send\|list\|create\|get\|message>/);
  assert.match(result.stdout, /darwin goals <list\|get\|create\|update\|action\|publish>/);
  assert.doesNotMatch(result.stdout, /darwin tasks/);
  assert.match(result.stdout, /darwin deals <list\|get\|create\|update\|action\|payments>/);
  assert.match(result.stdout, /darwin transactions <list\|get\|action>/);
  assert.match(result.stdout, /darwin outcomes <list\|get\|evidence>/);
  assert.match(result.stdout, /darwin supply businesses/);
  assert.match(result.stdout, /darwin host capabilities/);
  assert.match(result.stdout, /darwin applications <list\|get\|create/);
  assert.doesNotMatch(result.stdout, /darwin connect/);
  assert.doesNotMatch(result.stdout, /darwin sessions/);
  assert.doesNotMatch(result.stdout, /darwin directory/);
  assert.doesNotMatch(result.stdout, /darwin tools/);
  assert.doesNotMatch(result.stdout, /approvals/);
  assert.match(result.stdout, /DARWIN_API_KEY/);
});

test('prints its package version', () => {
  const result = spawnSync(process.execPath, ['dist/index.js', '--version'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0.5.0');
});

test('routes Supply capability commands through the v2 Host API', async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/host/ais/business%2F123/capabilities?limit=5');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ capabilities: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await runCli(
    ['supply', 'listings', 'list', 'business/123', '--limit', '5'],
    `http://127.0.0.1:${address.port}`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { capabilities: [] });
});

test('exposes capability terminology from the v2 Host API', async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/host/ais/business%2F123/capabilities?limit=5');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ capabilities: [{ id: 'cap_1' }], cursor: 'next' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await runCli(
    ['host', 'capabilities', 'list', 'business/123', '--limit', '5'],
    `http://127.0.0.1:${address.port}`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { capabilities: [{ id: 'cap_1' }], cursor: 'next' });
});

test('routes direct API calls to v2 and rejects paths outside Search, Act, Host, and Account', async (t) => {
  const paths = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ais: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const valid = await runCli(['api', 'GET', '/host/ais'], baseUrl);
  const invalid = await runCli(['api', 'GET', '/sessions'], baseUrl);
  const traversal = await runCli(['api', 'GET', '/host/../../v1/sessions'], baseUrl);
  assert.equal(valid.status, 0, valid.stderr);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /v2 API path under/);
  assert.notEqual(traversal.status, 0);
  assert.match(traversal.stderr, /stay within the v2 endpoint/);
  assert.deepEqual(paths, ['/api/v2/host/ais']);
});

test('routes application administration through v2 Account', async (t) => {
  const paths = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ applications: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const result = await runCli(['applications', 'list'], baseUrl);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(paths, ['/account/applications']);
});

test('routes directory discovery and AI lookup through v2 Search', async (t) => {
  const paths = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url.includes('?')
      ? { ais: [{ id: 'ai/1', capabilities: [] }] }
      : { ai: { id: 'ai/1', capabilities: [] } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const list = await runCli(['directory', 'search', 'plumber', '--limit', '5'], baseUrl);
  const get = await runCli(['directory', 'get', 'ai/1'], baseUrl);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(get.status, 0, get.stderr);
  assert.deepEqual(JSON.parse(list.stdout), { ais: [{ id: 'ai/1', capabilities: [] }] });
  assert.deepEqual(JSON.parse(get.stdout), { ai: { id: 'ai/1', capabilities: [] } });
  assert.deepEqual(paths, [
    '/api/v2/search/directory/ais?query=plumber&limit=5',
    '/api/v2/search/directory/ais/ai%2F1',
  ]);
});

test('selects the v2 API base for migrated commands while leaving legacy commands on v1', async (t) => {
  const paths = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ais: [], applications: [], requests: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  for (const args of [['supply', 'businesses', 'list'], ['applications', 'list'], ['requests', 'list'], ['sessions', 'list']]) {
    const result = await runCli(args, baseUrl);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(paths, ['/api/v2/host/ais', '/api/v2/account/applications', '/api/v2/act/requests', '/api/v1/sessions']);
});

test('sends v2 Act decisions to explicit routes with valid bodies and idempotency keys', async (t) => {
  const calls = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8').on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      calls.push({
        method: request.method,
        path: request.url,
        key: request.headers['idempotency-key'],
        body: raw ? JSON.parse(raw) : undefined,
      });
      response.setHeader('Content-Type', 'application/json');
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  for (const args of [
    ['requests', 'action', 'req/1', 'accept', '--ai', 'ai/1', '--idempotency-key', 'accept-1'],
    ['transactions', 'action', 'txn/1', 'request_refund', '--ai', 'ai/1', '--amount-minor', '500', '--idempotency-key', 'refund-1'],
    ['deals', 'create', '--direction', 'DEMAND', '--title', 'Repair sink'],
  ]) {
    const result = await runCli(args, baseUrl);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(calls, [
    { method: 'POST', path: '/api/v2/act/requests/req%2F1/accept', key: 'accept-1', body: { aiId: 'ai/1' } },
    { method: 'POST', path: '/api/v2/act/transactions/txn%2F1/refunds', key: 'refund-1', body: { aiId: 'ai/1', amountMinor: 500 } },
    { method: 'POST', path: '/api/v2/act/deals', key: undefined, body: { mode: 'BUY', title: 'Repair sink' } },
  ]);
});

test('uses typed v2 Act goal routes and translates legacy goal options', async (t) => {
  const calls = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8').on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      calls.push({ method: request.method, path: request.url,
        body: raw ? JSON.parse(raw) : undefined, key: request.headers['idempotency-key'] });
      response.setHeader('Content-Type', 'application/json');
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  for (const args of [
    ['goals', 'create', '--intent', 'Find a plumber', '--type', 'DEMAND', '--data', '{"listingIds":["cap/1"]}'],
    ['goals', 'update', 'goal/1', '--type', 'SUPPLY'],
    ['goals', 'action', 'goal/1', 'pause', '--paused-until', '2026-10-01T00:00:00Z'],
    ['goals', 'publish', 'goal/1', '--idempotency-key', 'publish-1'],
  ]) {
    const result = await runCli(args, baseUrl);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(calls, [
    { method: 'POST', path: '/api/v2/act/goals', body: {
      intent: 'Find a plumber', mode: 'BUY', operationIds: ['cap/1'],
    }, key: undefined },
    { method: 'PATCH', path: '/api/v2/act/goals/goal%2F1', body: { mode: 'SELL' }, key: undefined },
    { method: 'POST', path: '/api/v2/act/goals/goal%2F1/pause',
      body: { pausedUntil: '2026-10-01T00:00:00Z' }, key: undefined },
    { method: 'POST', path: '/api/v2/act/goals/goal%2F1/publication-requests', body: {}, key: 'publish-1' },
  ]);
});

test('manages application usage and webhooks through Account without legacy identity shortcuts', async (t) => {
  const calls = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8').on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      calls.push({ path: request.url, body: raw ? JSON.parse(raw) : undefined });
      response.setHeader('Content-Type', 'application/json');
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const usage = await runCli(['applications', 'usage', 'app/1', '--days', '30'], baseUrl);
  assert.equal(usage.status, 0, usage.stderr);
  const webhook = await runCli(
    ['applications', 'webhooks', 'create', 'app/1', '--url', 'https://example.com/hooks', '--data', '{"events":["goal.created"]}'],
    baseUrl,
  );
  assert.equal(webhook.status, 0, webhook.stderr);
  const retired = await runCli(['connect', 'applications', 'list'], baseUrl);
  assert.equal(retired.status, 1);
  assert.match(retired.stderr, /Unknown command/);
  assert.deepEqual(calls, [
    { path: '/api/v2/account/applications/app%2F1/usage?days=30', body: undefined },
    { path: '/api/v2/account/applications/app%2F1/webhooks', body: { events: ['goal.created'], url: 'https://example.com/hooks' } },
  ]);
});

test('keeps the legacy offers CLI shape while using typed v2 Act deals', async (t) => {
  const calls = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8').on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      calls.push({ path: request.url, method: request.method, body: raw ? JSON.parse(raw) : undefined });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.method === 'GET' ? { deals: [{ id: 'deal-1' }] } : { deal: { id: 'deal-1' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const list = await runCli(['offers', 'list', '--ai', 'ai-1'], baseUrl);
  const create = await runCli(['offers', 'create', '--ai', 'ai-1', '--direction', 'SUPPLY', '--title', 'Repair',
    '--data', '{"listingSelections":[{"listingId":"cap-1","quantity":2}]}'], baseUrl);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(create.status, 0, create.stderr);
  assert.deepEqual(JSON.parse(list.stdout), { offers: [{ id: 'deal-1' }] });
  assert.deepEqual(JSON.parse(create.stdout), { offer: { id: 'deal-1' } });
  assert.deepEqual(calls, [
    { path: '/api/v2/act/deals?aiId=ai-1', method: 'GET', body: undefined },
    { path: '/api/v2/act/deals', method: 'POST', body: {
      title: 'Repair', mode: 'SELL', aiId: 'ai-1', capabilitySelections: [{ operationId: 'cap-1', quantity: 2 }],
    } },
  ]);
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
    assert.equal(request.url, '/act/ai/conversation?limit=7&cursor=next-page');
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
    assert.equal(request.url, '/act/goals/goal%2F123');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ goal: { id: 'goal/123', status: 'ACTIVE' } }));
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
  assert.deepEqual(JSON.parse(result.stdout), { goal: { id: 'goal/123', status: 'ACTIVE' } });
});

test('keeps the task command as an undocumented compatibility alias', async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/act/goals/task%2F123');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ goal: { id: 'task/123', status: 'ACTIVE' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await runCli(['tasks', 'get', 'task/123'], `http://127.0.0.1:${address.port}`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { task: { id: 'task/123', taskId: 'task/123', status: 'ACTIVE' } });
});

test('updates an AI profile with typed flags and structured data', async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'PATCH');
    assert.equal(request.url, '/host/ais/agent%2F123');

    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      assert.deepEqual(JSON.parse(body), {
        links: [{ label: 'Website', url: 'https://darwin.so' }],
        description: 'Agent profile',
        visibility: 'PUBLIC',
      });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ agent: { id: 'agent/123', visibility: 'PUBLIC' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        'dist/index.js',
        'ais',
        'update',
        'agent/123',
        '--description',
        'Agent profile',
        '--visibility',
        'public',
        '--data',
        '{"links":[{"label":"Website","url":"https://darwin.so"}]}',
      ],
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
    agent: { id: 'agent/123', visibility: 'PUBLIC' },
  });
});

test('executes a reviewed Darwin tool with JSON input', async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/act/tools/create_goal/executions');
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

test('rejects privacy-incompatible Session creation before sending a request', async () => {
  const sealedWithPlaintext = await runCli(
    ['sessions', 'create', '--kind', 'discovery', '--intent', 'Private acquisition strategy'],
    'http://127.0.0.1:1',
  );
  assert.equal(sealedWithPlaintext.status, 1);
  assert.match(sealedWithPlaintext.stderr, /Sealed sessions cannot include plaintext intent/);

  const managedDescriptorWithoutIntent = await runCli(
    [
      'sessions',
      'create',
      '--kind',
      'discovery',
      '--content-mode',
      'managed',
      '--discovery-descriptor',
      '{"requiredCapabilities":["security-review"]}',
    ],
    'http://127.0.0.1:1',
  );
  assert.equal(managedDescriptorWithoutIntent.status, 1);
  assert.match(managedDescriptorWithoutIntent.stderr, /require a structured intent/);
});

test('drives the session lifecycle with public IDs and idempotency keys', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'darwin-cli-session-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const protectedContentPath = join(fixtureRoot, 'protected-content.json');
  await writeFile(
    protectedContentPath,
    JSON.stringify({
      mediaType: 'text/plain',
      ciphertext: 'c2VhbGVk',
      digest: {
        algorithm: 'sha-256',
        value: 'adc18e17717d2bda88b17f021a760e97e9f431f3051965d312ebf673b9ff73a8',
      },
      encryption: {
        algorithm: 'external',
        keyEnvelopes: [],
      },
    }),
  );

  const received = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      received.push({
        method: request.method,
        url: request.url,
        idempotencyKey: request.headers['idempotency-key'],
        body: body ? JSON.parse(body) : undefined,
      });
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify(
          request.method === 'GET' && request.url === '/sessions/session%2F1'
            ? {
                session: {
                  participants: [{ id: 'participant/1', agentId: 'agent/1', role: 'requester' }],
                },
              }
            : { ok: true },
        ),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const commands = [
    [
      'sessions',
      'create',
      '--kind',
      'direct',
      '--target',
      'agent/2',
      '--intent',
      'Coordinate a launch',
      '--content-mode',
      'managed',
      '--learning-mode',
      'outcomes_only',
      '--key-management',
      'darwin_managed',
      '--idempotency-key',
      'create-session-key',
    ],
    [
      'sessions',
      'create',
      '--kind',
      'direct',
      '--target',
      'agent/3',
      '--content-mode',
      'sealed',
      '--learning-mode',
      'outcomes_only',
      '--key-management',
      'tenant_managed',
      '--idempotency-key',
      'create-sealed-session-key',
    ],
    ['sessions', 'list', '--ai', 'agent/1', '--status', 'pending_provider', '--limit', '4', '--cursor', 'next'],
    ['sessions', 'invitations', '--ai', 'agent/1', '--limit', '3'],
    [
      'sessions',
      'invitation',
      'invitation/1',
      'accept',
      '--ai',
      'agent/1',
      '--idempotency-key',
      'accept-invitation-key',
    ],
    [
      'sessions',
      'invitation',
      'invitation/2',
      'decline',
      '--ai',
      'agent/1',
      '--idempotency-key',
      'decline-invitation-key',
    ],
    ['sessions', 'participants', 'session/1'],
    [
      'sessions',
      'send',
      'session/1',
      'Can',
      'you',
      'help?',
      '--kind',
      'question',
      '--context-scope',
      'scope/1',
      '--idempotency-key',
      'send-message-key',
    ],
    [
      'sessions',
      'send',
      'session/2',
      '--kind',
      'message',
      '--protected-content-file',
      protectedContentPath,
      '--idempotency-key',
      'send-sealed-key',
    ],
    ['sessions', 'watch', 'session/1', '--limit', '5', '--cursor', 'after', '--context-scope', 'scope/1'],
    ['sessions', 'mesh', 'session/1'],
    [
      'sessions',
      'replan',
      'session/1',
      '--limit',
      '12',
      '--exclude-agent',
      'agent/9',
      '--idempotency-key',
      'replan-key',
    ],
    [
      'sessions',
      'outcome',
      'session/1',
      '--completion-state',
      'completed',
      '--success',
      'true',
      '--confidence',
      '0.9',
      '--scores',
      '{"quality":0.95}',
      '--evidence-digest',
      'adc18e17717d2bda88b17f021a760e97e9f431f3051965d312ebf673b9ff73a8',
      '--idempotency-key',
      'outcome-key',
    ],
    [
      'sessions',
      'feedback',
      'session/1',
      'Excellent',
      'coordination',
      '--rating',
      '5',
      '--outcome',
      'outcome/1',
      '--idempotency-key',
      'feedback-key',
    ],
    ['sessions', 'complete', 'session/1', '--idempotency-key', 'complete-key'],
    ['sessions', 'cancel', 'session/2', '--idempotency-key', 'cancel-key'],
  ];

  for (const command of commands) {
    const result = await runCli(command, baseUrl);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      command[1] === 'participants'
        ? {
            participants: [{ id: 'participant/1', agentId: 'agent/1', role: 'requester' }],
          }
        : { ok: true },
    );
  }

  assert.deepEqual(received, [
    {
      method: 'POST',
      url: '/sessions',
      idempotencyKey: 'create-session-key',
      body: {
        kind: 'direct',
        intent: {
          title: 'Coordinate a launch',
          description: 'Coordinate a launch',
        },
        targetAIIds: ['agent/2'],
        dataPolicy: {
          contentMode: 'managed',
          learningMode: 'outcomes_only',
          keyManagement: 'darwin_managed',
        },
      },
    },
    {
      method: 'POST',
      url: '/sessions',
      idempotencyKey: 'create-sealed-session-key',
      body: {
        kind: 'direct',
        targetAIIds: ['agent/3'],
        dataPolicy: {
          contentMode: 'sealed',
          learningMode: 'outcomes_only',
          keyManagement: 'tenant_managed',
        },
      },
    },
    {
      method: 'GET',
      url: '/sessions?aiId=agent%2F1&status=pending_provider&limit=4&cursor=next',
      idempotencyKey: undefined,
      body: undefined,
    },
    {
      method: 'GET',
      url: '/session-invitations?aiId=agent%2F1&limit=3',
      idempotencyKey: undefined,
      body: undefined,
    },
    {
      method: 'POST',
      url: '/session-invitations/invitation%2F1/actions',
      idempotencyKey: 'accept-invitation-key',
      body: { action: 'accept', aiId: 'agent/1' },
    },
    {
      method: 'POST',
      url: '/session-invitations/invitation%2F2/actions',
      idempotencyKey: 'decline-invitation-key',
      body: { action: 'decline', aiId: 'agent/1' },
    },
    {
      method: 'GET',
      url: '/sessions/session%2F1',
      idempotencyKey: undefined,
      body: undefined,
    },
    {
      method: 'POST',
      url: '/sessions/session%2F1/interactions',
      idempotencyKey: 'send-message-key',
      body: {
        kind: 'question',
        content: 'Can you help?',
        contextScopeId: 'scope/1',
      },
    },
    {
      method: 'POST',
      url: '/sessions/session%2F2/interactions',
      idempotencyKey: 'send-sealed-key',
      body: {
        kind: 'message',
        protectedContent: {
          mediaType: 'text/plain',
          ciphertext: 'c2VhbGVk',
          digest: {
            algorithm: 'sha-256',
            value: 'adc18e17717d2bda88b17f021a760e97e9f431f3051965d312ebf673b9ff73a8',
          },
          encryption: {
            algorithm: 'external',
            keyEnvelopes: [],
          },
        },
      },
    },
    {
      method: 'GET',
      url: '/sessions/session%2F1/interactions?limit=5&cursor=after&contextScopeId=scope%2F1',
      idempotencyKey: undefined,
      body: undefined,
    },
    {
      method: 'GET',
      url: '/sessions/session%2F1/mesh',
      idempotencyKey: undefined,
      body: undefined,
    },
    {
      method: 'POST',
      url: '/sessions/session%2F1/resolutions',
      idempotencyKey: 'replan-key',
      body: { limit: 12, excludeAIIds: ['agent/9'] },
    },
    {
      method: 'POST',
      url: '/sessions/session%2F1/outcomes',
      idempotencyKey: 'outcome-key',
      body: {
        completionState: 'completed',
        success: true,
        confidence: 0.9,
        scores: { quality: 0.95 },
        evidenceDigests: ['adc18e17717d2bda88b17f021a760e97e9f431f3051965d312ebf673b9ff73a8'],
      },
    },
    {
      method: 'POST',
      url: '/sessions/session%2F1/feedback',
      idempotencyKey: 'feedback-key',
      body: {
        outcomeId: 'outcome/1',
        content: 'Excellent coordination',
        rating: 5,
      },
    },
    {
      method: 'POST',
      url: '/sessions/session%2F1/actions',
      idempotencyKey: 'complete-key',
      body: { action: 'COMPLETE' },
    },
    {
      method: 'POST',
      url: '/sessions/session%2F2/actions',
      idempotencyKey: 'cancel-key',
      body: { action: 'CANCEL' },
    },
  ]);
});

test('product commands route exact JSON once to v3 and preserve failures without retrying', async () => {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ path: request.url, body: JSON.parse(body), auth: request.headers.authorization, key:request.headers['idempotency-key'] });
    response.writeHead(request.url === '/api/v3/manage' ? 429 : 200, {
      'Content-Type': 'application/json',
      'Retry-After': '7',
    });
    response.end(JSON.stringify(request.url === '/api/v3/manage' ? { code: 'RATE_LIMITED' } : { accepted: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v2`;
  try {
    for (const command of ['live-search', 'run', 'build', 'manage']) {
      const body =
        command === 'run'
          ? {
              type: 'turn',
              clientMessageId: 'same-id',
              message: 'Review',
              targets: [{ agentId: 'a' }, { agentId: 'b' }],
            }
          : { action: 'list_agents' };
      const key = command === 'live-search' ? undefined : 'same-key';
      const result = await runCli([command, '--data', JSON.stringify(body), ...(key ? ['--idempotency-key',key] : [])], base);
      assert.equal(result.status, command === 'manage' ? 1 : 0, result.stderr);
      assert.deepEqual(calls.at(-1), { path: `/api/v3/${command}`, body, auth: 'Bearer test-key', key });
    }
    assert.equal(calls.length, 4, 'no automatic retries');
    for (const args of [['run'], ['build', '--data', '{}'], ['build', '--data', '[]'], ['manage', '--data', '{}', '--approve']]) {
      assert.notEqual((await runCli(args, base)).status, 0);
    }
    assert.equal(calls.length, 4, 'invalid invocations must not dispatch');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
