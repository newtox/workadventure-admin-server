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

/** Copies a map inside the map storage. Returns false when the destination already exists. */
export async function copyMap(source: string, destination: string): Promise<boolean> {
    const res = await fetch(`${config.internalMapStorageUrl}/copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.mapStorageToken}` },
        body: JSON.stringify({ source, destination }),
        signal: AbortSignal.timeout(10_000),
    });
    cached = undefined;
    if (res.status === 409) return false;
    if (!res.ok) throw new Error(`map-storage copy failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return true;
}

export async function deleteMap(path: string): Promise<void> {
    const res = await fetch(`${config.internalMapStorageUrl}/${encodePath(path)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${config.mapStorageToken}` },
        signal: AbortSignal.timeout(10_000),
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
