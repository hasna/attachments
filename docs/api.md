# HTTP API Reference

Attachments ships two Hono applications with different persistence and route
contracts.

## Local API: `attachments serve`

The local API uses the selected local/S3 object store and SQLite metadata. It
listens on `localhost:3459` by default. Authentication is disabled unless
`ATTACHMENTS_API_TOKEN` or `HASNA_ATTACHMENTS_API_TOKEN` is set. When set, send
`Authorization: Bearer <token>` or `X-API-Key: <token>`. `/api/health` stays
public.

### System Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Storage status and attachment counts |
| `GET` | `/api/deployment` | Current public routing plan |
| `GET` | `/api/context` | Compact text or JSON context |
| `GET` | `/api/report` | Detailed activity report |

### Attachment Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/attachments` | JSON/base64 attachment upload |
| `PUT` | `/api/attachments` | Raw request-body upload |
| `GET` | `/api/attachments` | List, filter, or project fields |
| `GET` | `/api/attachments/:id` | Get metadata |
| `DELETE` | `/api/attachments/:id` | Delete bytes and metadata |
| `GET` | `/api/attachments/:id/download` | Stream bytes |
| `GET` | `/api/attachments/:id/link` | Get current link |
| `POST` | `/api/attachments/:id/link` | Regenerate link |
| `POST` | `/api/attachments/multipart` | Begin multipart S3 upload |
| `POST` | `/api/attachments/:id/multipart/part` | Presign a multipart part |
| `POST` | `/api/attachments/:id/multipart/complete` | Complete multipart upload |
| `POST` | `/api/attachments/:id/multipart/abort` | Abort multipart upload |
| `POST` | `/api/attachments/presign-upload` | Begin direct S3 upload |
| `POST` | `/api/attachments/:id/presign-upload/complete` | Finalize direct upload |

Uploads enforce `ATTACHMENTS_MAX_SIZE` when set, otherwise the configured
10-GiB default. Oversized requests return `413`.

### Public Routes

`/a/:token` renders a share/download page. `/a/:token/download` accepts GET,
HEAD, and password-form POST. Email gates use `/a/:token/request-access`. The
configured public path is registered in addition to `/a`. `/d/:id` supports
legacy public downloads.

Unencrypted downloads support byte ranges. HEAD and unconfirmed GET probes do
not consume limited-use links.

## Self-Hosted API: `attachments-serve`

The hosted service reads/writes Postgres directly and stores bytes in
S3-compatible storage. It does not use local SQLite.

| Method | Path | Authentication |
|--------|------|----------------|
| `GET` | `/health` | Public liveness/database probe |
| `GET` | `/ready` | Public migration readiness probe |
| `GET` | `/version` | Public version and mode |
| `GET` | `/openapi.json` | Public OpenAPI 3.1 document |
| `GET`, `POST` | `/v1/attachments` | API key |
| `GET`, `DELETE` | `/v1/attachments/:id` | API key |
| `GET` | `/v1/attachments/:id/download` | API key |
| `GET`, `POST` | `/v1/attachments/:id/link` | API key |
| `POST` | `/v1/feedback` | API key |

Create accepts JSON/base64, multipart form data, or raw bytes. Signed API keys
are checked for app, scope, expiry, and revocation; read-only keys cannot write.

The hosted service also registers public share routes at the configured path.
Email-gated links fail closed there because the cloud public-route
implementation does not configure email delivery.

Use `/openapi.json` as the authoritative machine-readable `/v1` contract and to
regenerate the TypeScript SDK.
