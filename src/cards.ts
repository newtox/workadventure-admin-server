// Visit cards: WorkAdventure shows them when someone clicks on a player.
// They are the only place where roles other than "admin" can be shown in the game.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { roleLabel, type Lang } from "./i18n.js";

const KEY = createHmac("sha256", config.apiToken).update("visit-card").digest();

export function cardToken(identifier: string): string {
    const id = Buffer.from(identifier).toString("base64url");
    return `${id}.${createHmac("sha256", KEY).update(id).digest("base64url").slice(0, 22)}`;
}

export function identifierFromCardToken(token: string): string | undefined {
    const [id, sig] = token.split(".");
    if (!id || !sig) return undefined;
    const expected = Buffer.from(createHmac("sha256", KEY).update(id).digest("base64url").slice(0, 22));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    return Buffer.from(id, "base64url").toString("utf8");
}

/** URL of a user's visit card, or null when the admin UI (which serves them) is not enabled. */
export function visitCardUrl(identifier: string): string | null {
    if (!config.publicUrl) return null;
    // WorkAdventure appends "&embed=…", so the URL needs a query string already.
    return `${config.publicUrl}/card/${cardToken(identifier)}?card=1`;
}

/** Display name and colour per role; unknown roles are shown with their name in grey. */
// Colours follow WorkAdventure's theme: admin and editor use the same blue as the in-game admin badge.
export const WA_BLUE = "#4156f6";
export const WA_CONTRAST = "#1b2a41";

export const ROLE_STYLES: Record<string, { label: string; color: string; order: number }> = {
    admin: { label: "Admin", color: WA_BLUE, order: 0 },
    moderator: { label: "Moderator", color: "#e8772e", order: 1 },
    editor: { label: "Editor", color: WA_BLUE, order: 2 },
    vip: { label: "VIP", color: "#e6b800", order: 3 },
    freunde: { label: "Freunde", color: "#2fb36f", order: 4 },
    member: { label: "Mitglied", color: "#5b6b82", order: 5 },
};

export function roleStyle(tag: string, lang: Lang = "de") {
    const style = ROLE_STYLES[tag] ?? { label: tag.charAt(0).toUpperCase() + tag.slice(1), color: "#6b6385", order: 99 };
    return { ...style, label: roleLabel(tag, lang) ?? style.label };
}
