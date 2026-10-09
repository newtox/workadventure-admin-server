// Texts that players see (visit cards, profile tab, error screens). The admin UI's texts are in adminI18n.ts.
export type Lang = "de" | "en";

/**
 * Picks the language from an Accept-Language header. WorkAdventure sends the player's
 * game language this way to the admin API; browsers send their own language for the
 * visit card and profile iframes. Everything that is not German gets English.
 */
export function langFrom(...candidates: (string | string[] | null | undefined)[]): Lang {
    for (const candidate of candidates) {
        const lang = matchLang(candidate);
        if (lang) return lang;
    }
    return "en";
}

/** "de" or "en" when the header names one of them, otherwise undefined. */
export function matchLang(candidate: string | string[] | null | undefined): Lang | undefined {
    const value = Array.isArray(candidate) ? candidate[0] : candidate;
    if (!value) return undefined;
    const ranked = value
        .split(",")
        .map((part) => {
            const [tag, ...params] = part.trim().toLowerCase().split(";");
            const q = params.map((p) => /^q=([\d.]+)$/.exec(p.trim())).find(Boolean);
            return { tag: tag ?? "", q: q ? Number(q[1]) : 1 };
        })
        .filter((e) => e.tag && e.q > 0)
        .sort((a, b) => b.q - a.q);
    for (const { tag } of ranked) {
        if (tag === "de" || tag.startsWith("de-") || tag.startsWith("de_")) return "de";
        if (tag === "en" || tag.startsWith("en-") || tag.startsWith("en_")) return "en";
    }
    return undefined;
}

const TEXTS = {
    de: {
        guest: "Gast",
        unknown: "Unbekannt",
        memberSince: (date: string) => `Dabei seit ${date}`,
        noCard: "Keine Visitenkarte.",
        sessionExpired: "Deine Anmeldung ist abgelaufen. Lade WorkAdventure neu, dann siehst du hier dein Profil.",
        enterRoomFirst: "Betritt einmal einen Raum, dann erscheint hier deine Visitenkarte.",
        yourCard: "Deine Visitenkarte",
        yourCardHint: "So sehen dich die anderen, wenn sie auf dich klicken.",
        yourAvatar: "Dein Avatar",
        avatarHint: "Rollen vergibt ein Admin. Deinen Avatar änderst du oben rechts über deinen Namen.",
        yourTag: "Dein Tag",
        yourTagHint: "Damit kann man dir im Karteneditor Rechte für einzelne Bereiche geben.",
        yourRoom: "Dein Zimmer",
        roomIntro: "Du kannst dir ein eigenes Zimmer anlegen und es mit dem Karteneditor einrichten. Du bestimmst, wer rein darf.",
        createRoom: "Zimmer erstellen",
        enterRoom: "Zimmer betreten",
        roomEditHint: "Im Zimmer kannst du mit dem Karteneditor Möbel und Bereiche setzen.",
        name: "Name",
        whoMayEnter: "Wer darf rein? (Admins immer)",
        everyone: "Alle",
        roles: "Rollen",
        people: "Personen",
        nobodyYet: "Noch niemand war eingeloggt.",
        morePeople: "Weitere Personen (E-Mail, eine pro Zeile)",
        save: "Speichern",
        saved: "Gespeichert.",
        roomCreated: "Dein Zimmer ist fertig. Lege fest, wer rein darf, und richte es ein.",
        roomName: (owner: string) => `Zimmer von ${owner}`,
        chooseStyle: "Such dir einen Stil aus:",
        changeStyle: "Stil wechseln",
        changeStyleHint: "Du bekommst eine frische Kopie im neuen Stil. Alles, was du eingerichtet hast, ist danach weg. Name und Zutrittsrechte bleiben.",
        changeStyleConfirm: "Ja, meine Einrichtung darf verloren gehen",
        styleChanged: "Neuer Stil ist da. Betritt dein Zimmer neu, um ihn zu sehen.",
        currentStyle: "aktuell",
        roomMissing: "Die Karte deines Zimmers fehlt. Such dir einen Stil aus, dann wird es neu angelegt. Name und Zutrittsrechte bleiben.",
        restoreRoom: "Zimmer neu anlegen",
        failed: "Das hat nicht geklappt. Versuch es gleich nochmal oder sag einem Admin Bescheid.",
        forbidden: "Keine Berechtigung",
        bannedTitle: "Gesperrt",
        bannedSubtitle: "Du wurdest von dieser Welt gesperrt.",
        bannedReason: (reason: string) => `Grund: ${reason}`,
        bannedContact: "Wende dich an einen Admin, wenn du glaubst, dass das ein Fehler ist.",
        deniedTitle: "Kein Zutritt",
        deniedPrivate: "Das ist ein privates Zimmer.",
        deniedRoles: "Dieser Raum ist nur für bestimmte Rollen.",
        deniedHint: "Geh zurück und frag den Besitzer oder einen Admin, ob du rein darfst.",
        locale: "de-DE",
    },
    en: {
        guest: "Guest",
        unknown: "Unknown",
        memberSince: (date: string) => `Member since ${date}`,
        noCard: "No visit card.",
        sessionExpired: "Your login has expired. Reload WorkAdventure to see your profile here.",
        enterRoomFirst: "Enter a room once, then your visit card shows up here.",
        yourCard: "Your visit card",
        yourCardHint: "This is what others see when they click on you.",
        yourAvatar: "Your avatar",
        avatarHint: "Roles are given by an admin. Change your avatar through your name at the top right.",
        yourTag: "Your tag",
        yourTagHint: "With it, map editors can give you rights for single areas.",
        yourRoom: "Your room",
        roomIntro: "You can create your own room and furnish it with the map editor. You decide who may enter.",
        createRoom: "Create room",
        enterRoom: "Enter room",
        roomEditHint: "Inside the room, use the map editor to place furniture and areas.",
        name: "Name",
        whoMayEnter: "Who may enter? (admins always can)",
        everyone: "Everyone",
        roles: "Roles",
        people: "People",
        nobodyYet: "Nobody has logged in yet.",
        morePeople: "More people (email, one per line)",
        save: "Save",
        saved: "Saved.",
        roomCreated: "Your room is ready. Choose who may enter and start decorating.",
        roomName: (owner: string) => `${owner}'s room`,
        chooseStyle: "Pick a style:",
        changeStyle: "Change style",
        changeStyleHint: "You get a fresh copy in the new style. Everything you placed is gone afterwards. Name and access stay.",
        changeStyleConfirm: "Yes, my furnishing may be lost",
        styleChanged: "Your new style is ready. Re-enter your room to see it.",
        currentStyle: "current",
        roomMissing: "Your room's map is missing. Pick a style to create it again. Name and access stay.",
        restoreRoom: "Create room again",
        failed: "That did not work. Try again in a moment or tell an admin.",
        forbidden: "Not allowed",
        bannedTitle: "Banned",
        bannedSubtitle: "You have been banned from this world.",
        bannedReason: (reason: string) => `Reason: ${reason}`,
        bannedContact: "Contact an admin if you think this is a mistake.",
        deniedTitle: "No access",
        deniedPrivate: "This is a private room.",
        deniedRoles: "This room is only open to certain roles.",
        deniedHint: "Go back and ask the owner or an admin to let you in.",
        locale: "en-GB",
    },
} as const;

export type Texts = (typeof TEXTS)[Lang];

export function t(lang: Lang): Texts {
    return TEXTS[lang];
}

/** Role names that differ between the languages; other roles keep their own name. */
const ROLE_LABELS: Record<Lang, Record<string, string>> = {
    de: { freunde: "Freunde", member: "Mitglied" },
    en: { freunde: "Friends", member: "Member" },
};

const STYLE_LABELS: Record<Lang, Record<string, string>> = {
    de: { holz: "Holz", loft: "Loft", gemuetlich: "Gemütlich", dunkel: "Dunkel", gross: "Groß" },
    en: { holz: "Wood", loft: "Loft", gemuetlich: "Cozy", dunkel: "Dark", gross: "Large" },
};

/** Name of a room style; styles without a translation show their key. */
export function styleLabel(key: string, lang: Lang): string {
    return STYLE_LABELS[lang][key] ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/-/g, " ");
}

export function roleLabel(tag: string, lang: Lang): string | undefined {
    return ROLE_LABELS[lang][tag];
}
