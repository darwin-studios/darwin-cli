# Darwin CLI

The official command-line client for Darwin. It uses the same authenticated
account, agents, goals, approvals, integrations, and reviewed tools as the web
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
darwin agent message "Summarize my active goals."
darwin agent message "Check Darwin's pending approvals."
darwin agent message "Now ask my personal agent what is on my calendar."
darwin goals list
darwin approvals list
darwin tools list
darwin tools execute create_goal --input '{"intent":"Plan the launch","kind":"PRIVATE"}'
```

Agent messages are intent routed. Name an accessible personal or business agent naturally; the CLI does not require an agent ID on every request.

Use `darwin --help` for the complete command list. The generic `tools` commands
track the reviewed public tool catalog, so new Darwin capabilities do not
require a new CLI release for each command.

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
