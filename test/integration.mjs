import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import sharp from "sharp";
import { createEmptyProjectV2 } from "../src/features/studio-v2/core/document.schema.ts";
import { createWidget } from "../src/features/studio-v2/core/invitation-behavior.ts";

test("Studio API, persisted snapshots, public SSR and live RSVP", async () => {
  const temp = await mkdtemp(join(tmpdir(), "eventiq-"));
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  const actors = ["ADMIN", "MANAGER", "MANAGER"].map((role, index) => {
    const token = randomUUID();
    return { role, id: `actor-${index}`, token,
      sha256: createHash("sha256").update(token).digest("hex") };
  });
  const [admin, manager, stranger] = actors;
  const origin = `http://127.0.0.1:${port}`;
  const projectPath = "/api/studio-v2/projects/testProject";
  let server;
  async function start() {
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
      env: { ...process.env, STUDIO_DB: join(temp, "studio.sqlite"),
        STUDIO_CREDENTIALS: JSON.stringify(actors.map(({ token, ...actor }) => actor)) },
      stdio: ["ignore", "inherit", "inherit"],
    });
    for (let retry = 0; retry < 80; retry++) {
      if (server.exitCode !== null) throw new Error("Next.js exited during startup");
      try { await fetch(origin); return; } catch { await setTimeout(125); }
    }
    throw new Error("Next.js did not start");
  }
  async function stop() {
    if (server && server.exitCode === null && server.signalCode === null) {
      const closed = once(server, "exit");
      server.kill();
      await closed;
    }
  }
  async function request(path, status, { actor, method = "GET", body, type = "application/json", key } = {}) {
    const response = await fetch(origin + path, {
      method, body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : body,
      headers: { "Content-Type": type, ...(actor && { Authorization: `Bearer ${actor.token}` }),
        ...(key && { "Idempotency-Key": key }) },
    });
    assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
    return response;
  }

  try {
    await start();
    const document = createEmptyProjectV2("testProject");
    document.pages[0].name = "Original invitation";
    const root = document.nodes[document.pages[0].rootNodeId];
    const widget = createWidget("rsvp", "guestRsvp", root.id, 300);
    root.children.push(widget.id);
    document.nodes[widget.id] = widget;
    await request(projectPath + "/draft", 401, { method: "PUT", body: document });
    let draft = await (await request(projectPath + "/draft", 201, { actor: manager, method: "PUT", body: document })).json();
    await request(projectPath + "/draft", 403, { actor: stranger });
    await request(projectPath + "/draft", 409, { actor: manager, method: "PUT", body: document });
    const raster = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    await request(projectPath + "/assets", 403, { actor: stranger, method: "POST", body: raster, type: "image/png" });
    const asset = await (await request(projectPath + "/assets", 201, {
      actor: manager, method: "POST", body: raster, type: "image/png",
    })).json();
    draft.assets.poster = { ...asset, id: "poster", name: "Poster" };
    const gallery = createWidget("gallery", "photos", root.id, 300);
    gallery.block.assetIds.push("poster");
    draft.nodes.photos = gallery;
    draft.nodes[root.id].children.push("photos");
    draft = await (await request(projectPath + "/draft", 200, { actor: manager, method: "PUT", body: draft })).json();
    const publish = { actor: admin, method: "POST", body: { revision: draft.revision } };
    await request(projectPath + "/publish", 403, { ...publish, actor: manager });
    const entry = await (await request(projectPath + "/publish", 201, publish)).json();
    assert.deepEqual(await (await request(projectPath + "/publish", 200, publish)).json(), entry);
    const api = `/api/studio-v2/publications/${entry.id}`;
    const page = await (await request(entry.url, 200)).text();
    assert.match(page, /aria-label="Original invitation"/);
    assert.match(page, /\/assets\/poster/);
    const image = await request(api + "/assets/poster", 200);
    assert.equal(image.headers.get("content-type"), "image/webp");
    assert.match(image.headers.get("cache-control"), /immutable/);
    await request(api + "/assets/missing", 404);

    draft.pages[0].name = "Changed draft";
    draft.nodes.guestRsvp.block.deadline = "2020-01-01T00:00:00Z";
    const changed = await (await request(projectPath + "/draft", 200, { actor: manager, method: "PUT", body: draft })).json();
    const expired = await (await request(projectPath + "/publish", 201, { ...publish, body: { revision: changed.revision } })).json();
    const respond = { method: "POST", key: randomUUID(), body: { name: "Guest", attendance: "yes", guests: 2 } };
    await request(`/api/studio-v2/publications/${expired.id}/rsvp/guestRsvp`, 422, respond);
    const rsvpPath = api + "/rsvp/guestRsvp";
    await request(rsvpPath, 422, { ...respond, body: { ...respond.body, guests: 3 } });
    await request(rsvpPath, 204, respond);
    await request(rsvpPath, 204, respond);
    await request(rsvpPath, 409, { ...respond, body: { ...respond.body, guests: 1 } });
    const results = await Promise.all(Array.from({ length: 31 }, () => fetch(origin + rsvpPath, {
      method: "POST", body: JSON.stringify(respond.body), headers: { "Idempotency-Key": randomUUID() },
    })));
    assert.ok(results.some(result => result.status === 429));
    const events = await (await request(projectPath + "/audit", 200, { actor: admin })).json();
    assert.equal(events.filter(event => event.action === "publication.create").length, 2);

    await stop();
    await start();
    assert.match(await (await request(entry.url, 200)).text(), /aria-label="Original invitation"/);
    await request(rsvpPath, 204, respond);
  } finally {
    await stop();
    await rm(temp, { recursive: true, force: true });
  }
});
