# `@hasna/attachments` — Claude Guide

Start with [README.md](README.md). Detailed references:

- [CLI commands](docs/cli.md)
- [MCP server and tools](docs/mcp.md)
- [Local and hosted APIs](docs/api.md)
- [Configuration and deployment](docs/configuration.md)

## Common Commands

```bash
npm install -g @hasna/attachments

attachments upload ./report.pdf --tag task:TASK-042 --expiry 7d
attachments download att_xxx --output ./downloads/
attachments list --tag task:TASK-042
attachments link att_xxx --regenerate --expiry 24h
attachments serve

attachments complete-task TASK-042 --file ./report.pdf --notes "Complete"
attachments snapshot-session SESSION-ID --tag session:SESSION-ID
attachments health-check --fix
```

## MCP

```bash
attachments mcp --claude
attachments-mcp                 # Streamable HTTP, 127.0.0.1:8850
attachments-mcp --stdio         # stdio transport
```

Profiles expose 3 (`minimal`), 13 (`standard`, default), or 22 (`full`) tools.
Set `ATTACHMENTS_PROFILE` before starting the server.

## Runtime Model

- Local CLI/API: SQLite plus local or private S3 object storage.
- Hosted `attachments-serve`: direct Postgres plus S3-compatible storage.
- No local/cloud sync or cache mode.
- Default link preference: presigned; protected, constrained, local, long-lived,
  and non-expiring links automatically use server-hosted routes.
- Local API: `/api`; hosted API: `/v1` with `/openapi.json`.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

Do not edit `src/generated/storage-kit/` manually. Regenerate it through
`@hasna/contracts` as described in its generated README.
