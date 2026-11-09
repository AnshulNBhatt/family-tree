"use strict";
/*
 * Vanshavali server: serves the family tree page and stores the tree.
 * No dependencies. Data lives in DATA_DIR:
 *   state.json        people + relationships (+ which people have photos)
 *   photos/<id>.jpg   one small square photo per person
 * Every open page gets live updates over server-sent events (/api/events).
 * Anyone with the link can view the tree. Changing anything needs EDIT_CODE (a 6-digit code):
 * entering it once on a device unlocks editing there (an HttpOnly cookie).
 * Optional: if FAMILY_PASSCODE is set, even viewing needs that passcode.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PASSCODE = process.env.FAMILY_PASSCODE || "";
const EDIT_CODE = String(process.env.EDIT_CODE || "").trim();
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("vanshavali:" + PASSCODE).digest("hex");
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "false";
const MAX_BODY = 2 * 1024 * 1024;
const MAX_PEOPLE = 20000;
const MAX_PHOTO_BYTES = 1024 * 1024;

const PHOTO_DIR = path.join(DATA_DIR, "photos");
const STATE_FILE = path.join(DATA_DIR, "state.json");
fs.mkdirSync(PHOTO_DIR, { recursive: true });

/* ---------- state ---------- */
let state = { people: {}, relations: {}, photos: {} };
try {
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  state = { people: raw.people || {}, relations: raw.relations || {}, photos: raw.photos || {} };
} catch (e) {
  if (e.code !== "ENOENT") { console.error("Could not read", STATE_FILE, e.message); process.exit(1); }
}

let saveTimer = null, saving = false, dirty = false;
function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 250);
}
function flush() {
  saveTimer = null;
  if (saving || !dirty) return;
  saving = true; dirty = false;
  const tmp = STATE_FILE + ".tmp";
  fs.writeFile(tmp, JSON.stringify(state), (err) => {
    if (err) { saving = false; console.error("save failed", err.message); dirty = true; return scheduleSave(); }
    fs.rename(tmp, STATE_FILE, (err2) => {
      saving = false;
      if (err2) { console.error("save failed", err2.message); dirty = true; }
      if (dirty) scheduleSave();
    });
  });
}
function flushSync() {
  if (!dirty && !saveTimer) return;
  fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(state));
  fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
}

/* ---------- live updates ---------- */
const clients = new Set();
let broadcastTimer = null;
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const msg = "data: " + JSON.stringify(state) + "\n\n";
    for (const res of clients) res.write(msg);
  }, 60);
}
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25000).unref();
function changed() { scheduleSave(); broadcast(); }

/* ---------- validation ---------- */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REL_RE = /^(parent|spouse|sibling)~([A-Za-z0-9_-]{1,64})~([A-Za-z0-9_-]{1,64})$/;
const TEXT_FIELDS = ["name", "name_hi", "gender", "dob", "dod", "phone", "email", "location", "location_hi", "birthplace", "birthplace_hi",
  "gotra", "gotra_hi", "occupation", "occupation_hi", "notes", "notes_hi"];
function cleanPerson(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const out = {};
  for (const k of TEXT_FIELDS) {
    const v = body[k];
    if (v == null || v === "") continue;
    if (typeof v !== "string") return null;
    out[k] = v.slice(0, k.startsWith("notes") ? 4000 : 300);
  }
  if (out.gender && !["male", "female", "other"].includes(out.gender)) out.gender = "other";
  for (const k of ["createdAt", "updatedAt"]) if (Number.isFinite(body[k])) out[k] = body[k];
  if (!out.name && !out.name_hi) return null;
  return out;
}

/* ---------- auth ---------- */
const sessionToken = () => crypto.createHmac("sha256", SESSION_SECRET).update("session-v1:" + PASSCODE).digest("base64url");
const editToken = () => crypto.createHmac("sha256", SESSION_SECRET).update("edit-v1:" + EDIT_CODE).digest("base64url");
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${COOKIE_SECURE ? "; Secure" : ""}`;
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("="); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest(), hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const authed = (req) => !PASSCODE || safeEqual(cookies(req).vt || "", sessionToken());
const canEdit = (req) => !!EDIT_CODE && safeEqual(cookies(req).ve || "", editToken());
const attempts = new Map(); // ip -> {n, until}
function clientIp(req) { return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?"; }
let globalFails = { n: 0, reset: 0 };
function tooMany(ip) {
  const a = attempts.get(ip), now = Date.now();
  if (globalFails.reset > now && globalFails.n >= 100) return true; // at most 100 wrong guesses per hour in total
  if (!a || a.reset < now) return false;
  return a.n >= 8;
}
function noteFailure(ip) {
  const now = Date.now(); const a = attempts.get(ip);
  if (!a || a.reset < now) attempts.set(ip, { n: 1, reset: now + 15 * 60 * 1000 });
  else a.n++;
  if (globalFails.reset < now) globalFails = { n: 1, reset: now + 60 * 60 * 1000 }; else globalFails.n++;
}
setInterval(() => { const now = Date.now(); for (const [ip, a] of attempts) if (a.reset < now) attempts.delete(ip); }, 60000).unref();

/* ---------- http helpers ---------- */
const PAGE_HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<meta name="robots" content="noindex,nofollow">' +
  '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Cpath d=%22M16 3v26M16 11 7 18M16 11l9 7M16 19l-6 5M16 19l6 5%22 stroke=%22%230D6A62%22 stroke-width=%223%22 stroke-linecap=%22round%22 fill=%22none%22/%3E%3C/svg%3E">' +
  '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
  'body{margin:0;font:14px/1.4 system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>';
const PAGE_TAIL = "</body></html>";
const APP_FILE = path.join(__dirname, "app", "index.html");
let pageCache = null;
function page() {
  if (!pageCache || process.env.NODE_ENV !== "production") pageCache = PAGE_HEAD + fs.readFileSync(APP_FILE, "utf8") + PAGE_TAIL;
  return pageCache;
}
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, { "Content-Type": type, "Content-Length": buf.length, "Cache-Control": "no-store", ...SECURITY_HEADERS, ...extra });
  res.end(buf);
}
const noContent = (res) => { res.writeHead(204, { "Cache-Control": "no-store", ...SECURITY_HEADERS }); res.end(); };
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return reject(Object.assign(new Error("json only"), { status: 415 }));
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null")); } catch (e) { reject(Object.assign(new Error("bad json"), { status: 400 })); } });
    req.on("error", reject);
  });
}

/* ---------- routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const m = req.method;

  if (p === "/healthz") return send(res, 200, "ok", "text/plain");
  if ((p === "/" || p === "/index.html") && (m === "GET" || m === "HEAD")) return send(res, 200, page(), "text/html; charset=utf-8");
  if (!p.startsWith("/api/")) return send(res, 404, "Not found", "text/plain");

  if (p === "/api/session" && m === "GET") return send(res, 200, { needPasscode: !!PASSCODE, ok: authed(req), canEdit: authed(req) && canEdit(req), editCode: !!EDIT_CODE });
  if (p === "/api/login" && m === "POST") {
    const ip = clientIp(req);
    if (tooMany(ip)) return send(res, 429, { error: "too_many" });
    const body = await readJson(req);
    if (!PASSCODE || (body && typeof body.passcode === "string" && safeEqual(body.passcode.trim(), PASSCODE))) {
      return send(res, 200, { ok: true }, undefined, { "Set-Cookie": cookie("vt", sessionToken(), 180 * 24 * 3600) });
    }
    noteFailure(ip);
    return send(res, 401, { error: "wrong_passcode" });
  }

  if (!authed(req)) return send(res, 401, { error: "passcode_required" });

  if (p === "/api/unlock" && m === "POST") {
    const ip = clientIp(req);
    if (tooMany(ip)) return send(res, 429, { error: "too_many" });
    const body = await readJson(req);
    const code = body && typeof body.code === "string" ? body.code.replace(/\s/g, "") : "";
    if (EDIT_CODE && safeEqual(code, EDIT_CODE)) return send(res, 200, { ok: true }, undefined, { "Set-Cookie": cookie("ve", editToken(), 365 * 24 * 3600) });
    noteFailure(ip);
    return send(res, 401, { error: "wrong_code" });
  }
  if (p === "/api/lock" && m === "POST") return send(res, 200, { ok: true }, undefined, { "Set-Cookie": cookie("ve", "", 0) });
  // every change needs the edit code; reading does not
  if ((m === "PUT" || m === "DELETE" || m === "POST") && !canEdit(req)) return send(res, 403, { error: "edit_code_required" });

  if (p === "/api/state" && m === "GET") return send(res, 200, state);
  if (p === "/api/events" && m === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive", ...SECURITY_HEADERS });
    res.write("retry: 3000\n\n");
    res.write("data: " + JSON.stringify(state) + "\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  const seg = p.split("/").slice(2).map(decodeURIComponent); // [kind, id]
  if (seg.length !== 2) return send(res, 404, { error: "not_found" });
  const [kind, id] = seg;

  if (kind === "people") {
    if (!ID_RE.test(id)) return send(res, 400, { error: "bad_id" });
    if (m === "PUT") {
      const doc = cleanPerson(await readJson(req));
      if (!doc) return send(res, 400, { error: "bad_person" });
      if (!state.people[id] && Object.keys(state.people).length >= MAX_PEOPLE) return send(res, 507, { error: "full" });
      state.people[id] = doc; changed(); return noContent(res);
    }
    if (m === "DELETE") {
      delete state.people[id];
      for (const [k, r] of Object.entries(state.relations)) if (r.a === id || r.b === id) delete state.relations[k];
      if (state.photos[id]) { delete state.photos[id]; fs.rm(path.join(PHOTO_DIR, id + ".jpg"), { force: true }, () => {}); }
      changed(); return noContent(res);
    }
  }

  if (kind === "relations") {
    const mm = REL_RE.exec(id);
    if (!mm) return send(res, 400, { error: "bad_id" });
    if (m === "PUT") {
      const body = await readJson(req);
      const [, type, x, y] = mm;
      if (!body || body.type !== type || x === y) return send(res, 400, { error: "bad_relation" });
      const ok = type === "parent" ? body.a === x && body.b === y : [body.a, body.b].sort().join("~") === [x, y].sort().join("~") && [x, y].sort().join() === [x, y].join();
      if (!ok) return send(res, 400, { error: "bad_relation" });
      if (!state.people[x] || !state.people[y]) return send(res, 409, { error: "unknown_person" });
      if (type === "parent" && state.relations[`parent~${y}~${x}`]) return send(res, 409, { error: "cycle" });
      state.relations[id] = { type, a: body.a, b: body.b, createdAt: Number.isFinite(body.createdAt) ? body.createdAt : Date.now() };
      changed(); return noContent(res);
    }
    if (m === "DELETE") { delete state.relations[id]; changed(); return noContent(res); }
  }

  if (kind === "photos") {
    if (!ID_RE.test(id)) return send(res, 400, { error: "bad_id" });
    const file = path.join(PHOTO_DIR, id + ".jpg");
    if (m === "GET") {
      fs.readFile(file, (err, buf) => {
        if (err) return send(res, 404, { error: "not_found" });
        send(res, 200, buf, "image/jpeg", { "Cache-Control": "private, max-age=31536000, immutable" });
      });
      return;
    }
    if (m === "PUT") {
      if (!state.people[id]) return send(res, 409, { error: "unknown_person" });
      const body = await readJson(req);
      const mt = body && typeof body.data === "string" && /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(body.data);
      if (!mt) return send(res, 400, { error: "bad_photo" });
      const buf = Buffer.from(mt[1], "base64");
      if (buf.length > MAX_PHOTO_BYTES) return send(res, 413, { error: "too_large" });
      if (buf[0] !== 0xff || buf[1] !== 0xd8) return send(res, 400, { error: "bad_photo" });
      await fs.promises.writeFile(file + ".tmp", buf);
      await fs.promises.rename(file + ".tmp", file);
      state.photos[id] = Date.now(); changed(); return noContent(res);
    }
    if (m === "DELETE") { delete state.photos[id]; fs.rm(file, { force: true }, () => {}); changed(); return noContent(res); }
  }

  return send(res, 405, { error: "method_not_allowed" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err.message });
    else res.end();
  });
});
server.requestTimeout = 30000;
server.listen(PORT, () => {
  console.log(`Vanshavali listening on :${PORT}, data in ${DATA_DIR}, view passcode ${PASSCODE ? "on" : "off"}, editing ${EDIT_CODE ? "needs the 6-digit code" : "DISABLED (set EDIT_CODE)"}`);
});
function shutdown() {
  try { flushSync(); } catch (e) { console.error("final save failed", e.message); }
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
