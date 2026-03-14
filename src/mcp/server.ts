#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { nanoid } from "nanoid";
import { format } from "date-fns";
import { lookup as mimeLookup } from "mime-types";
import { uploadFile, uploadFromUrl } from "../core/upload.js";
import { downloadAttachment } from "../core/download.js";
import { AttachmentsDB } from "../core/db.js";
import { getConfig, setConfig, parseExpiry } from "../core/config.js";
import { generatePresignedLink, generateServerLink, getLinkType } from "../core/links.js";
import { S3Client } from "../core/s3.js";

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
      },
      required: ["paths"],
    },
  },
  configure_s3: {
    name: "configure_s3",
    description: "Persist S3 configuration to ~/.attachments/config.json.",
    inputSchema: {
      type: "object",
      properties: {
        bucket: { type: "string", description: "S3 bucket name." },
        region: { type: "string", description: "AWS region, e.g. 'us-east-1'." },
        access_key: { type: "string", description: "AWS access key ID." },
        secret_key: { type: "string", description: "AWS secret access key." },
        base_url: { type: "string", description: "Optional custom endpoint / base URL." },
      },
      required: ["bucket", "region", "access_key", "secret_key"],
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
  describe_tools: {
    name: "describe_tools",
    description: "Return full verbose schemas for one or all tools. Set the AGENT_PROFILE env var to control which tools are exposed in tools/list: 'minimal' (upload_attachment, download_attachment, get_link), 'standard' (default, adds list_attachments, delete_attachment, complete_task_with_files), or 'full' (all 12 tools).",
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
      required: ["bucket", "region", "access_key", "secret_key"],
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
]);

export function getToolsForProfile(
  profile?: string
): typeof LEAN_TOOLS {
  const p = (profile ?? process.env.AGENT_PROFILE ?? "standard").toLowerCase();
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
}) {
  if (!args.path && !args.url) {
    throw new Error("Either 'path' or 'url' must be provided.");
  }
  if (args.path && args.url) {
    throw new Error("Provide either 'path' or 'url', not both.");
  }

  const opts = { expiry: args.expiry, tag: args.tag };
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
  const db = new AttachmentsDB();
  let attachments: ReturnType<AttachmentsDB["findAll"]>;
  try {
    attachments = db.findAll({ limit: args.limit, tag: args.tag });
  } finally {
    db.close();
  }

  if (args.format === "json") {
    return attachments;
  }

  // compact format
  if (attachments.length === 0) return "no attachments";
  return attachments
    .map((a) => {
      const exp = a.expiresAt
        ? new Date(a.expiresAt).toISOString().slice(0, 10)
        : "never";
      return `${a.id}  ${a.filename}  ${(a.size / 1024).toFixed(1)}KB  exp:${exp}`;
    })
    .join("\n");
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
  const expiryMs = parseExpiry(expiryStr);
  const expiresAt = expiryMs !== null ? Date.now() + expiryMs : null;

  let link: string;
  if (linkType === "presigned") {
    const s3 = new S3Client(config.s3);
    link = await generatePresignedLink(s3, attachment.s3Key, expiryMs);
  } else {
    link = generateServerLink(attachment.id, config.server.baseUrl);
  }

  db.updateLink(args.id, link, expiresAt);
  db.close();

  return { link, expires_at: expiresAt };
}

async function handleUploadAttachments(args: {
  paths: string[];
  expiry?: string;
  tag?: string;
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
  const filename = args.filename;

  // Determine content type
  const contentType =
    args.content_type ?? (mimeLookup(filename) || "application/octet-stream") as string;

  // Parse expiry (default 1h)
  const expiryStr = args.expiry ?? "1h";
  const expiryMs = parseExpiry(expiryStr);
  if (expiryMs === null) {
    throw new Error(`Invalid expiry format: ${expiryStr}`);
  }

  const expirySeconds = Math.floor(expiryMs / 1000);

  // Generate ID and S3 key
  const id = `att_${nanoid(11)}`;
  const datePrefix = format(new Date(), "yyyy-MM-dd");
  const s3Key = `attachments/${datePrefix}/${id}/${filename}`;

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
    });
  } finally {
    db.close();
  }

  return {
    upload_url: uploadUrl,
    id,
    expires_at: expiresAt,
  };
}

function handleConfigureS3(args: {
  bucket: string;
  region: string;
  access_key: string;
  secret_key: string;
  base_url?: string;
}) {
  setConfig({
    s3: {
      bucket: args.bucket,
      region: args.region,
      accessKeyId: args.access_key,
      secretAccessKey: args.secret_key,
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

function handleSearchTools(args: { query: string }) {
  const q = args.query.toLowerCase();
  const matches = LEAN_TOOLS.map((t) => t.name).filter((name) =>
    name.includes(q)
  );
  return matches.join("\n");
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

export function createServer(): Server {
  const server = new Server(
    { name: "attachments-mcp", version: "0.1.0" },
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
        case "describe_tools":
          result = handleDescribeTools(
            args as Parameters<typeof handleDescribeTools>[0]
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
        case "complete_task_with_files":
          result = await handleCompleteTaskWithFiles(
            args as Parameters<typeof handleCompleteTaskWithFiles>[0]
          );
          break;
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
