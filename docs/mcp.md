# MCP Reference

## Transport

`attachments-mcp` starts Streamable HTTP by default:

```text
MCP endpoint: http://127.0.0.1:8850/mcp
Health check: http://127.0.0.1:8850/health
```

| Setting | Effect |
|---------|--------|
| `--port <number>` | HTTP port; defaults to `8850` |
| `MCP_HTTP_PORT` | Port when `--port` is absent |
| `--stdio` or `MCP_STDIO=1` | Uses stdio instead of HTTP |
| `--http` or `MCP_HTTP=1` | Explicitly selects HTTP; HTTP is already default |
| `--help`, `--version` | Prints information and exits |

HTTP supports multiple clients in one process. Stdio suits clients that own the
child process lifecycle.

## Client Installation

```bash
attachments mcp --claude
attachments mcp --codex
attachments mcp --gemini
attachments mcp --all
attachments mcp --uninstall --all
```

## Profiles

Set `ATTACHMENTS_PROFILE` before startup. Unknown values use `standard`.

| Profile | Count | Tools |
|---------|------:|-------|
| `minimal` | 3 | `upload_attachment`, `download_attachment`, `get_link` |
| `standard` | 13 | Minimal plus `list_attachments`, `delete_attachment`, `complete_task_with_files`, `save_session`, `report_stats`, `get_context`, `register_agent`, `heartbeat`, `set_focus`, `list_agents` |
| `full` | 22 | Every tool below |

`tools/list` returns lean schemas to reduce prompt size. `describe_tools` returns
verbose attachment-workflow schemas on demand.

## Full Tool Set

| Tool | Required input | Behavior |
|------|----------------|----------|
| `upload_attachment` | `path` or `url` | Uploads one local file or remote URL |
| `download_attachment` | `id_or_url` | Downloads to `dest` or the current directory |
| `list_attachments` | — | Lists records with limit, format, and tag filters |
| `delete_attachment` | `id` | Deletes through the selected store |
| `get_link` | `id` | Gets or regenerates a link |
| `upload_attachments` | `paths` | Batch uploads and reports per-file failures inline |
| `configure_s3` | `bucket`, `region` | Saves S3 config; explicit credentials are optional as a pair |
| `presign_upload` | `filename` | Creates a direct-to-S3 PUT URL in local mode |
| `complete_presigned_upload` | `id` | Finalizes direct upload and creates a share link |
| `report_stats` | — | Returns recent attachment activity |
| `describe_tools` | — | Returns verbose schemas for one or all workflow tools |
| `search_tools` | `query` | Searches all tool names |
| `link_to_task` | `attachment_id`, `task_id` | Adds metadata to a todos task |
| `save_session` | `session_id` | Exports and uploads a sessions transcript |
| `complete_task_with_files` | `task_id`, `paths` | Uploads evidence and completes a todos task |
| `check_attachment_health` | — | Audits links and optionally regenerates expired links |
| `get_context` | — | Returns compact storage context as text or JSON |
| `register_agent` | `name` | Registers an in-memory MCP agent |
| `heartbeat` | `agent_id` | Updates an MCP agent timestamp |
| `set_focus` | `agent_id` | Sets or clears project context |
| `list_agents` | — | Lists agents in this MCP process |
| `send_feedback` | `message` | Persists service feedback |

The MCP agent registry is process-local. CLI `init`, `heartbeat`, and `focus`
instead persist `~/.hasna/attachments/agent.json`.

Common optional inputs include `expiry`, `tag`, `password`, `encrypt`,
`max_downloads`, `todos_url` (default `http://localhost:3000`), and
`sessions_url` (default `http://localhost:3458`).

Recommended tags include `task:TASK-042`, `session:abc123`,
`project:attachments`, and `agent:builder`.
