# @hasna/attachments

> WeTransfer for AI agents — upload files, get shareable links, backed by your own S3 bucket.

Give your AI agents a place to put files. Upload a local file, get back a link you can paste into any chat or share with anyone. Works with AWS S3, MinIO, Cloudflare R2, or any S3-compatible storage. Your bucket, your data.

## Features

- **CLI** — `attachments upload`, `download`, `list`, `delete`, `link`, `config`, `serve`, `mcp`
- **MCP server** — 8 lean-stub tools for Claude Code, Codex, Gemini, and any MCP-compatible agent
- **REST API** — 8 endpoints served by Hono (Bun or Node.js)
- **TypeScript SDK** — `@hasna/attachments-sdk`, zero dependencies, works in Node.js, Bun, Deno, and browsers
- **Bring your own S3** — AWS, MinIO, Cloudflare R2, LocalStack, or any S3-compatible endpoint
- **Presigned URLs or server links** — choose how links are generated
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

# 4. Get the shareable link printed to stdout
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

### `upload <file>`

Upload a local file to S3 and print a shareable link.

```bash
attachments upload ./report.pdf
attachments upload ./data.csv --expiry 24h
attachments upload ./archive.zip --expiry never --link-type server
attachments upload ./image.png --format json
```

| Option | Description |
|--------|-------------|
| `--expiry <time>` | Link expiry: `30m`, `24h`, `7d`, `never`. Defaults to configured value (`7d`). |
| `--link-type <type>` | `presigned` (S3 signed URL) or `server` (local server shortlink). |
| `--format <fmt>` | `human` (default) or `json`. |

### `download <id-or-url>`

Download an attachment to disk by its ID or a `/d/:id` shortlink URL.

```bash
attachments download att_abc123
attachments download att_abc123 --output ./downloads/
attachments download http://localhost:3457/d/att_abc123 --output ./file.pdf
```

| Option | Description |
|--------|-------------|
| `--output <path>` | Destination directory or filename. Defaults to the current directory. |

### `list`

List all uploaded attachments stored in the local database.

```bash
attachments list
attachments list --format table
attachments list --format json
attachments list --limit 50 --expired
```

| Option | Description |
|--------|-------------|
| `--format <format>` | `compact` (default), `table`, or `json`. |
| `--limit <n>` | Maximum number of results (default: 20). |
| `--expired` | Include attachments whose links have expired. |

### `delete <id>`

Delete an attachment from S3 and the local database. Prompts for confirmation unless `--yes` is passed.

```bash
attachments delete att_abc123
attachments delete att_abc123 --yes
```

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip the confirmation prompt. |

### `link <id>`

Show or regenerate the shareable link for an attachment.

```bash
attachments link att_abc123
attachments link att_abc123 --regenerate
attachments link att_abc123 --regenerate --expiry 48h
attachments link att_abc123 --format json
```

| Option | Description |
|--------|-------------|
| `--regenerate` | Generate a fresh presigned URL and persist it. |
| `--expiry <time>` | Expiry for the regenerated link. |
| `--format <format>` | `human` (default) or `json`. |

### `config show`

Print the current configuration. Secrets are masked.

```bash
attachments config show
```

### `config set`

Update one or more configuration values. Persisted to `~/.attachments/config.json`.

```bash
attachments config set --bucket my-bucket
attachments config set --expiry 24h --link-type presigned
attachments config set --port 8080 --base-url http://myserver.example.com:8080
```

| Option | Description |
|--------|-------------|
| `--bucket <bucket>` | S3 bucket name. |
| `--region <region>` | AWS region (e.g., `us-east-1`). |
| `--access-key <id>` | AWS access key ID. |
| `--secret-key <key>` | AWS secret access key. |
| `--endpoint <url>` | Custom S3 endpoint (MinIO, R2, LocalStack). |
| `--port <port>` | Server port (default: 3457). |
| `--base-url <url>` | Server base URL for shortlinks. |
| `--expiry <time>` | Default link expiry. |
| `--link-type <type>` | Default link type: `presigned` or `server`. |

### `config test`

Test the S3 connection by listing one object from the configured bucket.

```bash
attachments config test
```

### `serve`

Start the REST API server (Hono, runs on Bun or Node.js).

```bash
attachments serve
attachments serve --port 8080
attachments serve --port 8080 --host 0.0.0.0
```

| Option | Description |
|--------|-------------|
| `--port <number>` | Port to listen on. Overrides the configured value. |
| `--host <string>` | Host to bind to (default: `localhost`). |

### `mcp`

Install or uninstall the MCP server into AI agent configurations.

```bash
# Install into Claude Code
attachments mcp --claude

# Install into all supported agents
attachments mcp --all

# Uninstall from Codex
attachments mcp --codex --uninstall
```

| Option | Description |
|--------|-------------|
| `--claude` | Target Claude Code. |
| `--codex` | Target Codex. |
| `--gemini` | Target Gemini. |
| `--all` | Target all agents. |
| `--uninstall` | Remove instead of install. |

---

## MCP Tools Reference

The MCP server (`attachments-mcp`) exposes 8 tools with lean stubs by default to minimize token usage. Call `describe_tools` for full schemas.

| Tool | Description | Required args |
|------|-------------|---------------|
| `upload_attachment` | Upload file → get shareable link | `path` |
| `download_attachment` | Download attachment to disk | `id_or_url` |
| `list_attachments` | List attachments in the local DB | — |
| `delete_attachment` | Delete attachment by ID (DB only) | `id` |
| `get_link` | Get or regenerate shareable link | `id` |
| `configure_s3` | Persist S3 credentials to config file | `bucket`, `region`, `access_key`, `secret_key` |
| `describe_tools` | Return full verbose schema for one or all tools | — |
| `search_tools` | Search tool names by keyword | `query` |

### Tool details

**`upload_attachment`**

```json
{ "path": "/tmp/report.pdf", "expiry": "7d", "tag": "weekly-report" }
```

Returns `{ id, link, size, filename, expires_at }`.

**`download_attachment`**

```json
{ "id_or_url": "att_abc123", "dest": "/tmp/downloads" }
```

Returns `{ path, filename, size }`.

**`list_attachments`**

```json
{ "limit": 10, "format": "compact" }
```

`format` is `"compact"` (one line per attachment) or `"json"` (array).

**`get_link`**

```json
{ "id": "att_abc123", "regenerate": true, "expiry": "24h" }
```

Returns `{ link, expires_at }`.

**`configure_s3`**

```json
{
  "bucket": "my-bucket",
  "region": "us-east-1",
  "access_key": "AKIA...",
  "secret_key": "secret...",
  "base_url": "https://..."
}
```

**`describe_tools`**

```json
{ "tool_name": "upload_attachment" }
```

Omit `tool_name` to get schemas for all tools.

### Installing the MCP server

```bash
# Claude Code
attachments mcp --claude
# or manually:
claude mcp add --transport stdio --scope user attachments -- attachments-mcp

# Codex — adds to ~/.codex/config.toml
attachments mcp --codex

# Gemini — adds to ~/.gemini/settings.json
attachments mcp --gemini

# All at once
attachments mcp --all
```

---

## REST API Reference

Start the server with `attachments serve` (default port 3457). All endpoints are under `/api/attachments`.

### `POST /api/attachments` — Upload a file

Accepts `multipart/form-data`.

**Request fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | The file to upload. |
| `expiry` | string | No | Link expiry (e.g., `24h`, `7d`, `never`). |
| `tag` | string | No | Optional tag for the attachment. |

**Response `201`:**

```json
{
  "id": "att_abc123",
  "filename": "report.pdf",
  "size": 145678,
  "link": "https://bucket.s3.us-east-1.amazonaws.com/att_abc123.pdf?...",
  "expires_at": 1742428800000,
  "created_at": 1741824000000
}
```

---

### `GET /api/attachments` — List attachments

**Query parameters:**

| Parameter | Description |
|-----------|-------------|
| `limit` | Max results (default: 20). |
| `fields` | Comma-separated field names to include (e.g., `id,filename,link`). |
| `format` | `compact` returns newline-delimited JSON. |
| `expired` | `true` to include expired attachments. |

**Response `200`:**

```json
[
  {
    "id": "att_abc123",
    "filename": "report.pdf",
    "size": 145678,
    "content_type": "application/pdf",
    "link": "https://...",
    "expires_at": 1742428800000,
    "created_at": 1741824000000
  }
]
```

---

### `GET /api/attachments/:id` — Get attachment metadata

**Response `200`:** Same shape as a single item from the list response.

**Response `404`:** `{ "error": "Not found" }`

---

### `DELETE /api/attachments/:id` — Delete attachment

Deletes from S3 and removes from the local database.

**Response `200`:** `deleted: att_abc123`

**Response `404`:** `{ "error": "Not found" }`

---

### `GET /api/attachments/:id/download` — Download file

If the link is a presigned S3 URL, responds with `302` redirect. Otherwise streams the file directly from S3.

**Response `302`:** Redirect to S3.

**Response `200`:** File binary with `Content-Disposition: attachment; filename="..."`.

---

### `GET /api/attachments/:id/link` — Get shareable link

**Response `200`:**

```json
{ "link": "https://...", "expires_at": 1742428800000 }
```

---

### `POST /api/attachments/:id/link` — Regenerate link

**Request body (optional JSON):**

```json
{ "expiry": "48h" }
```

**Response `200`:**

```json
{ "link": "https://...", "expires_at": 1742601600000 }
```

---

### `GET /d/:id` — Shortlink redirect

Public shortlink that redirects to the file. If a presigned URL exists, redirects to it (302). Otherwise generates a new presigned URL on the fly and redirects.

---

## SDK Usage

Install the SDK:

```bash
npm install @hasna/attachments-sdk
```

The SDK is zero-dependency and works in Node.js, Bun, Deno, and the browser.

```typescript
import { AttachmentsClient } from "@hasna/attachments-sdk";

const client = new AttachmentsClient({
  serverUrl: "http://localhost:3457",
});

// Upload (Node.js / Bun — pass a file path)
const attachment = await client.upload("./report.pdf", { expiry: "7d" });
console.log(attachment.link); // https://...

// Upload (browser — pass a File object)
const file = document.querySelector<HTMLInputElement>("#file")!.files![0];
const attachment = await client.upload(file, { tag: "user-upload" });

// List
const attachments = await client.list({ limit: 10 });

// Get metadata for one attachment
const att = await client.get("att_abc123");

// Download to disk (Node.js / Bun)
const result = await client.download("att_abc123", "./downloads/");
console.log(result.path); // /home/user/downloads/report.pdf

// Get shareable link
const link = await client.getLink("att_abc123");

// Regenerate link with new expiry
const newLink = await client.regenerateLink("att_abc123", { expiry: "24h" });

// Delete (removes from S3 and database)
await client.delete("att_abc123");
```

### `AttachmentsClient` API

| Method | Signature | Description |
|--------|-----------|-------------|
| `upload` | `(filePathOrBlob, opts?) → Attachment` | Upload a file. |
| `download` | `(idOrUrl, destPath?) → { path, filename, size }` | Download to disk (Node/Bun). |
| `list` | `(opts?) → Attachment[]` | List attachments. |
| `get` | `(id) → Attachment` | Get attachment metadata. |
| `delete` | `(id) → void` | Delete attachment. |
| `getLink` | `(id) → string` | Get current shareable link. |
| `regenerateLink` | `(id, opts?) → string` | Regenerate link with optional new expiry. |

### `Attachment` type

```typescript
interface Attachment {
  id: string;
  filename: string;
  s3Key: string;
  bucket: string;
  size: number;
  contentType: string;
  link: string | null;
  expiresAt: number | null;  // Unix timestamp in ms, or null for "never"
  createdAt: number;
}
```

---

## Configuration Reference

Configuration is stored at `~/.attachments/config.json`. Edit it directly or use `attachments config set`.

```json
{
  "s3": {
    "bucket": "my-bucket",
    "region": "us-east-1",
    "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
    "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "endpoint": "https://custom-endpoint.example.com"
  },
  "server": {
    "port": 3457,
    "baseUrl": "http://localhost:3457"
  },
  "defaults": {
    "expiry": "7d",
    "linkType": "presigned"
  }
}
```

### `s3`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `bucket` | string | Yes | S3 bucket name. |
| `region` | string | Yes | AWS region (e.g., `us-east-1`, `auto` for R2). |
| `accessKeyId` | string | Yes | AWS access key ID. |
| `secretAccessKey` | string | Yes | AWS secret access key. |
| `endpoint` | string | No | Custom S3-compatible endpoint. Required for MinIO, R2, LocalStack. |

### `server`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `port` | number | `3457` | Port for the REST API server. |
| `baseUrl` | string | `http://localhost:3457` | Public base URL used to generate `server`-type shortlinks. |

### `defaults`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `expiry` | string | `"7d"` | Default link expiry. Formats: `Nm` (minutes), `Nh` (hours), `Nd` (days), `"never"`. |
| `linkType` | `"presigned"` \| `"server"` | `"presigned"` | `presigned` generates a time-limited S3 signed URL. `server` generates a `/d/:id` shortlink served by the local server. |

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
