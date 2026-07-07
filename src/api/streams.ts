import { Readable } from "stream";
import { AttachmentsDB } from "../core/db";

export function toWebBody(body: Readable | ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  if (typeof (body as Readable).pipe === "function") {
    return Readable.toWeb(body as Readable) as unknown as ReadableStream<Uint8Array>;
  }
  return body as ReadableStream<Uint8Array>;
}

function toNodeBody(body: Readable | ReadableStream<Uint8Array>): Readable {
  if (typeof (body as Readable).pipe === "function") return body as Readable;
  return Readable.fromWeb(body as never);
}

export function trackShareDownloadCompletion(
  body: Readable | ReadableStream<Uint8Array>,
  shareLinkId: string,
  attachmentId: string
): Readable {
  const stream = toNodeBody(body);
  let ended = false;
  let settled = false;
  const settle = (ok: boolean) => {
    if (settled) return;
    settled = true;
    const db = new AttachmentsDB();
    try {
      if (ok) db.incrementDownloads(attachmentId);
      else db.releaseShareLink(shareLinkId);
    } finally {
      db.close();
    }
  };
  stream.once("end", () => {
    ended = true;
    settle(true);
  });
  stream.once("error", () => settle(false));
  stream.once("close", () => {
    if (!ended) settle(false);
  });
  return stream;
}
