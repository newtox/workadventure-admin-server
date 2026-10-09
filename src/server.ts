import http from "node:http";
import { config } from "./config.js";
import { handle } from "./api.js";
import { handleUi } from "./ui.js";
import { HttpError, sendJson } from "./http.js";

function serve(handler: typeof handle) {
  return http.createServer((req, res) => {
    const started = Date.now();
    handler(req, res)
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
}

const server = serve(handle);
server.listen(config.port, () => {
    console.info(`workadventure-admin-server listening on :${config.port}`);
    if (!config.oidcIssuer) console.warn("OIDC_ISSUER is not set: roles are only taken from the database.");
});

let ui: http.Server | undefined;
if (config.publicUrl && config.oidcClientId && config.oidcClientSecret && config.oidcIssuer) {
    ui = serve(handleUi);
    ui.listen(config.uiPort, () => console.info(`admin UI listening on :${config.uiPort} for ${config.publicUrl}`));
} else {
    console.info("Admin UI disabled (needs PUBLIC_URL, OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET).");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        ui?.close();
        server.close(() => process.exit(0));
    });
}
