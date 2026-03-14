# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.5] - 2026-03-14

### Fixed
- SDK `Attachment` type was missing `tag` field (added in v0.2.0 but never reflected in types)
- Default port changed from 3457 (conflict with @hasna/configs) to 3459
- Server now binds to `localhost` by default instead of `0.0.0.0`
- `src/index.ts` now exports the full library API (was empty in v0.1.0)
- `prepare` script ensures `dist/` is rebuilt before every `npm publish`

### Added (since v0.1.0)
- **Dashboard** — React + Vite UI with dark/light mode for browsing and managing attachments
- **CLI** — new commands: `health-check`, `watch`, `link-task`, `complete-task`, `snapshot-session`, `task-journal`, `status`, `clean`, `whoami`, `presign-upload`
- **MCP** — expanded from 8 to 14 tools total; `ATTACHMENTS_PROFILE` env var for token optimization (`minimal`=3, `standard`=7, `full`=14)
- **Economy integration** — set `ATTACHMENTS_TRACK_COSTS=1` to log cost data via the economy service
- **Sessions integration** — `snapshot-session` / `save_session` MCP tool fetches a transcript from open-sessions and uploads it to S3
- **Todos integration** — `link-task`, `complete-task`, `watch` (reactive health checks), `task-journal`, `link_to_task` MCP tool, `complete_task_with_files` MCP tool
- **File size limit** — `ATTACHMENTS_MAX_SIZE` env var (default 5 GB); uploads exceeding the limit return HTTP 413
- **Tag support** — `--tag` flag on CLI upload/list, `?tag=` query param on REST API, `tag` param in all relevant MCP tools
- **Batch upload** — `upload_attachments` MCP tool and `upload_attachments` REST endpoint for multi-file uploads
- **Presigned PUT** — `presign-upload` CLI and `presign_upload` MCP tool for direct client-to-S3 uploads without server credentials
- **Health check MCP tool** — `check_attachment_health` audits all links (expired/dead/healthy) with optional `fix:true` to regenerate expired presigned links
- **AGENTS.md** — standard agent workflow documentation

## [0.1.0] - 2026-03-12

### Added

- Initial release of `@hasna/attachments` and `@hasna/attachments-sdk`.

**CLI (`attachments`)**
- `upload <file>` — upload a local file to S3 and print a shareable link; supports `--expiry`, `--link-type`, `--format`
- `download <id-or-url>` — download an attachment by ID or `/d/:id` URL with `--output` option
- `list` — list attachments with `--format` (compact/table/json), `--limit`, and `--expired` options
- `delete <id>` — delete an attachment from S3 and the local database; `--yes` to skip confirmation
- `link <id>` — show or regenerate the shareable link; supports `--regenerate`, `--expiry`, `--format`
- `config show` — print current configuration with secrets masked
- `config set` — update S3, server, and defaults configuration
- `config test` — verify S3 connectivity by listing one bucket object
- `serve` — start the Hono REST API server; supports `--port` and `--host`
- `mcp` — install or uninstall the MCP server into Claude Code, Codex, and Gemini; supports `--all` and `--uninstall`

**MCP server (`attachments-mcp`)**
- 8 lean-stub tools to minimize token consumption: `upload_attachment`, `download_attachment`, `list_attachments`, `delete_attachment`, `get_link`, `configure_s3`, `describe_tools`, `search_tools`
- `describe_tools` returns full verbose JSON Schema for any tool on demand
- `search_tools` searches tool names by keyword
- stdio transport compatible with all MCP-capable agents

**REST API**
- `POST /api/attachments` — multipart file upload
- `GET /api/attachments` — list with `limit`, `fields`, `format`, `expired` query params
- `GET /api/attachments/:id` — get attachment metadata
- `DELETE /api/attachments/:id` — delete from S3 and database
- `GET /api/attachments/:id/download` — download or redirect to presigned URL
- `GET /api/attachments/:id/link` — get current shareable link
- `POST /api/attachments/:id/link` — regenerate link with optional new expiry
- `GET /d/:id` — public shortlink that redirects to the file

**`@hasna/attachments-sdk`**
- Zero-dependency TypeScript client compatible with Node.js, Bun, Deno, and browsers
- `upload(filePathOrBlob, opts?)` — upload from a file path or a `File`/`Blob`
- `download(idOrUrl, destPath?)` — download attachment to disk (Node.js/Bun)
- `list(opts?)` — list attachments with field selection and format options
- `get(id)` — get attachment metadata
- `delete(id)` — delete attachment
- `getLink(id)` — get current shareable link
- `regenerateLink(id, opts?)` — regenerate link with optional new expiry

**S3 / storage**
- AWS S3 support with presigned URL generation via `@aws-sdk/s3-request-presigner`
- S3-compatible endpoint support (Cloudflare R2, MinIO, LocalStack)
- Configurable link expiry: minutes (`m`), hours (`h`), days (`d`), or `never`
- Two link types: `presigned` (S3-signed URL) and `server` (local shortlink)
- SQLite-backed local attachment database at `~/.attachments/attachments.db`
- Configuration stored at `~/.attachments/config.json`
