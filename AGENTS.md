# AGENTS.md — `@hasna/attachments`

Agent-facing quick reference. Use the maintained references for complete
behavior:

- [CLI](docs/cli.md)
- [MCP](docs/mcp.md)
- [HTTP APIs](docs/api.md)
- [Configuration and deployment](docs/configuration.md)

## Setup

```bash
npm install -g @hasna/attachments
attachments mcp --claude
attachments mcp --codex
attachments mcp --gemini
attachments mcp --all
attachments mcp --uninstall --all
```

`attachments-mcp` defaults to Streamable HTTP at
`http://127.0.0.1:8850/mcp`. Use `--stdio` or `MCP_STDIO=1` for stdio clients.

## MCP Profiles

`tools/list` returns lean schemas. Set `ATTACHMENTS_PROFILE` before startup.

| Profile | Count | Scope |
|---------|------:|-------|
| `minimal` | 3 | Upload, download, link retrieval |
| `standard` | 13 | Default transfer, task, report, context, and agent tools |
| `full` | 22 | Every MCP tool |

Use `describe_tools` for verbose attachment-workflow schemas and `search_tools`
to find tools by name. The full list is in [docs/mcp.md](docs/mcp.md).

## Standard Workflow

```text
1. Upload evidence with upload_attachment or attachments upload.
2. Tag it with task:ID, session:ID, project:NAME, or agent:NAME.
3. Use link_to_task, or complete_task_with_files to upload and complete.
4. Use save_session when a transcript must be preserved.
5. Run check_attachment_health or attachments health-check periodically.
```

Todos integrations default to `http://localhost:3000`; sessions defaults to
`http://localhost:3458`. Supply `todos_url` or `sessions_url` to override them.

## Storage

Fresh local installs use SQLite and local objects without S3 configuration.
With an S3 bucket and region, `auto` storage selects S3. The default link
preference is `presigned`, with automatic server-link fallback for local
objects, protected links, download limits, email gates, encryption, long
expiry, and non-expiring links.

The `attachments-serve` binary is pure remote: it reads/writes Postgres and
object storage directly. There are no attachment `storage push`, `pull`, or
`sync` commands and no MCP storage-sync tools.

## Local Service

```bash
attachments serve --port 3459
```

- Public health: `GET /api/health`
- Authenticated-when-configured API: `/api/*`
- Public shares: `/a/<token>`
- Context: `GET /api/context`
- Report: `GET /api/report`

Set `ATTACHMENTS_API_TOKEN` or `HASNA_ATTACHMENTS_API_TOKEN` to require bearer
or `X-API-Key` authentication for local `/api/*` routes other than health.

## Useful Commands

```bash
attachments status
attachments whoami
attachments doctor
attachments list --tag task:TASK-042
attachments complete-task TASK-042 --file report.pdf --notes "Verified"
attachments snapshot-session SESSION-ID --tag session:SESSION-ID
attachments health-check --fix
attachments report --days 7 --format markdown
```

Configuration lives at `~/.hasna/attachments/config.json`; SQLite defaults to
`~/.hasna/attachments/db.sqlite` and honors `HASNA_ATTACHMENTS_DB_PATH`.
