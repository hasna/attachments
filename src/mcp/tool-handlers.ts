import { nanoid } from "nanoid";
import { lookup as mimeLookup } from "mime-types";
import { uploadFile, uploadFromUrl, uploadFromBuffer } from "../core/upload.js";
import { computeReport } from "../cli/commands/report.js";
import { runHealthCheck } from "../cli/commands/health-check.js";
import { downloadAttachment } from "../core/download.js";
import { AttachmentsDB } from "../core/db.js";
import { getStorageStatus, storagePull, storagePush, storageSync } from "../db/storage-sync.js";
import { getConfig, getPublicBaseUrl, parseExpiryStrict, setConfig, validateS3Config } from "../core/config.js";
import { generatePresignedLink, generateShareLink, getLinkType } from "../core/links.js";
import { S3Client } from "../core/s3.js";
import { createObjectKey, sanitizeFilename } from "../core/security.js";
import { FULL_SCHEMAS, LEAN_TOOLS } from "./tools.js";
import { getMcpVersion } from "./version.js";

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
  todos_url?: string;
}) {
  const summary = await runHealthCheck({ fix: args.fix });
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

function handleReportStats(args: { days?: number; tag?: string }) {
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
  return computeReport(all, sinceMs, nowMs);
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

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "upload_attachment":
      return handleUploadAttachment(
        args as Parameters<typeof handleUploadAttachment>[0]
      );
    case "download_attachment":
      return handleDownloadAttachment(
        args as Parameters<typeof handleDownloadAttachment>[0]
      );
    case "list_attachments":
      return handleListAttachments(
        args as Parameters<typeof handleListAttachments>[0]
      );
    case "delete_attachment":
      return handleDeleteAttachment(
        args as Parameters<typeof handleDeleteAttachment>[0]
      );
    case "get_link":
      return handleGetLink(
        args as Parameters<typeof handleGetLink>[0]
      );
    case "upload_attachments":
      return handleUploadAttachments(
        args as Parameters<typeof handleUploadAttachments>[0]
      );
    case "configure_s3":
      return handleConfigureS3(
        args as Parameters<typeof handleConfigureS3>[0]
      );
    case "presign_upload":
      return handlePresignUpload(
        args as Parameters<typeof handlePresignUpload>[0]
      );
    case "complete_presigned_upload":
      return handleCompletePresignedUpload(
        args as Parameters<typeof handleCompletePresignedUpload>[0]
      );
    case "describe_tools":
      return handleDescribeTools(
        args as Parameters<typeof handleDescribeTools>[0]
      );
    case "report_stats":
      return handleReportStats(
        args as Parameters<typeof handleReportStats>[0]
      );
    case "search_tools":
      return handleSearchTools(
        args as Parameters<typeof handleSearchTools>[0]
      );
    case "link_to_task":
      return handleLinkToTask(
        args as Parameters<typeof handleLinkToTask>[0]
      );
    case "save_session":
      return handleSaveSession(
        args as Parameters<typeof handleSaveSession>[0]
      );
    case "complete_task_with_files":
      return handleCompleteTaskWithFiles(
        args as Parameters<typeof handleCompleteTaskWithFiles>[0]
      );
    case "check_attachment_health":
      return handleCheckAttachmentHealth(
        args as Parameters<typeof handleCheckAttachmentHealth>[0]
      );
    case "get_context":
      return handleGetContext(
        args as Parameters<typeof handleGetContext>[0]
      );
    case "register_agent": {
      const a = args as { name: string; session_id?: string };
      const agent = registerAttachmentAgent(a.name, a.session_id);
      return { agent_id: agent.id, name: agent.name, last_seen_at: agent.last_seen_at };
    }
    case "heartbeat": {
      const a = args as { agent_id: string };
      const agent = agentRegistry.get(a.agent_id);
      if (!agent) throw new Error(`Agent not found: ${a.agent_id}`);
      agent.last_seen_at = new Date().toISOString();
      return { agent_id: agent.id, last_seen_at: agent.last_seen_at };
    }
    case "set_focus": {
      const a = args as { agent_id: string; project_id?: string };
      const agent = agentRegistry.get(a.agent_id);
      if (!agent) throw new Error(`Agent not found: ${a.agent_id}`);
      agent.project_id = a.project_id;
      return { agent_id: agent.id, project_id: agent.project_id };
    }
    case "list_agents":
      return [...agentRegistry.values()];
    case "storage_status":
      return getStorageStatus();
    case "storage_push":
      return storagePush(readStorageSyncOptions(args));
    case "storage_pull":
      return storagePull(readStorageSyncOptions(args));
    case "storage_sync":
      return storageSync(readStorageSyncOptions(args));
    case "send_feedback": {
      const fa = args as { message: string; email?: string; category?: string };
      const fdb = new AttachmentsDB();
      try {
        fdb.run("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)", [fa.message, fa.email || null, fa.category || "general", getMcpVersion()]);
      } finally {
        fdb.close();
      }
      return "Feedback saved. Thank you!";
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
