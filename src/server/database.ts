import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

const credentials = process.env.STUDIO_CREDENTIALS;
type Principal = { id: string; role: "ADMIN" | "MANAGER"; sha256: string };
const principals = credentials ? JSON.parse(credentials) as Principal[] : [];
for (const principal of principals) {
  if (!principal.id || !["ADMIN", "MANAGER"].includes(principal.role) ||
      !/^[a-f0-9]{64}$/.test(principal.sha256)) throw new Error("Invalid STUDIO_CREDENTIALS entry");
}

export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function authorize(request: Request, adminOnly = false) {
  const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const candidate = Buffer.from(hash(token ?? ""), "hex");
  const actor = principals.find(principal => timingSafeEqual(candidate, Buffer.from(principal.sha256, "hex")));
  if (!token || !actor) throw new HttpError(401, "Authentication required");
  if (adminOnly && actor.role !== "ADMIN") throw new HttpError(403, "Administrator permission required");
  return actor.id;
}

let instance: DatabaseSync | undefined;

export function database() {
  if (instance) return instance;
  const file = resolve(process.env.STUDIO_DB ?? "data/studio.sqlite");
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS revisions (
      project TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
      document TEXT NOT NULL, PRIMARY KEY (project, revision)
    );
    CREATE TABLE IF NOT EXISTS assets (
      project TEXT NOT NULL REFERENCES projects(id), storage_key TEXT NOT NULL,
      mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      bytes BLOB NOT NULL, PRIMARY KEY (project, storage_key)
    );
    CREATE TABLE IF NOT EXISTS publications (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, revision INTEGER NOT NULL,
      UNIQUE (project, revision), FOREIGN KEY (project, revision) REFERENCES revisions(project, revision)
    );
    CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY, time INTEGER NOT NULL, actor TEXT NOT NULL,
      action TEXT NOT NULL, project TEXT NOT NULL, target TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rsvp (
      publication TEXT NOT NULL REFERENCES publications(id), node TEXT NOT NULL, key TEXT NOT NULL,
      response TEXT NOT NULL, PRIMARY KEY (publication, node, key)
    );
    CREATE TABLE IF NOT EXISTS rate (
      scope TEXT NOT NULL, bucket INTEGER NOT NULL, hits INTEGER NOT NULL, PRIMARY KEY (scope, bucket)
    );
    CREATE TRIGGER IF NOT EXISTS revision_no_update BEFORE UPDATE ON revisions
      BEGIN SELECT RAISE(ABORT, 'immutable revision'); END;
    CREATE TRIGGER IF NOT EXISTS revision_no_delete BEFORE DELETE ON revisions
      BEGIN SELECT RAISE(ABORT, 'immutable revision'); END;
    CREATE TRIGGER IF NOT EXISTS publication_no_update BEFORE UPDATE ON publications
      BEGIN SELECT RAISE(ABORT, 'immutable publication'); END;
    CREATE TRIGGER IF NOT EXISTS publication_no_delete BEFORE DELETE ON publications
      BEGIN SELECT RAISE(ABORT, 'immutable publication'); END;
    CREATE TRIGGER IF NOT EXISTS asset_no_update BEFORE UPDATE ON assets
      BEGIN SELECT RAISE(ABORT, 'immutable asset'); END;
    CREATE TRIGGER IF NOT EXISTS asset_no_delete BEFORE DELETE ON assets
      BEGIN SELECT RAISE(ABORT, 'immutable asset'); END;
  `);
  instance = db;
  return db;
}

export function transaction<T>(operation: (db: DatabaseSync) => T): T {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function audit(db: DatabaseSync, actor: string, action: string, project: string, target: string) {
  db.prepare("INSERT INTO audit(time,actor,action,project,target) VALUES (?,?,?,?,?)")
    .run(Date.now(), actor, action, project, target);
}

export function requireOwner(db: DatabaseSync, project: string, actor: string) {
  const row = db.prepare("SELECT owner FROM projects WHERE id = ?").get(project);
  if (!row) throw new HttpError(404, "Project not found");
  if (row.owner !== actor && !principals.some(principal => principal.id === actor && principal.role === "ADMIN")) {
    throw new HttpError(403, "Project access denied");
  }
}
