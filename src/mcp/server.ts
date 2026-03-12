#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { uploadFile } from "../core/upload.js";
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
    description: "Upload a local file to S3 and return a shareable link.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to upload." },
        expiry: { type: "string", description: "Link expiry, e.g. '24h', '7d', 'never'. Defaults to configured value." },
        tag: { type: "string", description: "Optional tag to attach to the attachment record." },
      },
      required: ["path"],
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
  describe_tools: {
    name: "describe_tools",
    description: "Return full verbose schemas for one or all tools.",
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
};

// ---------------------------------------------------------------------------
// Lean stub list — minimal descriptions to save tokens
// ---------------------------------------------------------------------------

const LEAN_TOOLS = [
  {
    name: "upload_attachment",
    description: "Upload file → link",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        expiry: { type: "string" },
        tag: { type: "string" },
      },
      required: ["path"],
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
];

// ---------------------------------------------------------------------------
// Tool handler helpers
// ---------------------------------------------------------------------------

async function handleUploadAttachment(args: {
  path: string;
  expiry?: string;
  tag?: string;
}) {
  const attachment = await uploadFile(args.path, {
    expiry: args.expiry,
    tag: args.tag,
  });
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
}) {
  const db = new AttachmentsDB();
  let attachments: ReturnType<AttachmentsDB["findAll"]>;
  try {
    attachments = db.findAll({ limit: args.limit });
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
    tools: LEAN_TOOLS,
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
        case "configure_s3":
          result = handleConfigureS3(
            args as Parameters<typeof handleConfigureS3>[0]
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
