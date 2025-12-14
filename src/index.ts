import { DurableObject } from "cloudflare:workers";
import { $array, $boolean, $nullable, $number, $object, $record, $string, type Infer } from "lizod";
import PostalMime, { type Attachment as PostalAttachment } from "postal-mime";

const attachmentSchema = $object({
  id: $string,
  filename: $string,
  contentType: $string,
  size: $nullable($number),
  r2Key: $string,
  inline: $boolean,
  contentId: $nullable($string),
});
const mailboxRecordSchema = $object({
  id: $string,
  receivedAt: $string,
  username: $string,
  to: $string,
  from: $string,
  subject: $string,
  headers: $record($string, $string),
  raw: $object({ r2Key: $string }),
  parse: $object({ truncated: $boolean, maxBytes: $number }),
  body: $object({ text: $nullable($string), html: $nullable($string) }),
  attachments: $array(attachmentSchema),
});

type StoredAttachment = Infer<typeof attachmentSchema>;
type MailboxRecord = Infer<typeof mailboxRecordSchema>;

export class MailboxDO extends DurableObject<Env> {
  constructor(private state: DurableObjectState, public override env: Env) {
    super(state, env);
  }

  override async fetch(request: Request) {
    const authErr = requireBearer(request, this.env);
    if (authErr) return authErr;

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/_ingest") {
      let body: unknown;

      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "invalid_json" }, 400);
      }

      const errors: Array<Array<string | number | symbol>> = [];

      if (!mailboxRecordSchema(body, { errors })) {
        return json({ ok: false, error: "invalid_body", details: errors.map(formatValidationPath) }, 400);
      }

      const record: MailboxRecord = body;
      const id = record.id;
      const tsKey = `ts:${record.receivedAt}:${id}`;
      const msgKey = `msg:${id}`;

      await this.state.storage.put(tsKey, id);
      await this.state.storage.put(msgKey, record);

      const max = Number(this.env.MAILBOX_MAX_MESSAGES || 500);
      const list = await this.state.storage.list({ prefix: "ts:" });
      const keys = [...list.keys()].sort();
      const overflow = keys.length - max;

      if (overflow > 0) {
        const delTs = keys.slice(0, overflow);
        const delMsg: string[] = [];

        for (const k of delTs) {
          const mid = await this.state.storage.get<string>(k);

          if (mid) delMsg.push(`msg:${mid}`);
        }

        await this.state.storage.delete([...delTs, ...delMsg]);
      }

      return json({ ok: true });
    }

    if (request.method === "GET" && path === "/") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
      const cursor = url.searchParams.get("cursor");
      const take = cursor ? limit + 1 : limit;
      const listOptions: DurableObjectListOptions = {
        prefix: "ts:",
        limit: take,
        reverse: true,
        ...(cursor ? { start: cursor } : {}),
      };
      const listed = await this.state.storage.list(listOptions);
      const entries = [...listed.entries()] as Array<[string, string]>;
      let sliced = entries;
      const [firstEntry] = sliced;

      if (cursor && firstEntry && firstEntry[0] === cursor) {
        sliced = sliced.slice(1);
      }

      const page = sliced.slice(0, limit);
      const messages: MailboxRecord[] = [];

      for (const [, id] of page) {
        const rec = await this.state.storage.get<MailboxRecord>(`msg:${id}`);

        if (rec) messages.push(rec);
      }

      const lastEntry = page[page.length - 1];
      const nextCursor = page.length === limit && lastEntry ? lastEntry[0] : null;

      return json({ ok: true, count: messages.length, nextCursor, messages });
    }

    if (request.method === "GET" && path.startsWith("/msg/")) {
      const id = decodeURIComponent(path.slice("/msg/".length));
      const rec = await this.state.storage.get<MailboxRecord>(`msg:${id}`);

      if (!rec) return json({ ok: false, error: "not_found" }, 404);

      return json({ ok: true, message: rec });
    }

    if (request.method === "GET" && path.startsWith("/atts/")) {
      const id = decodeURIComponent(path.slice("/atts/".length));
      const rec = await this.state.storage.get<MailboxRecord>(`msg:${id}`);

      if (!rec) return json({ ok: false, error: "not_found" }, 404);

      return json({ ok: true, attachments: rec.attachments || [] });
    }

    if (request.method === "DELETE" && path === "/") {
      const list = await this.state.storage.list({ prefix: "ts:" });
      const tsKeys = [...list.keys()];
      const msgKeys: string[] = [];

      for (const k of tsKeys) {
        const id = await this.state.storage.get<string>(k);
        if (id) msgKeys.push(`msg:${id}`);
      }

      await this.state.storage.delete([...tsKeys, ...msgKeys]);

      return json({ ok: true, deleted: tsKeys.length });
    }

    return json({ ok: false, error: "not_found" }, 404);
  }
}

export default {
  async email(message, env, ctx) {
    const username = localPart(message.to);
    const id = crypto.randomUUID();
    const receivedAt = new Date().toISOString();
    const ymd = receivedAt.slice(0, 10);
    const rawKey = `raw/${username}/${ymd}/${id}.eml`;
    const [saveStream, parseStream] = message.raw.tee();
    const putRaw = env.MAIL_BUCKET.put(rawKey, saveStream, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: { to: message.to, from: message.from, receivedAt },
    });
    const maxParseBytes = Number(env.MAX_PARSE_BYTES || 1_000_000);

    let textBody: string | null = null;
    let htmlBody: string | null = null;
    let attachments: StoredAttachment[] = [];
    let parseTruncated = false;

    try {
      const { bytes, truncated } = await readUpTo(parseStream, maxParseBytes);
      parseTruncated = truncated;

      if (!truncated && bytes) {
        const parsed = await PostalMime.parse(bytes);
        textBody = parsed.text || null;
        htmlBody = parsed.html || null;

        const parsedAtts: PostalAttachment[] = Array.isArray(parsed.attachments) ? parsed.attachments : [];
        const attPuts: Array<Promise<StoredAttachment>> = parsedAtts.map(async (att, idx) => {
          const attachmentId = crypto.randomUUID();
          const safeName = (att.filename || `attachment-${idx}`).replace(/[\/\\]/g, "_");
          const attKey = `att/${username}/${ymd}/${id}/${attachmentId}/${safeName}`;
          const contentType = att.mimeType || "application/octet-stream";
          const content = att.content;
          const size = getByteLength(content);

          await env.MAIL_BUCKET.put(attKey, content, {
            httpMetadata: {
              contentType,
              contentDisposition: `attachment; filename="${safeName.replace(/"/g, "'")}"`,
            },
            customMetadata: {
              messageId: id,
              attachmentId,
              filename: safeName,
              contentType,
            },
          });

          return {
            id: attachmentId,
            filename: safeName,
            contentType,
            size,
            r2Key: attKey,
            inline: att.disposition === "inline",
            contentId: att.contentId || null,
          };
        });

        attachments = await Promise.all(attPuts);
      }
    } catch {
      textBody = null;
      htmlBody = null;
      attachments = [];
    }

    await putRaw;

    const record: MailboxRecord = {
      id,
      receivedAt,
      username,
      to: message.to,
      from: message.from,
      subject: message.headers.get("subject") || "",
      headers: Object.fromEntries(message.headers) as Record<string, string>,
      raw: { r2Key: rawKey },
      parse: { truncated: parseTruncated, maxBytes: maxParseBytes },
      body: { text: textBody, html: htmlBody },
      attachments,
    };

    const objId = env.MAILBOX.idFromName(username);
    const stub = env.MAILBOX.get(objId);
    const apiToken = (env.API_TOKEN || "").trim();

    if (!apiToken) throw new Error("API_TOKEN is required for ingest");

    const ingestHeaders: HeadersInit = {
      "content-type": "application/json",
      authorization: `Bearer ${apiToken}`,
    };

    ctx.waitUntil(
      stub.fetch("https://do/_ingest", {
        method: "POST",
        headers: ingestHeaders,
        body: JSON.stringify(record),
      })
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // /mailbox/:username
    // /mailbox/:username/:id
    // /mailbox/:username/:id/raw
    // /mailbox/:username/:id/attachments
    // /mailbox/:username/:id/attachments/:attachmentId
    const m = url.pathname.match(/^\/mailbox\/([^/]+)(?:\/([^/]+)(?:\/(raw|attachments)(?:\/([^/]+))?)?)?$/);
    if (!m || !m[1]) return new Response("Not Found", { status: 404 });

    const rawUsername = m[1];
    const rawId = m[2];
    const rawSub = m[3];
    const rawSubId = m[4];
    const username = decodeURIComponent(rawUsername).toLowerCase();
    const id = rawId ? decodeURIComponent(rawId) : null;
    const sub = rawSub || null;
    const subId = rawSubId ? decodeURIComponent(rawSubId) : null;
    const objId = env.MAILBOX.idFromName(username);
    const stub = env.MAILBOX.get(objId);

    if (request.method === "GET" && !id) {
      const forward = new URL("https://do/");
      forward.search = url.search;
      return stub.fetch(forward.toString(), { method: "GET", headers: request.headers });
    }

    if (request.method === "GET" && id && !sub) {
      return stub.fetch(`https://do/msg/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: request.headers,
      });
    }

    if (request.method === "GET" && id && sub === "raw") {
      const r = await stub.fetch(`https://do/msg/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: request.headers,
      });

      if (!r.ok) return r;

      const { message } = await r.json<{ message?: MailboxRecord }>();
      const rawKey = message?.raw?.r2Key;
      if (!rawKey) return json({ ok: false, error: "missing_raw_key" }, 500);

      const obj = await env.MAIL_BUCKET.get(rawKey);
      if (!obj) return json({ ok: false, error: "not_found" }, 404);

      const headers = new Headers();

      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      headers.set("content-type", obj.httpMetadata?.contentType || "message/rfc822");

      return new Response(obj.body, { headers });
    }

    if (request.method === "GET" && id && sub === "attachments" && !subId) {
      return stub.fetch(`https://do/atts/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: request.headers,
      });
    }

    if (request.method === "GET" && id && sub === "attachments" && subId) {
      const r = await stub.fetch(`https://do/msg/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: request.headers,
      });

      if (!r.ok) return r;

      const { message } = await r.json<{ message?: MailboxRecord }>();
      const atts: StoredAttachment[] = message?.attachments || [];
      const att = atts.find((a) => a.id === subId);

      if (!att) return json({ ok: false, error: "not_found" }, 404);

      const obj = await env.MAIL_BUCKET.get(att.r2Key);

      if (!obj) return json({ ok: false, error: "not_found" }, 404);

      const headers = asDownloadHeaders({ contentType: att.contentType, filename: att.filename });

      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);

      return new Response(obj.body, { headers });
    }

    if (request.method === "DELETE" && !id) {
      return stub.fetch("https://do/", { method: "DELETE", headers: request.headers });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function localPart(addr: string) {
  const at = addr.indexOf("@");
  return (at >= 0 ? addr.slice(0, at) : addr).trim().toLowerCase();
}

function json(data: Object, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function formatValidationPath(path: Array<string | number | symbol>) {
  return path.map(String).join(".");
}

function requireBearer(request: Request, env: Env): Response | null {
  const token = (env.API_TOKEN || "").trim();

  if (!token) {
    return json({ ok: false, error: "missing_api_token" }, 500);
  }

  const auth = request.headers.get("authorization") || "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (got === token) return null;

  return json({ ok: false, error: "unauthorized" }, 401, {
    "www-authenticate": 'Bearer realm="mailbox"',
  });
}

async function readUpTo(stream: ReadableStream, limitBytes: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;

      if (total > limitBytes) {
        try {
          await reader.cancel();
        } catch {}
        return { bytes: null, truncated: true, size: total };
      }

      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  const merged = new Uint8Array(total);
  let offset = 0;

  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }

  return { bytes: merged, truncated: false, size: total };
}

function getByteLength(content: string | ArrayBuffer | Uint8Array) {
  if (typeof content === "string") return new TextEncoder().encode(content).byteLength;
  if (content instanceof Uint8Array) return content.byteLength;

  return content.byteLength;
}

function asDownloadHeaders({ contentType, filename }: { contentType: string; filename: string }) {
  const headers = new Headers();
  headers.set("content-type", contentType || "application/octet-stream");

  if (filename) {
    headers.set("content-disposition", `attachment; filename="${filename.replace(/"/g, "'")}"`);
  } else {
    headers.set("content-disposition", "attachment");
  }
  return headers;
}
