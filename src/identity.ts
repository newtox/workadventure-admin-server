import { config } from "./config.js";

export interface Identity {
    tags: string[];
    username: string | null;
    name: string | null;
    email: string | null;
}

let userinfoEndpoint: Promise<string | undefined> | undefined;

function discoverUserinfo(): Promise<string | undefined> {
    if (!config.oidcIssuer) return Promise.resolve(undefined);
    if (!userinfoEndpoint) {
        const issuer = config.oidcIssuer.endsWith("/") ? config.oidcIssuer : config.oidcIssuer + "/";
        userinfoEndpoint = fetch(new URL(".well-known/openid-configuration", issuer), { signal: AbortSignal.timeout(5000) })
            .then((r) => (r.ok ? (r.json() as Promise<{ userinfo_endpoint?: string }>) : Promise.reject(new Error(`discovery ${r.status}`))))
            .then((d) => d.userinfo_endpoint)
            .catch((err) => {
                console.warn("OpenID discovery failed:", err instanceof Error ? err.message : err);
                userinfoEndpoint = undefined; // retry on the next request
                return undefined;
            });
    }
    return userinfoEndpoint;
}

// WorkAdventure asks for the same user several times within a second (page load + websocket).
const cache = new Map<string, { at: number; identity: Identity | undefined }>();
const CACHE_MS = 20_000;

function asStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    if (typeof value === "string" && value) return value.split(/[\s,]+/).filter(Boolean);
    return [];
}

/**
 * Reads the current roles of a user from the OpenID provider, using the access token WorkAdventure got at login.
 * Returns undefined when the token is missing, expired or the provider is unreachable.
 */
export async function identityFromAccessToken(accessToken: string | undefined): Promise<Identity | undefined> {
    if (!accessToken) return undefined;
    const now = Date.now();
    const hit = cache.get(accessToken);
    if (hit && now - hit.at < CACHE_MS) return hit.identity;

    const endpoint = await discoverUserinfo();
    if (!endpoint) return undefined;

    let identity: Identity | undefined;
    try {
        const res = await fetch(endpoint, {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
            signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
            const claims = (await res.json()) as Record<string, unknown>;
            identity = {
                tags: asStringArray(claims[config.tagsClaim]),
                username: typeof claims[config.usernameClaim] === "string" ? (claims[config.usernameClaim] as string) : null,
                name: typeof claims.name === "string" ? claims.name : null,
                email: typeof claims.email === "string" ? claims.email : null,
            };
        }
    } catch (err) {
        console.warn("userinfo request failed:", err instanceof Error ? err.message : err);
    }

    cache.set(accessToken, { at: now, identity });
    if (cache.size > 1000) {
        for (const [key, value] of cache) if (now - value.at > CACHE_MS) cache.delete(key);
    }
    return identity;
}
