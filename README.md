# Darwin CLI

The official command-line client for Darwin. Its public surface matches the
Darwin API: Account, Agents, Requests, Conversations, Goals, Deals, and Connect.

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

darwin connect list
```

Darwin handles discovery, coordination, and execution behind the agent. The
CLI intentionally does not provide direct network, directory, session, or
generic tool commands.

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

Documentation: [docs.darwin.so/cli](https://docs.darwin.so/cli)
