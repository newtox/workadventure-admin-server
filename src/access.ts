// Who may enter which room, and personal rooms.
import { config } from "./config.js";
import { rooms, type Access, type RoomSettings } from "./db.js";
import { deleteMap, listRooms, mapExists, readMap, writeMap, type RoomDescription } from "./mapStorage.js";
import type { Viewer } from "./wokas.js";
import { t, type Lang } from "./i18n.js";

export const isAdmin = (viewer: Viewer) => viewer.tags.includes(config.adminTag);

export function accessAllows(access: Access, viewer: Viewer): boolean {
    if (access.everyone) return true;
    if (access.users?.some((u) => u.toLowerCase() === viewer.identifier.toLowerCase())) return true;
    return access.tags?.some((t) => viewer.tags.includes(t)) ?? false;
}

/** "maps/office.wam" for https://play.example.com/~/maps/office.wam, undefined for other URLs. */
export function storagePath(playUri: URL): string | undefined {
    const m = /^\/~\/(.+)$/.exec(playUri.pathname);
    return m ? decodeURIComponent(m[1]!) : undefined;
}

export function canEnter(settings: RoomSettings | undefined, viewer: Viewer): boolean {
    if (!settings) return true;
    if (isAdmin(viewer)) return true;
    if (settings.owner && settings.owner.toLowerCase() === viewer.identifier.toLowerCase()) return true;
    return accessAllows(settings.access, viewer);
}

export function isOwner(settings: RoomSettings | undefined, viewer: Viewer): boolean {
    return !!settings?.owner && !!viewer.identifier && settings.owner.toLowerCase() === viewer.identifier.toLowerCase();
}

/** Room list with names/descriptions from the admin settings, filtered for the given roles. */
export async function roomsVisibleFor(tags: string[] | undefined): Promise<RoomDescription[]> {
    const list = await listRooms();
    const settings = new Map(rooms.all().map((r) => [r.path, r]));
    const templates = new Set((await roomStyles(list)).map((s) => s.path));
    const viewer = { identifier: "", tags: tags ?? [] };
    return list
        .filter((room) => {
            const path = room.roomUrl.replace(/^\/~\//, "");
            if (templates.has(path)) return false;
            const s = settings.get(path);
            if (!s) return true;
            if (s.hidden) return false;
            // Personal rooms only appear for everyone when they are open; invited people open them from their profile.
            return isAdmin(viewer) || accessAllows(s.access, viewer);
        })
        .map((room) => {
            const s = settings.get(room.roomUrl.replace(/^\/~\//, ""));
            return { ...room, name: s?.name || room.name, description: s?.description ?? room.description };
        });
}

// ---------- personal rooms ----------

export function personalRoomsEnabled(): boolean {
    return !!config.personalRoomTemplate && !!config.mapStorageToken;
}

export function mayCreatePersonalRoom(viewer: Viewer): boolean {
    if (!personalRoomsEnabled() || !viewer.identifier) return false;
    return config.personalRoomTags.length === 0 || viewer.tags.some((t) => config.personalRoomTags.includes(t)) || isAdmin(viewer);
}

function slugify(name: string): string {
    const slug = name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30);
    return slug || "zimmer";
}

export interface RoomStyle {
    key: string;
    path: string;
    thumbnail?: string | null;
}

export const DEFAULT_STYLE = "holz";

/**
 * Room styles to choose from: the template itself ("holz") plus every map named
 * "zimmer-stil-<key>.wam" in the template's folder.
 */
export async function roomStyles(list?: RoomDescription[]): Promise<RoomStyle[]> {
    const template = config.personalRoomTemplate;
    if (!template) return [];
    const dir = template.includes("/") ? template.slice(0, template.lastIndexOf("/") + 1) : "";
    const maps = list ?? (await listRooms().catch(() => []));
    const styles: RoomStyle[] = [];
    for (const room of maps) {
        const path = room.roomUrl.replace(/^\/~\//, "");
        if (path === template) styles.unshift({ key: DEFAULT_STYLE, path, thumbnail: room.thumbnail });
        else if (path.startsWith(dir)) {
            const m = /^zimmer-stil-([a-z0-9-]+)\.wam$/.exec(path.slice(dir.length));
            if (m && m[1] !== DEFAULT_STYLE) styles.push({ key: m[1]!, path, thumbnail: room.thumbnail });
        }
    }
    if (!styles.some((s) => s.key === DEFAULT_STYLE)) styles.unshift({ key: DEFAULT_STYLE, path: template });
    const order = ["holz", "loft", "gemuetlich", "dunkel", "gross"];
    const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
    return styles.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

async function stylePath(key: string | null | undefined): Promise<RoomStyle> {
    const styles = await roomStyles();
    return styles.find((s) => s.key === key) ?? styles[0]!;
}

/**
 * The style's map with absolute URLs, so that the copy works from the personal room folder.
 * Personal rooms live in their own folder because an upload of maps removes every map in
 * the uploaded folder that is not part of the upload.
 */
async function styleMap(style: RoomStyle): Promise<Record<string, unknown>> {
    const wam = await readMap(style.path);
    const base = `${config.publicMapStorageUrl}/${style.path}`;
    if (typeof wam.mapUrl === "string") wam.mapUrl = new URL(wam.mapUrl, base).toString();
    const metadata = wam.metadata as Record<string, unknown> | undefined;
    if (metadata && typeof metadata.thumbnail === "string") metadata.thumbnail = new URL(metadata.thumbnail, base).toString();
    return wam;
}

const inPersonalDir = (path: string) => path.startsWith(config.personalRoomDir + "/");

async function freePersonalPath(displayName: string): Promise<string> {
    const taken = new Set((await listRooms()).map((r) => r.roomUrl.replace(/^\/~\//, "")));
    const base = `${config.personalRoomDir}/zimmer-${slugify(displayName)}`;
    for (let i = 0; i < 50; i++) {
        const path = `${base}${i ? `-${i + 1}` : ""}.wam`;
        if (!rooms.get(path) && !taken.has(path)) return path;
    }
    throw new Error("No free room name");
}

/** Creates the owner's room from a style and registers it. */
export async function createPersonalRoom(owner: string, displayName: string, lang: Lang, styleKey?: string | null): Promise<RoomSettings> {
    const existing = rooms.byOwner(owner);
    if (existing) return existing;
    const style = await stylePath(styleKey);
    const path = await freePersonalPath(displayName);
    await writeMap(path, await styleMap(style));
    const settings: RoomSettings = {
        path,
        name: t(lang).roomName(displayName),
        description: null,
        access: { everyone: false, tags: [], users: [] },
        hidden: false,
        owner,
        style: style.key,
    };
    rooms.save(settings);
    return settings;
}

/**
 * Replaces a personal room's map with a fresh one of the given style (everything placed in it is lost),
 * or recreates it when its map has gone missing. Rooms from older versions move to the personal room folder.
 */
export async function changeRoomStyle(room: RoomSettings, styleKey: string, displayName: string): Promise<RoomSettings> {
    const style = await stylePath(styleKey);
    const path = inPersonalDir(room.path) ? room.path : await freePersonalPath(displayName);
    await writeMap(path, await styleMap(style));
    if (path !== room.path) {
        await deleteMap(room.path).catch(() => undefined);
        rooms.remove(room.path);
    }
    const updated = { ...room, path, style: style.key };
    rooms.save(updated);
    return updated;
}

/** Whether the map of a personal room still exists in the map storage. */
export async function roomMapExists(room: RoomSettings): Promise<boolean> {
    return mapExists(room.path).catch(() => true);
}
