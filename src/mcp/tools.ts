import { STORAGE_TABLES } from "../db/storage-sync.js";

// ---------------------------------------------------------------------------
// Full verbose schemas — returned by describe_tools on demand
// ---------------------------------------------------------------------------

export const FULL_SCHEMAS: Record<string, object> = {
  upload_attachment: {
    name: "upload_attachment",
    description: "Upload a local file or a URL to S3 and return a shareable link. Provide either 'path' (local file) or 'url' (remote URL), not both.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to upload." },
        url: { type: "string", description: "HTTP/HTTPS URL to fetch and upload. Alternative to 'path'." },
        expiry: { type: "string", description: "Link expiry, e.g. '24h', '7d', 'never'. Defaults to configured value." },
        tag: { type: "string", description: "Optional tag to attach to the attachment record." },
        password: { type: "string", description: "Optional password required before public download." },
        encrypt: { type: "boolean", description: "Encrypt stored bytes using the provided password." },
        max_downloads: { type: "number", description: "Maximum successful downloads for the generated share link." },
      },
    },
  },
  download_attachment: {
    name: "download_attachment",
    description: "Download an attachment from S3 to local disk.",
    inputSchema: {
      type: "object",
      properties: {
        id_or_url: { type: "string", description: "Attachment ID (att_xxx) or a /d/:id URL." },
        dest: { type: "string", description: "Destination directory or full file path. Defaults to cwd." },
      },
      required: ["id_or_url"],
    },
  },
  list_attachments: {
    name: "list_attachments",
    description: "List attachments stored in the local DB.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max number of results." },
        format: { type: "string", enum: ["compact", "json"], description: "Output format." },
        tag: { type: "string", description: "Filter by tag." },
      },
    },
  },
  delete_attachment: {
    name: "delete_attachment",
    description: "Delete an attachment from the DB (does not delete from S3).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Attachment ID to delete." },
      },
      required: ["id"],
    },
  },
  get_link: {
    name: "get_link",
    description: "Get the current shareable link for an attachment, optionally regenerating it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Attachment ID." },
        regenerate: { type: "boolean", description: "Force regeneration of the link." },
        expiry: { type: "string", description: "New expiry when regenerating, e.g. '24h'." },
      },
      required: ["id"],
    },
  },
  upload_attachments: {
    name: "upload_attachments",
    description: "Batch upload multiple local files to S3. Returns an array of results (one per file); individual failures are included inline without aborting the batch.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Array of absolute or relative file paths to upload." },
        expiry: { type: "string", description: "Link expiry, e.g. '24h', '7d', 'never'. Applied to all files." },
        tag: { type: "string", description: "Optional tag applied to every attachment." },
        password: { type: "string", description: "Optional password required before public download." },
        encrypt: { type: "boolean", description: "Encrypt stored bytes using the provided password." },
        max_downloads: { type: "number", description: "Maximum successful downloads for each generated share link." },
      },
      required: ["paths"],
    },
  },
  configure_s3: {
    name: "configure_s3",
    description: "Persist S3 configuration to ~/.hasna/attachments/config.json.",
    inputSchema: {
      type: "object",
      properties: {
        bucket: { type: "string", description: "S3 bucket name." },
        region: { type: "string", description: "AWS region, e.g. 'us-east-1'." },
        access_key: { type: "string", description: "Optional AWS access key ID. Omit when using the runtime default credential chain / IAM role." },
        secret_key: { type: "string", description: "Optional AWS secret access key. Required only when access_key is provided." },
        base_url: { type: "string", description: "Optional custom endpoint / base URL." },
      },
      required: ["bucket", "region"],
    },
  },
  presign_upload: {
    name: "presign_upload",
    description: "Generate a presigned PUT URL so a client can upload directly to S3 without credentials. Creates a DB record (status: pending upload, size 0).",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filename for the upload (e.g. report.pdf)." },
        expiry: { type: "string", description: "URL expiry, e.g. '1h', '30m', '7d'. Defaults to '1h'." },
        content_type: { type: "string", description: "Content type for the upload. Auto-detected from filename if omitted." },
      },
      required: ["filename"],
    },
  },
  complete_presigned_upload: {
    name: "complete_presigned_upload",
    description: "Verify and finalize a direct S3 upload created by presign_upload. Generates the final share link only after the object exists and passes size checks.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Pending attachment ID returned by presign_upload." },
        expiry: { type: "string", description: "Share link expiry, e.g. '24h', '7d', 'never'. Defaults to configured value." },
        password: { type: "string", description: "Optional password required before public download." },
        max_downloads: { type: "number", description: "Maximum successful downloads for the generated share link." },
        link_type: { type: "string", enum: ["presigned", "server"], description: "Final link type. Defaults to configured value." },
      },
      required: ["id"],
    },
  },
  report_stats: {
    name: "report_stats",
    description: "Return an activity and storage report for a recent time window. Equivalent to the `attachments report` CLI command.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Number of days to look back (default: 7)." },
        tag: { type: "string", description: "Filter by tag (e.g. project:my-project)." },
      },
    },
  },
  describe_tools: {
    name: "describe_tools",
    description: "Return full verbose schemas for one or all tools. Set the ATTACHMENTS_PROFILE env var to control which tools are exposed in tools/list: 'minimal' (upload_attachment, download_attachment, get_link), 'standard' (default, adds list_attachments, delete_attachment, complete_task_with_files), or 'full' (all 12 tools).",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "Name of the tool to describe. Omit for all tools." },
      },
    },
  },
  search_tools: {
    name: "search_tools",
    description: "Search tool names by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword to match against tool names." },
      },
      required: ["query"],
    },
  },
  link_to_task: {
    name: "link_to_task",
    description: "Link an uploaded attachment to a todos task by updating the task's metadata with attachment info (id, link, filename, size). Uses the todos REST API.",
    inputSchema: {
      type: "object",
      properties: {
        attachment_id: { type: "string", description: "Attachment ID (att_xxx)." },
        task_id: { type: "string", description: "Task ID to link the attachment to (e.g. TASK-001)." },
        todos_url: { type: "string", description: "Todos REST server base URL. Defaults to http://localhost:3000." },
      },
      required: ["attachment_id", "task_id"],
    },
  },
  save_session: {
    name: "save_session",
    description: "Fetch a session transcript from the open-sessions REST API and upload it as an attachment. Returns a shareable link and attachment ID.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID to snapshot." },
        sessions_url: { type: "string", description: "Sessions REST API base URL. Defaults to http://localhost:3458." },
        format: { type: "string", enum: ["markdown", "html"], description: "Transcript format. Defaults to markdown." },
        expiry: { type: "string", description: "Link expiry, e.g. '7d', '24h', 'never'." },
        tag: { type: "string", description: "Optional tag for the attachment." },
      },
      required: ["session_id"],
    },
  },
  check_attachment_health: {
    name: "check_attachment_health",
    description: "Check the health of all attachment links — identifies expired (past expiresAt), dead (link 404), and healthy ones. Optionally regenerates presigned links for expired attachments. Returns counts and per-attachment status.",
    inputSchema: {
      type: "object",
      properties: {
        fix: { type: "boolean", description: "If true, regenerate presigned links for expired attachments." },
        todos_url: { type: "string", description: "Unused currently; reserved for future todos-aware health checks." },
      },
    },
  },
  complete_task_with_files: {
    name: "complete_task_with_files",
    description: "Upload one or more local files to S3 and complete a todos task with those attachment IDs as evidence. Calls POST /api/tasks/:id/complete with attachment_ids.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to complete (e.g. TASK-001)." },
        paths: { type: "array", items: { type: "string" }, description: "Array of absolute or relative file paths to upload as evidence." },
        todos_url: { type: "string", description: "Todos REST server base URL. Defaults to http://localhost:3000." },
        expiry: { type: "string", description: "Link expiry for uploaded files, e.g. '24h', '7d', 'never'." },
        notes: { type: "string", description: "Optional completion notes to include in the task completion." },
      },
      required: ["task_id", "paths"],
    },
  },
  get_context: {
    name: "get_context",
    description: "Return a compact text summary of attachment storage for agent system prompt injection.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["text", "json"], description: "Output format (default: text)" }
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Lean stub list — minimal descriptions to save tokens
// ---------------------------------------------------------------------------

export const LEAN_TOOLS = [
  {
    name: "upload_attachment",
    description: "Upload file or URL → link",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        url: { type: "string" },
        expiry: { type: "string" },
        tag: { type: "string" },
        password: { type: "string" },
        encrypt: { type: "boolean" },
        max_downloads: { type: "number" },
      },
    },
  },
  {
    name: "download_attachment",
    description: "Download attachment to disk",
    inputSchema: {
      type: "object" as const,
      properties: {
        id_or_url: { type: "string" },
        dest: { type: "string" },
      },
      required: ["id_or_url"],
    },
  },
  {
    name: "list_attachments",
    description: "List attachments",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number" },
        format: { type: "string", enum: ["compact", "json"] },
        tag: { type: "string" },
      },
    },
  },
  {
    name: "delete_attachment",
    description: "Delete attachment by ID",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_link",
    description: "Get / regenerate shareable link",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        regenerate: { type: "boolean" },
        expiry: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "upload_attachments",
    description: "Batch upload multiple files → links",
    inputSchema: {
      type: "object" as const,
      properties: {
        paths: { type: "array", items: { type: "string" } },
        expiry: { type: "string" },
        tag: { type: "string" },
        password: { type: "string" },
        encrypt: { type: "boolean" },
        max_downloads: { type: "number" },
      },
      required: ["paths"],
    },
  },
  {
    name: "configure_s3",
    description: "Save S3 config",
    inputSchema: {
      type: "object" as const,
      properties: {
        bucket: { type: "string" },
        region: { type: "string" },
        access_key: { type: "string" },
        secret_key: { type: "string" },
        base_url: { type: "string" },
      },
      required: ["bucket", "region"],
    },
  },
  {
    name: "presign_upload",
    description: "Presigned PUT URL for direct S3 upload",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: { type: "string" },
        expiry: { type: "string" },
        content_type: { type: "string" },
      },
      required: ["filename"],
    },
  },
  {
    name: "complete_presigned_upload",
    description: "Finalize a presigned upload after S3 PUT",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        expiry: { type: "string" },
        password: { type: "string" },
        max_downloads: { type: "number" },
        link_type: { type: "string", enum: ["presigned", "server"] },
      },
      required: ["id"],
    },
  },
  {
    name: "report_stats",
    description: "Activity/storage report for a time window",
    inputSchema: {
      type: "object" as const,
      properties: {
        days: { type: "number" },
        tag: { type: "string" },
      },
    },
  },
  {
    name: "describe_tools",
    description: "Full schema for tool(s)",
    inputSchema: {
      type: "object" as const,
      properties: {
        tool_name: { type: "string" },
      },
    },
  },
  {
    name: "search_tools",
    description: "Search tool names",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "link_to_task",
    description: "Link attachment to a todos task",
    inputSchema: {
      type: "object" as const,
      properties: {
        attachment_id: { type: "string" },
        task_id: { type: "string" },
        todos_url: { type: "string" },
      },
      required: ["attachment_id", "task_id"],
    },
  },
  {
    name: "save_session",
    description: "Snapshot a session transcript → attachment link",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" },
        sessions_url: { type: "string" },
        format: { type: "string", enum: ["markdown", "html"] },
        expiry: { type: "string" },
        tag: { type: "string" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "complete_task_with_files",
    description: "Upload files and complete a todos task with them as evidence",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        todos_url: { type: "string" },
        expiry: { type: "string" },
        notes: { type: "string" },
      },
      required: ["task_id", "paths"],
    },
  },
  {
    name: "check_attachment_health",
    description: "Check health of all attachment links (expired/dead/healthy). Use fix:true to regenerate expired links.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fix: { type: "boolean" },
        todos_url: { type: "string" },
      },
    },
  },
  {
    name: "get_context",
    description: "Compact storage summary for system prompt injection",
    inputSchema: {
      type: "object" as const,
      properties: {
        format: { type: "string", enum: ["text", "json"] },
      },
    },
  },
  {
    name: "register_agent",
    description: "Register this agent session for upload attribution. Returns agent_id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Agent name" },
        session_id: { type: "string", description: "Session identifier" },
      },
      required: ["name"],
    },
  },
  {
    name: "heartbeat",
    description: "Mark this agent as active. Call periodically during long upload sessions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string", description: "Agent ID from register_agent" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "set_focus",
    description: "Set the active project context for this agent session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string", description: "Agent ID" },
        project_id: { type: "string", description: "Project to focus on" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "list_agents",
    description: "List all registered agents with their last_seen_at timestamps.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "send_feedback",
    description: "Send feedback about this service",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "Feedback message" },
        email: { type: "string", description: "Optional email for follow-up" },
        category: { type: "string", enum: ["bug", "feature", "general"], description: "Feedback category" },
      },
      required: ["message"],
    },
  },
  {
    name: "storage_status",
    description: "Show remote storage configuration and sync metadata",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "storage_push",
    description: "Push local attachment tables to remote Postgres storage",
    inputSchema: {
      type: "object" as const,
      properties: {
        tables: { type: "array", items: { type: "string", enum: [...STORAGE_TABLES] } },
      },
    },
  },
  {
    name: "storage_pull",
    description: "Pull attachment tables from remote Postgres storage",
    inputSchema: {
      type: "object" as const,
      properties: {
        tables: { type: "array", items: { type: "string", enum: [...STORAGE_TABLES] } },
      },
    },
  },
  {
    name: "storage_sync",
    description: "Push then pull attachment tables with remote Postgres storage",
    inputSchema: {
      type: "object" as const,
      properties: {
        tables: { type: "array", items: { type: "string", enum: [...STORAGE_TABLES] } },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Profile-based tool filtering
// ---------------------------------------------------------------------------

const MINIMAL_TOOLS = new Set(["upload_attachment", "download_attachment", "get_link"]);
const STANDARD_TOOLS = new Set([
  "upload_attachment",
  "download_attachment",
  "get_link",
  "list_attachments",
  "delete_attachment",
  "complete_task_with_files",
  "save_session",
  "report_stats",
  "get_context",
  "register_agent",
  "heartbeat",
  "set_focus",
  "list_agents",
]);

export function getToolsForProfile(
  profile?: string
): typeof LEAN_TOOLS {
  const p = (profile ?? process.env.ATTACHMENTS_PROFILE ?? "standard").toLowerCase();
  if (p === "minimal") {
    return LEAN_TOOLS.filter((t) => MINIMAL_TOOLS.has(t.name));
  }
  if (p === "full") {
    return LEAN_TOOLS;
  }
  // standard (default)
  return LEAN_TOOLS.filter((t) => STANDARD_TOOLS.has(t.name));
}
