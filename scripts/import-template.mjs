import { readFile } from "node:fs/promises";

const [file, origin, action] = process.argv.slice(2);
const token = process.env.STUDIO_TOKEN;
if (!file || !origin || !token || (action && action !== "--publish")) {
  throw new Error("Usage: STUDIO_TOKEN=… node scripts/import-template.mjs <package.json> <server-origin> [--publish]");
}
const base = new URL(origin);
if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))) {
  throw new Error("Use HTTPS or a local development server");
}
const pack = JSON.parse(await readFile(file, "utf8"));
if (pack.format !== "invito-template" || pack.version !== 1 || !pack.document || !Array.isArray(pack.media)) {
  throw new Error("Expected an INVITO Studio v2 template export");
}
const document = pack.document;
const path = `/api/studio-v2/projects/${encodeURIComponent(document.id)}`;
const assets = Object.values(document.assets);
const media = new Map(pack.media.map(entry => [entry.assetId, entry.data]));
if (assets.length !== pack.media.length || assets.some(asset =>
  !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(media.get(asset.id) ?? "")
)) throw new Error("Expected one raster upload for each document asset");

async function api(suffix, method, body, type = "application/json", allowedStatus = 0) {
  const response = await fetch(new URL(path + suffix, base), {
    method, body, redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": type },
  });
  if (response.status === allowedStatus) return null;
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error ?? "Request failed"}`);
  return result;
}

const current = await api("/draft", "GET", undefined, undefined, 404);
document.revision = current?.revision ?? 0;
if (assets.length && !current) {
  // Establish ownership before uploading the files. This revision cannot be published
  // until its asset references correspond to stored media.
  const draft = await api("/draft", "PUT", JSON.stringify(document));
  document.revision = draft.revision;
}
for (const asset of assets) {
  const [, type, encoded] = /^data:(image\/[^;]+);base64,(.+)$/.exec(media.get(asset.id));
  const upload = await api("/assets", "POST", Buffer.from(encoded, "base64"), type);
  Object.assign(asset, upload);
}
const saved = await api("/draft", "PUT", JSON.stringify(document));
console.log(`Draft revision ${saved.revision}`);
if (action === "--publish") {
  const entry = await api("/publish", "POST", JSON.stringify({ revision: saved.revision }));
  console.log(new URL(entry.url, base).href);
}
