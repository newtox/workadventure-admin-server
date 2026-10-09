import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listCustomWokas, type CustomWoka } from "./db.js";

// Same order WorkAdventure uses to stack the layers of a woka.
export const WOKA_PARTS = ["woka", "body", "eyes", "hair", "clothes", "hat", "accessory"] as const;

interface WokaTexture {
    id: string;
    name: string;
    url: string;
    position?: number;
}
interface WokaCollection {
    name: string;
    position?: number;
    textures: WokaTexture[];
}
interface WokaPart {
    required?: boolean;
    collections: WokaCollection[];
}
export type WokaList = Record<string, WokaPart>;

export interface WokaDetail {
    id: string;
    url: string;
}

export interface Viewer {
    identifier: string;
    tags: string[];
}

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const official: WokaList = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "woka.json"), "utf8"));

// Official wokas sit in the collection "default"; custom ones get their own, shown first.
export const CUSTOM_COLLECTION = "custom";

export function canUse(woka: CustomWoka, viewer: Viewer): boolean {
    const access = woka.access;
    if (access.everyone) return true;
    if (access.users?.some((u) => u.toLowerCase() === viewer.identifier.toLowerCase())) return true;
    return access.tags?.some((t) => viewer.tags.includes(t)) ?? false;
}

/** The woka list a given user may choose from: all official wokas plus the custom ones they are allowed to use. */
export function wokaListFor(viewer: Viewer): WokaList {
    const list: WokaList = structuredClone(official);
    const custom = listCustomWokas().filter((w) => canUse(w, viewer));
    for (const woka of custom) {
        const part = (list[woka.part] ??= { collections: [] });
        let collection = part.collections.find((c) => c.name === CUSTOM_COLLECTION);
        if (!collection) {
            collection = { name: CUSTOM_COLLECTION, position: -1, textures: [] };
            part.collections.unshift(collection);
        }
        collection.textures.push({ id: woka.id, name: woka.name, url: woka.url, position: woka.position });
    }
    return list;
}

/**
 * Resolves texture ids to their URLs, in layer order.
 * Returns undefined if any id is unknown or not allowed for this user.
 */
export function wokaDetailsFor(viewer: Viewer, ids: string[]): WokaDetail[] | undefined {
    if (ids.length === 0) return undefined;
    const list = wokaListFor(viewer);
    const wanted = new Set(ids);
    const details: WokaDetail[] = [];
    for (const part of [...WOKA_PARTS, ...Object.keys(list).filter((p) => !(WOKA_PARTS as readonly string[]).includes(p))]) {
        for (const collection of list[part]?.collections ?? []) {
            for (const texture of collection.textures) {
                if (wanted.has(texture.id)) {
                    details.push({ id: texture.id, url: texture.url });
                    wanted.delete(texture.id);
                }
            }
        }
    }
    return wanted.size === 0 ? details : undefined;
}

// ---------- Companions ----------

interface CompanionTexture {
    id: string;
    name: string;
    url: string;
    behavior?: string;
}
interface CompanionCollection {
    name: string;
    position?: number;
    textures: CompanionTexture[];
}

export const companions: CompanionCollection[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "companions.json"), "utf8"));

export function companionDetail(id: string): { id: string; url: string } | undefined {
    for (const collection of companions) {
        const texture = collection.textures.find((t) => t.id === id);
        if (texture) return { id: texture.id, url: texture.url };
    }
    return undefined;
}
