import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { actRequest, actRoutes } from '../dist/act.js';

async function fixture(run, respond = () => ({ body: { accepted: true } })) {
  const root = await mkdtemp(join(tmpdir(), 'darwin-cli-thread-'));
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks).toString();
    const call = {
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: bytes ? JSON.parse(bytes) : undefined,
    };
    calls.push(call);
    const reply = respond(call, calls.length);
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const cli = (args, authenticated = true) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['dist/index.js', ...args], {
        cwd: new URL('..', import.meta.url),
        env: {
          ...process.env,
          XDG_CONFIG_HOME: root,
          DARWIN_API_KEY: authenticated ? 'fixture-key' : '',
          DARWIN_API_URL: `http://127.0.0.1:${server.address().port}/api/v2`,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stdout, stderr }));
    });
  try {
    await run(cli, calls);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

const act = (command, data) => [
  'act',
  command,
  ...(['authenticate', 'pay'].includes(command) ? [] : ['--ai', 'acting-1']),
  '--data',
  JSON.stringify(data),
];

test('all seven CLI routes match the generated API contract', async () => {
  const contract = JSON.parse(
    await readFile(new URL('../../../../../scripts/sdk/fern/openapi-sdk.json', import.meta.url)).catch(() =>
      readFile(new URL('../openapi-sdk.json', import.meta.url)),
    ),
  );
  assert.equal(Object.keys(actRoutes).length, 7);
  for (const [method, path, operation] of Object.values(actRoutes)) {
    assert.equal(contract.paths[`/v2${path}`][method.toLowerCase()].operationId, operation);
  }
});

test('unsigned Search works but thread commands require credentials', async () => {
  await fixture(async (cli, calls) => {
    const search = await cli(['search', 'event venue with outdoor space'], false);
    assert.equal(search.status, 0, search.stderr);
    assert.equal(calls[0].headers.authorization, undefined);
    assert.equal(calls[0].path, '/api/v2/search');
    assert.deepEqual(calls[0].body, { query: 'event venue with outdoor space' });
    const denied = await cli(act('list-threads', {}), false);
    assert.equal(denied.status, 1);
    assert.equal(calls.length, 1);
    await cli(['search', 'venue']);
    assert.equal(calls[1].headers.authorization, 'Bearer fixture-key');
  });
});

test('seven operations and authentication status serialize identity and exact payloads', async () => {
  const inputs = [
    [
      'start-thread',
      {
        targetAgent: 'target-1',
        messageType: 'message',
        messageContent: 'Find an available venue.',
        operationId: 'op-1',
        idempotencyKey: 'start-1',
      },
    ],
    [
      'send-message',
      {
        thread: 'thread-1',
        messageType: 'action_request',
        messageContent: { operationId: 'op-1', arguments: { seats: 4 }, account: 'external-2' },
        idempotencyKey: 'message-1',
      },
    ],
    ['get-thread', { thread: 'thread-1', cursor: 'thread-1:3', wait: true, limit: 100 }],
    ['list-threads', { targetAgent: 'target-1', archived: false, needsAttention: true, cursor: 'page-1' }],
    ['archive-thread', { thread: 'thread-1' }],
    ['authenticate', { request: 'auth-request-1', idempotencyKey: 'auth-1' }],
    ['pay', { request: 'invoice-1', idempotencyKey: 'pay-1' }],
  ];
  await fixture(async (cli, calls) => {
    for (const [command, input] of inputs) {
      const result = await cli(act(command, input));
      assert.equal(result.status, 0, result.stderr);
    }
    assert.deepEqual(
      calls.map(({ method, path }) => [method, path.split('?')[0]]),
      [
        ['POST', '/api/v2/act/threads'],
        ['POST', '/api/v2/act/threads/thread-1/messages'],
        ['GET', '/api/v2/act/threads/thread-1'],
        ['GET', '/api/v2/act/threads'],
        ['POST', '/api/v2/act/threads/thread-1/archive'],
        ['POST', '/api/v2/act/authentications'],
        ['POST', '/api/v2/act/payments'],
      ],
    );
    assert.equal(calls[1].body.messageContent.account, 'external-2');
    assert.equal(calls[1].body.thread, undefined);
    const query = new URL(calls[2].path, 'http://fixture.test').searchParams;
    assert.equal(query.get('cursor'), 'thread-1:3');
    assert.equal(query.get('wait'), 'true');
    assert.match(calls[3].path, /archived=false/);
    assert.deepEqual(calls[4].body, { agent: 'acting-1' });
    assert.deepEqual(calls[5].body, { request: 'auth-request-1', idempotencyKey: 'auth-1' });
    assert.deepEqual(calls[6].body, { request: 'invoice-1', idempotencyKey: 'pay-1' });
    assert(calls.slice(0, 5).every((call) => call.body?.agent === 'acting-1' || call.path.includes('agent=acting-1')));
  });
});

test('capacity errors do not auto-retry and explicit retries preserve confirmation authority', async () => {
  await fixture(
    async (cli, calls) => {
      const input = {
        thread: 'thread-1',
        messageType: 'action_confirmation',
        messageContent: { request: 'proposal-1' },
        idempotencyKey: 'same-message',
      };
      const first = await cli(act('send-message', input));
      assert.equal(first.status, 1);
      assert.match(first.stderr, /Retry after 45 seconds/);
      assert.equal(calls.length, 1);
      const second = await cli(act('send-message', input));
      assert.equal(second.status, 0, second.stderr);
      assert.deepEqual(calls[0].body, calls[1].body);
    },
    (_call, n) =>
      n === 1
        ? { status: 429, body: { message: 'Capacity exceeded', retryAfterSeconds: 45 } }
        : { body: { accepted: true, delivery: 'accepted', cursor: 'thread-1:4' } },
  );
});

test('invalid bounds, conflicting AI and missing retry identity fail before dispatch', () => {
  assert.throws(() => actRequest('authenticate', { idempotencyKey: 'auth' }), /request/);
  for (const field of ['password', 'accessToken', 'apiKey', 'resource', 'targetAgent', 'account', 'authentication'])
    assert.throws(
      () => actRequest('authenticate', { request: 'request-1', idempotencyKey: 'auth', [field]: 'private-value' }),
      /request and optional idempotencyKey only/,
    );
  for (const input of [{ wait: 'yes' }, { limit: 0 }, { limit: 101 }]) {
    assert.throws(() => actRequest('get-thread', { ...input, thread: 'thread-1' }, 'acting-1'));
  }
  assert.throws(() => actRequest('list-threads', { agent: 'acting-2' }, 'acting-1'), /conflicts/);
  assert.throws(() => actRequest('start-thread', { targetAgent: 'target-1' }, 'acting-1'), /messageType/);
  assert.throws(() => actRequest('send-message', { thread: 'thread-1' }, 'acting-1'), /messageType/);
  assert.throws(() => actRequest('archive-thread', {}, 'acting-1'), /thread/);
  assert.throws(() => actRequest('approve-action', {}, 'acting-1'), /Act command/);
  assert.throws(() => actRequest('get-thread', { thread: '../escape' }, 'acting-1'), /thread/);
});

test('pending checkout is printed unchanged, never labeled paid', async () => {
  await fixture(
    async (cli) => {
      const result = await cli(act('pay', { request: 'invoice-1', idempotencyKey: 'pay-1' }));
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        status: 'pending',
        paymentUrl: 'https://pay.example.test/session',
      });
    },
    () => ({ body: { status: 'pending', paymentUrl: 'https://pay.example.test/session' } }),
  );
});

test('request-bound commands match the actual strict API bodies and preserve paused denials', async () => {
  const contract = JSON.parse(await readFile(new URL('../../../../../scripts/sdk/fern/openapi-sdk.json', import.meta.url), 'utf8').catch(() => readFile(new URL('../openapi-sdk.json', import.meta.url), 'utf8')));
  await fixture(
    async (cli, calls) => {
      for (const command of ['authenticate', 'pay']) {
        const result = await cli(act(command, { request: 'request-1', idempotencyKey: `${command}-1` }));
        assert.equal(result.status, 1);
        assert.match(result.stderr, /PROTOBALLS_EXECUTION_FEATURE_UNAVAILABLE/);
        const call = calls.at(-1);
        const schemaRef =
          contract.paths[`/v2${actRoutes[command][1]}`].post.requestBody.content['application/json'].schema.$ref;
        const schema = contract.components.schemas[schemaRef.split('/').at(-1)];
        assert.equal(schema.additionalProperties, false);
        for (const key of schema.required) assert(Object.hasOwn(call.body, key));
        for (const [key, value] of Object.entries(call.body)) {
          const field = schema.properties[key];
          assert(field, `Unknown ${command} field: ${key}`);
          assert.equal(typeof value, field.type);
          assert.match(value, new RegExp(field.pattern));
          assert(value.length >= field.minLength && value.length <= field.maxLength);
        }
      }
      assert.equal(calls.length, 2, 'one attempt per denied command');
      for (const command of ['authenticate', 'pay']) {
        for (const extra of ['agent', 'account', 'authentication', 'method', 'paymentMethod']) {
          const invalid = await cli(act(command, { request: 'request-1', [extra]: 'not-authority' }));
          assert.equal(invalid.status, 1);
        }
        const selected = await cli([...act(command, { request: 'request-1' }), '--ai', 'acting-1']);
        assert.equal(selected.status, 1);
        assert.match(selected.stderr, /omit --ai/);
      }
      assert.equal(calls.length, 2, 'legacy authority fields fail before HTTP');
    },
    () => ({ status: 503, body: { code: 'PROTOBALLS_EXECUTION_FEATURE_UNAVAILABLE' } }),
  );
});

test('header-only backoff and malformed command options are handled without retries', async () => {
  await fixture(
    async (cli, calls) => {
      const limited = await cli(act('get-thread', { thread: 'thread-1' }));
      assert.equal(limited.status, 1);
      assert.match(limited.stderr, /Retry after 12 seconds/);
      for (const extra of [['--wait-ms', '1'], ['--ai', 'another-ai'], ['unexpected']]) {
        const invalid = await cli([...act('get-thread', { thread: 'thread-1' }), ...extra]);
        assert.equal(invalid.status, 1);
        assert.match(invalid.stderr, /Act accepts/);
      }
      assert.equal(calls.length, 1);
    },
    () => ({ status: 503, headers: { 'Retry-After': '12' }, body: { message: 'Temporarily unavailable' } }),
  );
});

test('invalid Search credentials are not retried as anonymous', async () => {
  await fixture(
    async (cli, calls) => {
      const result = await cli(['search', 'outdoor venue']);
      assert.equal(result.status, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].headers.authorization, 'Bearer fixture-key');
    },
    () => ({ status: 401, body: { message: 'Invalid credential' } }),
  );
});

test(
  'interrupting a bounded read disconnects without sending an operation cancellation',
  { timeout: 5000 },
  async () => {
    const calls = [];
    let resolveRequest;
    const requested = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    const server = createServer((req, res) => {
      calls.push({ method: req.method, path: req.url });
      resolveRequest(new Promise((resolve) => res.once('close', resolve)));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const child = spawn(process.execPath, ['dist/index.js', ...act('get-thread', { thread: 'thread-1', wait: true })], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        DARWIN_API_KEY: 'fixture-key',
        DARWIN_API_URL: `http://127.0.0.1:${server.address().port}/api/v2`,
      },
    });
    // Capture request arrival separately: requested adopts the response-close promise.
    try {
      const received = calls.length ? undefined : once(server, 'request');
      if (received) await received;
      const exited = once(child, 'exit');
      child.kill('SIGINT');
      await exited;
      await requested;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'GET');
      assert.match(calls[0].path, /wait=true/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
