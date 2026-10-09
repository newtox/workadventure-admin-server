// Who may enter which room, and personal rooms.
import { config } from "./config.js";
import { rooms, type Access, type RoomSettings } from "./db.js";
import { listRooms, type RoomDescription } from "./mapStorage.js";
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
    const template = config.personalRoomTemplate;
    const viewer = { identifier: "", tags: tags ?? [] };
    return list
        .filter((room) => {
            const path = room.roomUrl.replace(/^\/~\//, "");
            if (path === template) return false;
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

/** Copies the template map in the map storage and registers the owner. */
export async function createPersonalRoom(owner: string, displayName: string, lang: Lang): Promise<RoomSettings> {
    const existing = rooms.byOwner(owner);
    if (existing) return existing;
    const template = config.personalRoomTemplate!;
    const dir = template.includes("/") ? template.slice(0, template.lastIndexOf("/") + 1) : "";
    const base = `${dir}zimmer-${slugify(displayName)}`;

    for (let i = 0; i < 20; i++) {
        const path = `${base}${i ? `-${i + 1}` : ""}.wam`;
        if (rooms.get(path)) continue;
        const res = await fetch(`${config.internalMapStorageUrl}/copy`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.mapStorageToken}` },
            body: JSON.stringify({ source: template, destination: path }),
            signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 409) continue; // a map with this name already exists
        if (!res.ok) throw new Error(`map-storage copy failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
        const settings: RoomSettings = {
            path,
            name: t(lang).roomName(displayName),
            description: null,
            access: { everyone: false, tags: [], users: [] },
            hidden: false,
            owner,
        };
        rooms.save(settings);
        return settings;
    }
    throw new Error("No free room name");
}
