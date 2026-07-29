# Configuration and Deployment

## Local Configuration

`attachments config` reads and writes
`~/.hasna/attachments/config.json`. `config set` deep-merges supplied values;
`config show` normalizes defaults and masks the S3 secret.

| Setting | Default |
|---------|---------|
| Storage backend | `auto` |
| Local objects | `~/.hasna/attachments/objects` |
| Maximum upload | `10737418240` bytes (10 GiB) |
| Server | `localhost:3459` |
| Public base URL/path | `http://localhost:3459`, `/a` |
| Link expiry/type | `7d`, `presigned` |

`auto` selects S3 when bucket and region are configured, otherwise local
storage. Explicit S3 keys are optional when the AWS credential chain is
available; if one is supplied, both are required.

The configured link type is a preference. Server links are selected for local
objects and features presigned URLs cannot enforce: passwords, encryption,
download caps, email gates, expiry beyond seven days, and `never` expiry.

## Local Environment

| Variable | Purpose |
|----------|---------|
| `HASNA_ATTACHMENTS_DB_PATH` | SQLite database override |
| `ATTACHMENTS_API_TOKEN`, `HASNA_ATTACHMENTS_API_TOKEN` | Local `/api` authentication |
| `ATTACHMENTS_MAX_SIZE` | Upload limit override in bytes |
| `ATTACHMENTS_TRACK_COSTS` | Enables economy tracking when set |
| `ATTACHMENTS_ECONOMY_URL` | Economy URL; defaults to `http://localhost:3460` |
| `ATTACHMENTS_INTERNAL_URL`, `HASNA_ATTACHMENTS_INTERNAL_URL` | Internal link base URL |
| `ATTACHMENTS_INTERNAL_BIND_HOST` | Explicit internal bind address |
| `ATTACHMENTS_ALLOW_LAN_INTERNAL=1` | Allows LAN fallback |
| `ATTACHMENTS_TRUST_PROXY` | Controls forwarded-address trust |
| `ATTACHMENTS_TRUSTED_PROXIES` | Restricts trusted proxy addresses |

## MCP Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `ATTACHMENTS_PROFILE` | `standard` | `minimal`, `standard`, or `full` tools |
| `MCP_HTTP_PORT` | `8850` | HTTP port |
| `MCP_STDIO=1` | unset | Selects stdio |
| `MCP_HTTP=1` | unset | Explicitly selects HTTP |

## Self-Hosted Service

| Variable | Purpose |
|----------|---------|
| `HASNA_ATTACHMENTS_STORAGE_MODE=cloud` | Selects direct Postgres mode |
| `HASNA_ATTACHMENTS_DATABASE_URL` | Postgres URL |
| `HASNA_ATTACHMENTS_API_SIGNING_KEY` | App API signing secret |
| `HASNA_API_SIGNING_KEY` | Fallback signing secret |
| `PORT` | HTTP port; defaults to `3459` |
| `ATTACHMENTS_PUBLIC_BASE_URL`, `ATTACHMENTS_BASE_URL` | Public origin |
| `ATTACHMENTS_S3_BUCKET` | S3 bucket |
| `ATTACHMENTS_S3_REGION` | Region; falls back to `AWS_REGION`, then `us-east-1` |
| `ATTACHMENTS_S3_ACCESS_KEY_ID`, `ATTACHMENTS_S3_SECRET_ACCESS_KEY` | Optional explicit credentials |
| `ATTACHMENTS_S3_ENDPOINT` | S3-compatible endpoint |
| `ATTACHMENTS_MAX_SIZE` | Maximum upload bytes |
| `ATTACHMENTS_SKIP_MIGRATE=1` | Skips startup migrations |
| `ATTACHMENTS_VERSION` | Reported version override |

The hosted service binds `0.0.0.0`, migrates before serving, and is pure remote:
there is no sync, cache, or local SQLite fallback.

## Domain Routing

`domain configure` stores deployment metadata; `domain plan` emits
provider-neutral, OpenDomains, or Cloudflare JSON without credentials. Neither
changes DNS.

On shared hosts, route the attachment prefix first:

```text
files.example.com/a/*  -> attachments origin
files.example.com/*    -> existing shortlink origin
```

`domain verify` probes the configured `/a/__attachments_probe__` URL and
classifies whether attachments or another service answered.

## Data Migration

On first use, missing files from legacy `~/.open-attachments` and
`~/.attachments` directories are copied into `~/.hasna/attachments` without
overwriting canonical files. This is unrelated to cloud persistence. Postgres
migrations run through `attachments-serve` or `attachments-serve migrate`.
