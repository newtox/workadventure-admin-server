import { config } from "./config.js";

interface MapsCache {
    maps: Record<string, { mapUrl: string; metadata?: Record<string, unknown> }>;
}

export interface RoomDescription {
    name: string;
    roomUrl: string;
    wamUrl: string;
    description?: string | null;
    copyright?: string | null;
    thumbnail?: string | null;
    areasSearchable?: number | null;
    entitiesSearchable?: number | null;
}

let cached: { at: number; rooms: RoomDescription[] } | undefined;

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Reads a map file (.wam) from the map storage. */
export async function readMap(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${config.internalMapStorageUrl}/${encodePath(path)}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`map-storage read of ${path} failed: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
}

/** Writes (creates or replaces) a map file (.wam) in the map storage. */
export async function writeMap(path: string, content: unknown): Promise<void> {
    const res = await fetch(`${config.internalMapStorageUrl}/${encodePath(path)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.mapStorageToken}` },
        body: JSON.stringify(content),
        signal: AbortSignal.timeout(30_000),
    });
    cached = undefined;
    if (!res.ok) throw new Error(`map-storage write of ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

/** Whether a map exists in the map storage (fresh list, not cached). */
export async function mapExists(path: string): Promise<boolean> {
    cached = undefined;
    return (await listRooms()).some((r) => r.roomUrl === "/~/" + path);
}

export async function deleteMap(path: string): Promise<void> {
    const res = await fetch(`${config.internalMapStorageUrl}/${encodePath(path)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${config.mapStorageToken}` },
        signal: AbortSignal.timeout(30_000),
    });
    cached = undefined;
    if (!res.ok && res.status !== 404) throw new Error(`map-storage delete failed: ${res.status}`);
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

/** All maps of the map storage, as shown in the room list. Relative thumbnails are resolved next to the map. */
export async function listRooms(): Promise<RoomDescription[]> {
    if (cached && Date.now() - cached.at < 10_000) return cached.rooms;
    const res = await fetch(`${config.internalMapStorageUrl}/maps`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`map-storage answered ${res.status}`);
    const data = (await res.json()) as MapsCache;

    const rooms: RoomDescription[] = [];
    for (const [path, value] of Object.entries(data.maps ?? {})) {
        const wamUrl = new URL(path, config.publicMapStorageUrl + "/").toString();
        const meta = value?.metadata ?? {};
        let thumbnail = str(meta.thumbnail);
        if (thumbnail) {
            try {
                thumbnail = new URL(thumbnail, wamUrl).toString();
            } catch {
                thumbnail = undefined;
            }
        }
        rooms.push({
            name: str(meta.name) ?? path,
            roomUrl: "/~/" + path,
            wamUrl,
            description: str(meta.description),
            copyright: str(meta.copyright),
            thumbnail,
            areasSearchable: num(meta.areasSearchable),
            entitiesSearchable: num(meta.entitiesSearchable),
        });
    }
    rooms.sort((a, b) => a.name.localeCompare(b.name, "de"));
    cached = { at: Date.now(), rooms };
    return rooms;
}
