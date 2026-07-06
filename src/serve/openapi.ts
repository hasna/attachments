/**
 * OpenAPI 3 description of the attachments serve HTTP API.
 *
 * This is the single source of truth for the generated SDK
 * (`@hasna/attachments-sdk`) — run `bun run sdk:generate` after changing it —
 * and is also served live at `GET /openapi.json`.
 */

export function buildOpenApiDocument(version: string): Record<string, unknown> {
  const attachmentSchema = {
    type: "object",
    properties: {
      id: { type: "string" },
      filename: { type: "string" },
      size: { type: "integer" },
      content_type: { type: "string" },
      link: { type: "string", nullable: true },
      tag: { type: "string", nullable: true },
      expires_at: { type: "integer", nullable: true },
      created_at: { type: "integer" },
    },
    required: ["id", "filename", "size", "created_at"],
  };

  return {
    openapi: "3.0.3",
    info: {
      title: "AttachmentsApi",
      version,
      description: "Attachment transfer service — upload, share, download with API-key auth.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      },
      schemas: {
        Attachment: attachmentSchema,
        HealthStatus: {
          type: "object",
          properties: {
            status: { type: "string" },
            version: { type: "string" },
            mode: { type: "string" },
          },
          required: ["status", "version", "mode"],
        },
        ReadyStatus: {
          type: "object",
          properties: {
            status: { type: "string" },
            version: { type: "string" },
            mode: { type: "string" },
            pending_migrations: { type: "array", items: { type: "string" } },
          },
          required: ["status", "version", "mode"],
        },
        VersionInfo: {
          type: "object",
          properties: {
            status: { type: "string" },
            version: { type: "string" },
            mode: { type: "string" },
          },
          required: ["status", "version", "mode"],
        },
        CreateAttachmentRequest: {
          type: "object",
          properties: {
            filename: { type: "string" },
            content_base64: { type: "string", description: "File bytes, base64-encoded." },
            expiry: { type: "string", description: "e.g. 30m, 24h, 7d, never." },
            tag: { type: "string" },
            password: { type: "string" },
            max_downloads: { type: "integer" },
            link_type: { type: "string", enum: ["presigned", "server"] },
          },
          required: ["filename", "content_base64"],
        },
        LinkResponse: {
          type: "object",
          properties: {
            link: { type: "string", nullable: true },
            expires_at: { type: "integer", nullable: true },
          },
          required: ["link"],
        },
        RegenerateLinkRequest: {
          type: "object",
          properties: {
            expiry: { type: "string" },
            password: { type: "string" },
            max_downloads: { type: "integer" },
            link_type: { type: "string", enum: ["presigned", "server"] },
          },
        },
        DeleteResponse: {
          type: "object",
          properties: { deleted: { type: "boolean" }, id: { type: "string" } },
          required: ["deleted", "id"],
        },
        AttachmentList: {
          type: "array",
          items: attachmentSchema,
        },
        ErrorResponse: {
          type: "object",
          properties: { error: { type: "string" } },
          required: ["error"],
        },
      },
    },
    paths: {
      "/health": {
        get: {
          operationId: "getHealth",
          summary: "Liveness probe.",
          responses: {
            "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/HealthStatus" } } } },
          },
        },
      },
      "/ready": {
        get: {
          operationId: "getReady",
          summary: "Readiness probe (DB reachable and schema migrated).",
          responses: {
            "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/ReadyStatus" } } } },
          },
        },
      },
      "/version": {
        get: {
          operationId: "getVersion",
          summary: "Service version and mode.",
          responses: {
            "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/VersionInfo" } } } },
          },
        },
      },
      "/v1/attachments": {
        get: {
          operationId: "listAttachments",
          summary: "List attachments.",
          security: [{ apiKey: [] }],
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer" } },
            { name: "tag", in: "query", schema: { type: "string" } },
            { name: "expired", in: "query", schema: { type: "boolean" } },
          ],
          responses: {
            "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/AttachmentList" } } } },
          },
        },
        post: {
          operationId: "createAttachment",
          summary: "Create an attachment from base64 content.",
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateAttachmentRequest" } } },
          },
          responses: {
            "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/Attachment" } } } },
          },
        },
      },
      "/v1/attachments/{id}": {
        get: {
          operationId: "getAttachment",
          summary: "Get attachment metadata.",
          security: [{ apiKey: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Attachment" } } } },
          },
        },
        delete: {
          operationId: "deleteAttachment",
          summary: "Delete an attachment.",
          security: [{ apiKey: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/DeleteResponse" } } } },
          },
        },
      },
      "/v1/attachments/{id}/link": {
        get: {
          operationId: "getAttachmentLink",
          summary: "Get the current share link.",
          security: [{ apiKey: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/LinkResponse" } } } },
          },
        },
        post: {
          operationId: "regenerateAttachmentLink",
          summary: "Regenerate the share link.",
          security: [{ apiKey: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: false,
            content: { "application/json": { schema: { $ref: "#/components/schemas/RegenerateLinkRequest" } } },
          },
          responses: {
            "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/LinkResponse" } } } },
          },
        },
      },
    },
  };
}
