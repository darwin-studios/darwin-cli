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
  assert.match(result.stdout, /darwin agent message/);
  assert.match(result.stdout, /darwin agents <list\|get\|create\|update\|activity>/);
  assert.match(result.stdout, /darwin applications/);
  assert.match(
    result.stdout,
    /darwin sessions <create\|list\|get\|send\|participants\|watch\|mesh\|replan\|outcome\|complete\|cancel>/,
  );
  assert.match(result.stdout, /darwin tools execute/);
  assert.match(result.stdout, /DARWIN_API_KEY/);
});

test('prints its package version', () => {
  const result = spawnSync(process.execPath, ['dist/index.js', '--version'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0.2.0');
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

test('updates an agent profile with typed flags and structured data', async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'PATCH');
    assert.equal(request.url, '/agents/agent%2F123');

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
        'agents',
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
    ['sessions', 'list', '--agent', 'agent/1', '--status', 'pending_provider', '--limit', '4', '--cursor', 'next'],
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
        targetAgentIds: ['agent/2'],
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
        targetAgentIds: ['agent/3'],
        dataPolicy: {
          contentMode: 'sealed',
          learningMode: 'outcomes_only',
          keyManagement: 'tenant_managed',
        },
      },
    },
    {
      method: 'GET',
      url: '/sessions?agentId=agent%2F1&status=pending_provider&limit=4&cursor=next',
      idempotencyKey: undefined,
      body: undefined,
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
      body: { limit: 12, excludeAgentIds: ['agent/9'] },
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
