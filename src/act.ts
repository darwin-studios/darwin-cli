/** CLI routing only. The API remains the authority for schemas and permissions. */
export const actRoutes = {
  'start-thread': ['POST', '/act/threads', 'start_thread'],
  'send-message': ['POST', '/act/threads/{thread}/messages', 'send_message'],
  'get-thread': ['GET', '/act/threads/{thread}', 'get_thread'],
  'list-threads': ['GET', '/act/threads', 'list_threads'],
  'archive-thread': ['POST', '/act/threads/{thread}/archive', 'archive_thread'],
  authenticate: ['POST', '/act/authentications', 'authenticate'],
  pay: ['POST', '/act/payments', 'pay'],
} as const;

function requiredId(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)) {
    throw new Error(`Pass a valid ${name} in --data.`);
  }
  return value;
}

function optionalId(body: Record<string, unknown>, name: string) {
  if (body[name] !== undefined) requiredId(body, name);
}

function requireMessage(body: Record<string, unknown>) {
  requiredId(body, 'messageType');
  if (!Object.hasOwn(body, 'messageContent')) throw new Error('Pass messageContent in --data.');
}

export function actRequest(command: string | undefined, input: Record<string, unknown>, agent?: string) {
  if (!command || !Object.hasOwn(actRoutes, command)) {
    throw new Error(`Act command must be one of: ${Object.keys(actRoutes).join(', ')}.`);
  }
  const body = { ...input };
  const requestBound = command === 'authenticate' || command === 'pay';
  if (requestBound && (agent !== undefined || Object.hasOwn(body, 'agent'))) {
    throw new Error('Authentication and payment are bound to the returned request; omit --ai and agent.');
  }
  if (agent) {
    if (body.agent !== undefined && body.agent !== agent) throw new Error('--ai conflicts with agent in --data.');
    body.agent = agent;
  }
  optionalId(body, 'agent');
  optionalId(body, 'idempotencyKey');

  const [method, template] = actRoutes[command as keyof typeof actRoutes];
  let path: string = template;
  if (template.includes('{thread}')) {
    path = template.replace('{thread}', encodeURIComponent(requiredId(body, 'thread')));
    delete body.thread;
  }

  if (command === 'start-thread') {
    requiredId(body, 'targetAgent');
    requireMessage(body);
  }
  if (command === 'send-message') requireMessage(body);
  if (requestBound) {
    requiredId(body, 'request');
    const allowed = new Set(['request', 'idempotencyKey']);
    if (Object.keys(body).some((key) => !allowed.has(key)))
      throw new Error(
        'Authentication and payment accept request and optional idempotencyKey only. Never send credentials or payment details.',
      );
  }

  if (method === 'GET') {
    const allowed = new Set(
      command === 'get-thread'
        ? ['agent', 'cursor', 'wait', 'limit']
        : ['agent', 'targetAgent', 'needsAttention', 'archived', 'cursor', 'limit'],
    );
    const query: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(body)) {
      if (!allowed.has(key)) throw new Error(`Unexpected read parameter: ${key}.`);
      if (key === 'limit') {
        if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100)
          throw new Error('limit must be an integer from 1 to 100.');
        query[key] = value as number;
      } else if (key === 'wait' || key === 'needsAttention' || key === 'archived') {
        if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean.`);
        query[key] = String(value);
      } else query[key] = requiredId(body, key);
    }
    return { path, options: { method, query, timeoutMs: 40_000 } };
  }

  return { path, options: { method, body, timeoutMs: 40_000 } };
}
