// Admin web UI: login through OpenID Connect (admin role only), custom wokas, members and reports.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { bans, customWokas, listCustomWokas, listReports, listUsers, reports, rooms, users, type Access, type CustomWoka, type RoomSettings } from "./db.js";
import { changeRoomStyle, createPersonalRoom, mayCreatePersonalRoom, personalRoomsEnabled, roomMapExists, roomStyles, type RoomStyle } from "./access.js";
import { deleteMap, listRooms } from "./mapStorage.js";
import { HttpError, sendJson } from "./http.js";
import { identityFromClaims, oidcEndpoints } from "./identity.js";
import { WOKA_PARTS, wokaListFor } from "./wokas.js";
import { cardToken, identifierFromCardToken, roleStyle, WA_BLUE, WA_CONTRAST } from "./cards.js";
import { identityFromAccessToken } from "./identity.js";
import { personalTag } from "./api.js";
import { langFrom, matchLang, styleLabel, t, type Lang } from "./i18n.js";
import { adminText, type AdminTexts } from "./adminI18n.js";

const WOKA_DIR = path.join(config.dataDir, "wokas");
fs.mkdirSync(WOKA_DIR, { recursive: true });

const SECRET = createHmac("sha256", config.apiToken).update("admin-ui-session").digest();
const SESSION_COOKIE = "wa_admin";
const FLOW_COOKIE = "wa_admin_flow";
const SESSION_HOURS = 8;
const secure = config.publicUrl?.startsWith("https://") ?? false;

// ---------- helpers ----------

const esc = (s: unknown) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** For text inside a single-quoted JavaScript string in an HTML attribute (escape with esc() afterwards). */
const jsString = (s: string) => s.replace(/[\\'"]/g, "\\$&").replace(/[\r\n<>]/g, " ");

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");

function sign(payload: object): string {
    const body = b64(JSON.stringify(payload));
    return `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
}

function verify<T extends { exp: number }>(value: string | undefined): T | undefined {
    if (!value) return undefined;
    const [body, sig] = value.split(".");
    if (!body || !sig) return undefined;
    const expected = Buffer.from(createHmac("sha256", SECRET).update(body).digest("base64url"));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    try {
        const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
        return data.exp > Date.now() ? data : undefined;
    } catch {
        return undefined;
    }
}

function cookies(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (req.headers.cookie ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

function redirect(res: ServerResponse, location: string, setCookies: string[] = []): void {
    res.writeHead(303, { Location: location, ...(setCookies.length ? { "Set-Cookie": setCookies } : {}) });
    res.end();
}

function html(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
        "Referrer-Policy": "same-origin",
    });
    res.end(body);
}

async function readBody(req: IncomingMessage, limit: number, tooBig = "Datei zu groß / File too large"): Promise<Buffer> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > limit) throw new HttpError(413, tooBig);
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    return new URLSearchParams((await readBody(req, 64 * 1024)).toString("utf8"));
}

/** Checks that the upload is a PNG of 96 × 128 pixels (3 frames × 4 directions of 32 × 32). */
function checkWokaPng(data: Buffer, a: AdminTexts): void {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (data.length < 24 || !data.subarray(0, 8).equals(signature) || data.toString("ascii", 12, 16) !== "IHDR") {
        throw new HttpError(400, a.notPng);
    }
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (width !== 96 || height !== 128) {
        throw new HttpError(400, a.wrongSize(width, height));
    }
}

function storeImage(id: string, data: Buffer): string {
    fs.writeFileSync(path.join(WOKA_DIR, `${id}.png`), data);
    const version = createHash("sha256").update(data).digest("hex").slice(0, 8);
    return `${config.publicUrl}/files/wokas/${id}.png?v=${version}`;
}

// ---------- session ----------

interface Session {
    sub: string;
    name: string;
    tags: string[];
    exp: number;
}

const csrfFor = (s: Session) => createHmac("sha256", SECRET).update(`csrf:${s.sub}:${s.exp}`).digest("base64url");

function checkCsrf(s: Session, value: string | null | undefined, a: AdminTexts): void {
    const expected = Buffer.from(csrfFor(s));
    const given = Buffer.from(value ?? "");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new HttpError(403, a.badForm);
}

// ---------- layout ----------

/** What every admin page needs: the session (if logged in), the language and the current path for the language switch. */
interface Ctx {
    s?: Session;
    lang: Lang;
    a: AdminTexts;
    path: string;
}

const ICONS: Record<string, string> = {
    wokas: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
    rooms: '<path d="M3 21h18"/><path d="M6 21V4h12v17"/><path d="M14.5 12.5h.01"/>',
    members: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 13.8c2.1.8 3.5 2.9 3.5 5.2"/>',
    reports: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
    logout: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z"/>',
    upload: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>',
};

const icon = (name: string, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;

const CSS = `
:root{--bg:#0d1220;--side:#111829;--surface:#161e31;--surface-2:#1c2640;--line:#26314d;--line-2:#33406a;--text:#e9edf7;--muted:#8d99b6;--faint:#5f6b89;
--primary:${WA_BLUE};--primary-2:#5b6dff;--primary-soft:rgba(65,86,246,.16);--danger:#e5484d;--danger-soft:rgba(229,72,77,.14);--ok:#2fb36f;--ok-soft:rgba(47,179,111,.14);
--radius:14px;--radius-sm:9px;--shadow:0 1px 0 rgba(255,255,255,.03) inset,0 10px 30px -12px rgba(0,0,0,.5)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--primary-2);text-decoration:none}a:hover{text-decoration:underline}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface-2);padding:1px 6px;border-radius:6px}
.i{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}

/* shell */
.app{display:grid;grid-template-columns:248px 1fr;min-height:100vh;background:linear-gradient(90deg,var(--side) 0 247px,var(--line) 247px 248px,transparent 248px)}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:18px;padding:20px 14px}
.brand{display:flex;align-items:center;gap:11px;padding:4px 8px;color:var(--text)}.brand:hover{text-decoration:none}
.mark{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--primary),#8b5cf6);font-weight:800;font-size:14px;letter-spacing:.5px;color:#fff;box-shadow:0 6px 18px -6px rgba(65,86,246,.8)}
.brand b{display:block;font-size:15px;line-height:1.15}.brand small{display:block;color:var(--muted);font-size:12px}
.nav{display:flex;flex-direction:column;gap:3px}
.nav a{display:flex;align-items:center;gap:11px;padding:9px 12px;border-radius:var(--radius-sm);color:var(--muted);font-weight:500}
.nav a:hover{background:var(--surface);color:var(--text);text-decoration:none}
.nav a.on{background:var(--primary-soft);color:#fff}.nav a.on .i{color:var(--primary-2)}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:10px}
.lang{display:flex;align-items:center;gap:8px;padding:0 8px;color:var(--muted);font-size:13px}
.seg{display:inline-flex;background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:2px}
.seg a{padding:2px 10px;border-radius:999px;color:var(--muted);font-size:12px;font-weight:600}.seg a:hover{text-decoration:none;color:var(--text)}
.seg a.on{background:var(--primary);color:#fff}
.me{display:flex;align-items:center;gap:10px;padding:10px;border-radius:var(--radius-sm);background:var(--surface);border:1px solid var(--line)}
.me .ini{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--surface-2);font-weight:700;font-size:13px}
.me .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.me a{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;color:var(--muted)}.me a:hover{background:var(--surface-2);color:var(--text)}
.main{min-width:0}
.wrap{max-width:1080px;margin:0 auto;padding:34px 28px 60px}
.tabbar{display:none}

/* page header */
.ph{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:6px}
.ph h1{margin:0;font-size:26px;line-height:1.2;letter-spacing:-.01em}
.meta{margin:4px 0 0;color:var(--muted);font-size:14px}
.lead{margin:8px 0 24px;color:var(--muted);max-width:760px}
.crumb{display:inline-flex;align-items:center;gap:4px;margin-bottom:14px;color:var(--muted);font-size:14px}.crumb:hover{color:var(--text);text-decoration:none}
h2{font-size:16px;margin:0 0 12px}
.hint{color:var(--muted);font-size:14px;margin:0 0 12px}

/* surfaces */
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow);margin-bottom:18px}
.card.danger{border-color:rgba(229,72,77,.35)}
.split{display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);gap:18px;align-items:start}
.split>.sticky{position:sticky;top:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
.empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:36px 16px;color:var(--muted);text-align:center}
.empty .i{width:34px;height:34px;color:var(--faint)}

/* flash messages */
.msg{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;margin-bottom:18px;border-radius:var(--radius-sm);background:var(--ok-soft);border:1px solid rgba(47,179,111,.35)}
.msg.err{background:var(--danger-soft);border-color:rgba(229,72,77,.4)}

/* chips */
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line);font-size:12.5px;line-height:1.6;white-space:nowrap}
.chip .dot{width:7px;height:7px;border-radius:50%;background:var(--muted)}
.chip.solid{border:0;color:#fff;font-weight:600}
.chip.warn{background:var(--danger-soft);border-color:rgba(229,72,77,.4);color:#ffb4b6}
.tagline{display:block;margin-top:4px;color:var(--faint);font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}

/* forms */
.field{margin-bottom:16px}
label,.label{display:block;margin:0 0 6px;color:var(--muted);font-size:13.5px;font-weight:500}
input[type=text],input[type=search],select,textarea{width:100%;padding:10px 12px;border-radius:var(--radius-sm);border:1px solid var(--line-2);background:var(--bg);color:var(--text);font:inherit;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-soft)}
textarea{resize:vertical}
input[type=file]{width:100%;color:var(--muted);font:inherit;font-size:14px}
input[type=file]::file-selector-button{margin-right:12px;padding:8px 14px;border-radius:var(--radius-sm);border:1px solid var(--line-2);background:var(--surface-2);color:var(--text);font:inherit;font-weight:600;cursor:pointer}
.checks{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.checks label{display:inline-flex;align-items:center;gap:8px;margin:0;padding:7px 12px;border-radius:999px;border:1px solid var(--line-2);background:var(--bg);color:var(--text);font-size:14px;cursor:pointer;user-select:none;transition:background .15s,border-color .15s}
.checks label:hover{border-color:var(--primary)}
.checks label:has(input:checked){background:var(--primary-soft);border-color:var(--primary)}
.checks input{accent-color:var(--primary);margin:0}
.checks .sub{color:var(--muted);font-size:14px}
.section-title{font-size:14px;font-weight:600;margin:4px 0 10px}

/* buttons */
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 16px;border-radius:var(--radius-sm);border:1px solid transparent;background:var(--primary);color:#fff;font:inherit;font-weight:600;font-size:14px;cursor:pointer;text-decoration:none;transition:background .15s,border-color .15s,transform .05s}
button:hover,.btn:hover{background:var(--primary-2);text-decoration:none}button:active,.btn:active{transform:translateY(1px)}
button.secondary,.btn.secondary{background:var(--surface-2);border-color:var(--line-2);color:var(--text)}button.secondary:hover,.btn.secondary:hover{border-color:var(--primary)}
button.danger,.btn.danger{background:var(--danger)}button.danger:hover,.btn.danger:hover{background:#f05a5f}
button.ghost{background:transparent;color:var(--muted);border-color:var(--line)}button.ghost:hover{color:#fff;border-color:var(--danger);background:var(--danger-soft)}
button.sm,.btn.sm{padding:6px 11px;font-size:13px}
button.icon-only{padding:7px}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.actions form{margin:0}
form.inline{display:inline}

/* sprites */
.sprite{width:64px;height:64px;flex:none;background-size:192px 256px;background-repeat:no-repeat;image-rendering:pixelated;animation:walk .6s steps(3) infinite}
.sprite.big{width:96px;height:96px;background-size:288px 384px;animation-name:walkbig}
@keyframes walk{from{background-position:0 0}to{background-position:-192px 0}}@keyframes walkbig{from{background-position:0 0}to{background-position:-288px 0}}
.dirs{display:flex;flex-wrap:wrap;gap:10px;justify-content:center}.dirs .sprite{border-radius:12px;background-color:var(--surface-2)}
.dirs .sprite.big:nth-child(2){animation-name:walkbig2}.dirs .sprite.big:nth-child(3){animation-name:walkbig3}.dirs .sprite.big:nth-child(4){animation-name:walkbig4}
@keyframes walkbig2{from{background-position:0 -96px}to{background-position:-288px -96px}}@keyframes walkbig3{from{background-position:0 -192px}to{background-position:-288px -192px}}@keyframes walkbig4{from{background-position:0 -288px}to{background-position:-288px -288px}}
.layers{position:relative;width:48px;height:48px;flex:none;border-radius:12px;background:var(--surface-2);overflow:hidden}
.layers div{position:absolute;inset:-8px;background-size:192px 256px;background-position:-64px 0;image-rendering:pixelated}

/* avatar cards */
.woka{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;padding:18px 16px;margin:0;color:var(--text);transition:border-color .15s,transform .15s}
a.woka:hover{border-color:var(--primary);text-decoration:none;transform:translateY(-2px)}
.woka .stage{display:grid;place-items:center;width:96px;height:96px;border-radius:16px;background:radial-gradient(circle at 50% 40%,var(--surface-2),var(--bg))}
.woka h3{margin:0;font-size:15px}.woka .part{color:var(--muted);font-size:13px}
.woka .chips{justify-content:center}
.drop{display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px 16px;border:1.5px dashed var(--line-2);border-radius:var(--radius);text-align:center;cursor:pointer;color:var(--muted);transition:border-color .15s,background .15s}
.drop .i{width:28px;height:28px;color:var(--primary-2)}.drop strong{color:var(--text)}
.drop:hover,.drop.over{border-color:var(--primary);background:var(--primary-soft)}
.upload-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px;align-items:start}
.upload-grid .dirs{justify-content:flex-start}
.dirs.preview{display:grid;grid-template-columns:repeat(2,96px);justify-content:center}

/* list rows (members, rooms, reports) */
.list{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;margin-bottom:18px}
.list-head,.row{display:grid;align-items:center;gap:14px;padding:12px 18px}
.list-head{color:var(--faint);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--line);background:rgba(255,255,255,.015)}
.row{border-top:1px solid var(--line)}.list-head+.row,.list>.row:first-child{border-top:0}
.row:hover{background:rgba(255,255,255,.015)}
.row.dim{opacity:.6}
.who{min-width:0;display:flex;align-items:center;gap:12px}
.who>div{min-width:0}.who strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.who .sub{display:block;color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cell-label{display:none}
.muted{color:var(--muted)}.small{font-size:13px}
.members .list-head,.members .row{grid-template-columns:minmax(0,2fr) minmax(0,1.6fr) 150px 236px}
.members .row .actions,.rooms .row .actions{justify-content:flex-end}
.rooms .list-head,.rooms .row{grid-template-columns:96px minmax(0,1.6fr) minmax(0,1.6fr) 130px}
.thumb{width:96px;height:60px;border-radius:10px;object-fit:cover;image-rendering:pixelated;background:var(--surface-2);display:block}
.reports .row{grid-template-columns:170px minmax(0,1fr) 48px;align-items:start}
.report-who{font-size:14px}.comment{margin:4px 0 0;white-space:pre-wrap;word-break:break-word}
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:14px}
.search{position:relative;flex:1;max-width:340px}.search .i{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--faint)}
.search input{padding-left:38px}

/* centered pages (login messages) */
.center{min-height:100vh;display:grid;place-items:center;padding:24px}
.center .card{max-width:440px;width:100%;text-align:center;padding:32px 28px}
.center .mark{margin:0 auto 14px;width:48px;height:48px;font-size:17px;border-radius:14px}
.center h1{margin:0 0 8px;font-size:22px}.center p{color:var(--muted);margin:0 0 20px}
.center .actions{justify-content:center}
.center .lang{justify-content:center;margin-top:22px;padding:0}

/* phones and small tablets */
@media (max-width:860px){
  .app{display:block;background:none}
  .side{position:sticky;z-index:20;height:auto;flex-direction:row;align-items:center;gap:10px;padding:10px 14px;border-right:0;border-bottom:1px solid var(--line);background:rgba(17,24,41,.92);backdrop-filter:blur(10px)}
  .side .nav{display:none}
  .brand small{display:none}.mark{width:32px;height:32px;font-size:13px}
  .side-foot{margin:0 0 0 auto;flex-direction:row;align-items:center;gap:8px}
  .lang{padding:0}.lang .i,.lang .lbl{display:none}
  .me{padding:0;background:none;border:0}.me .ini,.me .name{display:none}
  .wrap{padding:20px 16px 96px}
  .ph h1{font-size:22px}
  .tabbar{display:grid;grid-template-columns:repeat(4,1fr);position:fixed;z-index:20;left:0;right:0;bottom:0;padding:6px 6px calc(6px + env(safe-area-inset-bottom));background:rgba(17,24,41,.96);backdrop-filter:blur(10px);border-top:1px solid var(--line)}
  .tabbar a{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 2px;border-radius:10px;color:var(--muted);font-size:11.5px;font-weight:500}
  .tabbar a:hover{text-decoration:none}.tabbar a.on{color:#fff}.tabbar a.on .i{color:var(--primary-2)}
  .tabbar .i{width:22px;height:22px}
  .split,.upload-grid{grid-template-columns:1fr}.split>.sticky{position:static}
  .list-head{display:none}
  .members .row,.rooms .row,.reports .row{grid-template-columns:1fr;gap:10px;padding:14px 16px}
  .members .row .actions,.rooms .row .actions{justify-content:flex-start}
  .reports .row{grid-template-columns:minmax(0,1fr) 40px}.reports .row>:nth-child(2){grid-column:1/-1;grid-row:2}
  .cell-label{display:block;color:var(--faint);font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px}
  .rooms .row{grid-template-columns:84px minmax(0,1fr)}.rooms .row>.span{grid-column:1/-1}
  .thumb{width:84px;height:54px}
  .toolbar .search{max-width:none}
  .card{padding:16px}
}
`;

function langSwitch(c: Ctx): string {
    const back = encodeURIComponent(c.path);
    return `<div class="lang">${icon("globe")}<span class="lbl">${c.a.language}</span><span class="seg">${(["de", "en"] as const)
        .map((l) => `<a href="/lang?to=${l}&amp;back=${back}" class="${c.lang === l ? "on" : ""}" hreflang="${l}">${l.toUpperCase()}</a>`)
        .join("")}</span></div>`;
}

const NAV = ["wokas", "rooms", "members", "reports"] as const;

function layout(c: Ctx, title: string, active: string, body: string): string {
    const s = c.s;
    const head = `<!doctype html><html lang="${c.a.htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111829"><title>${esc(title)} · WorkAdventure Admin</title><style>${CSS}</style></head>`;
    if (!s) {
        return `${head}<body><div class="center">${body}</div></body></html>`;
    }
    const links = () =>
        NAV.map((key) => `<a href="/${key}" class="${active === key ? "on" : ""}"${active === key ? ' aria-current="page"' : ""}>${icon(key)}<span>${c.a.nav[key]}</span></a>`).join("");
    return `${head}<body><div class="app">
<aside class="side">
<a class="brand" href="/"><span class="mark">WA</span><span><b>WorkAdventure</b><small>Admin</small></span></a>
<nav class="nav">${links()}</nav>
<div class="side-foot">${langSwitch(c)}
<div class="me"><span class="ini">${esc((s.name || "?").charAt(0).toUpperCase())}</span><span class="name">${esc(s.name)}</span><a href="/logout" title="${c.a.logout}" aria-label="${c.a.logout}">${icon("logout")}</a></div></div>
</aside>
<main class="main"><div class="wrap">${body}</div></main>
<nav class="tabbar">${links()}</nav>
</div></body></html>`;
}

/** Centered card for pages without a session (login problems, logout). */
function messagePage(c: Ctx, title: string, text: string, links: [string, string, string?][] = []): string {
    return layout(c, title, "", `<div class="card"><span class="mark">WA</span><h1>${esc(title)}</h1><p>${esc(text)}</p>
<div class="actions">${links.map(([href, label, cls]) => `<a class="btn ${cls ?? ""}" href="${esc(href)}">${esc(label)}</a>`).join("")}</div>${langSwitch(c)}</div>`);
}

const flash = (message?: string, error = false) => (message ? `<div class="msg${error ? " err" : ""}" role="status">${esc(message)}</div>` : "");

function pageHead(title: string, meta?: string, lead?: string, actions = ""): string {
    return `<header class="ph"><div><h1>${esc(title)}</h1>${meta ? `<p class="meta">${esc(meta)}</p>` : ""}</div>${actions}</header>${lead ? `<p class="lead">${esc(lead)}</p>` : '<div style="height:18px"></div>'}`;
}

function fmtDate(iso: string | null | undefined, a: AdminTexts): string {
    if (!iso) return "–";
    const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso.replace(" ", "T") + "Z");
    if (Number.isNaN(d.getTime())) return iso;
    try {
        return d.toLocaleString(a.locale, { dateStyle: "medium", timeStyle: "short", timeZone: config.timeZone });
    } catch {
        return d.toLocaleString(a.locale, { dateStyle: "medium", timeStyle: "short" });
    }
}

function roleChip(tag: string, lang: Lang): string {
    const st = roleStyle(tag, lang);
    return `<span class="chip"><span class="dot" style="background:${st.color}"></span>${esc(st.label)}</span>`;
}

function accessSummary(w: CustomWoka, c: Ctx): string {
    if (w.access.everyone) return `<span class="chip">${c.a.everyone}</span>`;
    const parts = [...(w.access.tags ?? []).map((tag) => roleChip(tag, c.lang)), ...(w.access.users ?? []).map((u) => `<span class="chip">👤 ${esc(nameOf(u))}</span>`)];
    return parts.length ? parts.join("") : `<span class="chip">${c.a.nobody}</span>`;
}

function nameOf(identifier: string): string {
    const u = users.get(identifier);
    return u?.username ?? u?.name ?? identifier;
}

function knownTags(): string[] {
    return [...new Set([...config.knownTags, ...users.allTags()])].sort();
}

// ---------- shared access form ----------

const realUsers = () => listUsers().filter((u) => !u.identifier.match(/^[0-9a-f-]{36}$/));

// In the players' profile page other members' emails must not end up in the HTML, so ids are replaced by opaque tokens there.
function accessFields(access: Access, options: { everyoneLabel?: string; exclude?: string; opaque?: boolean; lang?: Lang } = {}): string {
    const lang = options.lang ?? "de";
    const text = t(lang);
    const idValue = (identifier: string) => (options.opaque ? cardToken(identifier) : identifier);
    const tagChecks = knownTags()
        .map((t) => `<label><input type="checkbox" name="tags" value="${esc(t)}"${access.tags?.includes(t) ? " checked" : ""}> ${esc(roleStyle(t, lang).label)}</label>`)
        .join("");
    const allowed = new Set((access.users ?? []).map((u) => u.toLowerCase()));
    const known = realUsers().filter((u) => u.identifier.toLowerCase() !== options.exclude?.toLowerCase());
    const userChecks = known
        .map((u) => `<label><input type="checkbox" name="users" value="${esc(idValue(u.identifier))}"${allowed.has(u.identifier.toLowerCase()) ? " checked" : ""}> ${esc(u.username ?? u.name ?? u.identifier)}</label>`)
        .join("");
    const extra = (access.users ?? []).filter((u) => !known.some((k) => k.identifier.toLowerCase() === u.toLowerCase()) && u.toLowerCase() !== options.exclude?.toLowerCase());
    return `<div class="checks"><label><input type="checkbox" name="everyone" value="1"${access.everyone ? " checked" : ""}> ${esc(options.everyoneLabel ?? text.everyone)}</label></div>
<label>${text.roles}</label><div class="checks">${tagChecks}</div>
<label>${text.people}</label><div class="checks">${userChecks || `<span class="sub">${text.nobodyYet}</span>`}</div>
<label for="more">${text.morePeople}</label><textarea id="more" name="more" rows="2">${esc(extra.join("\n"))}</textarea>`;
}

function accessFromForm(form: URLSearchParams, opaque = false): Access {
    const extra = (form.get("more") ?? "").split(/[\s,;]+/).map((v) => v.trim()).filter((v) => v.includes("@"));
    const checked = form.getAll("users").map((v) => (opaque ? identifierFromCardToken(v) : v)).filter((v): v is string => !!v);
    return {
        everyone: form.get("everyone") === "1",
        tags: form.getAll("tags").filter((t) => t !== ""),
        users: [...new Set([...checked, ...extra])],
    };
}

function accessText(access: Access, c: Ctx, owner?: string | null): string {
    const parts: string[] = [];
    if (owner) parts.push(`<span class="chip">🏠 ${esc(nameOf(owner))}</span>`);
    if (access.everyone) return parts.join("") + `<span class="chip">${c.a.everyone}</span>`;
    for (const tag of access.tags ?? []) parts.push(roleChip(tag, c.lang));
    for (const u of access.users ?? []) parts.push(`<span class="chip">👤 ${esc(nameOf(u))}</span>`);
    return parts.length ? parts.join("") : `<span class="chip">${c.a.adminsOnly}</span>`;
}

const csrfInput = (s: Session) => `<input type="hidden" name="csrf" value="${esc(csrfFor(s))}">`;

// ---------- pages ----------

function wokasPage(c: Ctx, message?: string): string {
    const s = c.s!;
    const a = c.a;
    const wokas = listCustomWokas();
    const cards = wokas.length
        ? `<div class="grid">${wokas
              .map(
                  (w) => `<a class="card woka" href="/wokas/${encodeURIComponent(w.id)}"><span class="stage"><span class="sprite" style="background-image:url('${esc(w.url)}')"></span></span>
<div><h3>${esc(w.name)}</h3><div class="part">${esc(a.parts[w.part] ?? w.part)}</div></div><div class="chips">${accessSummary(w, c)}</div></a>`,
              )
              .join("")}</div>`
        : `<div class="card empty">${icon("wokas")}<span>${a.wokasNone}</span></div>`;
    const partOptions = WOKA_PARTS.map((p) => `<option value="${p}">${esc(a.parts[p] ?? p)}</option>`).join("");
    return layout(c, a.wokasTitle, "wokas", `${flash(message)}
${pageHead(a.wokasTitle, a.wokasCount(wokas.length), a.wokasSub)}
<div class="card"><h2>${a.uploadTitle}</h2>
<form id="upload">${csrfInput(s)}<div class="upload-grid">
<div><label for="file" class="drop" id="drop">${icon("upload")}<strong>${a.dropHint}</strong><span class="small">${a.dropSize}</span><input id="file" type="file" accept="image/png" hidden></label>
<div id="preview" class="dirs" style="margin-top:12px"></div></div>
<div><div class="field"><label for="name">${a.name}</label><input id="name" type="text" maxlength="40" required></div>
<div class="field"><label for="part">${a.type}</label><select id="part">${partOptions}</select></div>
<div id="error" class="msg err" style="display:none"></div>
<button type="submit">${icon("upload")}${a.upload}</button></div>
</div></form></div>
${cards}
<script>
const csrf=${JSON.stringify(csrfFor(s))},T=${JSON.stringify({ chooseFirst: a.chooseFirst, failed: a.uploadFailed })};
const file=document.getElementById("file"),drop=document.getElementById("drop"),preview=document.getElementById("preview"),err=document.getElementById("error");
let chosen=null;
function show(f){chosen=f;const url=URL.createObjectURL(f);preview.innerHTML=[0,1,2,3].map(()=>'<div class="sprite big" style="background-image:url('+url+')"></div>').join("");
 const n=document.getElementById("name");if(!n.value)n.value=f.name.replace(/\\.png$/i,"");}
file.addEventListener("change",()=>file.files[0]&&show(file.files[0]));
["dragenter","dragover"].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();drop.classList.add("over")}));
["dragleave","drop"].forEach(t=>drop.addEventListener(t,()=>drop.classList.remove("over")));
drop.addEventListener("drop",e=>{e.preventDefault();e.dataTransfer.files[0]&&show(e.dataTransfer.files[0])});
document.getElementById("upload").addEventListener("submit",async e=>{e.preventDefault();err.style.display="none";
 if(!chosen){err.textContent=T.chooseFirst;err.style.display="flex";return}
 const r=await fetch("/wokas",{method:"POST",body:chosen,headers:{"Content-Type":"image/png","X-CSRF":csrf,"X-Woka-Name":encodeURIComponent(document.getElementById("name").value),"X-Woka-Part":document.getElementById("part").value}});
 const d=await r.json().catch(()=>({}));if(!r.ok){err.textContent=d.error||T.failed;err.style.display="flex";return}
 location.href="/wokas/"+encodeURIComponent(d.id)+"?neu=1";});
</script>`);
}

function wokaEditPage(c: Ctx, w: CustomWoka, message?: string): string {
    const s = c.s!;
    const a = c.a;
    const text = t(c.lang);
    const partOptions = WOKA_PARTS.map((p) => `<option value="${p}"${p === w.part ? " selected" : ""}>${esc(a.parts[p] ?? p)}</option>`).join("");
    return layout(c, w.name, "wokas", `${flash(message)}
<a class="crumb" href="/wokas">${icon("back")}${a.allAvatars}</a>
${pageHead(w.name, a.parts[w.part] ?? w.part)}
<div class="split">
<div class="sticky"><div class="card"><h2>${a.preview}</h2><div class="dirs preview">${[0, 1, 2, 3].map(() => `<div class="sprite big" style="background-image:url('${esc(w.url)}')"></div>`).join("")}</div></div>
<div class="card"><h2>${a.replaceImage}</h2><input id="file" type="file" accept="image/png"><div id="error" class="msg err" style="display:none;margin-top:12px"></div>
<button id="replace" class="secondary" type="button" style="margin-top:12px">${icon("upload")}${a.uploadNewImage}</button></div></div>
<div>
<form method="post" action="/wokas/${encodeURIComponent(w.id)}" class="card">${csrfInput(s)}
<div class="field"><label for="name">${a.name}</label><input id="name" name="name" type="text" maxlength="40" value="${esc(w.name)}" required></div>
<div class="field"><label for="part">${a.type}</label><select id="part" name="part">${partOptions}</select></div>
<h2 style="margin-top:22px">${a.whoMayUse}</h2>
${accessFields(w.access, { everyoneLabel: text.everyone, lang: c.lang })}
<div style="margin-top:16px"><button type="submit">${a.save}</button></div>
</form>
<form method="post" action="/wokas/${encodeURIComponent(w.id)}/delete" class="card danger" onsubmit="return confirm(${esc(JSON.stringify(a.confirmDeleteAvatar))})">${csrfInput(s)}
<h2>${a.deleteAvatar}</h2><p class="hint">${a.deleteAvatarHint}</p><button class="danger" type="submit">${icon("trash")}${a.deleteAvatar}</button></form>
</div></div>
<script>
document.getElementById("replace").addEventListener("click",async()=>{const f=document.getElementById("file").files[0],err=document.getElementById("error");
 if(!f){err.textContent=${JSON.stringify(a.chooseFirst)};err.style.display="flex";return}
 const r=await fetch(location.pathname+"/image",{method:"POST",body:f,headers:{"Content-Type":"image/png","X-CSRF":${JSON.stringify(csrfFor(s))}}});
 const d=await r.json().catch(()=>({}));if(!r.ok){err.textContent=d.error||${JSON.stringify(a.uploadFailed)};err.style.display="flex";return}location.reload();});
</script>`);
}

async function roomsPage(c: Ctx, message?: string): Promise<string> {
    const a = c.a;
    let list: Awaited<ReturnType<typeof listRooms>> = [];
    let error = "";
    try {
        list = await listRooms();
    } catch {
        error = a.storageDown;
    }
    const settings = new Map(rooms.all().map((r) => [r.path, r]));
    const templates = new Map((await roomStyles(list).catch(() => [])).map((st) => [st.path, st.key]));
    const rows = list
        .map((room) => {
            const path = room.roomUrl.replace(/^\/~\//, "");
            const st = settings.get(path);
            const access = templates.has(path)
                ? `<span class="chip">${a.template} · ${esc(styleLabel(templates.get(path)!, c.lang))}</span>`
                : (st?.hidden ? `<span class="chip warn">${a.hidden}</span>` : "") + (st ? accessText(st.access, c, st.owner) : `<span class="chip">${a.everyone}</span>`);
            const thumb = room.thumbnail ? `<img class="thumb" src="${esc(room.thumbnail)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="thumb"></span>`;
            return `<div class="row">${thumb}<div class="who"><div><strong>${esc(st?.name || room.name)}</strong><span class="sub">${esc(path)}</span></div></div>
<div class="span"><span class="cell-label">${a.colAccess}</span><div class="chips">${access}</div></div>
<div class="span actions"><a class="btn secondary sm" href="/rooms/edit?path=${encodeURIComponent(path)}">${icon("edit")}${a.edit}</a></div></div>`;
        })
        .join("");
    const personal = rooms.all().filter((r) => r.owner).length;
    return layout(c, a.roomsTitle, "rooms", `${flash(message)}${flash(error, true)}
${pageHead(a.roomsTitle, a.roomsCount(list.length, personal), a.roomsSub)}
<div class="list rooms"><div class="list-head"><span></span><span>${a.colRoom}</span><span>${a.colAccess}</span><span></span></div>
${rows || `<div class="empty">${icon("rooms")}<span>${a.roomsNone}</span></div>`}</div>
<p class="hint">${personalRoomsEnabled() ? esc(a.personalOn(config.personalRoomTemplate!)) : esc(a.personalOff)}</p>`);
}

function roomEditPage(c: Ctx, path: string, current: RoomSettings | undefined, mapName: string, message?: string): string {
    const s = c.s!;
    const a = c.a;
    const st: RoomSettings = current ?? { path, name: null, description: null, access: { everyone: true }, hidden: false, owner: null };
    return layout(c, st.name || mapName, "rooms", `${flash(message)}
<a class="crumb" href="/rooms">${icon("back")}${a.allRooms}</a>
${pageHead(st.name || mapName, path + (st.owner ? ` · ${a.roomOf(nameOf(st.owner))}` : ""))}
<form method="post" action="/rooms/edit?path=${encodeURIComponent(path)}" class="card">${csrfInput(s)}
<div class="field"><label for="name">${a.listName}</label><input id="name" name="name" type="text" maxlength="60" value="${esc(st.name ?? "")}" placeholder="${esc(mapName)}"></div>
<div class="field"><label for="description">${a.description}</label><input id="description" name="description" type="text" maxlength="200" value="${esc(st.description ?? "")}"></div>
<h2 style="margin-top:22px">${a.colAccess}</h2>
${accessFields(st.access, { exclude: st.owner ?? undefined, lang: c.lang })}
<div class="checks" style="margin-top:16px"><label><input type="checkbox" name="hidden" value="1"${st.hidden ? " checked" : ""}> ${a.hideInList}</label></div>
<button type="submit">${a.save}</button></form>
${
    st.owner
        ? `<form method="post" action="/rooms/delete?path=${encodeURIComponent(path)}" class="card danger" onsubmit="return confirm(${esc(JSON.stringify(a.confirmDeleteRoom))})">${csrfInput(s)}
<h2>${a.deleteRoom}</h2><p class="hint">${a.deleteRoomHint}</p><button class="danger" type="submit">${icon("trash")}${a.deleteRoom}</button></form>`
        : ""
}`);
}

function layerUrl(url: string): string {
    if (/^https?:\/\//.test(url)) return url;
    return config.playUrl ? `${config.playUrl}/${encodeURI(url)}` : url;
}

function membersPage(c: Ctx, message?: string): string {
    const s = c.s!;
    const a = c.a;
    const list = realUsers();
    let bannedCount = 0;
    const rows = list
        .map((u) => {
            const details = u.textures ? wokaDetails(u.identifier, u.tags, u.textures) : [];
            const avatar = `<div class="layers">${details.map((d) => `<div style="background-image:url('${esc(layerUrl(d))}')"></div>`).join("")}</div>`;
            const own = personalTag(u.username);
            const ban = bans.get(u.identifier);
            if (ban) bannedCount++;
            const self = u.identifier.toLowerCase() === s.sub.toLowerCase();
            const name = u.username ?? u.name ?? "–";
            const roles = [...u.tags]
                .sort((x, y) => roleStyle(x).order - roleStyle(y).order)
                .map((tag) => roleChip(tag, c.lang))
                .join("");
            const banForm = ban
                ? `<form method="post" action="/members/unban">${csrfInput(s)}<input type="hidden" name="id" value="${esc(u.identifier)}"><button class="secondary sm">${icon("unlock")}${a.unban}</button></form>`
                : self
                  ? ""
                  : `<form method="post" action="/members/ban" onsubmit="const r=prompt(${esc(JSON.stringify(a.banReason))});if(r===null)return false;this.reason.value=r;return true;">${csrfInput(s)}<input type="hidden" name="id" value="${esc(u.identifier)}"><input type="hidden" name="reason"><button class="ghost sm">${icon("ban")}${a.ban}</button></form>`;
            const removeForm = self
                ? ""
                : `<form method="post" action="/members/delete" onsubmit="return confirm(${esc(JSON.stringify(a.confirmRemove(name)))});">${csrfInput(s)}<input type="hidden" name="id" value="${esc(u.identifier)}"><button class="ghost sm" title="${a.remove}">${icon("trash")}${a.remove}</button></form>`;
            const search = `${name} ${u.email ?? u.identifier} ${u.tags.join(" ")} ${own ?? ""}`.toLowerCase();
            return `<div class="row${ban ? " dim" : ""}" data-search="${esc(search)}">
<div class="who">${avatar}<div><strong>${esc(name)}${self ? ` <span class="muted small">(${a.you})</span>` : ""}</strong><span class="sub">${esc(u.email ?? u.identifier)}</span>${
                ban ? `<span class="chip warn" style="margin-top:4px">${a.banned}${ban.reason ? `: ${esc(ban.reason)}` : ""}</span>` : ""
            }</div></div>
<div><span class="cell-label">${a.roles}</span><div class="chips">${roles || `<span class="muted small">–</span>`}</div>${own ? `<span class="tagline" title="${a.personalTagTitle}">${esc(own)}</span>` : ""}</div>
<div class="small muted"><span class="cell-label">${a.lastSeen}</span>${esc(fmtDate(u.lastSeen, a))}</div>
<div class="actions">${banForm}${removeForm}</div></div>`;
        })
        .join("");
    return layout(c, a.membersTitle, "members", `${flash(message)}
${pageHead(a.membersTitle, a.membersCount(list.length, bannedCount), a.membersSub)}
${list.length > 5 ? `<div class="toolbar"><div class="search">${icon("search")}<input type="search" id="q" placeholder="${a.search}" aria-label="${a.search}"></div></div>` : ""}
<div class="list members"><div class="list-head"><span>${a.nav.members}</span><span>${a.roles}</span><span>${a.lastSeen}</span><span></span></div>
${rows || `<div class="empty">${icon("members")}<span>${a.membersNone}</span></div>`}</div>
<script>const q=document.getElementById("q");q&&q.addEventListener("input",()=>{const v=q.value.trim().toLowerCase();document.querySelectorAll(".members .row").forEach(r=>{r.style.display=!v||r.dataset.search.includes(v)?"":"none"})});</script>`);
}

function wokaDetails(identifier: string, tags: string[], ids: string[]): string[] {
    const list = wokaListFor({ identifier, tags });
    const urls: string[] = [];
    for (const part of WOKA_PARTS) {
        for (const col of list[part]?.collections ?? []) for (const tex of col.textures) if (ids.includes(tex.id)) urls.push(tex.url);
    }
    return urls;
}

// WorkAdventure prefixes the comment with "-- Date: … -- -- Reporter: … -- -- Reported: … --".
function reportText(comment: string): string {
    return comment.replace(/^\s*--\s*Date:.*?--\s*--\s*Reporter:.*?--\s*--\s*Reported:.*?--\s*/s, "").trim() || comment;
}

function reportsPage(c: Ctx, message?: string): string {
    const s = c.s!;
    const a = c.a;
    const list = listReports();
    const rows = list
        .map(
            (r) => `<div class="row report"><div class="small muted">${esc(fmtDate(r.createdAt, a))}</div>
<div><div class="report-who"><span class="muted">${a.reportFrom}</span> <strong>${esc(nameOf(r.reporter))}</strong> · <span class="muted">${a.reportAbout}</span> <strong>${esc(nameOf(r.reported))}</strong></div><p class="comment">${esc(reportText(r.comment))}</p></div>
<form method="post" action="/reports/${r.id}/delete">${csrfInput(s)}<button class="ghost sm icon-only" title="${a.deleteReport}" aria-label="${a.deleteReport}">${icon("x")}</button></form></div>`,
        )
        .join("");
    const clearAll =
        list.length > 1
            ? `<form method="post" action="/reports/delete" onsubmit="return confirm(${esc(JSON.stringify(a.confirmDeleteAll))})">${csrfInput(s)}<button class="ghost sm" type="submit">${icon("trash")}${a.deleteAll}</button></form>`
            : "";
    return layout(c, a.reportsTitle, "reports", `${flash(message)}
${pageHead(a.reportsTitle, a.reportsCount(list.length), a.reportsSub, clearAll)}
<div class="list reports">${rows || `<div class="empty">${icon("reports")}<span>${a.reportsNone}</span></div>`}</div>`);
}

// ---------- visit card (public, shown inside WorkAdventure) ----------

function roleBadges(tags: string[], lang: Lang): string {
    const roles = [...tags]
        .filter((tag) => !tag.startsWith("@"))
        .sort((a, b) => roleStyle(a).order - roleStyle(b).order)
        .map((tag) => {
            const s = roleStyle(tag, lang);
            return `<span class="role" style="background:${s.color}">${esc(s.label)}</span>`;
        })
        .join("");
    return roles || `<span class="role" style="background:#6b6385">${t(lang).guest}</span>`;
}

const CARD_CSS = `
html,body{margin:0;background:${WA_CONTRAST};color:#fff;font:14px/1.4 "Roboto",ui-sans-serif,system-ui,sans-serif}
.card{display:flex;gap:14px;align-items:center;padding:12px}
.avatar{position:relative;width:64px;height:64px;flex:none;border-radius:8px;background:rgba(255,255,255,.08)}
.avatar div{position:absolute;inset:0;background-size:192px 256px;background-position:-64px 0;image-rendering:pixelated}
h1{margin:0 0 6px;font-size:17px;font-weight:700}.roles{display:flex;flex-wrap:wrap;gap:4px}
.role{color:#fff;font-size:11px;font-weight:500;padding:1px 6px;border-radius:2px;line-height:1.6}
small{display:block;margin-top:8px;color:rgba(255,255,255,.6)}`;

function cardMarkup(user: NonNullable<ReturnType<typeof users.get>>, lang: Lang): string {
    const text = t(lang);
    const layers = user.textures ? wokaDetails(user.identifier, user.tags, user.textures) : [];
    const since = user.firstSeen ? new Date(user.firstSeen).toLocaleDateString(text.locale, { month: "long", year: "numeric" }) : "";
    return `<div class="card" id="card">
<div class="avatar">${layers.map((u) => `<div style="background-image:url('${esc(layerUrl(u))}')"></div>`).join("")}</div>
<div><h1>${esc(user.username ?? user.name ?? text.unknown)}</h1><div class="roles">${roleBadges(user.tags, lang)}</div>
${since ? `<small>${esc(text.memberSince(since))}</small>` : ""}</div></div>`;
}

function cardPage(identifier: string, lang: Lang): string | undefined {
    const user = users.get(identifier);
    if (!user) return undefined;
    return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CARD_CSS}</style></head><body>${cardMarkup(user, lang)}
<script>parent.postMessage({type:"cvIframeSize",data:{w:document.body.scrollWidth,h:document.getElementById("card").offsetHeight+4}},"*");</script>
</body></html>`;
}

/** "Profil" tab in the WorkAdventure menu (OPENID_PROFILE_SCREEN_PROVIDER): own visit card and personal room. */
async function profilePage(accessToken: string | null, browserLang: Lang, message?: (text: ReturnType<typeof t>) => string): Promise<string> {
    const identity = await identityFromAccessToken(accessToken ?? undefined);
    const identifier = identity?.email;
    const user = identifier ? users.get(identifier) : undefined;
    // The game language of the last room visit wins over the browser language.
    const lang: Lang = user?.locale === "de" || user?.locale === "en" ? user.locale : browserLang;
    const text = t(lang);
    let body: string;
    if (!identity || !identifier) {
        body = `<p class="hint">${text.sessionExpired}</p>`;
    } else if (!user) {
        body = `<p class="hint">${text.enterRoomFirst}</p>`;
    } else {
        const viewer = { identifier, tags: identity.tags };
        const layers = user.textures ? wokaDetails(user.identifier, identity.tags, user.textures) : [];
        const tag = personalTag(user.username ?? identity.username);
        body = `${message ? `<p class="msg">${esc(message(text))}</p>` : ""}<h2>${text.yourCard}</h2><p class="hint">${text.yourCardHint}</p>
<div class="frame">${cardMarkup({ ...user, tags: identity.tags }, lang)}</div>
<h2>${text.yourAvatar}</h2><div class="dirs">${[0, 1, 2, 3]
            .map((dir) => `<div class="walk d${dir}">${layers.map((u) => `<div style="background-image:url('${esc(layerUrl(u))}')"></div>`).join("")}</div>`)
            .join("")}</div>
<p class="hint">${text.avatarHint}</p>
${tag ? `<h2>${text.yourTag}</h2><p class="hint"><code>${esc(tag)}</code> – ${text.yourTagHint}</p>` : ""}
${await personalRoomSection(viewer, accessToken!, lang, await roomStyles())}`;
    }
    return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CARD_CSS}
body{padding:16px 20px}code{background:rgba(255,255,255,.12);padding:1px 6px;border-radius:4px}h2{font-size:15px;margin:18px 0 4px}.hint{color:rgba(255,255,255,.65);margin:0 0 10px}
.frame{display:inline-block;background:rgba(0,0,0,.25);border-radius:8px;max-width:100%}
.dirs{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px}.walk{position:relative;width:96px;height:96px;border-radius:8px;background:rgba(255,255,255,.08)}
.walk div{position:absolute;inset:0;background-size:288px 384px;image-rendering:pixelated;animation:w .6s steps(3) infinite}
.d1 div{animation-name:w1}.d2 div{animation-name:w2}.d3 div{animation-name:w3}
@keyframes w{from{background-position:0 0}to{background-position:-288px 0}}@keyframes w1{from{background-position:0 -96px}to{background-position:-288px -96px}}
@keyframes w2{from{background-position:0 -192px}to{background-position:-288px -192px}}@keyframes w3{from{background-position:0 -288px}to{background-position:-288px -288px}}
.box{background:rgba(0,0,0,.25);border-radius:8px;padding:12px 14px;max-width:560px}
.btn{display:inline-block;margin-top:10px;padding:7px 14px;background:${WA_BLUE};color:#fff;border:0;border-radius:6px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn.secondary{background:rgba(255,255,255,.12)}
label{display:block;margin:10px 0 4px;color:rgba(255,255,255,.7)}input[type=text],textarea{width:100%;box-sizing:border-box;padding:7px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.25);color:#fff;font:inherit}
.checks{display:flex;flex-wrap:wrap;gap:4px 14px}.checks label{display:flex;gap:6px;align-items:center;margin:0;color:#fff}
.msg{background:rgba(47,179,111,.2);border-left:3px solid #2fb36f;padding:8px 12px;border-radius:4px}.sub{color:rgba(255,255,255,.5)}
.styles{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin:8px 0}
.style{display:block;margin:0;cursor:pointer}.style input{position:absolute;opacity:0}
.style span{display:block;border:2px solid transparent;border-radius:8px;overflow:hidden;background:rgba(0,0,0,.25)}
.style img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;image-rendering:pixelated;background:rgba(255,255,255,.06)}
.style b{display:block;padding:4px 8px;font-weight:500;color:#fff}.style small{color:rgba(255,255,255,.55);margin:0;display:inline}
.style input:checked+span{border-color:${WA_BLUE}}.style input:focus-visible+span{outline:2px solid #fff}
details{margin-top:14px}summary{cursor:pointer;color:rgba(255,255,255,.8)}
.confirm{display:flex!important;gap:8px;align-items:center;color:#fff!important}
</style></head><body>${body}</body></html>`;
}

function stylePicker(styles: RoomStyle[], lang: Lang, selected: string | null | undefined, current?: string | null): string {
    if (styles.length < 2) return "";
    const chosen = styles.some((s) => s.key === selected) ? selected : styles[0]!.key;
    return `<div class="styles">${styles
        .map(
            (s) => `<label class="style"><input type="radio" name="style" value="${esc(s.key)}"${s.key === chosen ? " checked" : ""}><span>${
                s.thumbnail ? `<img src="${esc(s.thumbnail)}" alt="">` : ""
            }<b>${esc(styleLabel(s.key, lang))}${s.key === current ? ` <small>(${t(lang).currentStyle})</small>` : ""}</b></span></label>`,
        )
        .join("")}</div>`;
}

async function personalRoomSection(viewer: { identifier: string; tags: string[] }, accessToken: string, lang: Lang, styles: RoomStyle[]): Promise<string> {
    if (!personalRoomsEnabled()) return "";
    const text = t(lang);
    const room = rooms.byOwner(viewer.identifier);
    const token = `<input type="hidden" name="accessToken" value="${esc(accessToken)}">`;
    if (!room) {
        if (!mayCreatePersonalRoom(viewer)) return "";
        return `<h2>${text.yourRoom}</h2><div class="box"><p class="hint" style="margin:0">${text.roomIntro}</p>
<form method="post" action="/profile/room">${token}${styles.length > 1 ? `<p class="hint" style="margin:10px 0 0">${text.chooseStyle}</p>` : ""}${stylePicker(styles, lang, null)}<button class="btn" type="submit">${text.createRoom}</button></form></div>`;
    }
    if (!(await roomMapExists(room))) {
        return `<h2>${text.yourRoom}</h2><div class="box"><p class="hint" style="margin:0">${text.roomMissing}</p>
<form method="post" action="/profile/room/style">${token}<input type="hidden" name="confirm" value="1">${stylePicker(styles, lang, room.style ?? "holz")}
<button class="btn" type="submit">${text.restoreRoom}</button></form></div>`;
    }
    const enter = config.playUrl ? `${config.playUrl}/~/${room.path.split("/").map(encodeURIComponent).join("/")}` : `/~/${room.path}`;
    return `<h2>${text.yourRoom}</h2><div class="box">
<a class="btn" href="${esc(enter)}" target="_top">${text.enterRoom}</a>
<p class="hint" style="margin-top:10px">${text.roomEditHint}</p>
<form method="post" action="/profile/room/settings">${token}
<label for="name">${text.name}</label><input id="name" name="name" type="text" maxlength="60" value="${esc(room.name ?? "")}">
<label>${text.whoMayEnter}</label>
${accessFields(room.access, { exclude: viewer.identifier, opaque: true, lang })}
<button class="btn" type="submit">${text.save}</button></form>
${
    styles.length > 1
        ? `<details><summary>${text.changeStyle}</summary><form method="post" action="/profile/room/style">${token}
<p class="hint" style="margin:8px 0 0">${text.changeStyleHint}</p>${stylePicker(styles, lang, styles.find((s) => s.key !== (room.style ?? "holz"))?.key, room.style ?? "holz")}
<label class="confirm"><input type="checkbox" name="confirm" value="1" required> ${text.changeStyleConfirm}</label>
<button class="btn secondary" type="submit">${text.changeStyle}</button></form></details>`
        : ""
}</div>`;
}

// ---------- login ----------

async function startLogin(res: ServerResponse, c: Ctx): Promise<void> {
    const endpoints = await oidcEndpoints();
    if (!endpoints?.authorization_endpoint) return html(res, 503, messagePage(c, c.a.loginUnavailableTitle, c.a.loginUnavailable));
    const state = b64(randomBytes(16));
    const verifier = b64(randomBytes(32));
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(endpoints.authorization_endpoint);
    url.search = new URLSearchParams({
        response_type: "code",
        client_id: config.oidcClientId!,
        redirect_uri: `${config.publicUrl}/callback`,
        scope: config.oidcScope,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
    }).toString();
    redirect(res, url.toString(), [cookie(FLOW_COOKIE, sign({ state, verifier, exp: Date.now() + 10 * 60_000 }), 600)]);
}

async function finishLogin(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, c: Ctx): Promise<void> {
    const a = c.a;
    const flow = verify<{ state: string; verifier: string; exp: number }>(cookies(req)[FLOW_COOKIE]);
    const code = query.get("code");
    if (!flow || !code || query.get("state") !== flow.state) {
        return html(res, 400, messagePage(c, a.loginExpiredTitle, a.loginExpired, [["/login", a.login]]));
    }
    const endpoints = await oidcEndpoints();
    if (!endpoints?.token_endpoint || !endpoints.userinfo_endpoint) throw new Error("OpenID provider without token/userinfo endpoint");

    const tokenRes = await fetch(endpoints.token_endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: "Basic " + Buffer.from(`${encodeURIComponent(config.oidcClientId!)}:${encodeURIComponent(config.oidcClientSecret!)}`).toString("base64"),
        },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${config.publicUrl}/callback`, code_verifier: flow.verifier }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) {
        console.warn("token exchange failed:", tokenRes.status, (await tokenRes.text()).slice(0, 300));
        return html(res, 400, messagePage(c, a.loginFailedTitle, a.loginFailed, [["/login", a.tryAgain]]));
    }
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    const infoRes = await fetch(endpoints.userinfo_endpoint, { headers: { Authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(10_000) });
    if (!infoRes.ok) throw new Error(`userinfo ${infoRes.status}`);
    const claims = (await infoRes.json()) as Record<string, unknown>;
    const identity = identityFromClaims(claims);
    const sub = identity.email ?? String(claims.sub ?? "");
    const clearFlow = cookie(FLOW_COOKIE, "", 0);
    if (!identity.tags.includes(config.adminTag)) {
        res.setHeader("Set-Cookie", clearFlow);
        return html(res, 403, messagePage(c, a.noAccessTitle, a.noAccess(config.adminTag)));
    }
    users.saveProfile(sub, identity);
    const session: Session = { sub, name: identity.username ?? identity.name ?? sub, tags: identity.tags, exp: Date.now() + SESSION_HOURS * 3600_000 };
    redirect(res, "/wokas", [clearFlow, cookie(SESSION_COOKIE, sign(session), SESSION_HOURS * 3600)]);
}

// ---------- router ----------

const WOKA_ID = /^custom-[a-z0-9]{12}$/;
const LANG_COOKIE = "wa_admin_lang";

/** Admin UI language: the switch in the sidebar (cookie) wins, otherwise the browser language. */
function adminLang(req: IncomingMessage): Lang {
    const chosen = cookies(req)[LANG_COOKIE];
    if (chosen === "de" || chosen === "en") return chosen;
    return matchLang(req.headers["accept-language"]) ?? "de";
}

export async function handleUi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    if (p === "/healthz") return sendJson(res, 200, { ok: true });

    // Woka images are public: browsers load them from inside WorkAdventure.
    const file = /^\/files\/wokas\/(custom-[a-z0-9]{12})\.png$/.exec(p);
    if (file && req.method === "GET") {
        const filePath = path.join(WOKA_DIR, `${file[1]}.png`);
        if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: "not found" });
        res.writeHead(200, {
            "Content-Type": "image/png",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "public, max-age=300",
            "X-Content-Type-Options": "nosniff",
        });
        return void fs.createReadStream(filePath).pipe(res);
    }

    const card = /^\/card\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(p);
    if (card && req.method === "GET") {
        const identifier = identifierFromCardToken(card[1]!);
        const lang = langFrom(url.searchParams.get("lang"), req.headers["accept-language"]);
        const page = identifier ? cardPage(identifier, lang) : undefined;
        res.writeHead(page ? 200 : 404, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": `default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors ${config.playUrl ?? "*"}`,
            "Referrer-Policy": "no-referrer",
        });
        return void res.end(page ?? `<!doctype html><p style='color:#a99cc9;font-family:sans-serif'>${t(lang).noCard}</p>`);
    }

    if (p === "/profile" || p.startsWith("/profile/")) {
        const browserLang = langFrom(url.searchParams.get("lang"), req.headers["accept-language"]);
        const sendProfile = async (accessToken: string | null, message?: (text: ReturnType<typeof t>) => string) => {
            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Content-Security-Policy": `default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors ${config.playUrl ?? "*"}`,
                "Referrer-Policy": "no-referrer",
            });
            res.end(await profilePage(accessToken, browserLang, message));
        };
        if (req.method === "GET" && p === "/profile") return sendProfile(url.searchParams.get("accessToken"));
        if (req.method === "POST" && (p === "/profile/room" || p === "/profile/room/settings" || p === "/profile/room/style")) {
            const form = await readForm(req);
            const accessToken = form.get("accessToken");
            const identity = await identityFromAccessToken(accessToken ?? undefined);
            if (!identity?.email) return sendProfile(accessToken);
            const viewer = { identifier: identity.email, tags: identity.tags };
            if (p === "/profile/room") {
                const stored = users.get(identity.email)?.locale;
                const lang: Lang = stored === "de" || stored === "en" ? stored : browserLang;
                if (!mayCreatePersonalRoom(viewer)) throw new HttpError(403, t(lang).forbidden);
                const name = identity.username ?? identity.name ?? identity.email.split("@")[0]!;
                let room;
                try {
                    room = await createPersonalRoom(identity.email, name, lang, form.get("style"));
                } catch (err) {
                    console.error(`personal room for ${identity.email} failed:`, err);
                    return sendProfile(accessToken, (text) => text.failed);
                }
                console.info(`personal room ${room.path} created for ${identity.email}`);
                return sendProfile(accessToken, (text) => text.roomCreated);
            }
            const room = rooms.byOwner(identity.email);
            if (!room) return sendProfile(accessToken);
            if (p === "/profile/room/style") {
                const style = form.get("style") ?? "holz";
                const missing = !(await roomMapExists(room));
                if (form.get("confirm") !== "1" || (!missing && style === (room.style ?? "holz"))) return sendProfile(accessToken);
                try {
                    const updated = await changeRoomStyle(room, style, identity.username ?? identity.name ?? identity.email.split("@")[0]!);
                    console.info(`personal room ${updated.path} of ${identity.email} ${missing ? "recreated" : "switched"} with style ${updated.style}`);
                    return sendProfile(accessToken, (text) => text.styleChanged);
                } catch (err) {
                    console.error(`style change for ${identity.email} failed:`, err);
                    return sendProfile(accessToken, (text) => text.failed);
                }
            }
            const access = accessFromForm(form, true);
            access.users = (access.users ?? []).filter((u) => u.toLowerCase() !== identity.email!.toLowerCase());
            rooms.save({ ...room, name: (form.get("name") ?? "").trim().slice(0, 60) || room.name, access });
            return sendProfile(accessToken, (text) => text.saved);
        }
    }

    // ----- admin UI -----
    const lang = adminLang(req);
    const a = adminText(lang);
    const session = verify<Session>(cookies(req)[SESSION_COOKIE]);
    const ctx: Ctx = { lang, a, path: p + url.search, s: session && session.tags.includes(config.adminTag) ? session : undefined };

    if (p === "/lang") {
        const to = url.searchParams.get("to");
        const back = url.searchParams.get("back") ?? "/";
        const target = back.startsWith("/") && !back.startsWith("//") && !back.startsWith("/\\") ? back : "/";
        if (to !== "de" && to !== "en") return redirect(res, target);
        return redirect(res, target, [cookie(LANG_COOKIE, to, 365 * 24 * 3600)]);
    }
    if (p === "/login") return startLogin(res, ctx);
    if (p === "/callback") return finishLogin(req, res, url.searchParams, ctx);
    if (p === "/logout") {
        // Only ends the admin session. Going back to "/" would log in again silently through the
        // still active Authentik session, so show a page instead and offer to log out there too.
        const endSession = (await oidcEndpoints())?.end_session_endpoint;
        res.setHeader("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
        const links: [string, string, string?][] = [["/login", a.loginAgain]];
        if (endSession) links.push([endSession, a.alsoAuthentik, "secondary"]);
        return html(res, 200, messagePage({ ...ctx, s: undefined, path: "/logout" }, a.loggedOutTitle, a.loggedOut, links));
    }

    if (!ctx.s) {
        if (req.method === "GET") return redirect(res, "/login");
        return sendJson(res, 401, { error: a.pleaseLogin });
    }
    const s = ctx.s;

    if (req.method === "GET" && (p === "/" || p === "")) return redirect(res, "/wokas");
    if (req.method === "GET" && p === "/wokas") return html(res, 200, wokasPage(ctx));
    if (req.method === "GET" && p === "/members") return html(res, 200, membersPage(ctx));
    if (req.method === "GET" && p === "/rooms") return html(res, 200, await roomsPage(ctx));
    if (p === "/rooms/edit" || p === "/rooms/delete") {
        const path = url.searchParams.get("path") ?? "";
        const known = (await listRooms().catch(() => [])).find((r) => r.roomUrl === "/~/" + path);
        const current = rooms.get(path);
        if (!known && !current) return html(res, 404, layout(ctx, a.notFound, "rooms", `${pageHead(a.notFound)}<div class="card empty">${icon("rooms")}<span>${a.roomGone}</span></div>`));
        const mapName = known?.name ?? path;
        if (req.method === "GET" && p === "/rooms/edit") return html(res, 200, roomEditPage(ctx, path, current, mapName));
        if (req.method === "POST") {
            const form = await readForm(req);
            checkCsrf(s, form.get("csrf"), a);
            if (p === "/rooms/delete") {
                if (!current?.owner) throw new HttpError(400, a.onlyOwnRooms);
                if (config.mapStorageToken) await deleteMap(path).catch((err) => console.warn("map-storage delete failed:", err));
                rooms.remove(path);
                return html(res, 200, await roomsPage({ ...ctx, path: "/rooms" }, a.roomDeleted));
            }
            const updated: RoomSettings = {
                path,
                name: (form.get("name") ?? "").trim().slice(0, 60) || null,
                description: (form.get("description") ?? "").trim().slice(0, 200) || null,
                access: accessFromForm(form),
                hidden: form.get("hidden") === "1",
                owner: current?.owner ?? null,
                style: current?.style ?? null,
            };
            rooms.save(updated);
            return html(res, 200, roomEditPage(ctx, path, updated, mapName, a.saved));
        }
    }
    if (req.method === "POST" && p === "/members/delete") {
        const form = await readForm(req);
        checkCsrf(s, form.get("csrf"), a);
        const id = form.get("id") ?? "";
        if (!id || id.toLowerCase() === s.sub.toLowerCase()) throw new HttpError(400, a.cannotRemove);
        const name = nameOf(id);
        const room = rooms.byOwner(id);
        if (room) {
            if (config.mapStorageToken) await deleteMap(room.path).catch((err) => console.warn("map-storage delete failed:", err));
            rooms.remove(room.path);
        }
        users.remove(id);
        console.info(`member ${id} removed by ${s.sub}`);
        return html(res, 200, membersPage({ ...ctx, path: "/members" }, a.removed(name, !!room)));
    }
    if (req.method === "POST" && (p === "/members/ban" || p === "/members/unban")) {
        const form = await readForm(req);
        checkCsrf(s, form.get("csrf"), a);
        const id = form.get("id") ?? "";
        if (!id) throw new HttpError(400, a.noMember);
        if (p === "/members/ban") {
            bans.add(id, (form.get("reason") ?? "").trim().slice(0, 500) || null, s.sub);
            return html(res, 200, membersPage({ ...ctx, path: "/members" }, a.bannedMsg(nameOf(id))));
        }
        bans.remove(id);
        return html(res, 200, membersPage({ ...ctx, path: "/members" }, a.unbannedMsg(nameOf(id))));
    }
    if (req.method === "GET" && p === "/reports") return html(res, 200, reportsPage(ctx));

    if (req.method === "POST" && p === "/wokas") {
        checkCsrf(s, req.headers["x-csrf"] as string | undefined, a);
        const name = decodeURIComponent(String(req.headers["x-woka-name"] ?? "")).trim().slice(0, 40);
        const part = String(req.headers["x-woka-part"] ?? "woka");
        if (!name) throw new HttpError(400, a.nameMissing);
        if (!(WOKA_PARTS as readonly string[]).includes(part)) throw new HttpError(400, a.unknownType);
        const data = await readBody(req, 512 * 1024, a.tooBig);
        checkWokaPng(data, a);
        const id = `custom-${randomBytes(8).toString("hex").slice(0, 12)}`;
        // New avatars are only visible to the uploader until access is set.
        customWokas.add({ id, part, name, url: storeImage(id, data), access: { users: [s.sub] }, position: 0 });
        console.info(`woka ${id} uploaded by ${s.sub}`);
        return sendJson(res, 201, { id });
    }

    if (req.method === "POST" && p === "/reports/delete") {
        checkCsrf(s, (await readForm(req)).get("csrf"), a);
        reports.removeAll();
        return html(res, 200, reportsPage({ ...ctx, path: "/reports" }, a.allReportsDeleted));
    }
    const report = /^\/reports\/(\d+)\/delete$/.exec(p);
    if (req.method === "POST" && report) {
        checkCsrf(s, (await readForm(req)).get("csrf"), a);
        reports.remove(Number(report[1]));
        return html(res, 200, reportsPage({ ...ctx, path: "/reports" }, a.reportDeleted));
    }

    const woka = /^\/wokas\/([^/]+)(\/image|\/delete)?$/.exec(p);
    if (woka && WOKA_ID.test(woka[1]!)) {
        const current = customWokas.get(woka[1]!);
        if (!current) return html(res, 404, layout(ctx, a.notFound, "wokas", `${pageHead(a.notFound)}<div class="card empty">${icon("wokas")}<span>${a.avatarGone}</span></div>`));

        if (req.method === "GET" && !woka[2]) {
            return html(res, 200, wokaEditPage(ctx, current, url.searchParams.has("neu") ? a.uploaded : undefined));
        }
        if (req.method === "POST" && woka[2] === "/image") {
            checkCsrf(s, req.headers["x-csrf"] as string | undefined, a);
            const data = await readBody(req, 512 * 1024, a.tooBig);
            checkWokaPng(data, a);
            customWokas.update({ ...current, url: storeImage(current.id, data) });
            return sendJson(res, 200, { id: current.id });
        }
        if (req.method === "POST" && woka[2] === "/delete") {
            const form = await readForm(req);
            checkCsrf(s, form.get("csrf"), a);
            customWokas.remove(current.id);
            fs.rmSync(path.join(WOKA_DIR, `${current.id}.png`), { force: true });
            return html(res, 200, wokasPage({ ...ctx, path: "/wokas" }, a.avatarDeleted(current.name)));
        }
        if (req.method === "POST" && !woka[2]) {
            const form = await readForm(req);
            checkCsrf(s, form.get("csrf"), a);
            const part = form.get("part") ?? current.part;
            const extra = (form.get("more") ?? "").split(/[\s,;]+/).map((v) => v.trim()).filter((v) => v.includes("@"));
            const updated: CustomWoka = {
                ...current,
                name: (form.get("name") ?? current.name).trim().slice(0, 40) || current.name,
                part: (WOKA_PARTS as readonly string[]).includes(part) ? part : current.part,
                access: {
                    everyone: form.get("everyone") === "1",
                    tags: form.getAll("tags").filter((tag) => tag !== ""),
                    users: [...new Set([...form.getAll("users"), ...extra])],
                },
            };
            customWokas.update(updated);
            return html(res, 200, wokaEditPage(ctx, updated, a.saved));
        }
    }

    return html(res, 404, layout(ctx, a.notFound, "", `${pageHead(a.notFound)}<div class="card empty">${icon("home")}<span>${a.pageNotFound}</span><a class="btn secondary" href="/">WorkAdventure Admin</a></div>`));
}
