# CLI Reference

The `attachments` binary uses Commander. Run `attachments --help` or
`attachments <command> --help` for the installed version's generated help.

## Transfer Commands

### `upload [files...]`

Uploads paths, or one stdin file with `--stdin --filename <name>`.

| Option | Behavior |
|--------|----------|
| `--expiry <time>` | Lifetime such as `24h`, `7d`, or `never` |
| `--link-type <type>` | `presigned` or `server` |
| `--tag <tag>` | Stores an organizational tag |
| `--password <password>` | Protects the public download |
| `--encrypt` | Encrypts stored bytes; requires `--password` |
| `--max-downloads <count>` | Limits successful downloads |
| `--require-email` | Requires one-time email access |
| `--allowed-email <email...>` | Restricts email-gated access |
| `--format <fmt>` | `human` (default) or `json` |
| `--copy`, `--brief` | Copies the link or prints compact output |
| `--stdin`, `--filename <name>` | Uploads stdin with the supplied filename |
| `--client-mode <mode>` | Uses `local` or `cloud` for this upload |
| `--internal` | Generates a local-network/Tailscale server link |

Invalid modes/formats, non-positive download limits, and `--encrypt` without a
password fail before upload.

### `download <id-or-url>`

Accepts an attachment ID, `/d/:id` URL, or local `/a/:token` URL.
`--output <path>` selects a destination, `--password` unlocks protected content,
and `--brief` prints compact output.

### `list`

Supports `--format compact|json|table`, `--expired`, `--limit <n>` (default
`20`), `--tag <tag>`, and `--brief`.

### `delete <id>` and `remove <id>`

`remove` aliases `delete`. Deletion asks for confirmation unless `-y` or
`--yes` is supplied. `--brief` selects compact output.

### `link <id>`

Shows the current link. `--regenerate` accepts `--expiry`, `--password`, and
`--max-downloads`. Output supports `--format human|json` and `--brief`.

## Direct S3 Upload

`presign-upload <filename>` creates a pending attachment and presigned PUT URL.
It accepts `--expiry` (default `1h`) and `--content-type` and requires local S3
access. After PUT, `presign-complete <id>` finalizes it with optional
`--expiry`, `--password`, `--max-downloads`, `--link-type`,
`--format human|json`, and `--brief`.

## Configuration Commands

- `config show` prints normalized configuration with secrets masked.
- `config test` validates S3 configuration and checks bucket access.
- `config set` updates only supplied values.

`config set` accepts S3 (`--bucket`, `--region`, `--access-key`, `--secret-key`,
`--endpoint`), storage (`--storage-backend`, `--local-dir`, `--max-size`), server
(`--port`, `--host`, `--base-url`, `--public-path`), link (`--expiry`,
`--link-type`), and internal-link (`--internal-base-url`, `--internal-machine`,
`--prefer-internal`) options.

The `domain` namespace has three subcommands:

- `domain configure --hostname <hostname>` stores domain, DNS, provider, and
  route metadata without mutating DNS.
- `domain plan --format json|opendomains|cloudflare` emits a credential-free
  deployment plan.
- `domain verify [--url] [--timeout] [--format human|json]` probes the public
  attachment prefix.

## Service and Maintenance

| Command | Behavior |
|---------|----------|
| `serve` | Starts the local API; accepts `--port`, `--host`, and `--internal` |
| `status` | Shows transport, paths, and attachment statistics |
| `whoami` | Shows package, storage, server, S3, and integration status |
| `doctor` | Checks configuration, storage, DB, links, MCP, version, and integrations |
| `clean [--dry-run]` | Deletes expired object bytes and metadata |
| `health-check [--fix]` | Audits links in `compact` or `json` format |
| `report` | Reports activity with `--days`, `--tag`/`--project`, and `compact|json|markdown` output |

## Agent and Task Integrations

| Command | Behavior |
|---------|----------|
| `mcp` | Installs/uninstalls config for `--claude`, `--codex`, `--gemini`, or `--all` |
| `init <name>` | Persists local agent attribution |
| `heartbeat` | Updates the registered agent timestamp |
| `focus [project]` | Sets or clears the agent project |
| `link-task <attachment-id> <task-id>` | Adds attachment metadata to a todos task |
| `complete-task <task-id> --file <path>` | Uploads evidence, persists it, and completes the task |
| `resolve-evidence <task-id>` | Resolves completed-task evidence as `compact` or `json` |
| `snapshot-session <session-id>` | Uploads a transcript as Markdown or HTML |
| `task-journal <task-id>` | Combines todos history and attachments |
| `watch` | Watches todos SSE and validates attachment links |

Todos commands default to `http://localhost:3000`; sessions commands default to
`http://localhost:3458`. The commands expose URL overrides. `watch` defaults to
the `task.completed` event.

The pinned `@hasna/events` Commander integration also contributes the `storage`
namespace. Use `attachments storage --help` for its version-specific options.
It is not an attachment synchronization engine.

## Examples

```bash
attachments complete-task TASK-042 \
  --file ./report.pdf \
  --file ./results.json \
  --notes "Verified locally"

attachments snapshot-session session-id --expiry 7d --tag session:session-id
attachments report --project attachments --format markdown
attachments health-check --fix --format json
```
