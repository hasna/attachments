# Attachments Documentation

The root [README](../README.md) is the quick start. These pages document the
current executable surfaces in more detail.

- [CLI reference](cli.md) — commands, arguments, options, and integrations
- [MCP reference](mcp.md) — transports, profiles, and all 22 tools
- [HTTP API reference](api.md) — local and self-hosted APIs
- [Configuration and deployment](configuration.md) — storage, links,
  environment variables, domains, and hosted operation

The package has two HTTP applications with intentionally different contracts:

- `attachments serve` is the local-first SQLite API under `/api`.
- `attachments-serve` is the self-hosted Postgres API under `/v1` and publishes
  its OpenAPI document at `/openapi.json`.

There is no local/cloud synchronization workflow. Local mode uses SQLite;
self-hosted cloud mode reads and writes Postgres directly.
