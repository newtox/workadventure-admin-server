// Registration invites, created through the authentik API (only when AUTHENTIK_TOKEN is set).
import { randomBytes } from "node:crypto";
import { config } from "./config.js";

export interface Invite {
    pk: string;
    name: string;
    url: string;
    expires: string | null;
    singleUse: boolean;
    createdBy: string | null;
}

export const invitesEnabled = () => !!config.authentikToken && !!config.authentikUrl;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${config.authentikUrl}/api/v3${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${config.authentikToken}`, Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`authentik ${init.method ?? "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
}

let flowPk: string | undefined;

async function inviteFlowPk(): Promise<string> {
    if (flowPk) return flowPk;
    const res = await api<{ results: { pk: string; slug: string }[] }>(`/flows/instances/?slug=${encodeURIComponent(config.inviteFlow)}`);
    const flow = res.results.find((f) => f.slug === config.inviteFlow);
    if (!flow) throw new Error(`authentik flow "${config.inviteFlow}" not found`);
    return (flowPk = flow.pk);
}

const linkFor = (pk: string) => `${config.authentikUrl}/if/flow/${encodeURIComponent(config.inviteFlow)}/?itoken=${pk}`;

function slug(text: string): string {
    return text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/ß/g, "ss")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30);
}

interface ApiInvite {
    pk: string;
    name: string;
    expires: string | null;
    single_use?: boolean;
    created_by?: { username?: string } | null;
}

const toInvite = (i: ApiInvite): Invite => ({
    pk: i.pk,
    name: i.name,
    url: linkFor(i.pk),
    expires: i.expires,
    singleUse: i.single_use ?? false,
    createdBy: i.created_by?.username ?? null,
});

/**
 * Creates an invite for the registration flow. The name carries who asked for it and for whom,
 * because authentik records the token's owner as creator.
 */
export async function createInvite(options: { by: string; forWhom?: string; days?: number; multiUse?: boolean }): Promise<Invite> {
    const days = Math.min(Math.max(Math.round(options.days ?? config.inviteDays), 1), 90);
    const name = [slug(options.by) || "admin", slug(options.forWhom ?? ""), randomBytes(3).toString("hex")].filter(Boolean).join("-");
    const created = await api<ApiInvite>("/stages/invitation/invitations/", {
        method: "POST",
        body: JSON.stringify({
            name,
            expires: new Date(Date.now() + days * 86_400_000).toISOString(),
            single_use: !options.multiUse,
            flow: await inviteFlowPk(),
            fixed_data: {},
        }),
    });
    return toInvite(created);
}

/** Open invites of the registration flow; used single-use invites are deleted by authentik. */
export async function listInvites(): Promise<Invite[]> {
    const res = await api<{ results: ApiInvite[] }>(`/stages/invitation/invitations/?flow__slug=${encodeURIComponent(config.inviteFlow)}&ordering=-expires&page_size=100`);
    const now = Date.now();
    return res.results.map(toInvite).filter((i) => !i.expires || new Date(i.expires).getTime() > now);
}

export async function deleteInvite(pk: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(pk)) throw new Error("invalid invite id");
    await api<void>(`/stages/invitation/invitations/${pk}/`, { method: "DELETE" });
}
