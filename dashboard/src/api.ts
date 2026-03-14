export interface Attachment {
  id: string;
  filename: string;
  size: number;
  content_type?: string;
  link: string | null;
  tag: string | null;
  expires_at: number | null;
  created_at: number;
}

export interface UploadResult {
  id: string;
  filename: string;
  size: number;
  link: string | null;
  tag: string | null;
  expires_at: number | null;
  created_at: number;
}

let BASE_URL = "http://localhost:3457";

export function setBaseUrl(url: string) {
  BASE_URL = url.replace(/\/$/, "");
}

export function getBaseUrl() {
  return BASE_URL;
}

export async function listAttachments(opts?: {
  limit?: number;
  includeExpired?: boolean;
  tag?: string;
}): Promise<Attachment[]> {
  const params = new URLSearchParams();
  params.set("limit", String(opts?.limit ?? 100));
  if (opts?.includeExpired) params.set("expired", "true");
  if (opts?.tag) params.set("tag", opts.tag);

  const res = await fetch(`${BASE_URL}/api/attachments?${params}`);
  if (!res.ok) throw new Error(`Failed to list: ${res.status}`);
  return res.json();
}

export async function uploadAttachment(
  file: File,
  opts?: { expiry?: string; tag?: string },
  onProgress?: (pct: number) => void
): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file);
  if (opts?.expiry) form.append("expiry", opts.expiry);
  if (opts?.tag) form.append("tag", opts.tag);

  // Use XMLHttpRequest for progress events
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE_URL}/api/attachments`);
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status === 201) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        const err = JSON.parse(xhr.responseText);
        reject(new Error(err.error ?? `Upload failed: ${xhr.status}`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Network error")));
    xhr.send(form);
  });
}

export async function deleteAttachment(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/attachments/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

export async function getLink(id: string): Promise<{ link: string | null; expires_at: number | null }> {
  const res = await fetch(`${BASE_URL}/api/attachments/${id}/link`);
  if (!res.ok) throw new Error(`Get link failed: ${res.status}`);
  return res.json();
}
