# @hasna/attachments

Open-source attachment transfer for agents and teams with local or private S3
object storage, share links, a CLI, an MCP server, and local and hosted REST
APIs.

[![npm](https://img.shields.io/npm/v/@hasna/attachments)](https://www.npmjs.com/package/@hasna/attachments)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/attachments
```

The package installs three binaries:

- `attachments` — local-first CLI and REST server
- `attachments-mcp` — MCP server over Streamable HTTP or stdio
- `attachments-serve` — self-hosted Postgres + S3 service

## Quick Start

Fresh installs need no S3 configuration. Files are stored under
`~/.hasna/attachments/objects`, metadata is stored in SQLite, and public links
use the local server.

```bash
attachments upload report.pdf
attachments list
attachments serve
```

The server listens on `http://localhost:3459` by default. Open the URL returned
by `attachments upload`, or download by attachment ID:

```bash
attachments download att_xxx --output ./downloads/
```

## CLI

Run `attachments <command> --help` for complete options.

| Area | Commands |
|------|----------|
| Transfer | `upload`, `download`, `list`, `delete`, `remove`, `link` |
| Direct S3 upload | `presign-upload`, `presign-complete` |
| Configuration | `config show`, `config set`, `config test`, `domain` |
| Service and diagnostics | `serve`, `status`, `whoami`, `doctor`, `health-check`, `clean`, `report` |
| Agent integrations | `mcp`, `init`, `heartbeat`, `focus`, `link-task`, `complete-task`, `resolve-evidence`, `snapshot-session`, `task-journal`, `watch` |

Common upload controls include expiry, tags, passwords, encrypted storage,
download limits, email gates, JSON output, stdin input, and internal-network
links:

```bash
attachments upload report.pdf --expiry 24h --tag task:TASK-042
attachments upload archive.zip --password "$ATTACHMENT_PASSWORD" --encrypt --max-downloads 1
printf 'hello\n' | attachments upload --stdin --filename greeting.txt --format json
```

## Storage and Links

Storage defaults to `auto`: it uses S3 when a bucket and region are configured,
and local object storage otherwise.

```bash
attachments config set --storage-backend local
attachments config set --storage-backend s3 --bucket my-bucket --region us-east-1
attachments config set --max-size 10737418240 # 10 GiB
```

The configured default link type is `presigned`. A request automatically uses
an app-hosted server link when a presigned S3 URL cannot represent it, including
local storage, expiry beyond seven days, non-expiring links, passwords,
encryption, download limits, and email gates. The S3 bucket can remain private
in both modes.

Use `--link-type presigned|server` on uploads, or change the default:

```bash
attachments config set --link-type server --expiry 7d
```

## Local REST API

`attachments serve` starts the local SQLite-backed API on port `3459`.
`GET /api/health` is public. Other `/api/*` routes require a bearer token only
when `ATTACHMENTS_API_TOKEN` or `HASNA_ATTACHMENTS_API_TOKEN` is set.

| Surface | Path |
|---------|------|
| Attachments API | `/api/attachments` |
| Health, context, report | `/api/health`, `/api/context`, `/api/report` |
| Public share page | `/a/<token>` |
| Legacy public download | `/d/<attachment-id>` |

The attachment API supports JSON/base64, raw-body, multipart form, multipart
S3 upload, presigned upload completion, listing, metadata, deletion, downloads,
and link regeneration.

## Self-Hosted Service

`attachments-serve` is the hosted API. It reads and writes Postgres and object
storage directly; there is no local/cloud sync engine or cache mode.

```bash
export HASNA_ATTACHMENTS_STORAGE_MODE=cloud
export HASNA_ATTACHMENTS_DATABASE_URL=postgres://...
export HASNA_ATTACHMENTS_API_SIGNING_KEY=replace-me
export ATTACHMENTS_S3_BUCKET=my-bucket
export ATTACHMENTS_PUBLIC_BASE_URL=https://files.example.com

attachments-serve
```

It runs migrations before serving unless `--no-migrate` or
`ATTACHMENTS_SKIP_MIGRATE=1` is set. Use `attachments-serve migrate` for a
one-shot migration. The hosted surface exposes public `/health`, `/ready`,
`/version`, and `/openapi.json` endpoints plus the authenticated `/v1` API.

## Public Domains

Domain support is declarative and does not mutate DNS. Configure public routing,
export a credential-free plan, then probe the deployed attachment prefix:

```bash
attachments domain configure \
  --hostname files.example.com \
  --attachments-origin https://attachments-origin.example.com \
  --fallback-origin https://shortlinks-origin.example.com \
  --provider cloudflare

attachments domain plan --format cloudflare
attachments domain verify --format json
```

On a shared hostname, route `/a/*` to attachments before a generic `/*`
shortlink or redirect route.

## MCP Server

`attachments-mcp` defaults to Streamable HTTP on `127.0.0.1:8850`. Use `--stdio`
for clients that launch one MCP process per session.

```bash
attachments-mcp                       # http://127.0.0.1:8850/mcp
attachments-mcp --port 9000           # HTTP port override
attachments-mcp --stdio               # stdio transport
MCP_STDIO=1 attachments-mcp           # stdio transport via environment
```

- Health: `GET http://127.0.0.1:8850/health`
- MCP: `http://127.0.0.1:8850/mcp`
- Port environment override: `MCP_HTTP_PORT`

`ATTACHMENTS_PROFILE` controls the lean schemas returned by `tools/list`:

| Profile | Tools | Intended use |
|---------|------:|--------------|
| `minimal` | 3 | Upload, download, and link retrieval |
| `standard` | 13 | Default transfer, reporting, task, context, and agent workflow |
| `full` | 22 | Every tool, including S3 setup, presigned upload, health, search, and feedback |

Install MCP configuration for supported clients with:

```bash
attachments mcp --claude
attachments mcp --codex
attachments mcp --gemini
attachments mcp --all
attachments mcp --uninstall --all
```

## Configuration and Data

Configuration is stored in `~/.hasna/attachments/config.json`; secrets are
masked by `attachments config show`. SQLite metadata defaults to
`~/.hasna/attachments/db.sqlite` and can be overridden with
`HASNA_ATTACHMENTS_DB_PATH`.

On first use, missing files from legacy `~/.open-attachments/` and
`~/.attachments/` directories are copied into the canonical directory without
overwriting existing files.

## Development

Requires Bun.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

## Documentation

- [CLI reference](docs/cli.md)
- [MCP reference](docs/mcp.md)
- [HTTP API reference](docs/api.md)
- [Configuration and deployment](docs/configuration.md)

## License

Apache-2.0 — see [LICENSE](LICENSE).
