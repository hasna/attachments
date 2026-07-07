import { describe, it, expect } from "bun:test";
import { setConfig } from "../core/config";
import { buildPasswordHash } from "../core/security";
import {
  createApp,
  currentApp,
  mockAttachment,
  mockDbConsumeShareLink,
  mockDbFindById,
  mockDbFindShareLinkByToken,
  mockGeneratePresignedLink,
  mockOpenAttachmentStream,
  mockShareLink,
} from "./server.test-harness.test";

describe("REST API server public links", () => {
  describe("GET /a/:token — public share page", () => {
    it("renders a password prompt without consuming password-protected links", async () => {
      mockDbFindShareLinkByToken.mockImplementation(() => ({
        ...mockShareLink,
        passwordHash: buildPasswordHash("passw0rd"),
      }));

      const res = await currentApp().request("/a/share_testtoken");

      expect(res.status).toBe(200);
      expect(await res.text()).toContain('name="password"');
      expect(mockDbConsumeShareLink).not.toHaveBeenCalled();
    });

    it("serves share pages from the configured public path", async () => {
      setConfig({ server: { publicPath: "/files" } });
      const customApp = createApp();
      const res = await customApp.request("/files/share_testtoken");

      expect(res.status).toBe(200);
      expect(await res.text()).toContain("test.txt");
      expect(mockDbConsumeShareLink).not.toHaveBeenCalled();
    });

    it("requires the password for public downloads", async () => {
      mockDbFindShareLinkByToken.mockImplementation(() => ({
        ...mockShareLink,
        passwordHash: buildPasswordHash("passw0rd"),
      }));

      const missing = await currentApp().request("/a/share_testtoken/download");
      expect(missing.status).toBe(401);
      expect(mockOpenAttachmentStream).not.toHaveBeenCalled();

      const form = new FormData();
      form.append("password", "passw0rd");
      const res = await currentApp().request("/a/share_testtoken/download", {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(200);
      expect(mockDbConsumeShareLink).toHaveBeenCalledWith("share_link_1");
      expect(mockOpenAttachmentStream).toHaveBeenCalledTimes(1);
    });

    it("does not stream when the public download password is wrong", async () => {
      mockDbFindShareLinkByToken.mockImplementation(() => ({
        ...mockShareLink,
        passwordHash: buildPasswordHash("passw0rd"),
      }));

      const form = new FormData();
      form.append("password", "wrong");
      const res = await currentApp().request("/a/share_wrongpassword/download", {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(401);
      expect(mockDbConsumeShareLink).not.toHaveBeenCalled();
      expect(mockOpenAttachmentStream).not.toHaveBeenCalled();
    });

    it("temporarily rate-limits repeated wrong public download passwords", async () => {
      mockDbFindShareLinkByToken.mockImplementation(() => ({
        ...mockShareLink,
        passwordHash: buildPasswordHash("passw0rd"),
      }));

      for (let i = 0; i < 10; i++) {
        const form = new FormData();
        form.append("password", "wrong");
        const res = await currentApp().request("/a/share_ratelimit/download", {
          method: "POST",
          headers: { "x-forwarded-for": "203.0.113.10" },
          body: form,
        });
        expect(res.status).toBe(401);
      }

      const blockedForm = new FormData();
      blockedForm.append("password", "wrong");
      const blocked = await currentApp().request("/a/share_ratelimit/download", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.10" },
        body: blockedForm,
      });

      expect(blocked.status).toBe(429);
      expect(await blocked.text()).toContain("Too many password attempts");
      expect(mockOpenAttachmentStream).not.toHaveBeenCalled();
    });

    it("does not consume limited links for page, HEAD, or unconfirmed direct GET probes", async () => {
      mockDbFindShareLinkByToken.mockImplementation(() => ({
        ...mockShareLink,
        maxUses: 2,
        usedCount: 0,
      }));

      const page = await currentApp().request("/a/share_testtoken");
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("2 of 2 remaining");

      const head = await currentApp().request("/a/share_testtoken/download", { method: "HEAD" });
      expect(head.status).toBe(200);

      const directGet = await currentApp().request("/a/share_testtoken/download");
      expect(directGet.status).toBe(303);
      expect(directGet.headers.get("location")).toBe("/a/share_testtoken");

      expect(mockDbConsumeShareLink).not.toHaveBeenCalled();
      expect(mockOpenAttachmentStream).not.toHaveBeenCalled();
    });

    it("allows CLI-confirmed GET downloads for limited links and consumes once", async () => {
      mockDbFindShareLinkByToken.mockImplementation(() => ({
        ...mockShareLink,
        maxUses: 2,
        usedCount: 0,
      }));

      const res = await currentApp().request("/a/share_testtoken/download", {
        headers: { "x-attachments-download": "1" },
      });

      expect(res.status).toBe(200);
      expect(mockDbConsumeShareLink).toHaveBeenCalledTimes(1);
      expect(mockOpenAttachmentStream).toHaveBeenCalledTimes(1);
    });

    it("renders a friendly page for exhausted attachment links", async () => {
      mockDbFindShareLinkByToken.mockImplementation(() => ({
        ...mockShareLink,
        maxUses: 1,
        usedCount: 1,
      }));

      const page = await currentApp().request("/a/share_testtoken");
      expect(page.status).toBe(410);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("This attachment link has already been used");

      const download = await currentApp().request("/a/share_testtoken/download", {
        method: "POST",
      });
      expect(download.status).toBe(410);
      expect(download.headers.get("content-type")).toContain("text/html");
      expect(await download.text()).toContain("Ask the sender for a new link");
      expect(mockOpenAttachmentStream).not.toHaveBeenCalled();
    });
  });

  describe("GET /d/:id — public shortlink", () => {
    it("streams legacy links through the app", async () => {
      const res = await currentApp().request("/d/att_test00001");
      expect(res.status).toBe(200);
    });

    it("returns 404 for unknown id", async () => {
      mockDbFindById.mockImplementation(() => null);
      const res = await currentApp().request("/d/att_missing");
      expect(res.status).toBe(404);
    });

    it("streams server-link attachments without generating S3 URLs", async () => {
      mockDbFindById.mockImplementation(() => ({
        ...mockAttachment,
        link: "http://localhost:3459/d/att_test00001",
      }));

      const res = await currentApp().request("/d/att_test00001");
      expect(res.status).toBe(200);
      expect(mockGeneratePresignedLink).not.toHaveBeenCalled();
    });

    it("returns 500 when streaming fails during legacy download", async () => {
      mockDbFindById.mockImplementation(() => ({
        ...mockAttachment,
        link: "http://localhost:3459/d/att_test00001",
      }));
      mockOpenAttachmentStream.mockImplementation(async () => {
        throw new Error("Presign failed");
      });

      const res = await currentApp().request("/d/att_test00001");
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("Presign failed");
    });
  });
});
