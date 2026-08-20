#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const defaultBaseUrl = 'https://api.darwin.so/api/v1';
const configRoot = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
const configPath = join(configRoot, 'darwin', 'config.json');

type DarwinConfig = {
  apiKey?: string;
  baseUrl?: string;
};

class DarwinApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'DarwinApiError';
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
};

async function readConfig(): Promise<DarwinConfig> {
  try {
    return JSON.parse(await readFile(configPath, 'utf8')) as DarwinConfig;
  } catch {
    return {};
  }
}

async function credentials() {
  const config = await readConfig();
  return {
    apiKey: process.env.DARWIN_API_KEY?.trim() || config.apiKey?.trim(),
    baseUrl: process.env.DARWIN_API_URL?.trim() || config.baseUrl?.trim() || defaultBaseUrl,
  };
}

async function request(apiKey: string, baseUrl: string, path: string, options: RequestOptions = {}) {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Darwin-Access-Point': 'cli',
      'X-Darwin-Client': '@darwinso/cli',
      'X-Darwin-Client-Version': '0.2.0',
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : response.statusText || 'Darwin API request failed';
    throw new DarwinApiError(response.status, message, body);
  }
  return body;
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function integerOption(args: string[], name: string) {
  const value = option(args, name);
  if (value === undefined) return undefined;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function repeatedOption(args: string[], name: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${name} requires a value.`);
    }
    values.push(value);
    index += 1;
  }
  return values;
}

function booleanOption(args: string[], name: string) {
  const value = option(args, name);
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function jsonObjectOption(args: string[], name: string): Record<string, unknown> {
  const value = option(args, name);
  if (!value) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

async function jsonObjectFileOption(args: string[], name: string): Promise<Record<string, unknown> | undefined> {
  const path = option(args, name);
  if (!path) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`${name} must reference a readable JSON file.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function jsonArrayOption(args: string[], name: string): unknown[] {
  const value = option(args, name);
  if (!value) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array.`);
  }
  return parsed;
}

function dataOption(args: string[]): Record<string, unknown> {
  return args.includes('--data') ? jsonObjectOption(args, '--data') : {};
}

function requiredOption(args: string[], name: string) {
  const value = option(args, name)?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function enumOption(args: string[], name: string, values: readonly string[]) {
  const value = option(args, name);
  if (value === undefined) return undefined;

  const normalized = value.toUpperCase();
  if (!values.includes(normalized)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}.`);
  }
  return normalized;
}

function lowerEnumOption(args: string[], name: string, values: readonly string[]) {
  const value = option(args, name);
  if (value === undefined) return undefined;

  const normalized = value.toLowerCase();
  if (!values.includes(normalized)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}.`);
  }
  return normalized;
}

function withOptionalString(body: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined) body[key] = value;
}

function idempotencyHeaders(args: string[]) {
  const supplied = option(args, '--idempotency-key')?.trim();
  if (supplied && supplied.length > 200) {
    throw new Error('--idempotency-key must be at most 200 characters.');
  }
  return {
    'Idempotency-Key': supplied || randomUUID(),
  };
}

function id(value: string | undefined, usage: string) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(usage);
  }
  return encodeURIComponent(normalized);
}

function textArgument(args: string[], start: number, valueOptions: readonly string[]) {
  const options = new Set(valueOptions);
  const words: string[] = [];
  for (let index = start; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (options.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('--')) {
      throw new Error(`Unknown option: ${value}`);
    }
    words.push(value);
  }
  return words.join(' ').trim();
}

function aiQuery(args: string[]) {
  return { aiId: option(args, '--ai') };
}

function mergeFields(body: Record<string, unknown>, fields: Array<[key: string, value: unknown]>) {
  for (const [key, value] of fields) withOptionalString(body, key, value);
  return body;
}

function redact(value: string | undefined) {
  if (!value) return null;
  if (value.length <= 12) return `${value.slice(0, 3)}...`;
  return `${value.slice(0, 7)}...${value.slice(-4)}`;
}

async function configure(args: string[]) {
  const apiKey = option(args, '--api-key');
  if (!apiKey?.trim()) {
    throw new Error('Pass an API key with --api-key.');
  }

  const baseUrl = option(args, '--base-url')?.trim();
  const config: DarwinConfig = {
    apiKey: apiKey.trim(),
    ...(baseUrl ? { baseUrl: baseUrl.replace(/\/+$/, '') } : {}),
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(configPath, 0o600);
  process.stdout.write(`Saved Darwin credentials to ${configPath}\n`);
}

async function showConfig() {
  const resolved = await credentials();
  process.stdout.write(
    `${JSON.stringify(
      {
        apiKey: redact(resolved.apiKey),
        baseUrl: resolved.baseUrl,
        configPath,
      },
      null,
      2,
    )}\n`,
  );
}

async function logout() {
  await rm(configPath, { force: true });
  process.stdout.write(`Removed Darwin credentials from ${configPath}\n`);
}

async function version() {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  process.stdout.write(`${packageJson.version}\n`);
}

function help() {
  process.stdout.write(`Darwin CLI

Usage:
  darwin configure --api-key <key> [--base-url <url>]
  darwin config show
  darwin logout
  darwin account show
  darwin ais <list|get|create|update|activity> [...]
  darwin ais skills
  darwin ais integrations
  darwin requests <list|action> [...]
  darwin conversations <send|list|create|get|message> [...]
  darwin goals <list|get|create|update|action|publish> [...]
  darwin deals <list|get|create|update|action|payments> [...]
  darwin transactions <list|get|action> [...]
  darwin outcomes <list|get|evidence> [...]

Options:
  --ai <id>     Explicitly target an accessible AI
  --data <json>    Supply or extend a JSON request body
  -h, --help       Show help
  -v, --version    Show the installed version

Set DARWIN_API_KEY and optionally DARWIN_API_URL instead of storing local
configuration when running in CI.

Run "darwin <resource> --help" for examples in the documentation:
https://docs.darwin.so/cli
`);
}

async function main() {
  let args = process.argv.slice(2);
  if (args[0] === 'agents') args[0] = 'ais';
  if (args[0] === 'agent') args[0] = 'ai';
  if ((args[0] === 'connect' || args[0] === 'applications') && args[1] === 'agents') args[1] = 'ais';
  if ((args[0] === 'connect' || args[0] === 'applications') && args[1] === 'link-agent') args[1] = 'link-ai';
  if ((args[0] === 'connect' || args[0] === 'applications') && args[1] === 'unlink-agent') args[1] = 'unlink-ai';
  args = args.map((value) =>
    value === '--agent' ? '--ai' : value === '--exclude-agent' ? '--exclude-ai' : value,
  );
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    help();
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    await version();
    return;
  }
  if (args[0] === 'configure') {
    await configure(args.slice(1));
    return;
  }
  if (args[0] === 'config' && args[1] === 'show') {
    await showConfig();
    return;
  }
  if (args[0] === 'logout') {
    await logout();
    return;
  }

  if (args[0] === 'account' && args[1] === 'show') {
    args = ['account'];
  }

  const auth = await credentials();
  if (!auth.apiKey) {
    throw new Error('No API key found. Run darwin configure --api-key <key> or set DARWIN_API_KEY.');
  }

  const resource = args[0] === 'applications' ? 'connect' : args[0];
  const operation = resource === 'connect' && args[1] === 'disconnect' ? 'archive' : args[1];
  let result: unknown;

  if (resource === 'account') {
    result = await request(auth.apiKey, auth.baseUrl, '/account');
  } else if (resource === 'ais' && operation === 'skills') {
    result = await request(auth.apiKey, auth.baseUrl, '/account/skills');
  } else if (resource === 'ais' && operation === 'integrations') {
    result = await request(auth.apiKey, auth.baseUrl, '/integrations');
  } else if (resource === 'requests' && operation === 'list') {
    result = await request(auth.apiKey, auth.baseUrl, '/requests', {
      query: {
        ...aiQuery(args),
        limit: integerOption(args, '--limit'),
      },
    });
  } else if (resource === 'requests' && operation === 'action') {
    const action = args[3]?.toUpperCase();
    if (action !== 'ACCEPT' && action !== 'DECLINE') {
      throw new Error('Request action must be accept or decline.');
    }
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/requests/${id(args[2], 'Pass a request ID after "darwin requests action".')}/actions`,
      {
        method: 'POST',
        body: {
          action,
          ...(option(args, '--ai') ? { aiId: option(args, '--ai') } : {}),
        },
        headers: idempotencyHeaders(args),
      },
    );
  } else if (
    (resource === 'ai' && operation === 'message') ||
    (resource === 'conversations' && operation === 'send')
  ) {
    const content = textArgument(args, 2, ['--ai', '--request-id']);
    if (!content) {
      throw new Error('Pass a message after "darwin conversations send".');
    }
    result = await request(auth.apiKey, auth.baseUrl, '/ai/messages', {
      method: 'POST',
      body: {
        content,
        aiId: option(args, '--ai'),
        requestId: option(args, '--request-id'),
      },
    });
  } else if (resource === 'conversation') {
    result = await request(auth.apiKey, auth.baseUrl, '/ai/conversation', {
      query: {
        ...aiQuery(args),
        limit: integerOption(args, '--limit'),
        cursor: option(args, '--cursor'),
      },
    });
  } else if (resource === 'ais' && operation === 'list') {
    result = await request(auth.apiKey, auth.baseUrl, '/ais');
  } else if (resource === 'ais' && operation === 'get') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(args[2], 'Pass an AI ID after "darwin ais get".')}`,
    );
  } else if (resource === 'ais' && operation === 'create') {
    const body = mergeFields(dataOption(args), [
      ['name', option(args, '--name')],
      ['handle', option(args, '--handle')],
      ['avatarUrl', option(args, '--avatar-url')],
      ['description', option(args, '--description')],
      ['visibility', enumOption(args, '--visibility', ['PUBLIC', 'RESTRICTED', 'PRIVATE'])],
    ]);
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new Error('Pass an AI name with --name or in --data.');
    }
    result = await request(auth.apiKey, auth.baseUrl, '/ais', { method: 'POST', body });
  } else if (resource === 'ais' && operation === 'update') {
    const body = mergeFields(dataOption(args), [
      ['name', option(args, '--name')],
      ['handle', option(args, '--handle')],
      ['avatarUrl', option(args, '--avatar-url')],
      ['description', option(args, '--description')],
      ['visibility', enumOption(args, '--visibility', ['PUBLIC', 'RESTRICTED', 'PRIVATE'])],
    ]);
    if (Object.keys(body).length === 0) {
      throw new Error('Pass at least one editable field or --data.');
    }
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(args[2], 'Pass an AI ID after "darwin ais update".')}`,
      { method: 'PATCH', body },
    );
  } else if (resource === 'ais' && operation === 'activity') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(args[2], 'Pass an AI ID after "darwin ais activity".')}/activity`,
      {
        query: {
          limit: integerOption(args, '--limit'),
          cursor: option(args, '--cursor'),
        },
      },
    );
  } else if (resource === 'ais' && operation === 'members') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(args[2], 'Pass an AI ID after "darwin ais members".')}/members`,
    );
  } else if (resource === 'ais' && operation === 'invite') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(args[2], 'Pass an AI ID after "darwin ais invite".')}/invitations`,
      {
        method: 'POST',
        body: {
          email: requiredOption(args, '--email'),
          role: option(args, '--role'),
        },
      },
    );
  } else if (resource === 'ais' && operation === 'invitations') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(args[2], 'Pass an AI ID after "darwin ais invitations".')}/invitations`,
    );
  } else if (resource === 'ais' && operation === 'revoke-invitation') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(args[2], 'Pass an AI ID.')}/invitations/${id(args[3], 'Pass an invitation ID.')}`,
      { method: 'DELETE' },
    );
  } else if (resource === 'ais' && operation === 'update-member') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(args[2], 'Pass an AI ID.')}/members/${id(args[3], 'Pass a membership ID.')}`,
      {
        method: 'PATCH',
        body: { role: requiredOption(args, '--role') },
      },
    );
  } else if (resource === 'ais' && operation === 'remove-member') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(args[2], 'Pass an AI ID.')}/members/${id(args[3], 'Pass a membership ID.')}`,
      { method: 'DELETE' },
    );
  } else if (resource === 'ais' && operation === 'policies') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(args[2], 'Pass an AI ID after "darwin ais policies".')}/access-policies`,
    );
  } else if (resource === 'ais' && operation === 'create-policy') {
    const body = mergeFields(dataOption(args), [
      ['name', option(args, '--name')],
      ['visibility', enumOption(args, '--visibility', ['PUBLIC', 'RESTRICTED', 'PRIVATE'])],
      ['naturalLanguage', option(args, '--natural-language')],
    ]);
    if (typeof body.name !== 'string' || typeof body.visibility !== 'string') {
      throw new Error('Pass --name and --visibility, or provide both in --data.');
    }
    result = await request(auth.apiKey, auth.baseUrl, `/ais/${id(args[2], 'Pass an AI ID.')}/access-policies`, {
      method: 'POST',
      body,
    });
  } else if (resource === 'ais' && operation === 'update-policy') {
    const body = mergeFields(dataOption(args), [
      ['name', option(args, '--name')],
      ['visibility', enumOption(args, '--visibility', ['PUBLIC', 'RESTRICTED', 'PRIVATE'])],
      ['naturalLanguage', option(args, '--natural-language')],
    ]);
    if (Object.keys(body).length === 0) throw new Error('Pass editable policy fields or --data.');
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(args[2], 'Pass an AI ID.')}/access-policies/${id(args[3], 'Pass a policy ID.')}`,
      { method: 'PATCH', body },
    );
  } else if (resource === 'ais' && operation === 'conversations') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(args[2], 'Pass an AI ID after "darwin ais conversations".')}/conversations`,
    );
  } else if (resource === 'ais' && operation === 'create-conversation') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(args[2], 'Pass an AI ID after "darwin ais create-conversation".')}/conversations`,
      { method: 'POST' },
    );
  } else if (resource === 'conversations' && operation === 'get') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/conversations/${id(args[2], 'Pass a conversation ID after "darwin conversations get".')}`,
      {
        query: {
          limit: integerOption(args, '--limit'),
          cursor: option(args, '--cursor'),
        },
      },
    );
  } else if (resource === 'conversations' && operation === 'message') {
    const content = textArgument(args, 3, ['--request-id']);
    if (!content) throw new Error('Pass message text after the conversation ID.');
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/conversations/${id(args[2], 'Pass a conversation ID.')}/messages`,
      {
        method: 'POST',
        body: { content, requestId: option(args, '--request-id') },
      },
    );
  } else if (resource === 'conversations' && (operation === 'list' || operation === 'create')) {
    const path = `/ais/${id(args[2], `Pass an AI ID after "darwin conversations ${operation}".`)}/conversations`;
    result = await request(auth.apiKey, auth.baseUrl, path, {
      method: operation === 'create' ? 'POST' : 'GET',
    });
  } else if ((resource === 'tasks' || resource === 'goals') && operation === 'list') {
    result = await request(auth.apiKey, auth.baseUrl, `/${resource}`, {
      query: {
        ...aiQuery(args),
        mode: enumOption(args, '--mode', ['BUY', 'SELL', 'CHAT']),
      },
    });
  } else if ((resource === 'tasks' || resource === 'goals') && operation === 'get') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/${resource}/${id(args[2], `Pass a goal ID after "darwin ${resource} get".`)}`,
      { query: aiQuery(args) },
    );
  } else if ((resource === 'tasks' || resource === 'goals') && operation === 'create') {
    const body = mergeFields(dataOption(args), [
      ['aiId', option(args, '--ai')],
      ['intent', option(args, '--intent')],
      ['title', option(args, '--title')],
      ['kind', option(args, '--kind')?.toUpperCase()],
      ['mode', enumOption(args, '--mode', ['BUY', 'SELL', 'CHAT'])],
      ['type', enumOption(args, '--type', ['DEMAND', 'SUPPLY', 'CHAT'])],
      ['lifecycleStatus', enumOption(args, '--status', ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'])],
      ['visibility', enumOption(args, '--visibility', ['PUBLIC', 'RESTRICTED', 'PRIVATE'])],
    ]);
    if (typeof body.intent !== 'string' || !body.intent.trim()) {
      throw new Error('Pass a goal intent with --intent or in --data.');
    }
    result = await request(auth.apiKey, auth.baseUrl, `/${resource}`, {
      method: 'POST',
      body,
    });
  } else if ((resource === 'tasks' || resource === 'goals') && operation === 'update') {
    const body = mergeFields(dataOption(args), [
      ['intent', option(args, '--intent')],
      ['title', option(args, '--title')],
      ['mode', enumOption(args, '--mode', ['BUY', 'SELL', 'CHAT'])],
      ['type', enumOption(args, '--type', ['DEMAND', 'SUPPLY', 'CHAT'])],
      ['lifecycleStatus', enumOption(args, '--status', ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'])],
      ['visibility', enumOption(args, '--visibility', ['PUBLIC', 'RESTRICTED', 'PRIVATE'])],
      ['pausedUntil', option(args, '--paused-until')],
    ]);
    if (Object.keys(body).length === 0) throw new Error('Pass editable goal fields or --data.');
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/${resource}/${id(args[2], `Pass a goal ID after "darwin ${resource} update".`)}`,
      { method: 'PATCH', body },
    );
  } else if ((resource === 'tasks' || resource === 'goals') && operation === 'action') {
    const action = args[3]?.toUpperCase();
    if (!action || !['PAUSE', 'RESUME', 'COMPLETE', 'ARCHIVE'].includes(action)) {
      throw new Error('Action must be pause, resume, complete, or archive.');
    }
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/${resource}/${id(args[2], `Pass a goal ID after "darwin ${resource} action".`)}/actions`,
      {
        method: 'POST',
        body: { action, pausedUntil: option(args, '--paused-until') },
      },
    );
  } else if ((resource === 'tasks' || resource === 'goals') && operation === 'publish') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/${resource}/${id(args[2], `Pass a goal ID after "darwin ${resource} publish".`)}/publication-requests`,
      { method: 'POST', body: dataOption(args) },
    );
  } else if (resource === 'deals' && operation === 'list') {
    result = await request(auth.apiKey, auth.baseUrl, '/deals', { query: aiQuery(args) });
  } else if (resource === 'deals' && operation === 'get') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/deals/${id(args[2], 'Pass a deal ID after "darwin deals get".')}`,
    );
  } else if (resource === 'deals' && operation === 'create') {
    const body = mergeFields(dataOption(args), [
      ['aiId', option(args, '--ai')],
      ['mode', enumOption(args, '--mode', ['BUY', 'SELL'])],
      ['direction', enumOption(args, '--direction', ['DEMAND', 'SUPPLY'])],
      ['title', option(args, '--title')],
      ['goalId', option(args, '--goal')],
      ['taskId', option(args, '--task')],
      ['visibility', enumOption(args, '--visibility', ['PUBLIC', 'RESTRICTED', 'PRIVATE'])],
    ]);
    if ((typeof body.mode !== 'string' && typeof body.direction !== 'string') || typeof body.title !== 'string') {
      throw new Error('Pass --mode and --title, or provide both in --data. --direction remains a deprecated alias.');
    }
    result = await request(auth.apiKey, auth.baseUrl, '/deals', { method: 'POST', body });
  } else if (resource === 'deals' && operation === 'update') {
    const body = mergeFields(dataOption(args), [
      ['title', option(args, '--title')],
      ['visibility', enumOption(args, '--visibility', ['PUBLIC', 'RESTRICTED', 'PRIVATE'])],
    ]);
    if (Object.keys(body).length === 0) throw new Error('Pass editable deal fields or --data.');
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/deals/${id(args[2], 'Pass a deal ID after "darwin deals update".')}`,
      { method: 'PATCH', body },
    );
  } else if (resource === 'deals' && operation === 'action') {
    const action = args[3]?.toUpperCase();
    if (!action || !['SEND', 'ACCEPT', 'REJECT', 'WITHDRAW'].includes(action)) {
      throw new Error('Action must be send, accept, reject, or withdraw.');
    }
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/deals/${id(args[2], 'Pass a deal ID after "darwin deals action".')}/actions`,
      { method: 'POST', body: { action } },
    );
  } else if (resource === 'deals' && operation === 'payments') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/deals/${id(args[2], 'Pass a deal ID after "darwin deals payments".')}/payments`,
    );
  } else if (resource === 'transactions' && operation === 'list') {
    result = await request(auth.apiKey, auth.baseUrl, '/transactions', { query: aiQuery(args) });
  } else if (resource === 'transactions' && operation === 'get') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/transactions/${id(args[2], 'Pass a transaction ID after "darwin transactions get".')}`,
      { query: aiQuery(args) },
    );
  } else if (resource === 'transactions' && operation === 'action') {
    const action = args[3]?.toUpperCase();
    if (!action || !['CANCEL', 'REQUEST_REFUND'].includes(action)) {
      throw new Error('Transaction action must be cancel or request_refund.');
    }
    const body = mergeFields(dataOption(args), [
      ['action', action],
      ['amountMinor', integerOption(args, '--amount-minor')],
    ]);
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/transactions/${id(args[2], 'Pass a transaction ID after "darwin transactions action".')}/actions`,
      { method: 'POST', body, headers: idempotencyHeaders(args) },
    );
  } else if (resource === 'outcomes' && operation === 'list') {
    result = await request(auth.apiKey, auth.baseUrl, '/outcomes', { query: aiQuery(args) });
  } else if (resource === 'outcomes' && operation === 'get') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/outcomes/${id(args[2], 'Pass an outcome ID after "darwin outcomes get".')}`,
    );
  } else if (resource === 'outcomes' && operation === 'evidence') {
    const body = mergeFields(dataOption(args), [
      ['evidenceDigest', option(args, '--digest')],
      ['signedReference', option(args, '--signed-reference')],
      ['dealId', option(args, '--deal')],
    ]);
    if (typeof body.evidenceDigest !== 'string') throw new Error('Pass --digest or evidenceDigest in --data.');
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/outcomes/${id(args[2], 'Pass an outcome ID after "darwin outcomes evidence".')}/evidence`,
      { method: 'POST', body, headers: idempotencyHeaders(args) },
    );
  } else if (resource === 'sessions' && operation === 'list') {
    result = await request(auth.apiKey, auth.baseUrl, '/sessions', {
      query: {
        aiId: option(args, '--ai'),
        status: lowerEnumOption(args, '--status', [
          'pending_provider',
          'planning',
          'active',
          'completed',
          'canceled',
          'failed',
        ]),
        limit: integerOption(args, '--limit'),
        cursor: option(args, '--cursor'),
      },
    });
  } else if (resource === 'sessions' && operation === 'invitations') {
    result = await request(auth.apiKey, auth.baseUrl, '/session-invitations', {
      query: {
        aiId: option(args, '--ai'),
        limit: integerOption(args, '--limit'),
      },
    });
  } else if (resource === 'sessions' && operation === 'invitation') {
    const action = args[3]?.toLowerCase();
    if (action !== 'accept' && action !== 'decline') {
      throw new Error('Session invitation action must be accept or decline.');
    }
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/session-invitations/${id(args[2], 'Pass an invitation ID after "darwin sessions invitation".')}/actions`,
      {
        method: 'POST',
        body: {
          action,
          ...(option(args, '--ai') ? { aiId: option(args, '--ai') } : {}),
        },
        headers: idempotencyHeaders(args),
      },
    );
  } else if (resource === 'sessions' && operation === 'get') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/sessions/${id(args[2], 'Pass a session ID after "darwin sessions get".')}`,
    );
  } else if (resource === 'sessions' && operation === 'participants') {
    const sessionResult = await request(
      auth.apiKey,
      auth.baseUrl,
      `/sessions/${id(args[2], 'Pass a session ID after "darwin sessions participants".')}`,
    );
    const session =
      sessionResult &&
      typeof sessionResult === 'object' &&
      'session' in sessionResult &&
      sessionResult.session &&
      typeof sessionResult.session === 'object'
        ? (sessionResult.session as Record<string, unknown>)
        : undefined;
    result = {
      participants: Array.isArray(session?.participants) ? session.participants : [],
    };
  } else if (resource === 'sessions' && operation === 'create') {
    const body = mergeFields(dataOption(args), [
      ['aiId', option(args, '--ai')],
      ['kind', lowerEnumOption(args, '--kind', ['direct', 'discovery', 'buy', 'sell', 'coordination'])],
      ['goalId', option(args, '--goal')],
      ['conversationId', option(args, '--conversation')],
      ['discoveryMode', lowerEnumOption(args, '--discovery-mode', ['none', 'if_needed', 'always'])],
      ['activationMode', lowerEnumOption(args, '--activation-mode', ['immediate', 'plan_only'])],
    ]);
    const intentDescription = option(args, '--intent');
    const intentTitle = option(args, '--title');
    if (intentDescription || intentTitle) {
      const existingIntent =
        body.intent && typeof body.intent === 'object' && !Array.isArray(body.intent)
          ? (body.intent as Record<string, unknown>)
          : {};
      const description =
        intentDescription ?? (typeof existingIntent.description === 'string' ? existingIntent.description : undefined);
      if (!description) {
        throw new Error('--title requires an intent description from --intent or --data.');
      }
      body.intent = {
        ...existingIntent,
        title:
          intentTitle ?? (typeof existingIntent.title === 'string' ? existingIntent.title : description.slice(0, 120)),
        description,
      };
    }
    const targetAIIds = repeatedOption(args, '--target');
    if (targetAIIds.length > 0) body.targetAIIds = targetAIIds;

    const descriptor = option(args, '--discovery-descriptor');
    if (descriptor !== undefined) {
      body.discoveryDescriptor = jsonObjectOption(args, '--discovery-descriptor');
    }

    const existingDataPolicy =
      body.dataPolicy && typeof body.dataPolicy === 'object' && !Array.isArray(body.dataPolicy)
        ? (body.dataPolicy as Record<string, unknown>)
        : {};
    const dataPolicy = mergeFields({ ...existingDataPolicy }, [
      ['contentMode', lowerEnumOption(args, '--content-mode', ['managed', 'sealed'])],
      [
        'learningMode',
        lowerEnumOption(args, '--learning-mode', [
          'none',
          'outcomes_only',
          'derived_and_outcomes',
          'content_and_outcomes',
        ]),
      ],
      ['keyManagement', lowerEnumOption(args, '--key-management', ['darwin_managed', 'tenant_managed'])],
    ]);
    if (Object.keys(dataPolicy).length > 0) body.dataPolicy = dataPolicy;
    const effectiveContentMode =
      typeof dataPolicy.contentMode === 'string' ? dataPolicy.contentMode.toLowerCase() : 'sealed';
    if (effectiveContentMode === 'sealed' && body.intent !== undefined) {
      throw new Error(
        'Sealed sessions cannot include plaintext intent. Remove --intent/intent and use --discovery-descriptor only when discovery is needed.',
      );
    }
    if (effectiveContentMode === 'managed' && body.discoveryDescriptor !== undefined && body.intent === undefined) {
      throw new Error('Managed session discovery descriptors require a structured intent.');
    }
    if (typeof body.kind !== 'string') {
      throw new Error('Pass a session kind with --kind or in --data.');
    }
    result = await request(auth.apiKey, auth.baseUrl, '/sessions', {
      method: 'POST',
      body,
      headers: idempotencyHeaders(args),
    });
  } else if (resource === 'sessions' && operation === 'send') {
    const content = textArgument(args, 3, [
      '--kind',
      '--context-scope',
      '--idempotency-key',
      '--data',
      '--protected-content',
      '--protected-content-file',
      '--sealed-content',
      '--sealed-content-file',
    ]);
    const body = mergeFields(dataOption(args), [
      [
        'kind',
        lowerEnumOption(args, '--kind', [
          'message',
          'question',
          'clarification',
          'proposal',
          'counterproposal',
          'notice',
          'result',
          'artifact',
        ]),
      ],
      ['content', content || undefined],
      ['contextScopeId', option(args, '--context-scope')],
    ]);
    if (args.includes('--protected-content') && args.includes('--sealed-content')) {
      throw new Error('Pass only one of --sealed-content or --protected-content.');
    }
    if (args.includes('--protected-content-file') && args.includes('--sealed-content-file')) {
      throw new Error('Pass only one of --sealed-content-file or --protected-content-file.');
    }
    const protectedContentOption = args.includes('--protected-content') ? '--protected-content' : '--sealed-content';
    if (args.includes(protectedContentOption)) {
      body.protectedContent = jsonObjectOption(args, protectedContentOption);
    }
    const protectedContentFileOption = args.includes('--protected-content-file')
      ? '--protected-content-file'
      : '--sealed-content-file';
    const protectedContentFile = await jsonObjectFileOption(args, protectedContentFileOption);
    if (protectedContentFile) {
      if (body.protectedContent) {
        throw new Error('Pass only one sealed-content value or file.');
      }
      body.protectedContent = protectedContentFile;
    }
    if (!body.kind) body.kind = 'message';
    const hasContent = typeof body.content === 'string' && body.content.trim().length > 0;
    const hasSealedContent =
      !!body.protectedContent && typeof body.protectedContent === 'object' && !Array.isArray(body.protectedContent);
    if ((!hasContent && !hasSealedContent) || (hasContent && hasSealedContent)) {
      throw new Error('Pass either message text or sealed content, but not both.');
    }
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/sessions/${id(args[2], 'Pass a session ID after "darwin sessions send".')}/interactions`,
      { method: 'POST', body, headers: idempotencyHeaders(args) },
    );
  } else if (resource === 'sessions' && operation === 'watch') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/sessions/${id(args[2], 'Pass a session ID after "darwin sessions watch".')}/interactions`,
      {
        query: {
          limit: integerOption(args, '--limit'),
          cursor: option(args, '--cursor'),
          contextScopeId: option(args, '--context-scope'),
        },
      },
    );
  } else if (resource === 'sessions' && operation === 'mesh') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/sessions/${id(args[2], 'Pass a session ID after "darwin sessions mesh".')}/mesh`,
    );
  } else if (resource === 'sessions' && operation === 'replan') {
    const body = dataOption(args);
    const limit = integerOption(args, '--limit');
    if (limit !== undefined) body.limit = limit;
    const excludeAIIds = repeatedOption(args, '--exclude-ai');
    if (excludeAIIds.length > 0) body.excludeAIIds = excludeAIIds;
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/sessions/${id(args[2], 'Pass a session ID after "darwin sessions replan".')}/resolutions`,
      {
        method: 'POST',
        body,
        headers: idempotencyHeaders(args),
      },
    );
  } else if (resource === 'sessions' && ['complete', 'cancel'].includes(operation ?? '')) {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/sessions/${id(args[2], `Pass a session ID after "darwin sessions ${operation}".`)}/actions`,
      {
        method: 'POST',
        body: {
          ...dataOption(args),
          action: operation?.toUpperCase(),
        },
        headers: idempotencyHeaders(args),
      },
    );
  } else if (resource === 'sessions' && operation === 'outcome') {
    const body = mergeFields(dataOption(args), [
      ['completionState', lowerEnumOption(args, '--completion-state', ['completed', 'partial', 'failed', 'cancelled'])],
      [
        'durationBand',
        lowerEnumOption(args, '--duration-band', ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months']),
      ],
      ['disputeState', lowerEnumOption(args, '--dispute-state', ['none', 'open', 'resolved'])],
      ['refundState', lowerEnumOption(args, '--refund-state', ['none', 'partial', 'full'])],
      [
        'evaluatorType',
        lowerEnumOption(args, '--evaluator-type', ['requester', 'provider', 'platform', 'third_party']),
      ],
    ]);
    const confidence = option(args, '--confidence');
    if (confidence !== undefined) {
      const parsed = Number(confidence);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error('--confidence must be a number from 0 to 1.');
      }
      body.confidence = parsed;
    }
    const success = booleanOption(args, '--success');
    if (success !== undefined) body.success = success;
    if (args.includes('--scores')) body.scores = jsonObjectOption(args, '--scores');
    if (args.includes('--signals')) body.signals = jsonArrayOption(args, '--signals');
    if (args.includes('--cost-band')) body.costBand = jsonObjectOption(args, '--cost-band');
    const criterionResultsOption = args.includes('--criterion-results')
      ? '--criterion-results'
      : '--success-criteria-results';
    if (args.includes(criterionResultsOption)) {
      body.criterionResults = jsonArrayOption(args, criterionResultsOption);
    }
    const decisionIds = repeatedOption(args, '--decision-id');
    if (decisionIds.length > 0) body.decisionIds = decisionIds;
    const evidenceDigests = repeatedOption(args, '--evidence-digest');
    if (evidenceDigests.some((value) => !/^[a-f0-9]{64}$/i.test(value))) {
      throw new Error('--evidence-digest must be a 64-character SHA-256 hex digest.');
    }
    if (evidenceDigests.length > 0) body.evidenceDigests = evidenceDigests;
    if (typeof body.completionState !== 'string') {
      throw new Error('Pass --completion-state or include completionState in --data.');
    }
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/sessions/${id(args[2], 'Pass a session ID after "darwin sessions outcome".')}/outcomes`,
      { method: 'POST', body, headers: idempotencyHeaders(args) },
    );
  } else if (resource === 'sessions' && operation === 'feedback') {
    const content = textArgument(args, 3, [
      '--rating',
      '--outcome',
      '--context-scope',
      '--idempotency-key',
      '--data',
      '--protected-content',
      '--protected-content-file',
      '--sealed-content',
      '--sealed-content-file',
    ]);
    const body = mergeFields(dataOption(args), [
      ['outcomeId', option(args, '--outcome')],
      ['contextScopeId', option(args, '--context-scope')],
      ['content', content || undefined],
    ]);
    const rating = integerOption(args, '--rating');
    if (rating !== undefined) {
      if (rating > 5) throw new Error('--rating must be an integer from 1 to 5.');
      body.rating = rating;
    }
    if (args.includes('--protected-content') && args.includes('--sealed-content')) {
      throw new Error('Pass only one of --sealed-content or --protected-content.');
    }
    if (args.includes('--protected-content-file') && args.includes('--sealed-content-file')) {
      throw new Error('Pass only one of --sealed-content-file or --protected-content-file.');
    }
    const protectedContentOption = args.includes('--protected-content') ? '--protected-content' : '--sealed-content';
    if (args.includes(protectedContentOption)) {
      body.protectedContent = jsonObjectOption(args, protectedContentOption);
    }
    const protectedContentFileOption = args.includes('--protected-content-file')
      ? '--protected-content-file'
      : '--sealed-content-file';
    const protectedContentFile = await jsonObjectFileOption(args, protectedContentFileOption);
    if (protectedContentFile) {
      if (body.protectedContent) throw new Error('Pass only one sealed-content value or file.');
      body.protectedContent = protectedContentFile;
    }
    const hasContent = typeof body.content === 'string' && body.content.trim().length > 0;
    const hasProtectedContent =
      !!body.protectedContent && typeof body.protectedContent === 'object' && !Array.isArray(body.protectedContent);
    if (hasContent && hasProtectedContent) {
      throw new Error('Pass plaintext feedback or protected content, not both.');
    }
    if (body.rating === undefined && !hasContent && !hasProtectedContent) {
      throw new Error('Pass a rating, feedback text, or protected content.');
    }
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/sessions/${id(args[2], 'Pass a session ID after "darwin sessions feedback".')}/feedback`,
      { method: 'POST', body, headers: idempotencyHeaders(args) },
    );
  } else if (resource === 'directory' && operation === 'search') {
    result = await request(auth.apiKey, auth.baseUrl, '/directory/ais', {
      query: {
        query: textArgument(args, 2, ['--limit']) || undefined,
        limit: integerOption(args, '--limit'),
      },
    });
  } else if (resource === 'directory' && operation === 'get') {
    result = await request(auth.apiKey, auth.baseUrl, `/directory/ais/${id(args[2], 'Pass a directory AI ID.')}`);
  } else if (resource === 'offers' && operation === 'list') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(option(args, '--ai'), 'Pass an AI ID with --ai.')}/offers`,
    );
  } else if (resource === 'offers' && operation === 'get') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/offers/${id(args[2], 'Pass an offer ID after "darwin offers get".')}`,
    );
  } else if (resource === 'offers' && operation === 'create') {
    const body = mergeFields(dataOption(args), [
      ['direction', enumOption(args, '--direction', ['DEMAND', 'SUPPLY'])],
      ['title', option(args, '--title')],
      ['goalId', option(args, '--goal')],
      ['visibility', enumOption(args, '--visibility', ['PUBLIC', 'RESTRICTED', 'PRIVATE'])],
    ]);
    if (typeof body.direction !== 'string' || typeof body.title !== 'string') {
      throw new Error('Pass --direction and --title, or provide both in --data.');
    }
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(option(args, '--ai'), 'Pass an AI ID with --ai.')}/offers`,
      { method: 'POST', body },
    );
  } else if (resource === 'offers' && operation === 'update') {
    const body = mergeFields(dataOption(args), [
      ['title', option(args, '--title')],
      ['visibility', enumOption(args, '--visibility', ['PUBLIC', 'RESTRICTED', 'PRIVATE'])],
    ]);
    if (Object.keys(body).length === 0) throw new Error('Pass editable offer fields or --data.');
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/offers/${id(args[2], 'Pass an offer ID after "darwin offers update".')}`,
      { method: 'PATCH', body },
    );
  } else if (resource === 'offers' && operation === 'action') {
    const action = args[3]?.toUpperCase();
    if (!action || !['SEND', 'ACCEPT', 'REJECT', 'WITHDRAW'].includes(action)) {
      throw new Error('Action must be send, accept, reject, or withdraw.');
    }
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/offers/${id(args[2], 'Pass an offer ID after "darwin offers action".')}/actions`,
      { method: 'POST', body: { action } },
    );
  } else if (resource === 'payments' && operation === 'account') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(option(args, '--ai'), 'Pass an AI ID with --ai.')}/payment-account`,
    );
  } else if (resource === 'payments' && operation === 'list') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/ais/${id(option(args, '--ai'), 'Pass an AI ID with --ai.')}/payments`,
    );
  } else if (resource === 'payments' && operation === 'get') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/payments/${id(args[2], 'Pass a payment ID after "darwin payments get".')}`,
    );
  } else if (resource === 'fee-quotes' && operation === 'create') {
    const body = dataOption(args);
    if (Object.keys(body).length === 0) throw new Error('Pass fee quote inputs with --data.');
    result = await request(auth.apiKey, auth.baseUrl, '/fee-quotes', { method: 'POST', body });
  } else if (resource === 'fee-quotes' && operation === 'get') {
    result = await request(auth.apiKey, auth.baseUrl, `/fee-quotes/${id(args[2], 'Pass a fee quote ID.')}`);
  } else if (resource === 'fee-quotes' && operation === 'accept') {
    result = await request(auth.apiKey, auth.baseUrl, `/fee-quotes/${id(args[2], 'Pass a fee quote ID.')}/accept`, {
      method: 'POST',
    });
  } else if (resource === 'connect' && operation === 'list') {
    result = await request(auth.apiKey, auth.baseUrl, '/applications');
  } else if (resource === 'connect' && operation === 'get') {
    result = await request(auth.apiKey, auth.baseUrl, `/applications/${id(args[2], 'Pass an application ID.')}`);
  } else if (resource === 'connect' && operation === 'create') {
    const body = mergeFields(dataOption(args), [
      ['name', option(args, '--name')],
      ['mode', enumOption(args, '--mode', ['HOSTED', 'EMBEDDED', 'HYBRID'])],
    ]);
    if (typeof body.name !== 'string') throw new Error('Pass --name or include name in --data.');
    result = await request(auth.apiKey, auth.baseUrl, '/applications', { method: 'POST', body });
  } else if (resource === 'connect' && operation === 'update') {
    const body = mergeFields(dataOption(args), [
      ['name', option(args, '--name')],
      ['mode', enumOption(args, '--mode', ['HOSTED', 'EMBEDDED', 'HYBRID'])],
    ]);
    if (Object.keys(body).length === 0) throw new Error('Pass editable application fields or --data.');
    result = await request(auth.apiKey, auth.baseUrl, `/applications/${id(args[2], 'Pass an application ID.')}`, {
      method: 'PATCH',
      body,
    });
  } else if (resource === 'connect' && operation === 'archive') {
    result = await request(auth.apiKey, auth.baseUrl, `/applications/${id(args[2], 'Pass an application ID.')}`, {
      method: 'DELETE',
    });
  } else if (resource === 'connect' && operation === 'ais') {
    result = await request(auth.apiKey, auth.baseUrl, `/applications/${id(args[2], 'Pass an application ID.')}/ais`);
  } else if (resource === 'connect' && operation === 'link-ai') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/applications/${id(args[2], 'Pass an application ID.')}/ais`,
      {
        method: 'POST',
        body: {
          aiId: requiredOption(args, '--ai'),
          role: option(args, '--role'),
        },
      },
    );
  } else if (resource === 'connect' && operation === 'unlink-ai') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/applications/${id(args[2], 'Pass an application ID.')}/ais/${id(args[3], 'Pass an AI ID.')}`,
      { method: 'DELETE' },
    );
  } else if (resource === 'connect' && operation === 'enrollments') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/applications/${id(args[2], 'Pass an application ID.')}/enrollment-links`,
    );
  } else if (resource === 'connect' && operation === 'create-enrollment') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/applications/${id(args[2], 'Pass an application ID.')}/enrollment-links`,
      { method: 'POST', body: dataOption(args) },
    );
  } else if (resource === 'connect' && operation === 'revoke-enrollment') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/applications/${id(args[2], 'Pass an application ID.')}/enrollment-links/${id(args[3], 'Pass an enrollment link ID.')}`,
      { method: 'DELETE' },
    );
  } else if (resource === 'connect' && operation === 'service-accounts') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/applications/${id(args[2], 'Pass an application ID.')}/service-accounts`,
    );
  } else if (resource === 'connect' && operation === 'create-service-account') {
    const body = mergeFields(dataOption(args), [['name', option(args, '--name')]]);
    if (typeof body.name !== 'string') throw new Error('Pass --name or include name in --data.');
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/applications/${id(args[2], 'Pass an application ID.')}/service-accounts`,
      { method: 'POST', body },
    );
  } else if (resource === 'connect' && operation === 'revoke-service-account') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/applications/${id(args[2], 'Pass an application ID.')}/service-accounts/${id(args[3], 'Pass a service account ID.')}`,
      { method: 'DELETE' },
    );
  } else if (resource === 'connect' && operation === 'webhooks') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/applications/${id(args[2], 'Pass an application ID.')}/webhooks`,
    );
  } else if (resource === 'connect' && operation === 'create-webhook') {
    const body = mergeFields(dataOption(args), [['url', option(args, '--url')]]);
    if (typeof body.url !== 'string') throw new Error('Pass --url or include url in --data.');
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/applications/${id(args[2], 'Pass an application ID.')}/webhooks`,
      { method: 'POST', body },
    );
  } else if (resource === 'connect' && operation === 'revoke-webhook') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/applications/${id(args[2], 'Pass an application ID.')}/webhooks/${id(args[3], 'Pass a webhook ID.')}`,
      { method: 'DELETE' },
    );
  } else if (resource === 'connect' && operation === 'webhook-deliveries') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/applications/${id(args[2], 'Pass an application ID.')}/webhooks/${id(args[3], 'Pass a webhook ID.')}/deliveries`,
      {
        query: {
          limit: integerOption(args, '--limit'),
          cursor: option(args, '--cursor'),
        },
      },
    );
  } else if (resource === 'connect' && operation === 'retry-webhook') {
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/applications/${id(args[2], 'Pass an application ID.')}/webhooks/${id(args[3], 'Pass a webhook ID.')}/deliveries/${id(args[4], 'Pass a delivery ID.')}/retry`,
      { method: 'POST' },
    );
  } else if (resource === 'tools' && operation === 'list') {
    result = await request(auth.apiKey, auth.baseUrl, '/tools');
  } else if (resource === 'tools' && operation === 'execute') {
    const tool = args[2]?.trim();
    if (!tool) {
      throw new Error('Pass a tool name after "darwin tools execute".');
    }
    result = await request(auth.apiKey, auth.baseUrl, `/tools/${encodeURIComponent(tool)}/executions`, {
      method: 'POST',
      body: { input: jsonObjectOption(args, '--input') },
    });
  } else if (resource === 'api') {
    const method = operation?.toUpperCase();
    if (!method || !['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
      throw new Error('API method must be GET, POST, PATCH, or DELETE.');
    }
    const path = args[2]?.trim();
    if (!path || path.includes('://')) {
      throw new Error('Pass a relative API path, such as /ais.');
    }
    const body = dataOption(args);
    result = await request(auth.apiKey, auth.baseUrl, path, {
      method: method as RequestOptions['method'],
      ...(Object.keys(body).length > 0 ? { body } : {}),
    });
  } else {
    throw new Error(`Unknown command: ${args.join(' ')}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof DarwinApiError) {
    process.stderr.write(`Darwin API error (${error.status}): ${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
