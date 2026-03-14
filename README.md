# @hasna/attachments

> File storage and sharing for AI agents — upload files, get shareable links, backed by your own S3 bucket.

Give your AI agents a place to put files. Upload a local file, get back a link you can paste into any chat or share with anyone. Works with AWS S3, MinIO, Cloudflare R2, or any S3-compatible storage. Your bucket, your data.

---

## What It Does

`@hasna/attachments` is a full-stack file attachment system built for AI agent workflows. It provides a CLI with 17+ commands, a 14-tool MCP server (with token-optimized profiles), a Hono-based REST API, a React dashboard, and a zero-dependency TypeScript SDK. Agents can upload artifacts, link files to tasks, snapshot session state, and watch for attachment activity — all with a single npm install.

---

## Features

- **CLI** — 17+ commands: `upload`, `download`, `list`, `delete`, `link`, `config`, `serve`, `mcp`, `status`, `clean`, `whoami`, `presign-upload`, `link-task`, `complete-task`, `snapshot-session`, `health-check`, `watch`, `task-journal`
- **MCP server** — 14 tools with `ATTACHMENTS_PROFILE=minimal|standard|full` for token optimization
- **REST API** — 8+ endpoints served by Hono on port 3457 (localhost binding by default)
- **TypeScript SDK** — `@hasna/attachments-sdk`, zero dependencies, works in Node.js, Bun, Deno, and the browser
- **Dashboard** — React + Vite UI with dark/light mode
- **Integrations** — todos (`link-task`, `complete-task`, `watch`, `task-journal`), sessions (`snapshot-session`), economy (`ATTACHMENTS_TRACK_COSTS`)
- **Health check** — `attachments health-check [--fix]` with watch mode (SSE-based reactive)
- **Bring your own S3** — AWS, MinIO, Cloudflare R2, LocalStack, or any S3-compatible endpoint
- **Security** — localhost binding by default; opt-in to external exposure with `--host 0.0.0.0`
- **Configurable expiry** — `30m`, `24h`, `7d`, `never`

---

## Quick Start

```bash
# 1. Install
npm install -g @hasna/attachments

# 2. Configure S3 (one time)
attachments config set --bucket my-bucket --region us-east-1 \
  --access-key AKIAIOSFODNN7EXAMPLE \
  --secret-key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

# 3. Upload a file
attachments upload ./report.pdf

# ✓ Uploaded report.pdf
#   Link:    https://my-bucket.s3.us-east-1.amazonaws.com/att_abc123.pdf?...
#   ID:      att_abc123
#   Size:    142.3 KB
#   Expires: 2026-03-19
```

---

## S3 Setup Guide

### AWS S3

1. Sign in to the [AWS Console](https://console.aws.amazon.com/s3/).
2. Create a bucket. Note the bucket name and region (e.g., `us-east-1`).
3. Go to **IAM → Users → Add user**. Give it programmatic access.
4. Attach the `AmazonS3FullAccess` policy (or a scoped policy with `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`).
5. Copy the **Access Key ID** and **Secret Access Key**.
6. Run:
   ```bash
   attachments config set \
     --bucket YOUR_BUCKET \
     --region YOUR_REGION \
     --access-key YOUR_ACCESS_KEY \
     --secret-key YOUR_SECRET_KEY
   ```
7. Verify the connection:
   ```bash
   attachments config test
   ```

### Cloudflare R2

R2 is S3-compatible with a custom endpoint. Find your endpoint in the Cloudflare Dashboard under **R2 → Your bucket → Settings → S3 API**.

```bash
attachments config set \
  --bucket YOUR_BUCKET \
  --region auto \
  --access-key YOUR_R2_ACCESS_KEY \
  --secret-key YOUR_R2_SECRET_KEY \
  --endpoint https://ACCOUNT_ID.r2.cloudflarestorage.com
```

### MinIO (self-hosted)

```bash
attachments config set \
  --bucket YOUR_BUCKET \
  --region us-east-1 \
  --access-key minioadmin \
  --secret-key minioadmin \
  --endpoint http://localhost:9000
```

### LocalStack (development)

```bash
attachments config set \
  --bucket test-bucket \
  --region us-east-1 \
  --access-key test \
  --secret-key test \
  --endpoint http://localhost:4566
```

---

## CLI Reference

All commands are under the `attachments` binary.

| Command | Description |
|---------|-------------|
| `upload <file>` | Upload a file to S3 and print a shareable link |
| `download <id-or-url>` | Download an attachment to disk |
| `list` | List all attachments in the local database |
| `delete <id>` | Delete an attachment from S3 and local DB |
| `link <id>` | Show or regenerate a shareable link |
| `presign-upload <file>` | Generate a presigned upload URL (no server needed) |
| `config show` | Print current configuration (secrets masked) |
| `config set` | Update configuration values |
| `config test` | Test the S3 connection |
| `serve` | Start the REST API server (default port 3457) |
| `mcp` | Install/uninstall the MCP server into agent configs |
| `status` | Show server and storage status |
| `clean` | Remove expired or orphaned attachments |
| `whoami` | Show current configuration identity |
| `health-check [--fix]` | Check system health; `--fix` attempts auto-repair |
| `watch` | Watch for attachment events (SSE-based reactive stream) |
| `link-task <id> <task-id>` | Link an attachment to a todos task |
| `complete-task <task-id>` | Complete a todos task and attach any pending files |
| `snapshot-session` | Snapshot current session state as an attachment |
| `task-journal <task-id>` | Append a journal entry to a task's attachment log |

### Common options

```bash
attachments upload ./report.pdf --expiry 24h --link-type server
attachments list --format table --limit 50 --expired
attachments delete att_abc123 --yes
attachments serve --port 8080
attachments health-check --fix
```

---

## MCP Server

The MCP server exposes 14 tools. Install it into your agent once:

```bash
# Claude Code
attachments mcp --claude

# All agents (Claude Code, Codex, Gemini)
attachments mcp --all
```

### MCP Profiles

Set `ATTACHMENTS_PROFILE` to control token usage. Lean stubs by default — call `describe_tools` for full schemas.

| Profile | Token cost | When to use |
|---------|-----------|-------------|
| `minimal` | ~200 tokens | Only core upload/download/list. Fastest. |
| `standard` (default) | ~600 tokens | All 14 tools with compact descriptions. |
| `full` | ~1,400 tokens | Full schemas with all options and examples. |

```bash
# Set in your shell profile or agent environment
export ATTACHMENTS_PROFILE=minimal
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `upload_attachment` | Upload a file and get a shareable link |
| `download_attachment` | Download an attachment to disk |
| `list_attachments` | List attachments in the local DB |
| `delete_attachment` | Delete an attachment by ID |
| `get_link` | Get or regenerate a shareable link |
| `configure_s3` | Persist S3 credentials to config |
| `describe_tools` | Return full verbose schema for one or all tools |
| `search_tools` | Search tool names by keyword |
| `health_check` | Check server and S3 health |
| `link_task` | Link an attachment to a todos task |
| `complete_task` | Complete a task and attach pending files |
| `snapshot_session` | Snapshot session state as an attachment |
| `task_journal` | Append a journal entry to a task's log |
| `watch` | Subscribe to attachment events (SSE) |

---

## Agent Workflow

A `CLAUDE.md` is included at the project root documenting the standard agent workflow for using this tool inside Claude Code sessions. Key patterns:

- Upload artifacts with `upload_attachment` and store the ID in task descriptions
- Use `link_task` to associate attachments with todos
- Use `snapshot_session` at the end of a session for continuity
- Use `health_check` before long sessions to verify S3 connectivity
- Use `ATTACHMENTS_PROFILE=minimal` in token-constrained contexts

See `CLAUDE.md` in the repo for the full documented workflow.

---

## Integrations

### todos

Link files to task management workflows:

```bash
attachments link-task att_abc123 TASK-42
attachments complete-task TASK-42          # marks done + attaches pending files
attachments task-journal TASK-42           # append journal entry
attachments watch --task TASK-42           # watch for task-related events
```

### Sessions

Snapshot the current agent session state:

```bash
attachments snapshot-session               # uploads session state, prints attachment ID
```

### Economy (cost tracking)

Set `ATTACHMENTS_TRACK_COSTS=1` to track upload/download costs and report them via the economy MCP:

```bash
export ATTACHMENTS_TRACK_COSTS=1
attachments upload ./large-export.csv
```

---

## REST API

Start the server with `attachments serve` (default port 3457, localhost only).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/attachments` | Upload a file (`multipart/form-data`) |
| `GET` | `/api/attachments` | List attachments |
| `GET` | `/api/attachments/:id` | Get attachment metadata |
| `DELETE` | `/api/attachments/:id` | Delete attachment (S3 + DB) |
| `GET` | `/api/attachments/:id/download` | Download file (redirect or stream) |
| `GET` | `/api/attachments/:id/link` | Get shareable link |
| `POST` | `/api/attachments/:id/link` | Regenerate link |
| `GET` | `/d/:id` | Public shortlink redirect |
| `GET` | `/health` | Health check endpoint |

---

## SDK

```bash
npm install @hasna/attachments-sdk
```

Zero dependencies. Works in Node.js, Bun, Deno, and the browser.

```typescript
import { AttachmentsClient } from "@hasna/attachments-sdk";

const client = new AttachmentsClient({ serverUrl: "http://localhost:3457" });

// Upload (Node.js/Bun: file path; browser: File object)
const attachment = await client.upload("./report.pdf", { expiry: "7d" });
console.log(attachment.link);

// List
const list = await client.list({ limit: 10 });

// Get metadata
const att = await client.get("att_abc123");

// Download to disk (Node.js/Bun)
const { path } = await client.download("att_abc123", "./downloads/");

// Regenerate link
const link = await client.regenerateLink("att_abc123", { expiry: "24h" });

// Delete
await client.delete("att_abc123");
```

| Method | Returns | Description |
|--------|---------|-------------|
| `upload(fileOrPath, opts?)` | `Attachment` | Upload a file |
| `download(idOrUrl, dest?)` | `{ path, filename, size }` | Download to disk |
| `list(opts?)` | `Attachment[]` | List attachments |
| `get(id)` | `Attachment` | Get metadata |
| `delete(id)` | `void` | Delete attachment |
| `getLink(id)` | `string` | Get current link |
| `regenerateLink(id, opts?)` | `string` | Regenerate with new expiry |

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
