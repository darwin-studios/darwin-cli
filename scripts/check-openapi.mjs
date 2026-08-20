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
  throw new Error('Darwin OpenAPI contract not found. Set DARWIN_OPENAPI_PATH or add openapi.json.');
}

const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const problems = [];
const expectedTags = [
  'Account',
  'ais',
  'Permissions',
  'Reputation',
  'Skills',
  'Integrations',
  'Connections',
  'Notifications',
  'Usage',
  'Verification',
  'Deployment',
  'Tools',
  'Requests',
  'Conversations',
  'Goals',
  'Tasks',
  'Deals',
  'Transactions',
  'Outcomes',
  'Billing',
  'Applications',
  'Enrollment',
  'Ephemeral Goals',
  'Webhooks',
  'Examples',
];
const expectedOperations = [
  ['get', '/account', 'getAccount'],
  ['get', '/account/skills', 'listSkillCatalog'],
  ['get', '/ais', 'listAIs'],
  ['get', '/requests', 'listRequests'],
  ['post', '/requests/{requestId}/actions', 'actOnRequest'],
  ['post', '/ai/messages', 'createMessage'],
  ['get', '/tasks', 'listTasks'],
  ['post', '/tasks', 'createTask'],
  ['post', '/tasks/{id}/publication-requests', 'requestTaskPublication'],
  ['get', '/deals', 'listDeals'],
  ['post', '/deals', 'createDeal'],
  ['get', '/deals/{dealId}', 'getDeal'],
  ['post', '/deals/{dealId}/actions', 'actOnDeal'],
  ['get', '/deals/{dealId}/payments', 'listDealPayments'],
  ['post', '/deals/{dealId}/transactions', 'createDealTransaction'],
  ['get', '/transactions', 'listTransactions'],
  ['get', '/outcomes', 'listOutcomes'],
  ['get', '/applications', 'listApplications'],
  ['post', '/applications/{applicationId}/ephemeral-goals', 'createEphemeralGoal'],
];

function checkLocalSchemaReferences(value, location = '#') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => checkLocalSchemaReferences(entry, `${location}/${index}`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/components/schemas/')) {
    const schemaName = value.$ref.slice('#/components/schemas/'.length);
    if (!contract.components?.schemas?.[schemaName]) {
      problems.push(`${location} references missing schema ${value.$ref}`);
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    checkLocalSchemaReferences(entry, `${location}/${key}`);
  }
}

if (contract.openapi !== '3.1.0') {
  problems.push(`expected OpenAPI 3.1.0, received ${String(contract.openapi)}`);
}
if (contract.info?.version !== '1.6.0') {
  problems.push(`expected Darwin API 1.6.0, received ${String(contract.info?.version)}`);
}
if (
  !Array.isArray(contract.servers) ||
  !contract.servers.some((server) => server.url === 'https://api.darwin.so/api/v1')
) {
  problems.push('production server https://api.darwin.so/api/v1 is missing');
}

const tags = contract.tags?.map((tag) => tag.name);
if (JSON.stringify(tags) !== JSON.stringify(expectedTags)) {
  problems.push(`expected public tags ${expectedTags.join(', ')}, received ${String(tags)}`);
}

const operations = Object.values(contract.paths ?? {}).flatMap((pathItem) =>
  Object.entries(pathItem)
    .filter(([method]) => ['get', 'post', 'patch', 'put', 'delete'].includes(method))
    .map(([, operation]) => operation),
);
const operationIds = operations.map((operation) => operation.operationId);
if (operationIds.length !== 111 || new Set(operationIds).size !== operationIds.length) {
  problems.push('expected 111 uniquely named public operations');
}
for (const operation of operations) {
  if (!Array.isArray(operation.tags) || operation.tags.length !== 1 || !expectedTags.includes(operation.tags[0])) {
    problems.push(`${operation.operationId ?? 'unknown operation'} is not assigned to one public domain`);
  }
}

const forbiddenPrefixes = [
  '/sessions',
  '/session-invitations',
  '/directory',
  '/offers',
  '/payments',
  '/approvals',
];
for (const path of Object.keys(contract.paths ?? {})) {
  if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
    problems.push(`${path} exposes a private or legacy surface`);
  }
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

checkLocalSchemaReferences(contract);

if (problems.length > 0) {
  throw new Error(`Darwin CLI contract check failed:\n- ${problems.join('\n- ')}`);
}

process.stdout.write(`Darwin CLI contract is aligned to the public resource model (${contractPath}).\n`);
