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
    -- Settings per map-storage room (path like "maps/office.wam").
    -- access: {"everyone": true} | {"tags": ["vip"], "users": ["someone@example.com"]}
    CREATE TABLE IF NOT EXISTS rooms (
        path        TEXT PRIMARY KEY,
        name        TEXT,
        description TEXT,
        access      TEXT NOT NULL DEFAULT '{"everyone":true}',
        hidden      INTEGER NOT NULL DEFAULT 0,
        owner       TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS bans (
        identifier TEXT PRIMARY KEY COLLATE NOCASE,
        reason     TEXT,
        banned_by  TEXT,
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
// Columns added after the first release.
for (const [table, column] of [["users", "locale TEXT"], ["rooms", "style TEXT"]]) {
    try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    } catch {
        // already there
    }
}

export interface UserRow {
    identifier: string;
    username: string | null;
    name: string | null;
    email: string | null;
    tags: string[];
    textures: string[] | null;
    companion: string | null;
    firstSeen: string | null;
    lastSeen: string;
    /** Game language of the user's last visit ("de" or "en"). */
    locale: string | null;
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
        firstSeen: (row.first_seen as string | null) ?? null,
        lastSeen: String(row.last_seen),
        locale: (row.locale as string | null) ?? null,
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
    setLocale: db.prepare("UPDATE users SET locale = ? WHERE identifier = ?"),
    deleteUser: db.prepare("DELETE FROM users WHERE identifier = ? COLLATE NOCASE"),
    search: db.prepare(`
        SELECT * FROM users
        WHERE ? = '' OR username LIKE ? OR name LIKE ? OR email LIKE ? OR identifier LIKE ?
        ORDER BY last_seen DESC LIMIT ?`),
    allTags: db.prepare("SELECT tags FROM users"),
    insertReport: db.prepare("INSERT INTO reports (reported, reporter, comment, room) VALUES (?, ?, ?, ?)"),
    customWokas: db.prepare("SELECT * FROM custom_wokas ORDER BY part, position, name"),
    customWoka: db.prepare("SELECT * FROM custom_wokas WHERE id = ?"),
    insertWoka: db.prepare("INSERT INTO custom_wokas (id, part, name, url, access, position) VALUES (?, ?, ?, ?, ?, ?)"),
    updateWoka: db.prepare("UPDATE custom_wokas SET name = ?, part = ?, access = ?, url = ? WHERE id = ?"),
    deleteWoka: db.prepare("DELETE FROM custom_wokas WHERE id = ?"),
    room: db.prepare("SELECT * FROM rooms WHERE path = ?"),
    roomByOwner: db.prepare("SELECT * FROM rooms WHERE owner = ? COLLATE NOCASE"),
    allRooms: db.prepare("SELECT * FROM rooms"),
    upsertRoom: db.prepare(`
        INSERT INTO rooms (path, name, description, access, hidden, owner, style) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET name = excluded.name, description = excluded.description,
            access = excluded.access, hidden = excluded.hidden, owner = excluded.owner, style = excluded.style`),
    deleteRoom: db.prepare("DELETE FROM rooms WHERE path = ?"),
    ban: db.prepare(`INSERT INTO bans (identifier, reason, banned_by) VALUES (?, ?, ?)
        ON CONFLICT(identifier) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by`),
    unban: db.prepare("DELETE FROM bans WHERE identifier = ?"),
    getBan: db.prepare("SELECT * FROM bans WHERE identifier = ?"),
    allBans: db.prepare("SELECT * FROM bans ORDER BY created_at DESC"),
    allUsers: db.prepare("SELECT * FROM users ORDER BY last_seen DESC"),
    allReports: db.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT 200"),
    deleteReport: db.prepare("DELETE FROM reports WHERE id = ?"),
    deleteAllReports: db.prepare("DELETE FROM reports"),
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
    /** Forgets a user (bans stay, so a deleted troublemaker cannot come back under the same account). */
    remove(identifier: string) {
        statements.deleteUser.run(identifier);
    },
    setLocale(identifier: string, locale: string) {
        statements.setLocale.run(locale, identifier);
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
    remove(id: number) {
        statements.deleteReport.run(id);
    },
    removeAll() {
        statements.deleteAllReports.run();
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

function toWoka(row: Record<string, unknown>): CustomWoka {
    return {
        id: String(row.id),
        part: String(row.part),
        name: String(row.name),
        url: String(row.url),
        access: parseJson(row.access, { everyone: true }),
        position: Number(row.position),
    };
}

export function listCustomWokas(): CustomWoka[] {
    return (statements.customWokas.all() as Record<string, unknown>[]).map(toWoka);
}

export const customWokas = {
    get(id: string): CustomWoka | undefined {
        const row = statements.customWoka.get(id) as Record<string, unknown> | undefined;
        return row ? toWoka(row) : undefined;
    },
    add(woka: CustomWoka) {
        statements.insertWoka.run(woka.id, woka.part, woka.name, woka.url, JSON.stringify(woka.access), woka.position);
    },
    update(woka: CustomWoka) {
        statements.updateWoka.run(woka.name, woka.part, JSON.stringify(woka.access), woka.url, woka.id);
    },
    remove(id: string) {
        statements.deleteWoka.run(id);
    },
};

export function listUsers(): UserRow[] {
    return (statements.allUsers.all() as Record<string, unknown>[]).map((r) => toUser(r)!);
}

export interface ReportRow {
    id: number;
    reported: string;
    reporter: string;
    comment: string;
    room: string | null;
    createdAt: string;
}

export function listReports(): ReportRow[] {
    return (statements.allReports.all() as Record<string, unknown>[]).map((r) => ({
        id: Number(r.id),
        reported: String(r.reported),
        reporter: String(r.reporter),
        comment: String(r.comment),
        room: (r.room as string | null) ?? null,
        createdAt: String(r.created_at),
    }));
}


// ---------- rooms ----------

export interface Access {
    everyone?: boolean;
    tags?: string[];
    users?: string[];
}

export interface RoomSettings {
    path: string;
    name: string | null;
    description: string | null;
    access: Access;
    hidden: boolean;
    owner: string | null;
    /** Style key of a personal room ("holz", "loft", …). */
    style?: string | null;
}

function toRoom(row: Record<string, unknown>): RoomSettings {
    return {
        path: String(row.path),
        name: (row.name as string | null) ?? null,
        description: (row.description as string | null) ?? null,
        access: parseJson<Access>(row.access, { everyone: true }),
        hidden: Number(row.hidden) === 1,
        owner: (row.owner as string | null) ?? null,
        style: (row.style as string | null) ?? null,
    };
}

export const rooms = {
    get(path: string): RoomSettings | undefined {
        const row = statements.room.get(path) as Record<string, unknown> | undefined;
        return row ? toRoom(row) : undefined;
    },
    byOwner(identifier: string): RoomSettings | undefined {
        const row = statements.roomByOwner.get(identifier) as Record<string, unknown> | undefined;
        return row ? toRoom(row) : undefined;
    },
    all(): RoomSettings[] {
        return (statements.allRooms.all() as Record<string, unknown>[]).map(toRoom);
    },
    save(r: RoomSettings) {
        statements.upsertRoom.run(r.path, r.name, r.description, JSON.stringify(r.access), r.hidden ? 1 : 0, r.owner, r.style ?? null);
    },
    remove(path: string) {
        statements.deleteRoom.run(path);
    },
};

// ---------- bans ----------

export interface Ban {
    identifier: string;
    reason: string | null;
    bannedBy: string | null;
    createdAt: string;
}

function toBan(row: Record<string, unknown>): Ban {
    return {
        identifier: String(row.identifier),
        reason: (row.reason as string | null) ?? null,
        bannedBy: (row.banned_by as string | null) ?? null,
        createdAt: String(row.created_at),
    };
}

export const bans = {
    get(identifier: string): Ban | undefined {
        const row = statements.getBan.get(identifier) as Record<string, unknown> | undefined;
        return row ? toBan(row) : undefined;
    },
    all(): Ban[] {
        return (statements.allBans.all() as Record<string, unknown>[]).map(toBan);
    },
    add(identifier: string, reason: string | null, by: string | null) {
        statements.ban.run(identifier, reason, by);
    },
    remove(identifier: string) {
        statements.unban.run(identifier);
    },
};
