#!/usr/bin/env node
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
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
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

async function request(
  apiKey: string,
  baseUrl: string,
  path: string,
  options: RequestOptions = {},
) {
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
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
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
      body &&
      typeof body === 'object' &&
      'message' in body &&
      typeof body.message === 'string'
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
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  process.stdout.write(`${packageJson.version}\n`);
}

function help() {
  process.stdout.write(`Darwin CLI

Usage:
  darwin configure --api-key <key> [--base-url <url>]
  darwin config show
  darwin logout
  darwin agent message <text> [--request-id <id>]
  darwin conversation [--limit <number>] [--cursor <cursor>]
  darwin goals list
  darwin goals get <id>
  darwin goals create --intent <text> [--title <text>] [--kind <kind>]
  darwin approvals list [--status <status>]
  darwin approvals decide <id> <approve|reject> [--reason <text>]
  darwin integrations
  darwin tools list
  darwin tools execute <tool> [--input <json-object>]

Options:
  -h, --help       Show help
  -v, --version    Show the installed version

Set DARWIN_API_KEY and optionally DARWIN_API_URL instead of storing local
configuration when running in CI.
`);
}

async function main() {
  const args = process.argv.slice(2);
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

  const auth = await credentials();
  if (!auth.apiKey) {
    throw new Error(
      'No API key found. Run darwin configure --api-key <key> or set DARWIN_API_KEY.',
    );
  }

  const resource = args[0];
  const operation = args[1];
  let result: unknown;

  if (resource === 'agent' && operation === 'message') {
    const requestIdIndex = args.indexOf('--request-id');
    const contentEnd = requestIdIndex === -1 ? args.length : requestIdIndex;
    const content = args.slice(2, contentEnd).join(' ').trim();
    if (!content) {
      throw new Error('Pass a message after "darwin agent message".');
    }
    result = await request(auth.apiKey, auth.baseUrl, '/agent/messages', {
      method: 'POST',
      body: {
        content,
        requestId: option(args, '--request-id'),
      },
    });
  } else if (resource === 'conversation') {
    result = await request(auth.apiKey, auth.baseUrl, '/agent/conversation', {
      query: {
        limit: integerOption(args, '--limit'),
        cursor: option(args, '--cursor'),
      },
    });
  } else if (resource === 'goals' && operation === 'list') {
    result = await request(auth.apiKey, auth.baseUrl, '/goals');
  } else if (resource === 'goals' && operation === 'get') {
    const goalId = args[2]?.trim();
    if (!goalId) {
      throw new Error('Pass a goal ID after "darwin goals get".');
    }
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/goals/${encodeURIComponent(goalId)}`,
    );
  } else if (resource === 'goals' && operation === 'create') {
    const intent = option(args, '--intent');
    if (!intent?.trim()) {
      throw new Error('Pass a goal intent with --intent.');
    }
    result = await request(auth.apiKey, auth.baseUrl, '/goals', {
      method: 'POST',
      body: {
        intent,
        title: option(args, '--title'),
        kind: option(args, '--kind')?.toUpperCase(),
      },
    });
  } else if (resource === 'approvals' && operation === 'list') {
    result = await request(auth.apiKey, auth.baseUrl, '/approvals', {
      query: { status: option(args, '--status') },
    });
  } else if (resource === 'approvals' && operation === 'decide') {
    const decision = args[3]?.toUpperCase();
    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      throw new Error('Decision must be approve or reject.');
    }
    const approvalId = args[2]?.trim();
    if (!approvalId) {
      throw new Error('Pass the approval ID before the decision.');
    }
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/approvals/${encodeURIComponent(approvalId)}/decisions`,
      {
        method: 'POST',
        body: {
          decision,
          reason: option(args, '--reason'),
        },
      },
    );
  } else if (resource === 'integrations') {
    result = await request(auth.apiKey, auth.baseUrl, '/integrations');
  } else if (resource === 'tools' && operation === 'list') {
    result = await request(auth.apiKey, auth.baseUrl, '/tools');
  } else if (resource === 'tools' && operation === 'execute') {
    const tool = args[2]?.trim();
    if (!tool) {
      throw new Error('Pass a tool name after "darwin tools execute".');
    }
    result = await request(
      auth.apiKey,
      auth.baseUrl,
      `/tools/${encodeURIComponent(tool)}/executions`,
      {
        method: 'POST',
        body: { input: jsonObjectOption(args, '--input') },
      },
    );
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
