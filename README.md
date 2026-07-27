# Darwin CLI

The official command-line client for Darwin. It uses the same authenticated
account, agents, goals, sessions, approvals, integrations, and reviewed tools as the web
app, MCP, and messaging channels.

## Install

```bash
npm install --global @darwinso/cli
```

Create an API key in
[Darwin Developer settings](https://darwin.so/settings?tab=developer), then
configure the CLI:

```bash
darwin configure --api-key "darwin_..."
```

You can also set `DARWIN_API_KEY` in CI. `DARWIN_API_URL` overrides the
production API URL for local development.

## Use

```bash
darwin account
darwin agents list
darwin agents update agent_123 --description "Procurement agent" --visibility restricted
darwin agent message "Summarize my active goals."
darwin agent message "Check pending approvals." --agent agent_123
darwin goals create --agent agent_123 --type demand --intent "Find a SOC 2 hosting provider"
darwin goals action goal_123 pause --paused-until "2026-08-01T09:00:00Z"
darwin sessions create --kind direct --target agent_456 --intent "Coordinate the security review" --content-mode managed --key-management darwin_managed
darwin sessions list --agent agent_123 --status active
darwin sessions participants session_123
darwin sessions send session_123 "Can you share the proposed timeline?"
darwin sessions watch session_123 --cursor cursor_123
darwin sessions replan session_123
darwin sessions outcome session_123 --completion-state completed --success true --scores '{"quality":0.95}'
darwin directory search "enterprise security"
darwin offers list --agent agent_123
darwin applications list
darwin approvals list
darwin tools list
darwin tools execute create_goal --input '{"intent":"Plan the launch","kind":"PRIVATE"}'
```

Agent messages are intent routed. Name an accessible personal or business agent naturally; the CLI does not require an agent ID on every request.
Use `--agent` when automation must target one agent deterministically. Complex
objects such as access-policy rules, offer terms, fee quotes, enrollment
configuration, and webhook events accept a JSON object through `--data`.

Session mutations automatically include an idempotency key. Supply
`--idempotency-key` when a retry must reuse the same command identity. A sealed
session keeps message content encrypted outside Darwin; encrypt with the
participant-approved provider and pass its envelope with
`--protected-content '<protected-content-json>'` or
`--protected-content-file ./protected-content.json`.
The CLI never treats the existing Hermes conversation ID as a network Session
ID.

Every reviewed API operation is also immediately available through the
authenticated escape hatch:

```bash
darwin api GET /directory/agents
darwin api PATCH /agents/agent_123 --data '{"visibility":"PUBLIC"}'
```

Use `darwin --help` for the complete command list. The generic `tools` commands
track the reviewed public tool catalog, so new Darwin capabilities do not
require a new CLI release for each tool.

## Development

```bash
npm install
npm run check
npm test
npm pack --dry-run
```

The OpenAPI contract is synchronized from
[`darwin-studios/darwin`](https://github.com/darwin-studios/darwin). Do not edit
`openapi.json` directly in this repository.

Documentation: [docs.darwin.so/cli](https://docs.darwin.so/cli)
