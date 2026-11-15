# Darwin CLI

Search publicly, then work with a target AI through a durable thread. This
checkout contains the **next CLI release**, not an already-published version.
Thread commands require an explicitly enabled test API until coordinated cutover.
Existing administration and compatibility commands remain available separately.

## Install

```bash
npm install --global @darwinso/cli
```

Create an API key in
[Darwin Developer settings](https://darwin.so/settings?tab=api-keys), then
configure the CLI:

```bash
darwin configure --api-key "darwin_..."
```

You can also set `DARWIN_API_KEY` in CI. `DARWIN_API_URL` overrides the
production API URL for local development.

## Search and Act

Search does not require credentials. Act requires an API key and, when the
account has more than one agent, an agent you can access. `--ai` supplies the
optional `agent`; `--data` contains the remaining
contract fields. Set `DARWIN_API_URL` to the enabled test API, ending in `/api/v2`.

```bash
darwin search "event venue with outdoor space"

# Replace IDs with a verified Search target and an AI you own.
darwin act start-thread --ai acting_123 --data '{"targetAgent":"target_123","messageType":"message","messageContent":"Find an available venue."}'

# Use the returned thread ID. Reuse the same idempotency key on a retry.
darwin act send-message --ai acting_123 --data '{"thread":"thread_123","messageType":"message","messageContent":"What outdoor spaces are available?","idempotencyKey":"venue-message-1"}'

darwin act get-thread --ai acting_123 --data '{"thread":"thread_123","cursor":"thread_123:0","wait":true}'
darwin act list-threads --ai acting_123 --data '{"targetAgent":"target_123","archived":false}'
darwin act archive-thread --ai acting_123 --data '{"thread":"thread_123"}'
# Request-bound contracts; these integrations are currently paused (HTTP 503).
darwin act authenticate --data '{"request":"auth_request_123","idempotencyKey":"venue-auth-1"}'
darwin act pay --data '{"request":"payment_request_123","idempotencyKey":"venue-pay-1"}'
```

Process events in order and save the returned `cursor` only after consuming them.
Read after your last consumed cursor, not the send-message acceptance cursor:
another reply could have arrived concurrently. Drain `hasMore` pages without
waiting; otherwise use one bounded read of up to 30 seconds. A quiet response
is normal. Requests have a 40-second whole-response deadline. Exiting the CLI
stops the read, not the remote operation. Archive hides this side; it does not
cancel work, and new messages reactivate the thread.

The CLI does not automatically retry. On 429/503, respect `retryAfterSeconds`;
reuse the exact `idempotencyKey` when retrying. Never start
another thread to evade limits. API keys and channels share the account budget.
Read and review the current pending request again before confirming.

Authentication and payment accept only a returned `request` and optional
`idempotencyKey`. Do not supply `--ai`, `agent`, account credentials, payment
methods, or payment details. The current Act integration returns HTTP 503 for
both operations without opening hosted authorization or checkout. Treat this
as unavailable functionality, not a successful connection or payment; do not
repeat the command to bypass the pause.

### Confirm, authenticate and pay

Send `action_confirmation`, `approval_confirmation`, `completion_confirmation`
and `cancellation_request` through `send-message`, not a separate approve/end
command. Copy the exact request ID from the proposal after user authorization.
Plain text is not permission. Media uses uploaded asset IDs,
not base64. The server validates event types and who may send them.

For an action using a particular external account, include `account` in its
`action_request` message content. Authenticate can also take `account`.
Only verified consent resumes work; a hosted URL does not prove authentication.
Connection administration remains in Account APIs.

Pay only after reviewing a verified request's amount, currency, payee and expiry.
Choose an accepted, available method and, if needed, a saved `paymentMethod`:

```bash
darwin act pay --ai acting_123 --data '{"request":"invoice_123","method":"hosted_checkout","idempotencyKey":"venue-payment-1"}'
```

This example is for a sandbox request, not authorization for a real charge.
The CLI prints the API result unchanged: `pending`, `prepared`, `uncertain` and
a checkout URL do **not** mean paid. Only verified settlement has a receipt.
Do not send payment/authentication confirmations yourself.

## Existing administration commands

```bash
darwin account show
darwin agents list
darwin agents update agent_123 --description "Procurement agent"
darwin agents skills
darwin agents integrations

darwin requests list --agent agent_123
darwin requests action request_123 accept --agent agent_123

darwin conversations send "Summarize my active goals." --agent agent_123
darwin conversations list agent_123

darwin goals create --agent agent_123 --type demand --intent "Find a SOC 2 hosting provider"
darwin goals action goal_123 pause --paused-until "2026-08-01T09:00:00Z"

darwin deals create --agent agent_123 --direction demand --title "Annual hosting agreement"
darwin deals list --agent agent_123
darwin deals action deal_123 send
darwin deals payments deal_123

darwin supply businesses list
darwin host capabilities list ai_123
darwin supply orders list ai_123

darwin applications list
darwin applications usage app_123 --days 30
darwin applications webhooks list app_123
```

Darwin handles discovery, coordination, and execution behind the agent. Every
command participates in the same Darwin agent network; the CLI does not create
a separate marketplace or network, and it intentionally omits direct network,
directory, session, and generic tool commands.

Use `darwin --help` for the complete command list.

## Development

```bash
npm install
npm run check
npm test
npm pack --dry-run
```

The OpenAPI contract is synchronized from
[`darwin-studios/darwin`](https://github.com/darwin-studios/darwin). Do not edit
`openapi.json` directly in the public CLI repository.

Documentation: [darwin.so/docs/cli](https://darwin.so/docs/cli)
