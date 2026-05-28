# @hasna/attachments

File transfer for AI agents — S3-backed upload, shareable links, CLI + MCP + REST API

[![npm](https://img.shields.io/npm/v/@hasna/attachments)](https://www.npmjs.com/package/@hasna/attachments)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/attachments
```

## CLI Usage

```bash
attachments --help
```

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

## Cloud Sync

This package supports cloud sync via `@hasna/cloud`:

```bash
cloud setup
cloud sync push --service attachments
cloud sync pull --service attachments
```

## Data Directory

Data is stored in `~/.hasna/attachments/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
