# AGENTS.md — open-attachments

AI agent reference guide for `@hasna/attachments` and its MCP server.

---

## MCP Setup

Install all tools into Claude Code (user scope):

```bash
attachments mcp --claude
```

For Codex or Gemini:

```bash
attachments mcp --codex
attachments mcp --gemini
attachments mcp --all        # all three agents at once
attachments mcp --uninstall --all
```

---

## Token Optimization — ATTACHMENTS_PROFILE

Set `ATTACHMENTS_PROFILE` before starting the MCP server to control how many tools appear in `tools/list`. Lean stubs are always served; use `describe_tools` to get full schemas on demand.

| Profile | Tools exposed | Best for |
|---------|--------------|----------|
| `minimal` | 3 | Agents that only upload/download |
| `standard` | 7 (default) | General-purpose agent workflows |
| `full` | 14 | Power users, auditing, batch ops |

```bash
ATTACHMENTS_PROFILE=minimal attachments-mcp
ATTACHMENTS_PROFILE=full    attachments-mcp
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ATTACHMENTS_PROFILE` | `standard` | Tool set: `minimal`, `standard`, or `full` |
| `ATTACHMENTS_TRACK_COSTS` | _(unset)_ | Set to `1` to log economy/cost data |
| `ATTACHMENTS_MAX_SIZE` | `5368709120` (5 GB) | Max upload size in bytes; returns 413 above this |
| `ATTACHMENTS_ECONOMY_URL` | `http://localhost:3460` | Economy service base URL |

---

## REST API

Default port: **3459**
Default bind: `localhost`

```bash
attachments serve --port 3459
```

---

## All 14 MCP Tools

Quick-reference table. Use `describe_tools` (with `tool_name`) to get the full JSON Schema for any tool.

| Tool | Profile | Required params | Description |
|------|---------|-----------------|-------------|
| `upload_attachment` | minimal+ | `path` OR `url` | Upload a local file or URL → shareable link |
| `download_attachment` | minimal+ | `id_or_url` | Download attachment to local disk |
| `get_link` | minimal+ | `id` | Get (or regenerate) shareable link |
| `list_attachments` | standard+ | _(none)_ | List attachments; filter by `tag` |
| `delete_attachment` | standard+ | `id` | Delete attachment record from DB |
| `complete_task_with_files` | standard+ | `task_id`, `paths` | Upload files then complete a todos task with them as evidence |
| `save_session` | standard+ | `session_id` | Snapshot a session transcript → attachment link |
| `upload_attachments` | full | `paths` | Batch upload multiple files |
| `configure_s3` | full | `bucket`, `region`, `access_key`, `secret_key` | Save S3 credentials to config |
| `presign_upload` | full | `filename` | Generate a presigned PUT URL for direct client-to-S3 upload |
| `link_to_task` | full | `attachment_id`, `task_id` | Link an attachment to a todos task metadata |
| `check_attachment_health` | full | _(none)_ | Audit all links (expired / dead / healthy); `fix:true` to regenerate |
| `describe_tools` | standard+ | _(none)_ | Return full verbose JSON Schema for one or all tools |
| `search_tools` | standard+ | `query` | Search tool names by keyword |

### Optional params common to several tools

- `expiry` — link lifetime: `"30m"`, `"24h"`, `"7d"`, `"never"`
- `tag` — string tag attached to the attachment record
- `todos_url` — todos REST base URL (default `http://localhost:3000`)
- `sessions_url` — sessions REST base URL (default `http://localhost:3458`)

---

## Tag Conventions

Tags are free-form strings. Recommended conventions:

| Tag format | Example | Purpose |
|------------|---------|---------|
| `task:ID` | `task:TASK-042` | Link evidence to a task |
| `session:ID` | `session:abc123` | Group attachments from a session |
| `project:NAME` | `project:alumia` | Namespace by project |
| `agent:NAME` | `agent:maximus` | Track which agent uploaded |

CLI: `attachments upload file.png --tag task:TASK-001`
MCP: pass `tag: "task:TASK-001"` to any upload tool
REST: `?tag=task:TASK-001` on `GET /api/attachments`

---

## Standard Agent Workflow

### Session start

```
1. Run health check — verify S3 + DB are reachable
   attachments health-check

2. Recall any relevant attachments for this session
   → list_attachments (tag: "session:<your-session-id>")
```

### Upload evidence

```
3. Upload a file or screenshot
   → upload_attachment { path: "/tmp/screenshot.png", tag: "task:TASK-007" }

4. Link it to the task (optional, or use complete_task_with_files)
   → link_to_task { attachment_id: "att_xxx", task_id: "TASK-007" }
```

### Complete a task with evidence

```
5. Upload files and complete in one step
   → complete_task_with_files {
       task_id: "TASK-007",
       paths: ["/tmp/report.pdf", "/tmp/screenshot.png"],
       notes: "Implementation verified, tests passing"
     }
```

### Snapshot session

```
6. Save session transcript as an attachment
   → save_session { session_id: "<id>", expiry: "7d", tag: "session:<id>" }
```

---

## Integration Commands (CLI)

| Command | Description |
|---------|-------------|
| `attachments health-check` | Check S3 + DB connectivity and link health |
| `attachments watch` | Watch for todo tasks with attachment links and react |
| `attachments link-task <att-id> <task-id>` | Link an attachment to a todos task |
| `attachments complete-task <task-id> <files...>` | Upload files and complete task with evidence |
| `attachments snapshot-session <session-id>` | Snapshot a session transcript → S3 |
| `attachments task-journal` | Append task activity to a running journal attachment |
| `attachments status` | Show DB stats, S3 config, and last few attachments |
| `attachments clean` | Remove expired DB records |
| `attachments whoami` | Show configured S3 identity and bucket |
| `attachments presign-upload <filename>` | Generate a presigned PUT URL |

---

## Configuration

Stored at `~/.attachments/config.json`. Set via CLI or MCP:

```bash
attachments config set --bucket my-bucket --region us-east-1
attachments config show
attachments config test      # verify S3 connectivity
```

SQLite database: `~/.attachments/attachments.db`

---

## Context Injection (System Prompt)

Set `ATTACHMENTS_URL=http://localhost:3459` in your agent to enable automatic context injection.

```
GET http://localhost:3459/api/context
```

Returns a compact text summary for system prompts:
```
Attachments: 42 total (39 active, 3 expired)
⚠ Expiring in 24h: 2 (report.pdf, data.csv)
Recent: report.pdf (att_abc), output.json (att_def)
```

Or use the MCP tool `get_context` (standard profile) for the same result.

---

## Health & Reporting

```bash
GET http://localhost:3459/api/health    # status + counts
GET http://localhost:3459/api/report    # detailed activity
GET http://localhost:3459/api/context   # system prompt text
attachments report [--days 7]           # CLI equivalent
```
