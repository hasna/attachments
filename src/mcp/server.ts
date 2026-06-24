#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { isStdioMode, resolveMcpHttpPort, startMcpHttpServer } from "./http.js";

import { nanoid } from "nanoid";
import { lookup as mimeLookup } from "mime-types";
import { uploadFile, uploadFromUrl, uploadFromBuffer } from "../core/upload.js";
import { computeReport, formatCompact as formatReportCompact } from "../cli/commands/report.js";
import { formatHealthCompact, runHealthCheck } from "../cli/commands/health-check.js";
import { downloadAttachment } from "../core/download.js";
import { AttachmentsDB } from "../core/db.js";
import { STORAGE_TABLES, getStorageStatus, storagePull, storagePush, storageSync } from "../db/storage-sync.js";
import { getConfig, getPublicBaseUrl, parseExpiryStrict, setConfig, validateS3Config } from "../core/config.js";
import { generatePresignedLink, generateShareLink, getLinkType } from "../core/links.js";
import { S3Client } from "../core/s3.js";
import { createObjectKey, sanitizeFilename } from "../core/security.js";
import { formatBytes, formatDateShort, linkState, truncateMiddle } from "../cli/utils.js";

// ---------------------------------------------------------------------------
// In-memory agent registry (attribution for uploads)
// ---------------------------------------------------------------------------
interface AttachmentAgent { id: string; name: string; session_id?: string; last_seen_at: string; project_id?: string; }
const agentRegistry = new Map<string, AttachmentAgent>();

function registerAttachmentAgent(name: string, sessionId?: string): AttachmentAgent {
  const existing = [...agentRegistry.values()].find(a => a.name === name);
  if (existing) {
    existing.last_seen_at = new Date().toISOString();
    if (sessionId) existing.session_id = sessionId;
    return existing;
  }
  const agent: AttachmentAgent = { id: nanoid(8), name, session_id: sessionId, last_seen_at: new Date().toISOString() };
  agentRegistry.set(agent.id, agent);
  return agent;
}

// ---------------------------------------------------------------------------
// Full verbose schemas — returned by describe_tools on demand
// ---------------------------------------------------------------------------

const FULL_SCHEMAS: Record<string, object> = {
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
    description: "List attachments stored in the local DB. Compact output is capped and hides full links by default; use format=json for full records.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max number of results (default 20)." },
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
    description: "Return an activity and storage report for a recent time window. Defaults to compact text; set format=json for the full object.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Number of days to look back (default: 7)." },
        tag: { type: "string", description: "Filter by tag (e.g. project:my-project)." },
        format: { type: "string", enum: ["compact", "json"], description: "Output format (default compact)." },
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
    description: "Check attachment link health. Defaults to compact text capped at 20 issue rows; set format=json for full per-attachment results.",
    inputSchema: {
      type: "object",
      properties: {
        fix: { type: "boolean", description: "If true, regenerate presigned links for expired attachments." },
        limit: { type: "number", description: "Maximum issue rows in compact output (default 20)." },
        verbose: { type: "boolean", description: "Show all issue rows and regenerated/dead URLs in compact output." },
        format: { type: "string", enum: ["compact", "json"], description: "Output format (default compact)." },
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

const LEAN_TOOLS = [
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
    description: "List attachments compactly",
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
    description: "Compact activity/storage report",
    inputSchema: {
      type: "object" as const,
      properties: {
        days: { type: "number" },
        tag: { type: "string" },
        format: { type: "string", enum: ["compact", "json"] },
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
    description: "Compact attachment link health check",
    inputSchema: {
      type: "object" as const,
      properties: {
        fix: { type: "boolean" },
        limit: { type: "number" },
        verbose: { type: "boolean" },
        format: { type: "string", enum: ["compact", "json"] },
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
    description: "Show compact remote storage configuration and sync metadata",
    inputSchema: {
      type: "object" as const,
      properties: {
        format: { type: "string", enum: ["compact", "json"] },
      },
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

// ---------------------------------------------------------------------------
// Tool handler helpers
// ---------------------------------------------------------------------------

async function handleUploadAttachment(args: {
  path?: string;
  url?: string;
  expiry?: string;
  tag?: string;
  password?: string;
  encrypt?: boolean;
  max_downloads?: number;
}) {
  if (!args.path && !args.url) {
    throw new Error("Either 'path' or 'url' must be provided.");
  }
  if (args.path && args.url) {
    throw new Error("Provide either 'path' or 'url', not both.");
  }

  const opts = {
    expiry: args.expiry,
    tag: args.tag,
    password: args.password,
    encrypt: args.encrypt,
    maxDownloads: args.max_downloads,
  };
  const attachment = args.url
    ? await uploadFromUrl(args.url, opts)
    : await uploadFile(args.path!, opts);

  return {
    id: attachment.id,
    link: attachment.link,
    size: attachment.size,
    filename: attachment.filename,
    expires_at: attachment.expiresAt,
  };
}

async function handleDownloadAttachment(args: {
  id_or_url: string;
  dest?: string;
}) {
  const result = await downloadAttachment(args.id_or_url, args.dest);
  return {
    path: result.path,
    filename: result.filename,
    size: result.size,
  };
}

function handleListAttachments(args: {
  limit?: number;
  format?: "compact" | "json";
  tag?: string;
}) {
  const isJson = args.format === "json";
  const limit = Number.isInteger(args.limit) && args.limit! > 0
    ? args.limit!
    : isJson
      ? undefined
      : 20;
  const db = new AttachmentsDB();
  let attachments: ReturnType<AttachmentsDB["findAll"]>;
  try {
    attachments = db.findAll({ limit, tag: args.tag });
  } finally {
    db.close();
  }

  if (isJson) {
    return attachments;
  }

  // compact format
  if (attachments.length === 0) return "no attachments";
  const lines = attachments.map((a) => {
    const tag = a.tag ? ` tag:${truncateMiddle(a.tag, 24)}` : "";
    return `${a.id}  ${truncateMiddle(a.filename, 48)}  ${formatBytes(a.size)}  link:${linkState(a.link, a.expiresAt)}  exp:${formatDateShort(a.expiresAt)}${tag}`;
  });
  lines.push(`Showing ${attachments.length} attachment${attachments.length === 1 ? "" : "s"} (limit ${limit ?? 20}). Links hidden; call get_link or use format:'json' for details.`);
  return lines.join("\n");
}

function handleDeleteAttachment(args: { id: string }) {
  const db = new AttachmentsDB();
  try {
    db.delete(args.id);
  } finally {
    db.close();
  }
  return `deleted: ${args.id}`;
}

async function handleGetLink(args: {
  id: string;
  regenerate?: boolean;
  expiry?: string;
}) {
  const db = new AttachmentsDB();
  const attachment = db.findById(args.id);

  if (!attachment) {
    db.close();
    throw new Error(`Attachment not found: ${args.id}`);
  }

  if (!args.regenerate) {
    db.close();
    return {
      link: attachment.link,
      expires_at: attachment.expiresAt,
    };
  }

  // Regenerate
  const config = getConfig();
  const linkType = getLinkType(config);
  const expiryStr = args.expiry ?? config.defaults.expiry;
  const { milliseconds: expiryMs } = parseExpiryStrict(expiryStr);
  const expiresAt = expiryMs !== null ? Date.now() + expiryMs : null;

  let link: string;
  if (linkType === "presigned" && (attachment.storageBackend ?? "s3") === "s3") {
    const s3 = new S3Client(config.s3);
    link = await generatePresignedLink(s3, attachment.s3Key, expiryMs);
  } else {
    const { token } = db.createShareLink({ attachmentId: attachment.id, expiresAt });
    link = generateShareLink(token, getPublicBaseUrl(config), config.server.publicPath);
  }

  db.updateLink(args.id, link, expiresAt);
  db.close();

  return { link, expires_at: expiresAt };
}

async function handleUploadAttachments(args: {
  paths: string[];
  expiry?: string;
  tag?: string;
  password?: string;
  encrypt?: boolean;
  max_downloads?: number;
}) {
  if (!args.paths || args.paths.length === 0) {
    return [];
  }

  const results: Array<
    { id: string; link: string | null; filename: string; size: number } | { path: string; error: string }
  > = [];

  for (const filePath of args.paths) {
    try {
      const attachment = await uploadFile(filePath, {
        expiry: args.expiry,
        tag: args.tag,
        password: args.password,
        encrypt: args.encrypt,
        maxDownloads: args.max_downloads,
      });
      results.push({
        id: attachment.id,
        link: attachment.link,
        filename: attachment.filename,
        size: attachment.size,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ path: filePath, error: message });
    }
  }

  return results;
}

async function handlePresignUpload(args: {
  filename: string;
  expiry?: string;
  content_type?: string;
}) {
  const config = getConfig();
  const filename = sanitizeFilename(args.filename);

  // Determine content type
  const contentType =
    args.content_type ?? (mimeLookup(filename) || "application/octet-stream") as string;

  // Parse expiry (default 1h)
  const expiryStr = args.expiry ?? "1h";
  const { milliseconds: expiryMs } = parseExpiryStrict(expiryStr);
  if (expiryMs === null) {
    throw new Error("Presigned upload expiry cannot be never");
  }
  validateS3Config(config);

  const expirySeconds = Math.floor(expiryMs / 1000);

  // Generate ID and S3 key
  const id = `att_${nanoid(11)}`;
  const s3Key = createObjectKey(id, filename);

  // Generate presigned PUT URL
  const s3 = new S3Client(config.s3);
  const uploadUrl = await s3.presignPut(s3Key, contentType, expirySeconds);

  // Create DB record with size 0 (pending upload)
  const now = Date.now();
  const expiresAt = now + expiryMs;
  const db = new AttachmentsDB();
  try {
    db.insert({
      id,
      filename,
      s3Key,
      bucket: config.s3.bucket,
      size: 0,
      contentType,
      link: null,
      tag: null,
      expiresAt,
      createdAt: now,
      storageBackend: "s3",
      status: "pending",
    });
  } finally {
    db.close();
  }

  return {
    upload_url: uploadUrl,
    id,
    expires_at: expiresAt,
    finalize_tool: "complete_presigned_upload",
  };
}

async function handleCompletePresignedUpload(args: {
  id: string;
  expiry?: string;
  password?: string;
  max_downloads?: number;
  link_type?: "presigned" | "server";
}) {
  const config = getConfig();
  validateS3Config(config);

  const db = new AttachmentsDB();
  const attachment = db.findById(args.id);
  if (!attachment) {
    db.close();
    throw new Error(`Pending attachment not found: ${args.id}`);
  }
  if (attachment.status !== "pending") {
    db.close();
    throw new Error(`Attachment upload is already complete: ${args.id}`);
  }

  try {
    const s3 = new S3Client(config.s3);
    const info = await s3.head(attachment.s3Key);
    const size = info.contentLength ?? attachment.size;
    if (size > config.storage.maxSizeBytes) {
      try {
        await s3.delete(attachment.s3Key);
      } catch {
        // Best-effort cleanup; the pending DB row is removed either way.
      }
      db.delete(args.id);
      throw new Error(`File too large. Maximum size is ${config.storage.maxSizeBytes} bytes.`);
    }

    const { milliseconds: expiryMs } = parseExpiryStrict(args.expiry ?? config.defaults.expiry);
    const expiresAt = expiryMs !== null ? Date.now() + expiryMs : null;
    const maxDownloads = typeof args.max_downloads === "number" && args.max_downloads > 0
      ? Math.floor(args.max_downloads)
      : null;
    const linkType = args.link_type ?? config.defaults.linkType;
    const mustUseServerLink = !!args.password || maxDownloads !== null || linkType !== "presigned";

    let link: string;
    if (!mustUseServerLink && (attachment.storageBackend ?? "s3") === "s3") {
      link = await generatePresignedLink(s3, attachment.s3Key, expiryMs);
    } else {
      const { token } = db.createShareLink({
        attachmentId: attachment.id,
        expiresAt,
        password: args.password,
        maxUses: maxDownloads,
      });
      link = generateShareLink(token, getPublicBaseUrl(config), config.server.publicPath);
    }

    db.markReady({
      id: attachment.id,
      size,
      contentType: info.contentType ?? attachment.contentType,
      link,
      expiresAt,
    });

    return {
      id: attachment.id,
      filename: attachment.filename,
      size,
      link,
      expires_at: expiresAt,
    };
  } finally {
    db.close();
  }
}

function handleConfigureS3(args: {
  bucket: string;
  region: string;
  access_key?: string;
  secret_key?: string;
  base_url?: string;
}) {
  if (!!args.access_key !== !!args.secret_key) {
    throw new Error("access_key and secret_key must be provided together, or both omitted for default credential-chain auth");
  }
  setConfig({
    s3: {
      bucket: args.bucket,
      region: args.region,
      ...(args.access_key && args.secret_key
        ? { accessKeyId: args.access_key, secretAccessKey: args.secret_key }
        : {}),
      ...(args.base_url !== undefined ? { endpoint: args.base_url } : {}),
    },
  });
  return "ok";
}

function handleDescribeTools(args: { tool_name?: string }) {
  if (args.tool_name) {
    const schema = FULL_SCHEMAS[args.tool_name];
    if (!schema) throw new Error(`Unknown tool: ${args.tool_name}`);
    return schema;
  }
  return FULL_SCHEMAS;
}

async function handleLinkToTask(args: {
  attachment_id: string;
  task_id: string;
  todos_url?: string;
}) {
  const todosUrl = args.todos_url ?? "http://localhost:3000";
  const db = new AttachmentsDB();
  let att: ReturnType<AttachmentsDB["findById"]>;
  try {
    att = db.findById(args.attachment_id);
  } finally {
    db.close();
  }

  if (!att) {
    throw new Error(`Attachment not found: ${args.attachment_id}`);
  }

  const url = `${todosUrl}/api/tasks/${args.task_id}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      metadata: {
        _attachments: [
          {
            id: att.id,
            link: att.link,
            filename: att.filename,
            size: att.size,
          },
        ],
      },
    }),
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Task not found: ${args.task_id}`);
    }
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to update task ${args.task_id}: HTTP ${response.status}${body ? ` — ${body}` : ""}`
    );
  }

  return `Linked ${args.attachment_id} → task ${args.task_id}`;
}

async function handleCompleteTaskWithFiles(args: {
  task_id: string;
  paths: string[];
  todos_url?: string;
  expiry?: string;
  notes?: string;
}) {
  if (!args.paths || args.paths.length === 0) {
    throw new Error("'paths' must be a non-empty array.");
  }

  const todosUrl = args.todos_url ?? "http://localhost:3000";

  // Upload each file and collect attachment IDs + links
  const attachment_ids: string[] = [];
  const links: Array<string | null> = [];

  for (const filePath of args.paths) {
    const attachment = await uploadFile(filePath, { expiry: args.expiry });
    attachment_ids.push(attachment.id);
    links.push(attachment.link);
  }

  // Complete the task via todos REST API
  const url = `${todosUrl}/api/tasks/${args.task_id}/complete`;
  const body: Record<string, unknown> = { attachment_ids };
  if (args.notes !== undefined) {
    body.notes = args.notes;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Task not found: ${args.task_id}`);
    }
    const responseBody = await response.text().catch(() => "");
    throw new Error(
      `Failed to complete task ${args.task_id}: HTTP ${response.status}${responseBody ? ` — ${responseBody}` : ""}`
    );
  }

  return { task_id: args.task_id, attachment_ids, links };
}

async function handleSaveSession(args: {
  session_id: string;
  sessions_url?: string;
  format?: "markdown" | "html";
  expiry?: string;
  tag?: string;
}) {
  const sessionsUrl = args.sessions_url ?? "http://localhost:3458";
  const fmt = args.format === "html" ? "html" : "markdown";

  // Fetch messages from sessions API
  async function fetchMessages(): Promise<Array<Record<string, unknown>>> {
    const messagesUrl = `${sessionsUrl}/api/sessions/${args.session_id}/messages`;
    const res = await fetch(messagesUrl);
    if (res.ok) {
      const data = await res.json() as unknown;
      if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.messages)) return obj.messages as Array<Record<string, unknown>>;
      if (Array.isArray(obj.data)) return obj.data as Array<Record<string, unknown>>;
      return [{ role: "raw", content: JSON.stringify(data) }];
    }
    const sessionUrl = `${sessionsUrl}/api/sessions/${args.session_id}`;
    const res2 = await fetch(sessionUrl);
    if (!res2.ok) {
      throw new Error(`Failed to fetch session ${args.session_id}: HTTP ${res2.status}`);
    }
    const data2 = await res2.json() as unknown;
    const obj2 = data2 as Record<string, unknown>;
    if (Array.isArray(obj2.messages)) return obj2.messages as Array<Record<string, unknown>>;
    return [{ role: "raw", content: JSON.stringify(data2) }];
  }

  const messages = await fetchMessages();

  type Msg = Record<string, unknown>;
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  let content: string;
  if (fmt === "html") {
    const body = messages
      .map((msg: Msg) => {
        const role = String(msg.role ?? "unknown");
        const text = String(msg.content ?? msg.text ?? JSON.stringify(msg));
        const ts = msg.timestamp ?? msg.created_at;
        const timeStr = ts ? ` <small>${new Date(ts as string).toISOString()}</small>` : "";
        return `<div class="message ${escape(role)}"><strong>${escape(role)}</strong>${timeStr}<p>${escape(text)}</p></div>`;
      })
      .join("\n");
    content = `<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"><title>Session: ${escape(args.session_id)}</title></head>\n<body>\n<h1>Session Snapshot: ${escape(args.session_id)}</h1>\n${body}\n</body>\n</html>`;
  } else {
    const lines: string[] = [`# Session Snapshot: ${args.session_id}`, ""];
    for (const msg of messages as Msg[]) {
      const role = String(msg.role ?? "unknown");
      const text = String(msg.content ?? msg.text ?? JSON.stringify(msg));
      const ts = msg.timestamp ?? msg.created_at;
      const header = ts ? `### ${role} (${new Date(ts as string).toISOString()})` : `### ${role}`;
      lines.push(header, "", text, "");
    }
    content = lines.join("\n");
  }

  const ext = fmt === "html" ? "html" : "md";
  const filename = `session-${args.session_id}.${ext}`;
  const buffer = Buffer.from(content, "utf-8");

  const attachment = await uploadFromBuffer(buffer, filename, {
    expiry: args.expiry,
    tag: args.tag,
  });

  return {
    id: attachment.id,
    link: attachment.link,
    filename: attachment.filename,
  };
}

async function handleCheckAttachmentHealth(args: {
  fix?: boolean;
  limit?: number;
  verbose?: boolean;
  format?: "compact" | "json";
  todos_url?: string;
}) {
  const summary = await runHealthCheck({ fix: args.fix });
  if (args.format !== "json") {
    return formatHealthCompact(summary, {
      limit: Number.isInteger(args.limit) && args.limit! > 0 ? args.limit : 20,
      verbose: args.verbose,
    });
  }
  return {
    healthy: summary.healthy,
    expired: summary.expired,
    dead: summary.dead,
    no_link: summary.noLink,
    fixed: summary.fixed,
    total: summary.total,
    summary: `${summary.healthy} healthy, ${summary.expired} expired, ${summary.dead} dead`,
    results: summary.results.map((r) => ({
      id: r.id,
      filename: r.filename,
      status: r.status,
      link: r.link,
      expires_at: r.expiresAt,
      fixed: r.fixed ?? false,
      new_link: r.newLink,
    })),
  };
}

function handleReportStats(args: { days?: number; tag?: string; format?: "compact" | "json" }) {
  const days = args.days ?? 7;
  if (isNaN(days) || days < 1) {
    throw new Error("days must be a positive integer");
  }
  const nowMs = Date.now();
  const sinceMs = nowMs - days * 24 * 60 * 60 * 1000;
  const db = new AttachmentsDB();
  let all: ReturnType<AttachmentsDB["findAll"]>;
  try {
    all = db.findAll({ includeExpired: true, tag: args.tag });
  } finally {
    db.close();
  }
  const report = computeReport(all, sinceMs, nowMs);
  if (args.format === "json") return report;
  return `${formatReportCompact(report)}\nUse format:'json' for the full report object.`;
}

function handleStorageStatus(args: { format?: "compact" | "json" }) {
  const status = getStorageStatus();
  if (args.format === "json") return status;
  const syncSummary = status.sync.length === 0
    ? "none"
    : status.sync.map((item) => `${item.table_name}:${item.direction}:${item.last_synced_at ?? "never"}`).join(", ");
  return [
    `Storage: ${status.mode}${status.configured ? " (remote configured)" : " (local only)"}`,
    `Env: ${status.activeEnv ?? "none"}`,
    `Tables: ${status.tables.join(", ")}`,
    `Sync: ${syncSummary}`,
    "Use format:'json' for full storage metadata.",
  ].join("\n");
}

async function handleGetContext(args: { format?: string }) {
  const db = new AttachmentsDB();
  try {
    const all = db.findAll({ includeExpired: true });
    const active = all.filter(a => !a.expiresAt || a.expiresAt > Date.now());
    const expiringSoon = all.filter(a => a.expiresAt && a.expiresAt > Date.now() && a.expiresAt - Date.now() < 24 * 60 * 60 * 1000);
    const expired = all.filter(a => a.expiresAt && a.expiresAt <= Date.now());
    const lines: string[] = [`Attachments: ${all.length} total (${active.length} active, ${expired.length} expired)`];
    if (expiringSoon.length > 0) lines.push(`⚠ Expiring in 24h: ${expiringSoon.length} (${expiringSoon.map(a => a.filename).join(", ")})`);
    if (all.length > 0) {
      const recent = all.slice(0, 3).map(a => `${a.filename} (${a.id})`).join(", ");
      lines.push(`Recent: ${recent}`);
    }
    if (args.format === "json") return { attachments: all.length, active: active.length, expired: expired.length, expiring_soon: expiringSoon.length, summary: lines.join("\n") };
    return lines.join("\n");
  } finally {
    db.close();
  }
}

function handleSearchTools(args: { query: string }) {
  const q = args.query.toLowerCase();
  const matches = LEAN_TOOLS.map((t) => t.name).filter((name) =>
    name.includes(q)
  );
  return matches.join("\n");
}

function readStorageTables(args: Record<string, unknown>): string[] | undefined {
  return Array.isArray(args["tables"]) ? args["tables"].map(String) : undefined;
}

function readStorageSyncOptions(args: Record<string, unknown>): { tables?: string[] } | undefined {
  const tables = readStorageTables(args);
  return tables ? { tables } : undefined;
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

function getMcpVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("../../package.json") as { version: string }).version;
  } catch {
    return process.env.npm_package_version ?? "1.0.0";
  }
}

export function buildServer(): Server {
  const server = new Server(
    { name: "attachments-mcp", version: getMcpVersion() },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getToolsForProfile(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case "upload_attachment":
          result = await handleUploadAttachment(
            args as Parameters<typeof handleUploadAttachment>[0]
          );
          break;
        case "download_attachment":
          result = await handleDownloadAttachment(
            args as Parameters<typeof handleDownloadAttachment>[0]
          );
          break;
        case "list_attachments":
          result = handleListAttachments(
            args as Parameters<typeof handleListAttachments>[0]
          );
          break;
        case "delete_attachment":
          result = handleDeleteAttachment(
            args as Parameters<typeof handleDeleteAttachment>[0]
          );
          break;
        case "get_link":
          result = await handleGetLink(
            args as Parameters<typeof handleGetLink>[0]
          );
          break;
        case "upload_attachments":
          result = await handleUploadAttachments(
            args as Parameters<typeof handleUploadAttachments>[0]
          );
          break;
        case "configure_s3":
          result = handleConfigureS3(
            args as Parameters<typeof handleConfigureS3>[0]
          );
          break;
        case "presign_upload":
          result = await handlePresignUpload(
            args as Parameters<typeof handlePresignUpload>[0]
          );
          break;
        case "complete_presigned_upload":
          result = await handleCompletePresignedUpload(
            args as Parameters<typeof handleCompletePresignedUpload>[0]
          );
          break;
        case "describe_tools":
          result = handleDescribeTools(
            args as Parameters<typeof handleDescribeTools>[0]
          );
          break;
        case "report_stats":
          result = handleReportStats(
            args as Parameters<typeof handleReportStats>[0]
          );
          break;
        case "search_tools":
          result = handleSearchTools(
            args as Parameters<typeof handleSearchTools>[0]
          );
          break;
        case "link_to_task":
          result = await handleLinkToTask(
            args as Parameters<typeof handleLinkToTask>[0]
          );
          break;
        case "save_session":
          result = await handleSaveSession(
            args as Parameters<typeof handleSaveSession>[0]
          );
          break;
        case "complete_task_with_files":
          result = await handleCompleteTaskWithFiles(
            args as Parameters<typeof handleCompleteTaskWithFiles>[0]
          );
          break;
        case "check_attachment_health":
          result = await handleCheckAttachmentHealth(
            args as Parameters<typeof handleCheckAttachmentHealth>[0]
          );
          break;
        case "get_context":
          result = await handleGetContext(
            args as Parameters<typeof handleGetContext>[0]
          );
          break;
        case "register_agent": {
          const a = args as { name: string; session_id?: string };
          const agent = registerAttachmentAgent(a.name, a.session_id);
          result = { agent_id: agent.id, name: agent.name, last_seen_at: agent.last_seen_at };
          break;
        }
        case "heartbeat": {
          const a = args as { agent_id: string };
          const agent = agentRegistry.get(a.agent_id);
          if (!agent) throw new Error(`Agent not found: ${a.agent_id}`);
          agent.last_seen_at = new Date().toISOString();
          result = { agent_id: agent.id, last_seen_at: agent.last_seen_at };
          break;
        }
        case "set_focus": {
          const a = args as { agent_id: string; project_id?: string };
          const agent = agentRegistry.get(a.agent_id);
          if (!agent) throw new Error(`Agent not found: ${a.agent_id}`);
          agent.project_id = a.project_id;
          result = { agent_id: agent.id, project_id: agent.project_id };
          break;
        }
        case "list_agents": {
          result = [...agentRegistry.values()];
          break;
        }
        case "storage_status": {
          result = handleStorageStatus(args as Parameters<typeof handleStorageStatus>[0]);
          break;
        }
        case "storage_push": {
          result = await storagePush(readStorageSyncOptions(args));
          break;
        }
        case "storage_pull": {
          result = await storagePull(readStorageSyncOptions(args));
          break;
        }
        case "storage_sync": {
          result = await storageSync(readStorageSyncOptions(args));
          break;
        }
        case "send_feedback": {
          const fa = args as { message: string; email?: string; category?: string };
          const fdb = new AttachmentsDB();
          try {
            fdb.run("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)", [fa.message, fa.email || null, fa.category || "general", getMcpVersion()]);
          } finally {
            fdb.close();
          }
          result = "Feedback saved. Thank you!";
          break;
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

/** @deprecated Use buildServer() */
export const createServer = buildServer;

function hasFlag(...flags: string[]): boolean {
  return process.argv.some((arg) => flags.includes(arg));
}

function printHelp(): void {
  process.stdout.write(
    `Usage: attachments-mcp [options]

Attachments MCP server (stdio transport by default)

Options:
  --http           Serve MCP over Streamable HTTP (127.0.0.1)
  --port <number>  HTTP port (default: 8800, env: MCP_HTTP_PORT)
  -h, --help       Show help
  -V, --version    Show version
`,
  );
}

async function main(): Promise<void> {
  if (hasFlag("--help", "-h")) {
    printHelp();
    return;
  }

  if (hasFlag("--version", "-V")) {
    process.stdout.write(`${getMcpVersion()}\n`);
    return;
  }

  if (isStdioMode()) {
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  // Default: shared Streamable HTTP server (one process per MCP, many agents).
  const handle = await startMcpHttpServer(buildServer, {
    port: resolveMcpHttpPort(),
  });
  process.on("SIGINT", () => {
    void handle.close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void handle.close().finally(() => process.exit(0));
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  main().catch((error) => {
    console.error("MCP server error:", error);
    process.exit(1);
  });
}
