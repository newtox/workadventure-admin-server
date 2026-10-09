// All settings come from environment variables (see README).

function str(name: string, fallback?: string): string {
    const value = process.env[name];
    if (value === undefined || value === "") {
        if (fallback === undefined) throw new Error(`Missing environment variable ${name}`);
        return fallback;
    }
    return value;
}

function bool(name: string, fallback: boolean): boolean {
    const value = process.env[name];
    if (value === undefined || value === "") return fallback;
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function list(name: string, fallback: string): string[] {
    return str(name, fallback)
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v !== "");
}

function optional(name: string): string | undefined {
    const value = process.env[name];
    return value === undefined || value === "" ? undefined : value;
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

export const config = {
    port: Number(str("PORT", "3000")),
    dataDir: str("DATA_DIR", "./data-local"),
    /** Shared secret, must be identical to ADMIN_API_TOKEN in WorkAdventure. */
    apiToken: str("ADMIN_API_TOKEN"),

    /** OpenID issuer (Authentik application), used to read live roles via the userinfo endpoint. */
    oidcIssuer: optional("OIDC_ISSUER"),
    /** Claim in the userinfo answer that holds the roles. */
    tagsClaim: str("OIDC_TAGS_CLAIM", "tags"),
    usernameClaim: str("OIDC_USERNAME_CLAIM", "preferred_username"),

    /** Map storage as seen from this container, and as seen from browsers. */
    internalMapStorageUrl: trimSlash(str("INTERNAL_MAP_STORAGE_URL", "http://map-storage:3000")),
    publicMapStorageUrl: trimSlash(str("PUBLIC_MAP_STORAGE_URL")),
    startRoomUrl: str("START_ROOM_URL", "/~/maps/office.wam"),

    disableAnonymous: bool("DISABLE_ANONYMOUS", true),
    wokaNamePolicy: str("OPENID_WOKA_NAME_POLICY", "allow_override_opid"),
    enableMapEditor: bool("ENABLE_MAP_EDITOR", true),
    /** Users with one of these roles may use the map editor. */
    editorTags: list("EDITOR_TAGS", "admin,editor"),
    /** Additional user identifiers (emails) that may use the map editor. */
    editorUsers: list("MAP_EDITOR_ALLOWED_USERS", ""),
    /** Roles offered in the map editor when restricting areas, in addition to the ones seen on users. */
    knownTags: list("KNOWN_TAGS", "admin,editor,moderator,freunde,vip,member"),

    enableChat: bool("ENABLE_CHAT", true),
    /**
     * Matrix server name (MATRIX_DOMAIN of WorkAdventure). When set, the Matrix chat (direct messages,
     * chat rooms) is enabled and members get their Matrix id, so they can be messaged from the member list.
     */
    matrixDomain: optional("MATRIX_DOMAIN"),
    enableChatUpload: bool("ENABLE_CHAT_UPLOAD", true),
    enableChatOnlineList: bool("ENABLE_CHAT_ONLINE_LIST", true),
    enableChatDisconnectedList: bool("ENABLE_CHAT_DISCONNECTED_LIST", true),
    enableSay: bool("ENABLE_SAY", true),
    enableIssueReport: bool("ENABLE_ISSUE_REPORT", false),
    enableTutorial: bool("ENABLE_TUTORIAL", true),
    enableReport: bool("ENABLE_REPORT", true),
    /** Maximum size of files uploaded in the chat (bytes). */
    uploadMaxFilesize: Number(str("UPLOAD_MAX_FILESIZE", String(10 * 1024 * 1024))),

    /** Token for the map storage API (MAP_STORAGE_AUTHENTICATION_TOKEN), needed to create personal rooms. */
    mapStorageToken: optional("MAP_STORAGE_TOKEN"),
    /** Map that is copied for each personal room, e.g. "maps/zimmer.wam". Enables personal rooms. */
    personalRoomTemplate: optional("PERSONAL_ROOM_TEMPLATE"),
    /**
     * Folder in the map storage for personal rooms. It must not be a folder that maps are uploaded to:
     * an upload removes every map in its folder that is not part of the upload.
     */
    personalRoomDir: str("PERSONAL_ROOM_DIR", "zimmer").replace(/^\/+|\/+$/g, ""),
    /** Roles that may create a personal room (empty = everyone who is logged in). */
    personalRoomTags: list("PERSONAL_ROOM_TAGS", ""),

    // ---------- Admin UI (optional) ----------
    /** Public URL of the admin UI, e.g. https://workadventure-admin.example.com. Enables the UI. */
    publicUrl: optional("PUBLIC_URL") ? trimSlash(optional("PUBLIC_URL")!) : undefined,
    uiPort: Number(str("UI_PORT", "3001")),
    /** Time zone for dates in the admin UI (TZ of the container, otherwise Europe/Berlin). */
    timeZone: str("TIME_ZONE", process.env.TZ || "Europe/Berlin"),
    oidcClientId: optional("OIDC_CLIENT_ID"),
    oidcClientSecret: optional("OIDC_CLIENT_SECRET"),
    oidcScope: str("OIDC_SCOPE", "openid email profile wa"),
    /** Role required to use the admin UI. */
    adminTag: str("ADMIN_TAG", "admin"),
    /** WorkAdventure URL, used to show official wokas in previews. */
    playUrl: optional("PLAY_URL") ? trimSlash(optional("PLAY_URL")!) : undefined,
} as const;

export type Config = typeof config;
