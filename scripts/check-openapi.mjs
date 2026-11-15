import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.env.DARWIN_OPENAPI_PATH,
  join(packageRoot, 'openapi.json'),
  join(packageRoot, '..', '..', '..', '..', 'apps', 'website', 'docs', 'openapi-v2.json'),
  join(packageRoot, '..', '..', '..', '..', 'apps', 'docs', 'openapi-v2.json'),
  join(packageRoot, '..', '..', '..', '..', 'fern', 'openapi-sdk.json'),
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
if (!contractPath) throw new Error('Darwin v2 OpenAPI contract not found.');

const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const problems = [];
const expectedOperations = [
  ['post', '/search', 'search'],
  ['post', '/act/threads', 'start_thread'],
  ['post', '/act/threads/{thread}/messages', 'send_message'],
  ['get', '/act/threads/{thread}', 'get_thread'],
  ['get', '/act/threads', 'list_threads'],
  ['post', '/act/threads/{thread}/archive', 'archive_thread'],
  ['post', '/act/authentications', 'authenticate'],
  ['post', '/act/payments', 'pay'],
];

function checkLocalSchemaReferences(value, location = '#') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => checkLocalSchemaReferences(entry, `${location}/${index}`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/components/schemas/')) {
    const schemaName = value.$ref.slice('#/components/schemas/'.length);
    if (!contract.components?.schemas?.[schemaName])
      problems.push(`${location} references missing schema ${value.$ref}`);
  }
  for (const [key, entry] of Object.entries(value)) checkLocalSchemaReferences(entry, `${location}/${key}`);
}

if (contract.openapi !== '3.1.0') problems.push(`expected OpenAPI 3.1.0, received ${String(contract.openapi)}`);
if (contract.info?.version !== '2.0.0') {
  problems.push(`expected Darwin API 2.0.0, received ${String(contract.info?.version)}`);
}
if (!contract.servers?.some((server) => server.url === 'https://api.darwin.so/api/v2')) {
  problems.push('production v2 server is missing');
}

const operations = Object.entries(contract.paths ?? {}).flatMap(([path, pathItem]) =>
  Object.entries(pathItem)
    .filter(([method]) => ['get', 'post', 'patch', 'put', 'delete'].includes(method))
    .map(([method, operation]) => ({ method, path, operation })),
);
const operationIds = operations.map(({ operation }) => operation.operationId);
const callableCliOperations = operations.filter(
  ({ method, path, operation }) =>
    // Status, owner-context discovery and download tickets are HTTP helpers; none
    // adds a CLI command to the exact seven-operation thread surface.
    (path === '/search' ||
      (path.startsWith('/act/') &&
        !['get_authentication_status', 'get_result_artifact_download_url'].includes(operation.operationId) &&
        !(
          method === 'get' &&
          path === '/act/processing-context' &&
          operation.operationId === 'get_owner_processing_context'
        ))) &&
    operation['x-darwin-callable'] !== false,
);
if (callableCliOperations.length !== expectedOperations.length) {
  problems.push(
    `expected exactly ${expectedOperations.length} callable Search/Act operations, received ${callableCliOperations.length}`,
  );
}
if (!operations.length || new Set(operationIds).size !== operationIds.length) {
  problems.push('all public operations must have unique operation IDs');
}

for (const path of Object.keys(contract.paths ?? {})) {
  if (path === '/actions' || path.startsWith('/actions/')) problems.push(`${path} exposes the retired Action contract`);
  if (path === '/connect' || path.startsWith('/connect/'))
    problems.push(`${path} exposes the retired Connect namespace`);
  if (/service-accounts|enrollment-(?:links|batches)|users\/resolve/u.test(path)) {
    problems.push(`${path} exposes a retired application credential flow`);
  }
}
for (const [method, path, operationId] of expectedOperations) {
  const operation = contract.paths?.[path]?.[method];
  if (!operation) problems.push(`${method.toUpperCase()} ${path} is missing`);
  else if (operation.operationId !== operationId) {
    problems.push(`${method.toUpperCase()} ${path} expected ${operationId}, received ${String(operation.operationId)}`);
  }
}

checkLocalSchemaReferences(contract);
if (problems.length) throw new Error(`Darwin CLI contract check failed:\n- ${problems.join('\n- ')}`);
process.stdout.write(
  `Darwin CLI next-release contract covers Search and the seven public thread operations (${contractPath}).\n`,
);
