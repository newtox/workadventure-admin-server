import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, "admin.sqlite"));
db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
        identifier TEXT PRIMARY KEY,
        username   TEXT,
        name       TEXT,
        email      TEXT,
        tags       TEXT NOT NULL DEFAULT '[]',
        textures   TEXT,
        companion  TEXT,
        first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        last_seen  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS reports (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        reported   TEXT NOT NULL,
        reporter   TEXT NOT NULL,
        comment    TEXT NOT NULL,
        room       TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    -- Custom wokas (managed through the admin UI in a later version).
    -- access: {"everyone": true} | {"tags": ["vip"], "users": ["someone@example.com"]}
    CREATE TABLE IF NOT EXISTS custom_wokas (
        id         TEXT PRIMARY KEY,
        part       TEXT NOT NULL,
        name       TEXT NOT NULL,
        url        TEXT NOT NULL,
        access     TEXT NOT NULL DEFAULT '{"everyone":true}',
        position   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
`);

export interface UserRow {
    identifier: string;
    username: string | null;
    name: string | null;
    email: string | null;
    tags: string[];
    textures: string[] | null;
    companion: string | null;
    lastSeen: string;
}

function parseJson<T>(value: unknown, fallback: T): T {
    if (typeof value !== "string") return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

function toUser(row: Record<string, unknown> | undefined): UserRow | undefined {
    if (!row) return undefined;
    return {
        identifier: String(row.identifier),
        username: (row.username as string | null) ?? null,
        name: (row.name as string | null) ?? null,
        email: (row.email as string | null) ?? null,
        tags: parseJson<string[]>(row.tags, []),
        textures: parseJson<string[] | null>(row.textures, null),
        companion: (row.companion as string | null) ?? null,
        lastSeen: String(row.last_seen),
    };
}

const statements = {
    get: db.prepare("SELECT * FROM users WHERE identifier = ? COLLATE NOCASE ORDER BY last_seen DESC LIMIT 1"),
    upsertProfile: db.prepare(`
        INSERT INTO users (identifier, username, name, email, tags) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(identifier) DO UPDATE SET
            username = COALESCE(excluded.username, users.username),
            name = COALESCE(excluded.name, users.name),
            email = COALESCE(excluded.email, users.email),
            tags = excluded.tags,
            last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`),
    touch: db.prepare(`
        INSERT INTO users (identifier) VALUES (?)
        ON CONFLICT(identifier) DO UPDATE SET last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`),
    setTextures: db.prepare(`
        INSERT INTO users (identifier, textures) VALUES (?, ?)
        ON CONFLICT(identifier) DO UPDATE SET textures = excluded.textures`),
    setCompanion: db.prepare(`
        INSERT INTO users (identifier, companion) VALUES (?, ?)
        ON CONFLICT(identifier) DO UPDATE SET companion = excluded.companion`),
    search: db.prepare(`
        SELECT * FROM users
        WHERE ? = '' OR username LIKE ? OR name LIKE ? OR email LIKE ? OR identifier LIKE ?
        ORDER BY last_seen DESC LIMIT ?`),
    allTags: db.prepare("SELECT tags FROM users"),
    insertReport: db.prepare("INSERT INTO reports (reported, reporter, comment, room) VALUES (?, ?, ?, ?)"),
    customWokas: db.prepare("SELECT * FROM custom_wokas ORDER BY part, position, name"),
};

export const users = {
    get(identifier: string): UserRow | undefined {
        return toUser(statements.get.get(identifier) as Record<string, unknown> | undefined);
    },
    saveProfile(identifier: string, profile: { username?: string | null; name?: string | null; email?: string | null; tags: string[] }) {
        statements.upsertProfile.run(identifier, profile.username ?? null, profile.name ?? null, profile.email ?? null, JSON.stringify(profile.tags));
    },
    touch(identifier: string) {
        statements.touch.run(identifier);
    },
    setTextures(identifier: string, textures: string[]) {
        statements.setTextures.run(identifier, JSON.stringify(textures));
    },
    setCompanion(identifier: string, companion: string | null) {
        statements.setCompanion.run(identifier, companion);
    },
    search(text: string, limit = 50): UserRow[] {
        const like = `%${text}%`;
        return (statements.search.all(text, like, like, like, like, limit) as Record<string, unknown>[]).map((r) => toUser(r)!);
    },
    allTags(): string[] {
        const tags = new Set<string>();
        for (const row of statements.allTags.all() as { tags: string }[]) {
            for (const tag of parseJson<string[]>(row.tags, [])) tags.add(tag);
        }
        return [...tags];
    },
};

export const reports = {
    add(reported: string, reporter: string, comment: string, room: string | null) {
        statements.insertReport.run(reported, reporter, comment, room);
    },
};

export interface CustomWoka {
    id: string;
    part: string;
    name: string;
    url: string;
    access: { everyone?: boolean; tags?: string[]; users?: string[] };
    position: number;
}

export function listCustomWokas(): CustomWoka[] {
    return (statements.customWokas.all() as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        part: String(row.part),
        name: String(row.name),
        url: String(row.url),
        access: parseJson(row.access, { everyone: true }),
        position: Number(row.position),
    }));
}
