import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { parseProjectV2, type ProjectDocumentV2 } from "@/features/studio-v2/core/document.schema.ts";
import { validateRsvp } from "@/features/studio-v2/core/invitation-behavior.ts";
import { boundedSize, detectImage, MAX_DECODE_PIXELS, MAX_UPLOAD_BYTES } from "@/features/studio-v2/core/media-policy.ts";
import { audit, authorize, database, hash, HttpError, requireOwner, transaction } from "./database";

const mediaBase = "/api/studio-v2/publications";

async function body(request: Request, maxBytes: number) {
  if (Number(request.headers.get("content-length")) > maxBytes) throw new HttpError(413, "Payload too large");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "Payload too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

async function json(request: Request, maxBytes: number): Promise<unknown> {
  const bytes = await body(request, maxBytes);
  try { return JSON.parse(bytes.toString()); }
  catch { throw new HttpError(400, "Invalid JSON"); }
}

export function publication(id: string) {
  const row = database().prepare(`
    SELECT p.project, r.document FROM publications p
    JOIN revisions r ON r.project = p.project AND r.revision = p.revision WHERE p.id = ?
  `).get(id);
  if (!row) return null;
  return { project: String(row.project), document: parseProjectV2(JSON.parse(String(row.document))) };
}

export function mediaUrls(id: string, document: ProjectDocumentV2) {
  return Object.fromEntries(Object.values(document.assets).map(asset => [
    asset.storageKey, `${mediaBase}/${id}/assets/${encodeURIComponent(asset.id)}`,
  ]));
}

async function save(request: Request, project: string) {
  const actor = authorize(request);
  const input = await json(request, 8 * 1024 * 1024);
  let document: ProjectDocumentV2;
  try { document = parseProjectV2(input); }
  catch { throw new HttpError(422, "Invalid Studio document"); }
  if (document.id !== project) throw new HttpError(422, "Document ID differs from project ID");
  return transaction(db => {
    const row = db.prepare("SELECT MAX(revision) AS revision FROM revisions WHERE project = ?").get(project);
    const existing = row?.revision;
    if (existing == null) {
      if (document.revision !== 0) throw new HttpError(409, "New projects start at revision 0");
      db.prepare("INSERT INTO projects VALUES (?,?)").run(project, actor);
    } else {
      requireOwner(db, project, actor);
      if (document.revision !== existing) throw new HttpError(409, "Draft revision conflict");
    }
    const next = { ...document, revision: document.revision + 1 };
    db.prepare("INSERT INTO revisions VALUES (?,?,?)").run(project, next.revision, JSON.stringify(next));
    audit(db, actor, "draft.save", project, String(next.revision));
    return Response.json(next, { status: existing == null ? 201 : 200 });
  });
}

async function upload(request: Request, project: string) {
  const actor = authorize(request);
  requireOwner(database(), project, actor);
  const bytes = await body(request, MAX_UPLOAD_BYTES);
  const mime = detectImage(bytes);
  if (!mime || mime === "image/svg+xml" || request.headers.get("content-type") !== mime) {
    throw new HttpError(415, "Upload a PNG, JPEG or WebP image");
  }
  let normalized: Buffer;
  let width: number;
  let height: number;
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS, failOn: "warning" });
    const metadata = await image.metadata();
    if (metadata.format !== mime.split("/")[1] || (metadata.pages ?? 1) > 1) throw new Error("Unsupported image");
    const size = boundedSize(metadata.width, metadata.height);
    const output = await image.autoOrient().resize(size.width, size.height, { fit: "inside" })
      .webp().toBuffer({ resolveWithObject: true });
    normalized = output.data;
    ({ width, height } = output.info);
  } catch { throw new HttpError(422, "Invalid or unsupported image"); }
  const key = `local:${hash(normalized.toString("base64"))}`;
  return transaction(db => {
    const result = db.prepare("INSERT OR IGNORE INTO assets VALUES (?,?,?,?,?,?)")
      .run(project, key, "image/webp", width, height, normalized);
    if (result.changes) audit(db, actor, "asset.upload", project, key);
    return Response.json({ storageKey: key, mimeType: "image/webp", sizeBytes: normalized.length,
      pixelWidth: width, pixelHeight: height }, { status: result.changes ? 201 : 200 });
  });
}

async function publish(request: Request, project: string) {
  const actor = authorize(request, true);
  const input = await json(request, 1024);
  const revision = (input as { revision?: number } | null)?.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    throw new HttpError(422, "Revision required");
  }
  return transaction(db => {
    requireOwner(db, project, actor);
    const row = db.prepare("SELECT document FROM revisions WHERE project = ? AND revision = ?").get(project, revision);
    if (!row) throw new HttpError(404, "Draft revision not found");
    const previous = db.prepare("SELECT id FROM publications WHERE project = ? AND revision = ?").get(project, revision);
    if (previous) return Response.json({ id: previous.id, url: `/i/${previous.id}` });
    const document = parseProjectV2(JSON.parse(String(row.document)));
    if (!document.pages.some(page => document.nodes[page.rootNodeId].visible)) {
      throw new HttpError(422, "Publication needs a visible page");
    }
    for (const asset of Object.values(document.assets)) {
      const stored = db.prepare("SELECT mime, width, height, length(bytes) AS size FROM assets WHERE project = ? AND storage_key = ?")
        .get(project, asset.storageKey);
      if (!stored || stored.mime !== asset.mimeType || stored.size !== asset.sizeBytes ||
          (asset.pixelWidth !== undefined && stored.width !== asset.pixelWidth) ||
          (asset.pixelHeight !== undefined && stored.height !== asset.pixelHeight)) {
        throw new HttpError(422, `Missing or unmatched asset: ${asset.id}`);
      }
    }
    const id = randomUUID();
    db.prepare("INSERT INTO publications VALUES (?,?,?)").run(id, project, revision);
    audit(db, actor, "publication.create", project, id);
    return Response.json({ id, url: `/i/${id}` }, { status: 201 });
  });
}

function publicAsset(id: string, assetId: string) {
  const entry = publication(id);
  const asset = entry && Object.hasOwn(entry.document.assets, assetId) ? entry.document.assets[assetId] : undefined;
  if (!entry || !asset) throw new HttpError(404, "Asset not found");
  const row = database().prepare("SELECT mime, bytes FROM assets WHERE project = ? AND storage_key = ?")
    .get(entry.project, asset.storageKey);
  if (!row) throw new HttpError(404, "Asset not found");
  return new Response(Buffer.from(row.bytes as Uint8Array), { headers: {
    "Content-Type": String(row.mime), "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=31536000, immutable",
  } });
}

async function rsvp(request: Request, id: string, nodeId: string) {
  const entry = publication(id);
  if (!entry) throw new HttpError(404, "Publication not found");
  const { document } = entry;
  const node = Object.hasOwn(document.nodes, nodeId) ? document.nodes[nodeId] : undefined;
  if (node?.type !== "widget" || node.block.kind !== "rsvp") throw new HttpError(404, "RSVP not found");
  let current: typeof document.nodes[string] | undefined = node;
  while (current) {
    if (!current.visible) throw new HttpError(404, "RSVP not found");
    current = current.parentId ? document.nodes[current.parentId] : undefined;
  }
  const { maxGuests, deadline } = node.block;
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "Idempotency key required");
  const payload = await json(request, 4096);
  let response: string;
  try { response = JSON.stringify(validateRsvp(payload, maxGuests)); }
  catch { throw new HttpError(422, "Invalid guest response"); }
  const now = Date.now();
  return transaction(db => {
    const existing = db.prepare("SELECT response FROM rsvp WHERE publication = ? AND node = ? AND key = ?")
      .get(id, nodeId, key);
    if (existing) {
      if (existing.response !== response) throw new HttpError(409, "Idempotency key already used");
      return new Response(null, { status: 204 });
    }
    if (deadline && now >= Date.parse(deadline)) throw new HttpError(422, "RSVP closed");
    const bucket = Math.floor(now / 60_000);
    db.prepare("DELETE FROM rate WHERE bucket < ?").run(bucket - 1);
    const count = db.prepare(`
      INSERT INTO rate VALUES (?, ?, 1)
      ON CONFLICT (scope,bucket) DO UPDATE SET hits=hits+1 RETURNING hits
    `).get(id, bucket);
    if (Number(count?.hits) > 30) return Response.json({ error: "Too many responses" }, {
      status: 429, headers: { "Retry-After": String(60 - Math.floor(now / 1000) % 60) },
    });
    db.prepare("INSERT INTO rsvp VALUES (?,?,?,?)").run(id, nodeId, key, response);
    return new Response(null, { status: 204 });
  });
}

export async function handle(request: Request, parts: string[]) {
  const [scope, id, operation, target] = parts;
  try {
    if (scope === "projects" && id) {
      if (request.method === "GET" && operation === "audit" && parts.length === 3) {
        const actor = authorize(request, true);
        const db = database();
        requireOwner(db, id, actor);
        const events = db.prepare("SELECT seq,time,actor,action,target FROM audit WHERE project = ? ORDER BY seq DESC LIMIT 100").all(id);
        return Response.json(events, { headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "PUT" && operation === "draft" && parts.length === 3) return await save(request, id);
      if (request.method === "GET" && operation === "draft" && parts.length === 3) {
        const actor = authorize(request);
        const db = database();
        requireOwner(db, id, actor);
        const row = db.prepare("SELECT document FROM revisions WHERE project = ? ORDER BY revision DESC LIMIT 1").get(id);
        return Response.json(JSON.parse(String(row?.document)), { headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "POST" && operation === "assets" && parts.length === 3) return await upload(request, id);
      if (request.method === "POST" && operation === "publish" && parts.length === 3) return await publish(request, id);
    }
    if (scope === "publications" && id && target && parts.length === 4) {
      if (request.method === "GET" && operation === "assets") return publicAsset(id, target);
      if (request.method === "POST" && operation === "rsvp") return await rsvp(request, id, target);
    }
    throw new HttpError(404, "Endpoint not found");
  } catch (error) {
    if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
    console.error(error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
