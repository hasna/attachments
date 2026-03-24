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
