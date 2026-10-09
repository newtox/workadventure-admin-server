import http from "node:http";
import { config } from "./config.js";
import { handle } from "./api.js";
import { HttpError, sendJson } from "./http.js";

const server = http.createServer((req, res) => {
    const started = Date.now();
    handle(req, res)
        .catch((err: unknown) => {
            if (err instanceof HttpError) {
                if (!res.headersSent) sendJson(res, err.status, { error: err.message });
                return;
            }
            console.error(`${req.method} ${req.url?.split("?")[0]} failed:`, err);
            if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
        })
        .finally(() => {
            if (res.statusCode >= 400 || process.env.LOG_REQUESTS === "1") {
                console.info(`${req.method} ${req.url?.split("?")[0]} ${res.statusCode} ${Date.now() - started}ms`);
            }
        });
});

server.listen(config.port, () => {
    console.info(`workadventure-admin-server listening on :${config.port}`);
    if (!config.oidcIssuer) console.warn("OIDC_ISSUER is not set: roles are only taken from the database.");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
