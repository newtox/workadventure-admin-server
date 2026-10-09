// Admin web UI: login through OpenID Connect (admin role only), custom wokas, members and reports.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { customWokas, listCustomWokas, listReports, listUsers, reports, users, type CustomWoka } from "./db.js";
import { HttpError, sendJson } from "./http.js";
import { identityFromClaims, oidcEndpoints } from "./identity.js";
import { WOKA_PARTS, wokaListFor } from "./wokas.js";
import { identifierFromCardToken, roleStyle } from "./cards.js";

const WOKA_DIR = path.join(config.dataDir, "wokas");
fs.mkdirSync(WOKA_DIR, { recursive: true });

const SECRET = createHmac("sha256", config.apiToken).update("admin-ui-session").digest();
const SESSION_COOKIE = "wa_admin";
const FLOW_COOKIE = "wa_admin_flow";
const SESSION_HOURS = 8;
const secure = config.publicUrl?.startsWith("https://") ?? false;

const PART_LABELS: Record<string, string> = {
    woka: "Kompletter Charakter",
    body: "Körper",
    eyes: "Augen",
    hair: "Haare",
    clothes: "Kleidung",
    hat: "Hut",
    accessory: "Accessoire",
};

// ---------- helpers ----------

const esc = (s: unknown) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

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

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > limit) throw new HttpError(413, "Datei zu groß");
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    return new URLSearchParams((await readBody(req, 64 * 1024)).toString("utf8"));
}

/** Checks that the upload is a PNG of 96 × 128 pixels (3 frames × 4 directions of 32 × 32). */
function checkWokaPng(data: Buffer): void {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (data.length < 24 || !data.subarray(0, 8).equals(signature) || data.toString("ascii", 12, 16) !== "IHDR") {
        throw new HttpError(400, "Das ist keine PNG-Datei.");
    }
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (width !== 96 || height !== 128) {
        throw new HttpError(400, `Die Grafik muss 96 × 128 Pixel groß sein (ist ${width} × ${height}).`);
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

function checkCsrf(s: Session, value: string | null | undefined): void {
    const expected = Buffer.from(csrfFor(s));
    const given = Buffer.from(value ?? "");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new HttpError(403, "Ungültiges Formular, bitte Seite neu laden.");
}

// ---------- layout ----------

const CSS = `
:root{--bg:#14111f;--card:#221c35;--line:#3d3360;--text:#f3eefc;--muted:#a99cc9;--accent:#ff4fa3;--gold:#ffd84f;--ok:#4fd18b;--bad:#ff6b6b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 ui-monospace,"Courier New",monospace}
a{color:var(--accent)}header{display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center;padding:14px 20px;border-bottom:3px solid var(--line);background:#1a1529}
header strong{color:var(--accent);font-size:18px;margin-right:12px}header nav{display:flex;gap:16px;flex:1}header nav a{color:var(--text);text-decoration:none}
header nav a.on{color:var(--accent)}header span{color:var(--muted);font-size:13px}main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 6px}p.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:3px solid var(--line);box-shadow:5px 5px 0 #000;padding:16px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px}
.woka{display:flex;gap:14px;align-items:flex-start}.woka h3{margin:0 0 4px;font-size:16px}.woka small{display:block;color:var(--muted)}
.sprite{width:64px;height:64px;flex:none;background-size:192px 256px;background-repeat:no-repeat;image-rendering:pixelated;background-color:#2c2545;animation:walk .6s steps(3) infinite}
.sprite.big{width:96px;height:96px;background-size:288px 384px;animation-name:walkbig}
@keyframes walk{from{background-position:0 0}to{background-position:-192px 0}}@keyframes walkbig{from{background-position:0 0}to{background-position:-288px 0}}
.dirs{display:flex;gap:8px}.dirs .sprite.big:nth-child(2){animation-name:walkbig2}.dirs .sprite.big:nth-child(3){animation-name:walkbig3}.dirs .sprite.big:nth-child(4){animation-name:walkbig4}
@keyframes walkbig2{from{background-position:0 -96px}to{background-position:-288px -96px}}@keyframes walkbig3{from{background-position:0 -192px}to{background-position:-288px -192px}}@keyframes walkbig4{from{background-position:0 -288px}to{background-position:-288px -288px}}
.tag{display:inline-block;background:#3d3360;color:var(--text);padding:0 6px;margin:2px 4px 0 0;font-size:12px}.tag.admin{background:#7a1f45}
label{display:block;margin:10px 0 4px;color:var(--muted)}input[type=text],select,textarea{width:100%;padding:8px;background:#14111f;color:var(--text);border:2px solid var(--line);font:inherit}
.checks{display:flex;flex-wrap:wrap;gap:6px 16px}.checks label{display:flex;gap:6px;align-items:center;margin:0;color:var(--text)}
button,.button{display:inline-block;margin-top:14px;padding:8px 16px;background:var(--accent);color:#14111f;border:0;font:inherit;font-weight:bold;cursor:pointer;text-decoration:none;box-shadow:3px 3px 0 #000}
button.secondary{background:#3d3360;color:var(--text)}button.danger{background:var(--bad)}
.msg{padding:10px 14px;margin-bottom:16px;border-left:4px solid var(--ok);background:#1d2b25}.msg.err{border-color:var(--bad);background:#2b1d22}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:middle}th{color:var(--muted);font-weight:normal}
.layers{position:relative;width:64px;height:64px;background:#2c2545}.layers div{position:absolute;inset:0;background-size:192px 256px;background-position:-64px 0;image-rendering:pixelated}
.drop{border:3px dashed var(--line);padding:18px;text-align:center;cursor:pointer}.drop.over{border-color:var(--accent)}
`;

function layout(title: string, session: Session | undefined, active: string, body: string): string {
    const nav = session
        ? `<nav>${[["wokas", "Avatare"], ["members", "Mitglieder"], ["reports", "Meldungen"]]
              .map(([href, label]) => `<a href="/${href}" class="${active === href ? "on" : ""}">${label}</a>`)
              .join("")}</nav><span>${esc(session.name)} · <a href="/logout">Abmelden</a></span>`
        : "";
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} – WorkAdventure Admin</title><style>${CSS}</style></head>
<body><header><strong>WA Admin</strong>${nav}</header><main>${body}</main></body></html>`;
}

function accessSummary(w: CustomWoka): string {
    if (w.access.everyone) return `<span class="tag">alle</span>`;
    const parts = [...(w.access.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`), ...(w.access.users ?? []).map((u) => `<span class="tag">👤 ${esc(nameOf(u))}</span>`)];
    return parts.length ? parts.join("") : `<span class="tag">niemand</span>`;
}

function nameOf(identifier: string): string {
    const u = users.get(identifier);
    return u?.username ?? u?.name ?? identifier;
}

function knownTags(): string[] {
    return [...new Set([...config.knownTags, ...users.allTags()])].sort();
}

// ---------- pages ----------

function wokasPage(s: Session, message?: string): string {
    const wokas = listCustomWokas();
    const cards = wokas.length
        ? wokas
              .map(
                  (w) => `<div class="card woka"><div class="sprite" style="background-image:url('${esc(w.url)}')"></div>
<div><h3>${esc(w.name)}</h3><small>${esc(PART_LABELS[w.part] ?? w.part)}</small><div>${accessSummary(w)}</div>
<a href="/wokas/${encodeURIComponent(w.id)}">Bearbeiten</a></div></div>`,
              )
              .join("")
        : `<p class="sub">Noch keine eigenen Avatare.</p>`;
    const partOptions = WOKA_PARTS.map((p) => `<option value="${p}">${esc(PART_LABELS[p])}</option>`).join("");
    return layout("Avatare", s, "wokas", `
${message ? `<div class="msg">${esc(message)}</div>` : ""}
<h1>Eigene Avatare</h1>
<p class="sub">PNG mit 96 × 128 Pixeln: 3 Laufbilder nebeneinander, 4 Richtungen untereinander (unten, links, rechts, oben). Offizielle Avatare kann weiterhin jeder nutzen.</p>
<div class="grid">${cards}</div>
<div class="card"><h2 style="margin-top:0;font-size:18px">Neuen Avatar hochladen</h2>
<form id="upload">
<label for="file" class="drop" id="drop">📂 PNG auswählen oder hierher ziehen<input id="file" type="file" accept="image/png" hidden></label>
<div id="preview" class="dirs" style="margin-top:12px"></div>
<label for="name">Name</label><input id="name" type="text" maxlength="40" required>
<label for="part">Art</label><select id="part">${partOptions}</select>
<div id="error" class="msg err" style="display:none;margin-top:12px"></div>
<button type="submit">Hochladen</button>
</form></div>
<script>
const csrf=${JSON.stringify(csrfFor(s))};
const file=document.getElementById("file"),drop=document.getElementById("drop"),preview=document.getElementById("preview"),err=document.getElementById("error");
let chosen=null;
function show(f){chosen=f;const url=URL.createObjectURL(f);preview.innerHTML=[0,1,2,3].map(()=>'<div class="sprite big" style="background-image:url('+url+')"></div>').join("");
 const n=document.getElementById("name");if(!n.value)n.value=f.name.replace(/\\.png$/i,"");}
file.addEventListener("change",()=>file.files[0]&&show(file.files[0]));
["dragenter","dragover"].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();drop.classList.add("over")}));
["dragleave","drop"].forEach(t=>drop.addEventListener(t,()=>drop.classList.remove("over")));
drop.addEventListener("drop",e=>{e.preventDefault();e.dataTransfer.files[0]&&show(e.dataTransfer.files[0])});
document.getElementById("upload").addEventListener("submit",async e=>{e.preventDefault();err.style.display="none";
 if(!chosen){err.textContent="Bitte zuerst eine PNG-Datei auswählen.";err.style.display="block";return}
 const r=await fetch("/wokas",{method:"POST",body:chosen,headers:{"Content-Type":"image/png","X-CSRF":csrf,"X-Woka-Name":encodeURIComponent(document.getElementById("name").value),"X-Woka-Part":document.getElementById("part").value}});
 const d=await r.json().catch(()=>({}));if(!r.ok){err.textContent=d.error||"Fehler beim Hochladen";err.style.display="block";return}
 location.href="/wokas/"+encodeURIComponent(d.id)+"?neu=1";});
</script>`);
}

function wokaEditPage(s: Session, w: CustomWoka, message?: string): string {
    const partOptions = WOKA_PARTS.map((p) => `<option value="${p}"${p === w.part ? " selected" : ""}>${esc(PART_LABELS[p])}</option>`).join("");
    const tagChecks = knownTags()
        .map((t) => `<label><input type="checkbox" name="tags" value="${esc(t)}"${w.access.tags?.includes(t) ? " checked" : ""}> ${esc(t)}</label>`)
        .join("");
    const allowedUsers = new Set((w.access.users ?? []).map((u) => u.toLowerCase()));
    const known = listUsers().filter((u) => !u.identifier.match(/^[0-9a-f-]{36}$/));
    const userChecks = known
        .map(
            (u) =>
                `<label><input type="checkbox" name="users" value="${esc(u.identifier)}"${allowedUsers.has(u.identifier.toLowerCase()) ? " checked" : ""}> ${esc(u.username ?? u.name ?? u.identifier)}</label>`,
        )
        .join("");
    const extraUsers = (w.access.users ?? []).filter((u) => !known.some((k) => k.identifier.toLowerCase() === u.toLowerCase()));
    const csrf = csrfFor(s);
    return layout(w.name, s, "wokas", `
${message ? `<div class="msg">${esc(message)}</div>` : ""}
<p><a href="/wokas">← Alle Avatare</a></p>
<h1>${esc(w.name)}</h1>
<div class="card"><div class="dirs">${[0, 1, 2, 3].map(() => `<div class="sprite big" style="background-image:url('${esc(w.url)}')"></div>`).join("")}</div></div>
<form method="post" action="/wokas/${encodeURIComponent(w.id)}" class="card">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label for="name">Name</label><input id="name" name="name" type="text" maxlength="40" value="${esc(w.name)}" required>
<label for="part">Art</label><select id="part" name="part">${partOptions}</select>
<h2 style="font-size:16px;margin:20px 0 4px">Wer darf ihn benutzen?</h2>
<div class="checks"><label><input type="checkbox" name="everyone" value="1"${w.access.everyone ? " checked" : ""}> Alle</label></div>
<label>Rollen</label><div class="checks">${tagChecks}</div>
<label>Personen</label><div class="checks">${userChecks || '<span class="sub">Noch niemand war eingeloggt.</span>'}</div>
<label for="more">Weitere Personen (E-Mail, eine pro Zeile)</label><textarea id="more" name="more" rows="2">${esc(extraUsers.join("\n"))}</textarea>
<button type="submit">Speichern</button>
</form>
<div class="card"><h2 style="margin-top:0;font-size:16px">Grafik ersetzen</h2>
<input id="file" type="file" accept="image/png"><div id="error" class="msg err" style="display:none;margin-top:12px"></div>
<button id="replace" class="secondary" type="button">Neue Grafik hochladen</button></div>
<form method="post" action="/wokas/${encodeURIComponent(w.id)}/delete" class="card" onsubmit="return confirm('Avatar wirklich löschen? Wer ihn trägt, muss sich einen neuen aussuchen.')">
<input type="hidden" name="csrf" value="${esc(csrf)}"><button class="danger" type="submit">Avatar löschen</button></form>
<script>
document.getElementById("replace").addEventListener("click",async()=>{const f=document.getElementById("file").files[0],err=document.getElementById("error");
 if(!f){err.textContent="Bitte eine PNG-Datei auswählen.";err.style.display="block";return}
 const r=await fetch(location.pathname+"/image",{method:"POST",body:f,headers:{"Content-Type":"image/png","X-CSRF":${JSON.stringify(csrf)}}});
 const d=await r.json().catch(()=>({}));if(!r.ok){err.textContent=d.error||"Fehler";err.style.display="block";return}location.reload();});
</script>`);
}

function layerUrl(url: string): string {
    if (/^https?:\/\//.test(url)) return url;
    return config.playUrl ? `${config.playUrl}/${encodeURI(url)}` : url;
}

function membersPage(s: Session): string {
    const rows = listUsers()
        .filter((u) => !u.identifier.match(/^[0-9a-f-]{36}$/))
        .map((u) => {
            const details = u.textures ? wokaDetails(u.identifier, u.tags, u.textures) : [];
            const avatar = `<div class="layers">${details.map((d) => `<div style="background-image:url('${esc(layerUrl(d))}')"></div>`).join("")}</div>`;
            const tags = u.tags.map((t) => `<span class="tag${t === config.adminTag ? " admin" : ""}">${esc(t)}</span>`).join("");
            return `<tr><td>${avatar}</td><td>${esc(u.username ?? u.name ?? "–")}</td><td>${esc(u.email ?? u.identifier)}</td><td>${tags}</td><td>${esc(u.lastSeen.replace("T", " ").slice(0, 16))}</td></tr>`;
        })
        .join("");
    return layout("Mitglieder", s, "members", `<h1>Mitglieder</h1>
<p class="sub">Alle, die seit dem Start des Admin-Servers eingeloggt waren. Rollen werden in Authentik vergeben (Gruppen mit „wa-“ davor).</p>
<div class="card" style="overflow-x:auto"><table><thead><tr><th>Avatar</th><th>Name</th><th>E-Mail</th><th>Rollen</th><th>Zuletzt da</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5">Noch niemand.</td></tr>'}</tbody></table></div>`);
}

function wokaDetails(identifier: string, tags: string[], ids: string[]): string[] {
    const list = wokaListFor({ identifier, tags });
    const urls: string[] = [];
    for (const part of WOKA_PARTS) {
        for (const c of list[part]?.collections ?? []) for (const t of c.textures) if (ids.includes(t.id)) urls.push(t.url);
    }
    return urls;
}

// WorkAdventure prefixes the comment with "-- Date: … -- -- Reporter: … -- -- Reported: … --".
function reportText(comment: string): string {
    return comment.replace(/^\s*--\s*Date:.*?--\s*--\s*Reporter:.*?--\s*--\s*Reported:.*?--\s*/s, "").trim() || comment;
}

function reportsPage(s: Session, message?: string): string {
    const csrf = csrfFor(s);
    const list = listReports();
    const rows = list
        .map(
            (r) =>
                `<tr><td>${esc(r.createdAt.replace("T", " ").slice(0, 16))}</td><td>${esc(nameOf(r.reporter))}</td><td>${esc(nameOf(r.reported))}</td><td>${esc(reportText(r.comment))}</td>
<td><form method="post" action="/reports/${r.id}/delete"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="secondary" style="margin:0" title="Meldung löschen">✕</button></form></td></tr>`,
        )
        .join("");
    const clearAll = list.length > 1
        ? `<form method="post" action="/reports/delete" onsubmit="return confirm('Alle Meldungen löschen?')"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="danger" type="submit">Alle löschen</button></form>`
        : "";
    return layout("Meldungen", s, "reports", `${message ? `<div class="msg">${esc(message)}</div>` : ""}<h1>Meldungen</h1><p class="sub">Spieler-Meldungen aus WorkAdventure.</p>
<div class="card" style="overflow-x:auto"><table><thead><tr><th>Wann</th><th>Von</th><th>Über</th><th>Kommentar</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="5">Keine Meldungen.</td></tr>'}</tbody></table>${clearAll}</div>`);
}

function messagePage(title: string, text: string, link?: [string, string]): string {
    return layout(title, undefined, "", `<div class="card"><h1>${esc(title)}</h1><p>${esc(text)}</p>${link ? `<a class="button" href="${esc(link[0])}">${esc(link[1])}</a>` : ""}</div>`);
}

// ---------- visit card (public, shown inside WorkAdventure) ----------

function cardPage(identifier: string): string | undefined {
    const user = users.get(identifier);
    if (!user) return undefined;
    const layers = user.textures ? wokaDetails(user.identifier, user.tags, user.textures) : [];
    const roles = [...user.tags]
        .sort((a, b) => roleStyle(a).order - roleStyle(b).order)
        .map((t) => {
            const s = roleStyle(t);
            return `<span class="role" style="background:${s.color}">${esc(s.label)}</span>`;
        })
        .join("");
    const since = user.firstSeen ? new Date(user.firstSeen).toLocaleDateString("de-DE", { month: "long", year: "numeric" }) : "";
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;background:#1b1630;color:#f3eefc;font:14px/1.4 ui-sans-serif,system-ui,sans-serif}
.card{display:flex;gap:14px;align-items:center;padding:12px}
.avatar{position:relative;width:64px;height:64px;flex:none;border-radius:12px;background:#2c2545}
.avatar div{position:absolute;inset:0;background-size:192px 256px;background-position:-64px 0;image-rendering:pixelated}
h1{margin:0 0 6px;font-size:18px}.roles{display:flex;flex-wrap:wrap;gap:5px}
.role{color:#fff;font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px}
small{display:block;margin-top:8px;color:#a99cc9}
</style></head><body><div class="card" id="card">
<div class="avatar">${layers.map((u) => `<div style="background-image:url('${esc(layerUrl(u))}')"></div>`).join("")}</div>
<div><h1>${esc(user.username ?? user.name ?? "Unbekannt")}</h1><div class="roles">${roles || '<span class="role" style="background:#6b6385">Gast</span>'}</div>
${since ? `<small>Dabei seit ${esc(since)}</small>` : ""}</div></div>
<script>parent.postMessage({type:"cvIframeSize",data:{w:document.body.scrollWidth,h:document.getElementById("card").offsetHeight+4}},"*");</script>
</body></html>`;
}

// ---------- login ----------

async function startLogin(res: ServerResponse): Promise<void> {
    const endpoints = await oidcEndpoints();
    if (!endpoints?.authorization_endpoint) return html(res, 503, messagePage("Anmeldung nicht möglich", "Der Login-Server ist gerade nicht erreichbar."));
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

async function finishLogin(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    const flow = verify<{ state: string; verifier: string; exp: number }>(cookies(req)[FLOW_COOKIE]);
    const code = query.get("code");
    if (!flow || !code || query.get("state") !== flow.state) {
        return html(res, 400, messagePage("Anmeldung abgelaufen", "Bitte noch einmal anmelden.", ["/login", "Anmelden"]));
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
        return html(res, 400, messagePage("Anmeldung fehlgeschlagen", "Der Login-Server hat die Anmeldung abgelehnt.", ["/login", "Nochmal versuchen"]));
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
        return html(res, 403, messagePage("Kein Zugriff", `Dieser Bereich ist nur für die Rolle „${config.adminTag}“.`));
    }
    users.saveProfile(sub, identity);
    const session: Session = { sub, name: identity.username ?? identity.name ?? sub, tags: identity.tags, exp: Date.now() + SESSION_HOURS * 3600_000 };
    redirect(res, "/wokas", [clearFlow, cookie(SESSION_COOKIE, sign(session), SESSION_HOURS * 3600)]);
}

// ---------- router ----------

const WOKA_ID = /^custom-[a-z0-9]{12}$/;

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
        const page = identifier ? cardPage(identifier) : undefined;
        res.writeHead(page ? 200 : 404, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": `default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors ${config.playUrl ?? "*"}`,
            "Referrer-Policy": "no-referrer",
        });
        return void res.end(page ?? "<!doctype html><p style='color:#a99cc9;font-family:sans-serif'>Keine Visitenkarte.</p>");
    }

    if (p === "/login") return startLogin(res);
    if (p === "/callback") return finishLogin(req, res, url.searchParams);
    if (p === "/logout") {
        // Only ends the admin session. Going back to "/" would log in again silently through the
        // still active Authentik session, so show a page instead and offer to log out there too.
        const endSession = (await oidcEndpoints())?.end_session_endpoint;
        res.setHeader("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
        return html(res, 200, layout("Abgemeldet", undefined, "", `<div class="card"><h1>Abgemeldet</h1>
<p>Du bist aus der Admin-Oberfläche abgemeldet.</p>
<a class="button" href="/login">Wieder anmelden</a>
${endSession ? ` <a class="button" style="background:#3d3360;color:var(--text)" href="${esc(endSession)}">Auch bei Authentik abmelden</a>` : ""}</div>`));
    }

    const session = verify<Session>(cookies(req)[SESSION_COOKIE]);
    if (!session || !session.tags.includes(config.adminTag)) {
        if (req.method === "GET") return redirect(res, "/login");
        return sendJson(res, 401, { error: "Bitte neu anmelden." });
    }

    if (req.method === "GET" && (p === "/" || p === "")) return redirect(res, "/wokas");
    if (req.method === "GET" && p === "/wokas") return html(res, 200, wokasPage(session));
    if (req.method === "GET" && p === "/members") return html(res, 200, membersPage(session));
    if (req.method === "GET" && p === "/reports") return html(res, 200, reportsPage(session));

    if (req.method === "POST" && p === "/wokas") {
        checkCsrf(session, req.headers["x-csrf"] as string | undefined);
        const name = decodeURIComponent(String(req.headers["x-woka-name"] ?? "")).trim().slice(0, 40);
        const part = String(req.headers["x-woka-part"] ?? "woka");
        if (!name) throw new HttpError(400, "Bitte einen Namen angeben.");
        if (!(WOKA_PARTS as readonly string[]).includes(part)) throw new HttpError(400, "Unbekannte Art.");
        const data = await readBody(req, 512 * 1024);
        checkWokaPng(data);
        const id = `custom-${randomBytes(8).toString("hex").slice(0, 12)}`;
        // New avatars are only visible to the uploader until access is set.
        customWokas.add({ id, part, name, url: storeImage(id, data), access: { users: [session.sub] }, position: 0 });
        console.info(`woka ${id} uploaded by ${session.sub}`);
        return sendJson(res, 201, { id });
    }

    if (req.method === "POST" && p === "/reports/delete") {
        checkCsrf(session, (await readForm(req)).get("csrf"));
        reports.removeAll();
        return html(res, 200, reportsPage(session, "Alle Meldungen gelöscht."));
    }
    const report = /^\/reports\/(\d+)\/delete$/.exec(p);
    if (req.method === "POST" && report) {
        checkCsrf(session, (await readForm(req)).get("csrf"));
        reports.remove(Number(report[1]));
        return html(res, 200, reportsPage(session, "Meldung gelöscht."));
    }

    const woka = /^\/wokas\/([^/]+)(\/image|\/delete)?$/.exec(p);
    if (woka && WOKA_ID.test(woka[1]!)) {
        const current = customWokas.get(woka[1]!);
        if (!current) return html(res, 404, layout("Nicht gefunden", session, "wokas", "<p>Diesen Avatar gibt es nicht mehr.</p>"));

        if (req.method === "GET" && !woka[2]) {
            return html(res, 200, wokaEditPage(session, current, url.searchParams.has("neu") ? "Hochgeladen. Lege jetzt fest, wer ihn benutzen darf." : undefined));
        }
        if (req.method === "POST" && woka[2] === "/image") {
            checkCsrf(session, req.headers["x-csrf"] as string | undefined);
            const data = await readBody(req, 512 * 1024);
            checkWokaPng(data);
            customWokas.update({ ...current, url: storeImage(current.id, data) });
            return sendJson(res, 200, { id: current.id });
        }
        if (req.method === "POST" && woka[2] === "/delete") {
            const form = await readForm(req);
            checkCsrf(session, form.get("csrf"));
            customWokas.remove(current.id);
            fs.rmSync(path.join(WOKA_DIR, `${current.id}.png`), { force: true });
            return html(res, 200, wokasPage(session, `„${current.name}“ wurde gelöscht.`));
        }
        if (req.method === "POST" && !woka[2]) {
            const form = await readForm(req);
            checkCsrf(session, form.get("csrf"));
            const part = form.get("part") ?? current.part;
            const extra = (form.get("more") ?? "").split(/[\s,;]+/).map((v) => v.trim()).filter((v) => v.includes("@"));
            const updated: CustomWoka = {
                ...current,
                name: (form.get("name") ?? current.name).trim().slice(0, 40) || current.name,
                part: (WOKA_PARTS as readonly string[]).includes(part) ? part : current.part,
                access: {
                    everyone: form.get("everyone") === "1",
                    tags: form.getAll("tags").filter((t) => t !== ""),
                    users: [...new Set([...form.getAll("users"), ...extra])],
                },
            };
            customWokas.update(updated);
            return html(res, 200, wokaEditPage(session, updated, "Gespeichert."));
        }
    }

    return html(res, 404, layout("Nicht gefunden", session, "", "<p>Diese Seite gibt es nicht.</p>"));
}
