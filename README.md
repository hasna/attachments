# @hasna/attachments

Open-source attachment transfer for agents and teams — local or private S3 storage, app-hosted share links, CLI + MCP + REST API.

[![npm](https://img.shields.io/npm/v/@hasna/attachments)](https://www.npmjs.com/package/@hasna/attachments)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/attachments
```

## CLI Usage

```bash
attachments --help
attachments upload report.pdf
attachments upload report.pdf --expiry 24h --password "$ATTACHMENT_PASSWORD"
attachments upload archive.zip --encrypt --password "$ATTACHMENT_PASSWORD" --max-downloads 1
attachments serve --host 0.0.0.0 --port 3459
```

Fresh installs work without S3. Objects are stored under
`~/.hasna/attachments/objects`, metadata is stored in local SQLite, and share
links are app-hosted URLs such as `http://localhost:3459/a/<token>`.

For hosted deployments, keep the bucket private and let the app serve public
download pages and byte streams from `/a/<token>`. Direct presigned S3 links
remain available for explicit admin workflows, but server links are the default.

## Versioned Artifacts

Attachments can also register uploaded files as versioned artifacts with
checksum metadata and generated install plans. This is used by BrowserPlan to
publish macOS app builds and let machines resolve/download/update consistently.

```bash
attachments artifact publish ./dist/BrowserPlan.zip \
  --name browserplan --version 1.2.3 \
  --platform darwin --arch arm64 --kind mac-app-zip \
  --app-name BrowserPlan.app --expiry never --format json

attachments artifact latest --name browserplan --platform darwin --arch arm64 --format json
attachments artifact download art_xxx --output /tmp --format json
attachments artifact install-plan art_xxx --browserplan-fleet --format json
```

See [docs/BROWSERPLAN_ARTIFACT_CONTRACT.md](docs/BROWSERPLAN_ARTIFACT_CONTRACT.md)
for the open-chrome and open-machines facing contract.

## Storage

```bash
attachments config set --storage-backend local
attachments config set --storage-backend s3 --bucket my-bucket --region us-east-1
attachments config set --max-size 10737418240 # 10 GB
```

`--storage-backend auto` uses S3 when S3 credentials are configured and falls
back to local object storage otherwise.

## Public Domains

Domain support is declarative and does not depend on `@hasna/domains` at
runtime. Configure a public base URL and export a DNS plan for manual,
Cloudflare, OpenDomains, or other automation.

```bash
attachments domain configure \
  --hostname files.example.com \
  --base-url https://files.example.com \
  --path-prefix /a \
  --provider cloudflare \
  --attachments-origin https://attachments-origin.example.com \
  --fallback-origin https://shortlinks-origin.example.com \
  --zone example.com \
  --record CNAME \
  --name files \
  --target attachments.example.net \
  --proxied

attachments domain plan --format json
attachments domain plan --format opendomains
attachments domain plan --format cloudflare
attachments domain verify --format json
```

The generated plan contains no credentials and does not mutate DNS. For shared
domains, route the attachment prefix before any generic redirect/shortlink
route; for example, `files.example.com/a/*` should target the attachments app
and `files.example.com/*` can remain pointed at an existing shortlink service.
`attachments domain verify` probes the configured `.../a/__attachments_probe__`
URL and fails if the prefix is still handled by a shortlink route.

## MCP Server

```bash
attachments-mcp
```

## HTTP mode

Run a long-lived Streamable HTTP MCP server on `127.0.0.1` (default port **8800**):

```bash
attachments-mcp --http
# or: MCP_HTTP=1 attachments-mcp
# port override: --port 8800  or  MCP_HTTP_PORT=8800
```

- Health: `GET http://127.0.0.1:8800/health` → `{"status":"ok","name":"attachments"}`
- MCP: `http://127.0.0.1:8800/mcp`

Stdio remains the default when no `--http` / `MCP_HTTP=1` is set.

## Storage Sync

This package supports optional remote storage sync directly against a Postgres/RDS
database. Local SQLite remains the default.

```bash
export HASNA_ATTACHMENTS_DATABASE_URL=postgres://...
export HASNA_ATTACHMENTS_STORAGE_MODE=hybrid # local | remote | hybrid

attachments storage status
attachments storage push
attachments storage pull
attachments storage sync
```

MCP exposes the same flow through `storage_status`, `storage_push`,
`storage_pull`, and `storage_sync`.

## Data Directory

Data is stored in `~/.hasna/attachments/`. Local object storage defaults to
`~/.hasna/attachments/objects`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
