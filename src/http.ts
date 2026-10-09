import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
}

export function sendEmpty(res: ServerResponse, status = 204): void {
    res.writeHead(status);
    res.end();
}

export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > limit) throw new HttpError(413, "Body too large");
        chunks.push(chunk as Buffer);
    }
    if (size === 0) return {};
    try {
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
    } catch {}
    throw new HttpError(400, "Invalid JSON body");
}

/** Reads a query parameter that axios may send as `name` or `name[]`, once or repeated. */
export function queryList(query: URLSearchParams, name: string): string[] {
    return [...query.getAll(name), ...query.getAll(`${name}[]`)].filter((v) => v !== "");
}

export function queryString(query: URLSearchParams, name: string): string | undefined {
    const value = query.get(name);
    return value === null || value === "" ? undefined : value;
}
