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
const expectedOperations = [
  ['get', '/account', 'getAccount'],
  ['get', '/agents', 'listAgents'],
  ['post', '/agents', 'createAgent'],
  ['get', '/agents/{agentId}', 'getAgent'],
  ['patch', '/agents/{agentId}', 'updateAgent'],
  ['get', '/agents/{agentId}/activity', 'listAgentActivity'],
  ['get', '/agents/{agentId}/members', 'listAgentMembers'],
  ['patch', '/agents/{agentId}/members/{membershipId}', 'updateAgentMember'],
  ['delete', '/agents/{agentId}/members/{membershipId}', 'removeAgentMember'],
  ['get', '/agents/{agentId}/invitations', 'listAgentInvitations'],
  ['post', '/agents/{agentId}/invitations', 'createAgentInvitation'],
  ['delete', '/agents/{agentId}/invitations/{invitationId}', 'revokeAgentInvitation'],
  ['get', '/agents/{agentId}/access-policies', 'listAccessPolicies'],
  ['post', '/agents/{agentId}/access-policies', 'createAccessPolicy'],
  ['patch', '/agents/{agentId}/access-policies/{policyId}', 'updateAccessPolicy'],
  ['get', '/agent/conversation', 'getSelectedAgentConversation'],
  ['post', '/agent/messages', 'createMessage'],
  ['get', '/agents/{agentId}/conversations', 'listAgentConversations'],
  ['post', '/agents/{agentId}/conversations', 'createAgentConversation'],
  ['get', '/conversations/{conversationId}', 'getConversation'],
  ['post', '/conversations/{conversationId}/messages', 'createConversationMessage'],
  ['get', '/tools', 'listTools'],
  ['post', '/tools/{tool}/executions', 'executeTool'],
  ['get', '/goals', 'listGoals'],
  ['post', '/goals', 'createGoal'],
  ['get', '/goals/{id}', 'getGoal'],
  ['patch', '/goals/{id}', 'updateGoal'],
  ['post', '/goals/{id}/actions', 'actOnGoal'],
  ['post', '/goals/{id}/publication-approvals', 'requestGoalPublication'],
  ['get', '/sessions', 'listSessions'],
  ['post', '/sessions', 'createSession'],
  ['get', '/sessions/{sessionId}', 'getSession'],
  ['get', '/sessions/{sessionId}/interactions', 'listSessionInteractions'],
  ['post', '/sessions/{sessionId}/interactions', 'sendSessionInteraction'],
  ['post', '/sessions/{sessionId}/resolutions', 'resolveSession'],
  ['get', '/sessions/{sessionId}/mesh', 'getSessionMesh'],
  ['post', '/sessions/{sessionId}/actions', 'actOnSession'],
  ['post', '/sessions/{sessionId}/outcomes', 'recordSessionOutcome'],
  ['get', '/approvals', 'listApprovals'],
  ['post', '/approvals/{id}/decisions', 'decideApproval'],
  ['get', '/directory/agents', 'searchAgentDirectory'],
  ['get', '/directory/agents/{agentId}', 'getDirectoryAgent'],
  ['get', '/agents/{agentId}/offers', 'listOffers'],
  ['post', '/agents/{agentId}/offers', 'createOffer'],
  ['get', '/offers/{offerId}', 'getOffer'],
  ['patch', '/offers/{offerId}', 'updateOffer'],
  ['post', '/offers/{offerId}/actions', 'actOnOffer'],
  ['get', '/agents/{agentId}/payment-account', 'getAgentPaymentAccount'],
  ['get', '/agents/{agentId}/payments', 'listAgentPayments'],
  ['get', '/payments/{paymentId}', 'getPayment'],
  ['post', '/fee-quotes', 'createFeeQuote'],
  ['get', '/fee-quotes/{feeQuoteId}', 'getFeeQuote'],
  ['post', '/fee-quotes/{feeQuoteId}/accept', 'acceptFeeQuote'],
  ['get', '/integrations', 'getIntegrations'],
  ['get', '/applications', 'listApplications'],
  ['post', '/applications', 'createApplication'],
  ['get', '/applications/{applicationId}', 'getApplication'],
  ['patch', '/applications/{applicationId}', 'updateApplication'],
  ['delete', '/applications/{applicationId}', 'archiveApplication'],
  ['get', '/applications/{applicationId}/agents', 'listApplicationAgents'],
  ['post', '/applications/{applicationId}/agents', 'linkApplicationAgent'],
  ['delete', '/applications/{applicationId}/agents/{agentId}', 'unlinkApplicationAgent'],
  ['get', '/applications/{applicationId}/enrollment-links', 'listEnrollmentLinks'],
  ['post', '/applications/{applicationId}/enrollment-links', 'createEnrollmentLink'],
  ['delete', '/applications/{applicationId}/enrollment-links/{enrollmentLinkId}', 'revokeEnrollmentLink'],
  ['get', '/applications/{applicationId}/service-accounts', 'listServiceAccounts'],
  ['post', '/applications/{applicationId}/service-accounts', 'createServiceAccount'],
  ['delete', '/applications/{applicationId}/service-accounts/{serviceAccountId}', 'revokeServiceAccount'],
  ['get', '/applications/{applicationId}/webhooks', 'listWebhooks'],
  ['post', '/applications/{applicationId}/webhooks', 'createWebhook'],
  ['delete', '/applications/{applicationId}/webhooks/{webhookId}', 'revokeWebhook'],
  ['get', '/applications/{applicationId}/webhooks/{webhookId}/deliveries', 'listWebhookDeliveries'],
  ['post', '/applications/{applicationId}/webhooks/{webhookId}/deliveries/{deliveryId}/retry', 'retryWebhookDelivery'],
];

const problems = [];

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
if (contract.info?.version !== '1.3.0') {
  problems.push(`expected Darwin API 1.3.0, received ${String(contract.info?.version)}`);
}
if (
  !Array.isArray(contract.servers) ||
  !contract.servers.some((server) => server.url === 'https://api.darwin.so/api/v1')
) {
  problems.push('production server https://api.darwin.so/api/v1 is missing');
}
if (expectedOperations.length !== 73) {
  problems.push(`CLI operation inventory expected 73 entries, received ${expectedOperations.length}`);
}
checkLocalSchemaReferences(contract);

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
