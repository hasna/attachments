# @hasna/attachments — Agent Guide

WeTransfer for AI agents. Upload files, get shareable links, backed by your own S3 bucket (AWS, MinIO, Cloudflare R2, or any S3-compatible storage).

- **CLI** — `attachments upload`, `download`, `list`, `delete`, `link`, `config`, `serve`, `mcp`
- **MCP server** — lean-stub tools for Claude Code, Codex, Gemini, and any MCP-compatible agent
- **REST API** — 8 endpoints via Hono, runs on port **3459**
- **TypeScript SDK** — `@hasna/attachments-sdk`, zero dependencies

---

## Key Commands

```bash
# Install globally
npm install -g @hasna/attachments

# Configure S3 (one time)
attachments config set --bucket my-bucket --region us-east-1 \
  --access-key AKIAIOSFODNN7EXAMPLE \
  --secret-key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

# Upload a file — prints link to stdout
attachments upload ./report.pdf

# Upload with expiry and tag
attachments upload ./output.json --expiry 30d --tag task-evidence

# Download by ID
attachments download att_abc123 --out ./local-copy.pdf

# List uploads
attachments list

# Delete by ID
attachments delete att_abc123

# Get a fresh link for an existing upload
attachments link att_abc123

# Start REST API server (port 3459)
attachments serve

# Start MCP server
attachments mcp
```

### Build & Test

```bash
bun run build          # Build all targets
bun run build:cli      # Build CLI only
bun run test           # Run test suite
bun run test:coverage  # Run with coverage
bun run dashboard      # Start dashboard dev server
```

---

## Standard Agent Workflow

### Session Start

```bash
mementos memory-inject --project open-attachments --format compact  # Load context (compact = 60% token savings)
```

### Uploading Evidence (during work)

```bash
# Upload a file and get a shareable link
attachments upload ./output.json --tag "task-evidence" --expiry 30d

# Link to your current todo task
attachments link-task <attachment-id> <task-id>
```

### Session End (completing a task with evidence)

```bash
# Upload files AND complete the task in one command
attachments complete-task <task-id> --file ./report.pdf --file ./output.json --notes "implementation complete"

# Archive the session transcript
attachments snapshot-session <session-id> --tag "$(date +%Y-%m-%d)"
```

### Health Check (periodic maintenance)

```bash
# Check for expired attachment links
attachments health-check --fix
```

### Environment Variables

- `ATTACHMENTS_PROFILE=minimal|standard|full` (default: `standard`, controls MCP tools exposed)
- `ATTACHMENTS_TRACK_COSTS=1` (enable @hasna/economy cost tracking)
- `ATTACHMENTS_ECONOMY_URL=http://localhost:3456`

### Integration Points

- **todos**: `complete-task` uploads files + marks task done with `attachment_ids`
- **sessions**: `snapshot-session` exports session transcript as shareable link
- **economy**: `ATTACHMENTS_TRACK_COSTS=1` logs upload costs to @hasna/economy
- **mementos**: tag uploads with project/session for organized storage
- **Tag conventions**: use `task:TASK-ID`, `session:SESSION-ID`, `project:NAME`, `agent:NAME` for cross-agent discovery (e.g. `attachments list --tag task:OPE-00123`)

---

## MCP Tool Profiles

| Tool | minimal | standard | full |
|------|---------|----------|------|
| `upload_attachment` | yes | yes | yes |
| `download_attachment` | yes | yes | yes |
| `list_attachments` | — | yes | yes |
| `delete_attachment` | — | yes | yes |
| `get_link` | — | yes | yes |
| `configure_s3` | — | — | yes |
| `search_tools` | — | yes | yes |
| `describe_tools` | — | yes | yes |

Set profile via `ATTACHMENTS_PROFILE` env var before starting the MCP server.

---

## REST API (port 3459)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/upload` | Upload a file |
| `GET` | `/download/:id` | Download by attachment ID |
| `GET` | `/list` | List all attachments |
| `DELETE` | `/:id` | Delete by ID |
| `GET` | `/link/:id` | Get a fresh presigned link |
| `GET` | `/health` | Health check |
| `POST` | `/configure` | Update S3 config at runtime |
| `GET` | `/config` | View current config (keys redacted) |

Start with: `attachments serve` or `bun run src/cli/index.ts serve`

---

## Project Structure

```
src/
  cli/        — CLI entry point (commander)
  mcp/        — MCP server (stub tools)
  api/        — Hono REST API
  s3/         — S3 client wrapper
  config/     — Config file management (~/.attachments/config.json)
  types/      — Shared TypeScript types
sdk/          — @hasna/attachments-sdk (standalone, zero-dep)
dashboard/    — Web UI (Bun + Vite)
scripts/      — test.sh and utility scripts
dist/         — Build output
```

---

## Config File

Stored at `~/.attachments/config.json`. Managed via `attachments config set/get/reset`.

```json
{
  "bucket": "my-bucket",
  "region": "us-east-1",
  "accessKey": "AKIA...",
  "secretKey": "...",
  "endpoint": "https://s3.amazonaws.com",
  "linkMode": "presigned",
  "defaultExpiry": "7d"
}
```
