import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { bans, reports, rooms, users } from "./db.js";
import { canEnter, isOwner, roomsVisibleFor, storagePath } from "./access.js";
import { HttpError, queryList, queryString, readJson, sendEmpty, sendJson } from "./http.js";
import { identityFromAccessToken } from "./identity.js";
import { visitCardUrl } from "./cards.js";
import { langFrom, matchLang, t } from "./i18n.js";
import { companionDetail, companions, wokaDetailsFor, wokaListFor, type Viewer } from "./wokas.js";

const CAPABILITIES = {
    "api/woka/list": "v1",
    "api/companion/list": "v1",
    "api/save-textures": "v1",
    "api/ban": "v1",
};

function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : header;
    const a = Buffer.from(token);
    const b = Buffer.from(config.apiToken);
    return a.length === b.length && timingSafeEqual(a, b);
}

// Token handed to the browser for chat uploads; the uploader sends it back to /api/limit/fileSize.
function userRoomToken(identifier: string): string {
    const id = Buffer.from(identifier).toString("base64url");
    return `${id}.${createHmac("sha256", config.apiToken).update(id).digest("base64url")}`;
}

function checkUserRoomToken(token: string | undefined): boolean {
    if (!token) return false;
    const [id, sig] = token.split(".");
    if (!id || !sig) return false;
    const expected = Buffer.from(createHmac("sha256", config.apiToken).update(id).digest("base64url"));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
}

function error(code: string, title: string, subtitle: string, details: string) {
    return { status: "error", type: "error", code, title, subtitle, details, image: "" } as const;
}

// Anonymous users get a random uuid as identifier, logged-in users their email (or OpenID "sub").
const isAnonymous = (identifier: string | undefined, accessToken: string | undefined) => !identifier || !accessToken;

/** Current roles of a user: live from the OpenID provider if possible, otherwise the last known ones. */
/**
 * Personal tag "@name" for each logged-in user, so that the map editor's area rights
 * (which only know tags) can also be given to single persons.
 */
export function personalTag(username: string | null | undefined): string | undefined {
    // Lower case, accents removed ("Jürgen" → "jurgen"), spaces and other characters dropped ("Graf Cedric" → "grafcedric").
    const slug = (username ?? "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/ß/g, "ss")
        .replace(/[^a-z0-9._-]+/g, "");
    return slug ? `@${slug}` : undefined;
}

function withPersonalTag(tags: string[], username: string | null | undefined): string[] {
    const tag = personalTag(username);
    return tag ? [...tags, tag] : tags;
}

async function resolveViewer(identifier: string | undefined, accessToken: string | undefined): Promise<Viewer> {
    if (!identifier) return { identifier: "", tags: [] };
    const identity = await identityFromAccessToken(accessToken);
    if (identity) {
        users.saveProfile(identifier, identity);
        return { identifier, tags: withPersonalTag(identity.tags, identity.username ?? users.get(identifier)?.username) };
    }
    const known = users.get(identifier);
    if (known && accessToken) users.touch(identifier);
    return { identifier, tags: withPersonalTag(known?.tags ?? [], known?.username) };
}

function canEditMap(viewer: Viewer, playUri: URL): boolean {
    if (!config.enableMapEditor || !/^\/~\//.test(playUri.pathname)) return false;
    // Owners decorate their personal room themselves.
    const path = storagePath(playUri);
    if (path && isOwner(rooms.get(path), viewer)) return true;
    if (config.editorUsers.some((u) => u.toLowerCase() === viewer.identifier.toLowerCase())) return true;
    return viewer.tags.some((t) => config.editorTags.includes(t));
}

function parseUrl(value: string | undefined, name: string): URL {
    if (!value) throw new HttpError(400, `Missing ${name}`);
    try {
        return new URL(value);
    } catch {
        throw new HttpError(400, `Invalid ${name}`);
    }
}

// ---------- /api/map ----------

function mapDetails(playUri: URL) {
    if (playUri.pathname === "/") {
        return { redirectUrl: new URL(config.startRoomUrl, playUri).toString() };
    }

    let mapUrl: string | undefined;
    let wamUrl: string | undefined;
    const storage = /^\/~\/(.+)/.exec(playUri.pathname);
    if (storage) {
        if (storage[1]!.endsWith(".tmj")) {
            const target = new URL(playUri);
            target.pathname = playUri.pathname.replace(/\.tmj$/, ".wam");
            return { redirectUrl: target.toString() };
        }
        wamUrl = `${config.publicMapStorageUrl}/${storage[1]}`;
    } else {
        const external = /^\/_\/[^/]+\/(.+)/.exec(playUri.pathname);
        if (!external) {
            return error("UNSUPPORTED_URL_FORMAT", "Unsupported URL format", "", "Unsupported path: " + playUri.pathname);
        }
        mapUrl = playUri.protocol + "//" + external[1];
    }

    return {
        mapUrl,
        wamUrl,
        editable: wamUrl !== undefined && config.enableMapEditor,
        authenticationMandatory: config.disableAnonymous,
        group: wamUrl ? "default" : null,
        contactPage: null,
        opidLogoutRedirectUrl: null,
        opidWokaNamePolicy: config.wokaNamePolicy,
        canReport: config.enableReport,
        loadingLogo: null,
        loginSceneLogo: null,
        errorSceneLogo: null,
        showPoweredBy: true,
        enableChat: config.enableChat,
        enableMatrixChat: config.enableChat && !!config.matrixDomain,
        enableChatUpload: config.enableChatUpload,
        enableChatOnlineList: config.enableChatOnlineList,
        enableChatDisconnectedList: config.enableChatDisconnectedList,
        enableSay: config.enableSay,
        enableIssueReport: config.enableIssueReport,
        recording: { buttonState: "hidden", disabledReason: null },
        metadata: { enableTutorial: config.enableTutorial },
    };
}

// ---------- /api/room/access ----------

async function roomAccess(query: URLSearchParams, acceptLanguage: string | undefined) {
    const text = t(langFrom(acceptLanguage));
    const identifier = queryString(query, "userIdentifier");
    const accessToken = queryString(query, "accessToken");
    const playUri = parseUrl(queryString(query, "playUri"), "playUri");
    const requestedTextures = queryList(query, "characterTextureIds");
    const requestedCompanion = queryString(query, "companionTextureId");

    const anonymous = isAnonymous(identifier, accessToken);
    const viewer = await resolveViewer(identifier, accessToken);

    if (identifier) {
        const ban = bans.get(identifier);
        if (ban) {
            return error("BANNED", text.bannedTitle, text.bannedSubtitle, ban.reason ? text.bannedReason(ban.reason) : text.bannedContact);
        }
    }
    const path = storagePath(playUri);
    const settings = path ? rooms.get(path) : undefined;
    if (!canEnter(settings, viewer)) {
        return error(
            "ROOM_ACCESS_DENIED",
            text.deniedTitle,
            settings?.owner ? text.deniedPrivate : text.deniedRoles,
            text.deniedHint,
        );
    }
    const stored = !anonymous && identifier ? users.get(identifier) : undefined;
    // Remembered so the profile tab can use the game language instead of the browser's.
    const gameLang = matchLang(acceptLanguage);
    if (stored && gameLang) {
        if (stored.locale !== gameLang) users.setLocale(stored.identifier, gameLang);
    }

    // The account's saved woka wins; the browser's choice is used (and saved) when there is none yet.
    let characterTextures = stored?.textures ? wokaDetailsFor(viewer, stored.textures) : undefined;
    if (!characterTextures) {
        characterTextures = wokaDetailsFor(viewer, requestedTextures);
        if (characterTextures && !anonymous && identifier) users.setTextures(identifier, requestedTextures);
    }

    let companionTexture: { id: string; url: string } | null = null;
    let isCompanionTextureValid = true;
    const companionId = stored?.companion ?? requestedCompanion;
    if (companionId) {
        companionTexture = companionDetail(companionId) ?? null;
        if (!companionTexture) {
            // Unknown companion: fall back to the browser's choice, otherwise ask again.
            companionTexture = requestedCompanion ? (companionDetail(requestedCompanion) ?? null) : null;
            isCompanionTextureValid = companionTexture !== null || !requestedCompanion;
        }
    }

    return {
        status: "ok",
        email: anonymous ? null : (identifier ?? null),
        userUuid: identifier ?? "",
        tags: viewer.tags,
        visitCardUrl: anonymous || !identifier ? null : visitCardUrl(identifier),
        isCharacterTexturesValid: characterTextures !== undefined,
        characterTextures: characterTextures ?? [],
        isCompanionTextureValid,
        companionTexture,
        userRoomToken: anonymous || !identifier ? undefined : userRoomToken(identifier),
        activatedInviteUser: true,
        canEdit: canEditMap(viewer, playUri),
        world: playUri.origin,
        applications: [],
        canRecord: false,
        analyticsEventsEnabled: false,
    };
}

// ---------- Router ----------

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname.replace(/\/+$/, "") || "/"}`;
    const q = url.searchParams;

    if (route === "GET /healthz") return sendJson(res, 200, { ok: true });
    // WorkAdventure asks for the capabilities without credentials.
    if (route === "GET /api/capabilities") return sendJson(res, 200, CAPABILITIES);
    // Called by WorkAdventure without credentials; nothing to do here.
    if (route === "GET /oauth/logout") return sendJson(res, 200, {});
    // The uploader authenticates with the user's room token instead of the API token.
    if (route === "GET /api/limit/fileSize") {
        const token = req.headers.userroomtoken;
        if (!checkUserRoomToken(Array.isArray(token) ? token[0] : token)) return sendJson(res, 401, { error: "not logged in" });
        const size = Number(queryString(q, "fileSize"));
        if (!config.enableChatUpload) return sendJson(res, 403, { error: "upload disabled" });
        if (!(size >= 0) || size > config.uploadMaxFilesize) return sendJson(res, 413, { error: "file-too-big" });
        return sendJson(res, 200, { ok: true });
    }
    if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });

    switch (route) {
        case "GET /api/map":
            return sendJson(res, 200, mapDetails(parseUrl(queryString(q, "playUri"), "playUri")));

        case "GET /api/room/access":
            return sendJson(res, 200, await roomAccess(q, req.headers["accept-language"]));

        case "GET /api/woka/list": {
            const identifier = queryString(q, "uuid");
            const known = identifier ? users.get(identifier) : undefined;
            return sendJson(res, 200, wokaListFor({ identifier: identifier ?? "", tags: known?.tags ?? [] }));
        }

        case "GET /api/companion/list":
            return sendJson(res, 200, companions);

        case "POST /api/save-textures": {
            const body = await readJson(req);
            const identifier = typeof body.userIdentifier === "string" ? body.userIdentifier : undefined;
            const textures = Array.isArray(body.textures) ? body.textures.filter((t): t is string => typeof t === "string") : [];
            if (!identifier) throw new HttpError(400, "Missing userIdentifier");
            const known = users.get(identifier);
            if (!wokaDetailsFor({ identifier, tags: known?.tags ?? [] }, textures)) throw new HttpError(400, "Unknown or forbidden texture");
            users.setTextures(identifier, textures);
            return sendEmpty(res, 204);
        }

        case "POST /api/save-companion-texture": {
            const body = await readJson(req);
            const identifier = typeof body.userIdentifier === "string" ? body.userIdentifier : undefined;
            const texture = typeof body.texture === "string" ? body.texture : null;
            if (!identifier) throw new HttpError(400, "Missing userIdentifier");
            if (texture !== null && !companionDetail(texture)) throw new HttpError(400, "Unknown companion");
            users.setCompanion(identifier, texture);
            return sendEmpty(res, 204);
        }

        case "GET /api/room/sameWorld": {
            const bypass = queryString(q, "bypassTagFilter") === "true";
            const tags = (queryString(q, "tags") ?? "").split(",").filter(Boolean);
            return sendJson(res, 200, bypass ? await roomsVisibleFor(["admin"]) : await roomsVisibleFor(tags));
        }

        case "POST /api/ban": {
            const body = await readJson(req);
            const s = (v: unknown) => (typeof v === "string" ? v : "");
            const target = s(body.uuidToBan);
            if (!target) throw new HttpError(400, "Missing uuidToBan");
            bans.add(target, s(body.message).slice(0, 500) || null, s(body.byUserUuid) || null);
            console.info(`ban: ${s(body.byUserUuid)} banned ${target}`);
            return sendJson(res, 200, {});
        }

        case "GET /api/room/tags":
            return sendJson(res, 200, knownTags());

        case "GET /api/world/tags": {
            const search = (queryString(q, "searchText") ?? "").toLowerCase();
            return sendJson(res, 200, knownTags().filter((t) => t.toLowerCase().includes(search)));
        }

        case "GET /api/members": {
            const found = users.search(queryString(q, "searchText") ?? "");
            return sendJson(res, 200, found.map(toMember));
        }

        case "GET /api/chat/members": {
            const found = users.search(queryString(q, "searchText") ?? "", 500);
            return sendJson(res, 200, {
                total: found.length,
                members: found.map((u) => ({ uuid: u.identifier, wokaName: u.username ?? undefined, email: u.email ?? u.identifier, chatId: matrixId(u.identifier) ?? undefined, tags: u.tags })),
            });
        }

        case "POST /api/report": {
            const body = await readJson(req);
            const s = (v: unknown) => (typeof v === "string" ? v : "");
            reports.add(s(body.reportedUserUuid), s(body.reporterUserUuid), s(body.reportedUserComment).slice(0, 2000), s(body.reportWorldSlug) || null);
            console.info(`report: ${s(body.reporterUserUuid)} reported ${s(body.reportedUserUuid)}`);
            return sendJson(res, 200, {});
        }

    }

    const member = /^GET \/api\/members\/(.+)$/.exec(route);
    if (member) {
        const id = decodeURIComponent(member[1]!);
        // Users who have not entered a room since the admin server runs are not in the database yet.
        const user = users.get(id) ?? { identifier: id, username: null, name: null, email: id.includes("@") ? id : null };
        return sendJson(res, 200, toMember(user));
    }

    return sendJson(res, 404, { error: "not found" });
}

function knownTags(): string[] {
    const personal = users.search("", 1000).map((u) => personalTag(u.username)).filter((t): t is string => !!t);
    return [...new Set([...config.knownTags, ...users.allTags()])].sort().concat([...new Set(personal)].sort());
}

/** Matrix id WorkAdventure gives a logged-in user: "@" + email with "@" replaced by "_" + ":" + MATRIX_DOMAIN. */
export function matrixId(identifier: string): string | null {
    if (!config.matrixDomain || !identifier || /^[0-9a-f-]{36}$/.test(identifier)) return null;
    return `@${identifier.replace("@", "_")}:${config.matrixDomain}`;
}

function toMember(u: { identifier: string; username: string | null; name: string | null; email: string | null }) {
    return { id: u.identifier, name: u.username ?? u.name ?? null, email: u.email ?? u.identifier, visitCardUrl: visitCardUrl(u.identifier), chatID: matrixId(u.identifier) };
}
