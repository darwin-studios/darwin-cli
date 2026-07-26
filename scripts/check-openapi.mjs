import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.env.DARWIN_OPENAPI_PATH,
  join(packageRoot, 'openapi.json'),
  join(packageRoot, '..', '..', 'fern', 'openapi.json'),
].filter(Boolean);

let contractPath;
for (const candidate of candidates) {
  try {
    await access(candidate);
    contractPath = candidate;
    break;
  } catch {
    // Try the next supported repository layout.
  }
}

if (!contractPath) {
  throw new Error(
    'Darwin OpenAPI contract not found. Set DARWIN_OPENAPI_PATH or add openapi.json.',
  );
}

const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const expectedOperations = [
  ['get', '/agent/conversation', 'getConversation'],
  ['post', '/agent/messages', 'createMessage'],
  ['get', '/tools', 'listTools'],
  ['post', '/tools/{tool}/executions', 'executeTool'],
  ['get', '/goals', 'listGoals'],
  ['post', '/goals', 'createGoal'],
  ['get', '/goals/{id}', 'getGoal'],
  ['get', '/approvals', 'listApprovals'],
  ['post', '/approvals/{id}/decisions', 'decideApproval'],
  ['get', '/integrations', 'getIntegrations'],
];

const problems = [];
if (contract.openapi !== '3.1.0') {
  problems.push(`expected OpenAPI 3.1.0, received ${String(contract.openapi)}`);
}
if (
  !Array.isArray(contract.servers) ||
  !contract.servers.some((server) => server.url === 'https://api.darwin.so/api/v1')
) {
  problems.push('production server https://api.darwin.so/api/v1 is missing');
}

for (const [method, path, operationId] of expectedOperations) {
  const operation = contract.paths?.[path]?.[method];
  if (!operation) {
    problems.push(`${method.toUpperCase()} ${path} is missing`);
  } else if (operation.operationId !== operationId) {
    problems.push(
      `${method.toUpperCase()} ${path} expected operationId ${operationId}, received ${String(operation.operationId)}`,
    );
  }
}

if (problems.length > 0) {
  throw new Error(`Darwin CLI contract check failed:\n- ${problems.join('\n- ')}`);
}

process.stdout.write(`Darwin CLI contract is compatible (${contractPath}).\n`);
