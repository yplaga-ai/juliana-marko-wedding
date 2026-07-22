// Juliana & Marko — wedding photo upload service (Cloudflare Worker)
// Binding required: R2 bucket  ->  variable name: PHOTOS  ->  bucket: juliana-marko-photos
// Passwords (env vars override the defaults below):
//   GALLERY_PASSWORD "44Hoolis2026" — photo album view
//   ADMIN_PASSWORD   "44bubbly"      — MOH / organiser, FULL access
//   BRIDE_PASSWORD   "44Hoolis2026"  — bride (Juliana): Kitchen Tea RSVPs + wedding plan ONLY, never any hens data
//   HENS_PASSWORD    "bubbly"        — hens shared gallery read

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB per file (allows phone videos)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Filename",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const PW = env.GALLERY_PASSWORD || "44Hoolis2026";      // photo album (guests' uploads view)
    const ADMIN_PW = env.ADMIN_PASSWORD || "44bubbly";      // MOH / organiser — FULL access (Kitchen + Hens RSVPs, hens tracker, breakfast, hens-media delete)
    const BRIDE_PW = env.BRIDE_PASSWORD || "44Hoolis2026";  // Bride (Juliana) — Kitchen Tea RSVPs + wedding-plan ONLY. Never receives any hens data. (Hens = surprise.)
    const HENS_PW = env.HENS_PASSWORD || "bubbly";          // hens shared gallery read (view/download) — matches the /hens page word

    // --- Guest upload (public) ---
    if (request.method === "POST" && url.pathname === "/upload") {
      try {
        const ct = request.headers.get("Content-Type") || "";
        let key, type, body;
        if (ct.includes("multipart/form-data")) {
          const form = await request.formData();
          const file = form.get("file");
          if (!file || typeof file === "string") return j({ error: "No file provided" }, 400);
          type = file.type || "application/octet-stream";
          if (!/^(image|video)\//.test(type)) return j({ error: "Only photos and videos are allowed" }, 415);
          if (file.size > MAX_BYTES) return j({ error: "File is too large (max 100MB)" }, 413);
          key = makeKey(file.name);
          body = file.stream();
        } else {
          type = ct || "application/octet-stream";
          if (!/^(image|video)\//.test(type)) return j({ error: "Only photos and videos are allowed" }, 415);
          const buf = await request.arrayBuffer();
          if (buf.byteLength > MAX_BYTES) return j({ error: "File is too large (max 100MB)" }, 413);
          key = makeKey(request.headers.get("X-Filename") || "upload");
          body = buf;
        }
        await env.PHOTOS.put(key, body, { httpMetadata: { contentType: type } });
        return j({ ok: true, key }, 200);
      } catch (e) {
        return j({ error: "Upload failed: " + e.message }, 500);
      }
    }

    // --- Private album list (couple only, password) ---
    if (request.method === "GET" && url.pathname === "/list") {
      if (url.searchParams.get("pw") !== PW) return j({ error: "Unauthorized" }, 401);
      const out = [];
      let cursor;
      do {
        const r = await env.PHOTOS.list({ prefix: "uploads/", limit: 1000, cursor });
        for (const o of r.objects) out.push({ key: o.key, size: o.size, uploaded: o.uploaded });
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
      out.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
      return j({ ok: true, count: out.length, items: out }, 200);
    }

    // --- Event RSVP / booking (public submit: Kitchen Tea + Hens) ---
    if (request.method === "POST" && url.pathname === "/rsvp") {
      try {
        let name = "", email = "", notes = "", event = "", departure = "", extra = null;
        const ct = request.headers.get("Content-Type") || "";
        if (ct.includes("application/json")) {
          const b = await request.json();
          name = (b.name || "").toString().trim();
          email = (b.email || "").toString().trim();
          notes = (b.notes || "").toString().trim();
          event = (b.event || "").toString().trim().toLowerCase();
          departure = (b.departure || "").toString().trim();
          if (b.extra && typeof b.extra === "object") extra = b.extra;
        } else {
          const form = await request.formData();
          name = (form.get("name") || "").toString().trim();
          email = (form.get("email") || "").toString().trim();
          notes = (form.get("notes") || "").toString().trim();
          event = (form.get("event") || "").toString().trim().toLowerCase();
          departure = (form.get("departure") || "").toString().trim();
        }
        if (event !== "kitchen" && event !== "hens" && event !== "wedding") event = "kitchen";
        // "wedding" RSVPs may decline, so email isn't strictly required for a "not attending" reply.
        const attending = extra && (extra.attending === false || extra.attending === "no") ? false : true;
        if (!name) return j({ error: "Your name is required" }, 400);
        if ((event !== "wedding" || attending) && !email) return j({ error: "Name and email are required" }, 400);
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return j({ error: "Please enter a valid email address" }, 400);
        if (departure.length > 40) departure = departure.slice(0, 40);
        if (name.length > 120 || email.length > 200 || notes.length > 2000) return j({ error: "That entry is too long" }, 400);
        if (extra) { const es = JSON.stringify(extra); if (es.length > 4000) return j({ error: "That entry is too long" }, 400); }
        const rec = { event, name, email, departure, notes, extra, ts: new Date().toISOString() };
        const key = `rsvps/${event}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
        await env.PHOTOS.put(key, JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
        return j({ ok: true }, 200);
      } catch (e) {
        return j({ error: "Could not save RSVP: " + e.message }, 500);
      }
    }

    // --- RSVP list ---
    // MOH (ADMIN_PW): all RSVPs. Bride (BRIDE_PW): Kitchen Tea + Wedding only — the worker lists
    // only those prefixes, so hens RSVPs are never even read for her (hens = surprise).
    if (request.method === "GET" && url.pathname === "/rsvps") {
      const pw = url.searchParams.get("pw");
      const isAdmin = pw === ADMIN_PW;
      const isBride = pw === BRIDE_PW;
      if (!isAdmin && !isBride) return j({ error: "Unauthorized" }, 401);
      const prefixes = isAdmin ? ["rsvps/"] : ["rsvps/kitchen/", "rsvps/wedding/"];
      const out = [];
      for (const prefix of prefixes) {
        let cursor;
        do {
          const r = await env.PHOTOS.list({ prefix, limit: 1000, cursor });
          for (const o of r.objects) {
            const obj = await env.PHOTOS.get(o.key);
            if (obj) { try { out.push(JSON.parse(await obj.text())); } catch (_) {} }
          }
          cursor = r.truncated ? r.cursor : undefined;
        } while (cursor);
      }
      // Belt-and-braces: never return a hens record to the bride.
      const items = isAdmin ? out : out.filter(x => x && x.event !== "hens");
      items.sort((a, b) => new Date(b.ts) - new Date(a.ts));
      return j({ ok: true, count: items.length, items }, 200);
    }

    // --- RSVP delete (organiser tooling) ---
    // Admin (MOH) may delete any RSVP. Bride may delete Kitchen Tea + Wedding only, never hens.
    // Matched by the record's ts (unique ISO timestamp returned in /rsvps items).
    if (request.method === "POST" && url.pathname === "/rsvp-delete") {
      try {
        const b = await request.json();
        const pw = (b.pw || "").toString();
        const ts = (b.ts || "").toString();
        const isAdmin = pw === ADMIN_PW;
        const isBride = pw === BRIDE_PW;
        if (!isAdmin && !isBride) return j({ error: "Unauthorized" }, 401);
        if (!ts) return j({ error: "Missing ts" }, 400);
        const prefixes = isAdmin ? ["rsvps/"] : ["rsvps/kitchen/", "rsvps/wedding/"];
        let deleted = 0;
        for (const prefix of prefixes) {
          let cursor;
          do {
            const r = await env.PHOTOS.list({ prefix, limit: 1000, cursor });
            for (const o of r.objects) {
              const obj = await env.PHOTOS.get(o.key);
              if (!obj) continue;
              let rec = null; try { rec = JSON.parse(await obj.text()); } catch (_) {}
              if (rec && rec.ts === ts) {
                if (!isAdmin && rec.event === "hens") continue; // never let the bride touch hens
                await env.PHOTOS.delete(o.key);
                deleted++;
              }
            }
            cursor = r.truncated ? r.cursor : undefined;
          } while (cursor);
        }
        return j({ ok: true, deleted }, 200);
      } catch (e) {
        return j({ error: "Could not delete RSVP: " + e.message }, 500);
      }
    }

    // --- Crew self-view (public, per-person NAME + PASSWORD) ---
    // POST { name, pw }. The person's name is not secret (it's in their link); the password is.
    // Returns ONLY the matching person's slice of the wedding plan (their schedule rows + their tasks,
    // and the shared notes if the admin allowed it). Never any hens data; never another person's items;
    // never the admin's private per-person note or anyone's password.
    if (request.method === "POST" && url.pathname === "/crew") {
      let name = "", pw = "";
      try { const b = await request.json(); name = (b.name || "").toString().trim(); pw = (b.pw || "").toString(); } catch (_) {}
      if (!name || !pw) return j({ error: "Please enter your name and password" }, 400);
      const obj = await env.PHOTOS.get("admin/hens-tracker.json");
      let data = null;
      if (obj) { try { data = JSON.parse(await obj.text()); } catch (_) {} }
      const wed = (data && data.wedding && typeof data.wedding === "object") ? data.wedding : {};
      const people = Array.isArray(wed.people) ? wed.people : [];
      const lc = name.toLowerCase();
      const me = people.find(p => p && (p.name || "").toString().trim().toLowerCase() === lc && (p.pw || "").toString() !== "" && (p.pw || "").toString() === pw);
      if (!me) return j({ error: "not_found" }, 404);
      const pname = (me.name || "").toString().trim();
      const view = (me.view && typeof me.view === "object") ? me.view : { run: true, tasks: true, notes: false };
      const out = { name: pname };
      if (view.run !== false) {
        // Run sheet = their schedule rows + their transport legs, time-sorted (transport auto-links in).
        const sched = (Array.isArray(wed.schedule) ? wed.schedule : [])
          .filter(r => r && (r.who || "").toString().trim().toLowerCase() === lc && (r.time || r.item || r.loc))
          .map(r => ({ time: r.time || "", loc: r.loc || "", item: r.item || "", _t: tmin(r.time) }));
        const trans = (Array.isArray(wed.transport) ? wed.transport : [])
          .filter(t => t && (t.who || "").toString().trim().toLowerCase() === lc && (t.time || t.from || t.to || t.provider))
          .map(t => { const f = (t.from || "").toString().trim(), to = (t.to || "").toString().trim();
            return { time: t.time || "", loc: (f && to) ? (f + " → " + to) : (f || to || ""), item: "🚗 " + ((t.provider || "").toString().trim() || "Transport"), _t: tmin(t.time) }; });
        out.schedule = sched.concat(trans)
          .sort((a, b) => { if (a._t == null && b._t == null) return 0; if (a._t == null) return 1; if (b._t == null) return -1; return a._t - b._t; })
          .map(x => ({ time: x.time, loc: x.loc, item: x.item }));
        // Where they're staying
        const stays = (Array.isArray(wed.accommodation) ? wed.accommodation : [])
          .filter(a => a && (a.place || "").toString().trim() && (a.who || "").toString().trim().toLowerCase() === lc)
          .map(a => ({ place: a.place || "", checkin: a.checkin || "", checkout: a.checkout || "", address: a.address || "" }));
        if (stays.length) out.stays = stays;
      }
      if (view.tasks !== false) {
        out.tasks = (Array.isArray(wed.tasks) ? wed.tasks : [])
          .filter(t => t && (t.who || "").toString().trim().toLowerCase() === lc && (t.text || "").toString().trim())
          .map(t => ({ text: t.text || "", status: t.status || "todo", note: t.note || "", due: t.due || "" }));
      }
      if (view.notes) out.notes = (typeof wed.notes === "string") ? wed.notes : "";
      return j({ ok: true, data: out }, 200);
    }

    // --- Well wish (public submit: note and/or video/photo, recorded or uploaded) ---
    if (request.method === "POST" && url.pathname === "/wish") {
      try {
        const form = await request.formData();
        const name = (form.get("name") || "").toString().trim();
        const message = (form.get("message") || "").toString().trim();
        const file = form.get("file");
        const hasFile = file && typeof file !== "string";
        if (!name) return j({ error: "Please add your name" }, 400);
        if (!message && !hasFile) return j({ error: "Please leave a message or a video/photo" }, 400);
        if (name.length > 120 || message.length > 5000) return j({ error: "That message is a little too long" }, 400);
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let mediaKey = "", mediaType = "";
        if (hasFile) {
          mediaType = file.type || "application/octet-stream";
          if (!/^(image|video)\//.test(mediaType)) return j({ error: "Only photos and videos are allowed" }, 415);
          if (file.size > MAX_BYTES) return j({ error: "That file is too large (max 100MB)" }, 413);
          const clean = (file.name || "wish").replace(/[^\w.\-]/g, "_").slice(-80);
          mediaKey = `wishes/media/${id}-${clean}`;
          await env.PHOTOS.put(mediaKey, file.stream(), { httpMetadata: { contentType: mediaType } });
        }
        const rec = { name, message, mediaKey, mediaType, ts: new Date().toISOString() };
        await env.PHOTOS.put(`wishes/meta/${id}.json`, JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
        return j({ ok: true }, 200);
      } catch (e) {
        return j({ error: "Could not save your message: " + e.message }, 500);
      }
    }

    // --- Well wishes list (couple only, album password) ---
    if (request.method === "GET" && url.pathname === "/wishes") {
      if (url.searchParams.get("pw") !== PW) return j({ error: "Unauthorized" }, 401);
      const out = [];
      let cursor;
      do {
        const r = await env.PHOTOS.list({ prefix: "wishes/meta/", limit: 1000, cursor });
        for (const o of r.objects) {
          const obj = await env.PHOTOS.get(o.key);
          if (obj) { try { out.push(JSON.parse(await obj.text())); } catch (_) {} }
        }
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
      out.sort((a, b) => new Date(b.ts) - new Date(a.ts));
      return j({ ok: true, count: out.length, items: out }, 200);
    }

    // --- Hens shared gallery: upload (public) ---
    if (request.method === "POST" && url.pathname === "/hens-upload") {
      try {
        const ct = request.headers.get("Content-Type") || "";
        let key, type, body;
        if (ct.includes("multipart/form-data")) {
          const form = await request.formData();
          const file = form.get("file");
          if (!file || typeof file === "string") return j({ error: "No file provided" }, 400);
          type = file.type || "application/octet-stream";
          if (!/^(image|video)\//.test(type)) return j({ error: "Only photos and videos are allowed" }, 415);
          if (file.size > MAX_BYTES) return j({ error: "File is too large (max 100MB)" }, 413);
          key = makeKey(file.name, "hens");
          body = file.stream();
        } else {
          type = ct || "application/octet-stream";
          if (!/^(image|video)\//.test(type)) return j({ error: "Only photos and videos are allowed" }, 415);
          const buf = await request.arrayBuffer();
          if (buf.byteLength > MAX_BYTES) return j({ error: "File is too large (max 100MB)" }, 413);
          key = makeKey(request.headers.get("X-Filename") || "upload", "hens");
          body = buf;
        }
        await env.PHOTOS.put(key, body, { httpMetadata: { contentType: type } });
        return j({ ok: true, key }, 200);
      } catch (e) {
        return j({ error: "Upload failed: " + e.message }, 500);
      }
    }

    // --- Hens shared gallery: list (anyone with the hens word) ---
    if (request.method === "GET" && url.pathname === "/hens-list") {
      if (url.searchParams.get("pw") !== HENS_PW) return j({ error: "Unauthorized" }, 401);
      const out = [];
      let cursor;
      do {
        const r = await env.PHOTOS.list({ prefix: "hens/", limit: 1000, cursor });
        for (const o of r.objects) out.push({ key: o.key, size: o.size, uploaded: o.uploaded });
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
      out.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
      return j({ ok: true, count: out.length, items: out }, 200);
    }

    // --- Hens shared gallery: serve a file (anyone with the hens word) ---
    if (request.method === "GET" && url.pathname.startsWith("/hens-file/")) {
      if (url.searchParams.get("pw") !== HENS_PW) return new Response("Unauthorized", { status: 401, headers: CORS });
      const key = decodeURIComponent(url.pathname.slice("/hens-file/".length));
      if (!key.startsWith("hens/")) return new Response("Not found", { status: 404, headers: CORS });
      const obj = await env.PHOTOS.get(key);
      if (!obj) return new Response("Not found", { status: 404, headers: CORS });
      const h = new Headers(CORS);
      obj.writeHttpMetadata(h);
      h.set("Cache-Control", "private, max-age=3600");
      return new Response(obj.body, { headers: h });
    }

    // --- Hens shared gallery: delete an item (admin only) ---
    if (request.method === "POST" && url.pathname === "/hens-delete") {
      try {
        let key = "", pw = "";
        const ct = request.headers.get("Content-Type") || "";
        if (ct.includes("application/json")) {
          const b = await request.json();
          key = (b.key || "").toString();
          pw = (b.pw || "").toString();
        } else {
          const form = await request.formData();
          key = (form.get("key") || "").toString();
          pw = (form.get("pw") || "").toString();
        }
        if (pw !== ADMIN_PW) return j({ error: "Unauthorized" }, 401);
        if (!key.startsWith("hens/")) return j({ error: "That item can't be deleted here" }, 400);
        await env.PHOTOS.delete(key);
        return j({ ok: true }, 200);
      } catch (e) {
        return j({ error: "Could not delete: " + e.message }, 500);
      }
    }

    // --- Hens tracker (admin only): expenses, contributions, activities. One JSON doc. ---
    // Stored at admin/ (NOT hens/) so it is never exposed via the hens gallery endpoints.
    // MOH (ADMIN_PW): the whole tracker doc (hens money/activities + the bride's wedding key).
    // Bride (BRIDE_PW): ONLY the { wedding } slice — the hens tracker never leaves the worker for her.
    if (request.method === "GET" && url.pathname === "/hens-tracker") {
      const pw = url.searchParams.get("pw");
      const isAdmin = pw === ADMIN_PW;
      const isBride = pw === BRIDE_PW;
      if (!isAdmin && !isBride) return j({ error: "Unauthorized" }, 401);
      const obj = await env.PHOTOS.get("admin/hens-tracker.json");
      let data = null;
      if (obj) { try { data = JSON.parse(await obj.text()); } catch (_) { data = null; } }
      if (isBride) {
        const wedding = (data && typeof data === "object" && data.wedding && typeof data.wedding === "object") ? data.wedding : {};
        return j({ ok: true, data: { wedding } }, 200);
      }
      return j({ ok: true, data }, 200);
    }
    if (request.method === "POST" && url.pathname === "/hens-tracker") {
      try {
        const b = await request.json();
        const pw = (b.pw || "");
        const isAdmin = pw === ADMIN_PW;
        const isBride = pw === BRIDE_PW;
        if (!isAdmin && !isBride) return j({ error: "Unauthorized" }, 401);
        const incoming = (b.data && typeof b.data === "object") ? b.data : {};
        let toStore;
        if (isBride) {
          // The bride may only touch the wedding-plan slice. Read-modify-write server-side so her
          // save can never see or clobber the hens tracker.
          const cur = await env.PHOTOS.get("admin/hens-tracker.json");
          let existing = {};
          if (cur) { try { existing = JSON.parse(await cur.text()) || {}; } catch (_) { existing = {}; } }
          if (typeof existing !== "object" || existing === null) existing = {};
          existing.wedding = (incoming.wedding && typeof incoming.wedding === "object") ? incoming.wedding : (existing.wedding || {});
          toStore = existing;
        } else {
          toStore = incoming;
        }
        const str = JSON.stringify(toStore);
        if (str.length > 500000) return j({ error: "That's too much data to save" }, 413);
        await env.PHOTOS.put("admin/hens-tracker.json", str, { httpMetadata: { contentType: "application/json" } });
        return j({ ok: true }, 200);
      } catch (e) {
        return j({ error: "Could not save: " + e.message }, 500);
      }
    }

    // --- Hens Saturday breakfast order (public submit; one record per name) ---
    if (request.method === "POST" && url.pathname === "/brekky") {
      try {
        let name = "", choice = "";
        const ct = request.headers.get("Content-Type") || "";
        if (ct.includes("application/json")) {
          const b = await request.json();
          name = (b.name || "").toString().trim();
          choice = (b.choice || "").toString().trim().toLowerCase();
        } else {
          const form = await request.formData();
          name = (form.get("name") || "").toString().trim();
          choice = (form.get("choice") || "").toString().trim().toLowerCase();
        }
        if (!name) return j({ error: "Please add your name" }, 400);
        if (choice !== "salmon" && choice !== "bacon") return j({ error: "Please pick a breakfast" }, 400);
        if (name.length > 120) return j({ error: "That name is too long" }, 400);
        const slug = name.toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "guest";
        const rec = { name, choice, ts: new Date().toISOString() };
        await env.PHOTOS.put(`brekky/${slug}.json`, JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
        return j({ ok: true }, 200);
      } catch (e) {
        return j({ error: "Could not save: " + e.message }, 500);
      }
    }

    // --- Hens breakfast list (admin only) ---
    if (request.method === "GET" && url.pathname === "/brekkys") {
      if (url.searchParams.get("pw") !== ADMIN_PW) return j({ error: "Unauthorized" }, 401);
      const out = [];
      let cursor;
      do {
        const r = await env.PHOTOS.list({ prefix: "brekky/", limit: 1000, cursor });
        for (const o of r.objects) {
          const obj = await env.PHOTOS.get(o.key);
          if (obj) { try { out.push(JSON.parse(await obj.text())); } catch (_) {} }
        }
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
      out.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      return j({ ok: true, count: out.length, items: out }, 200);
    }

    // --- Gift registry (PUBLIC read so guests see it on the main site; bride/admin write) ---
    if (request.method === "GET" && url.pathname === "/registry") {
      const obj = await env.PHOTOS.get("registry.json");
      if (!obj) return j({ ok: true, data: {} }, 200);
      try { return j({ ok: true, data: JSON.parse(await obj.text()) }, 200); }
      catch (_) { return j({ ok: true, data: {} }, 200); }
    }
    if (request.method === "POST" && url.pathname === "/registry") {
      try {
        const b = await request.json();
        const pw = (b.pw || "");
        if (pw !== ADMIN_PW && pw !== BRIDE_PW) return j({ error: "Unauthorized" }, 401);
        const data = (b.data && typeof b.data === "object") ? b.data : {};
        const str = JSON.stringify(data);
        if (str.length > 100000) return j({ error: "That's too much data to save" }, 413);
        await env.PHOTOS.put("registry.json", str, { httpMetadata: { contentType: "application/json" } });
        return j({ ok: true }, 200);
      } catch (e) { return j({ error: "Could not save: " + e.message }, 500); }
    }

    // --- Site config (PUBLIC read; bride/admin write). Drives the optional, configurable
    //     sections/features of the site: event details, FAQ, travel, feature toggles, sub-events, etc. ---
    if (request.method === "GET" && url.pathname === "/site") {
      const obj = await env.PHOTOS.get("site.json");
      if (!obj) return j({ ok: true, data: {} }, 200);
      try { return j({ ok: true, data: JSON.parse(await obj.text()) }, 200); }
      catch (_) { return j({ ok: true, data: {} }, 200); }
    }
    if (request.method === "POST" && url.pathname === "/site") {
      try {
        const b = await request.json();
        const pw = (b.pw || "");
        if (pw !== ADMIN_PW && pw !== BRIDE_PW) return j({ error: "Unauthorized" }, 401);
        const data = (b.data && typeof b.data === "object") ? b.data : {};
        const str = JSON.stringify(data);
        if (str.length > 300000) return j({ error: "That's too much data to save" }, 413);
        await env.PHOTOS.put("site.json", str, { httpMetadata: { contentType: "application/json" } });
        return j({ ok: true }, 200);
      } catch (e) { return j({ error: "Could not save: " + e.message }, 500); }
    }

    // --- Vendor contracts / documents (bride or MOH only; never public) ---
    if (request.method === "POST" && url.pathname === "/doc-upload") {
      try {
        const form = await request.formData();
        const pw = (form.get("pw") || "").toString();
        if (pw !== ADMIN_PW && pw !== BRIDE_PW) return j({ error: "Unauthorized" }, 401);
        const file = form.get("file");
        if (!file || typeof file === "string") return j({ error: "No file provided" }, 400);
        const type = file.type || "application/octet-stream";
        if (!/(pdf|^image\/|msword|officedocument|spreadsheet|text\/plain)/.test(type)) return j({ error: "Please upload a PDF, image or document" }, 415);
        if (file.size > MAX_BYTES) return j({ error: "File is too large (max 100MB)" }, 413);
        const key = makeKey(file.name, "docs");
        await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: type } });
        return j({ ok: true, key, name: (file.name || "contract").toString().slice(0, 120) }, 200);
      } catch (e) { return j({ error: "Upload failed: " + e.message }, 500); }
    }
    if (request.method === "GET" && url.pathname === "/docs") {
      const pw = url.searchParams.get("pw");
      if (pw !== ADMIN_PW && pw !== BRIDE_PW) return j({ error: "Unauthorized" }, 401);
      const out = [];
      let cursor;
      do {
        const r = await env.PHOTOS.list({ prefix: "docs/", limit: 1000, cursor });
        for (const o of r.objects) out.push({ key: o.key, size: o.size, uploaded: o.uploaded });
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
      return j({ ok: true, items: out }, 200);
    }
    if (request.method === "GET" && url.pathname.startsWith("/doc/")) {
      const pw = url.searchParams.get("pw");
      if (pw !== ADMIN_PW && pw !== BRIDE_PW) return new Response("Unauthorized", { status: 401, headers: CORS });
      const key = decodeURIComponent(url.pathname.slice("/doc/".length));
      if (!key.startsWith("docs/")) return new Response("Not found", { status: 404, headers: CORS });
      const obj = await env.PHOTOS.get(key);
      if (!obj) return new Response("Not found", { status: 404, headers: CORS });
      const h = new Headers(CORS);
      obj.writeHttpMetadata(h);
      h.set("Cache-Control", "private, max-age=3600");
      return new Response(obj.body, { headers: h });
    }
    if (request.method === "POST" && url.pathname === "/doc-delete") {
      try {
        const b = await request.json();
        const pw = (b.pw || "");
        if (pw !== ADMIN_PW && pw !== BRIDE_PW) return j({ error: "Unauthorized" }, 401);
        const key = (b.key || "").toString();
        if (!key.startsWith("docs/")) return j({ error: "That item can't be deleted here" }, 400);
        await env.PHOTOS.delete(key);
        return j({ ok: true }, 200);
      } catch (e) { return j({ error: "Could not delete: " + e.message }, 500); }
    }

    // --- Serve a single file (couple only, password) ---
    if (request.method === "GET" && url.pathname.startsWith("/file/")) {
      if (url.searchParams.get("pw") !== PW) return new Response("Unauthorized", { status: 401, headers: CORS });
      const key = decodeURIComponent(url.pathname.slice(6));
      const obj = await env.PHOTOS.get(key);
      if (!obj) return new Response("Not found", { status: 404, headers: CORS });
      const h = new Headers(CORS);
      obj.writeHttpMetadata(h);
      h.set("Cache-Control", "private, max-age=3600");
      return new Response(obj.body, { headers: h });
    }

    if (url.pathname === "/") return new Response("Juliana & Marko — photo upload service", { headers: CORS });
    return new Response("Not found", { status: 404, headers: CORS });
  },
};

function makeKey(name, prefix) {
  const clean = (name || "upload").replace(/[^\w.\-]/g, "_").slice(-80);
  const rand = Math.random().toString(36).slice(2, 10);
  const day = new Date().toISOString().slice(0, 10);
  const base = (prefix || "uploads").replace(/[^\w\-]/g, "");
  return `${base}/${day}/${Date.now()}-${rand}-${clean}`;
}
function j(o, s) {
  return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
}
// Parse a free-text time ("8:00 am", "3:30 pm", "15:00") into minutes for sorting; null if unparseable.
function tmin(s) {
  s = (s || "").toString().trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(a|p)?\.?\s*m?/);
  if (!m) return null;
  let h = parseInt(m[1], 10); const mi = m[2] ? parseInt(m[2], 10) : 0; const ap = m[3];
  if (isNaN(h)) return null;
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  return h * 60 + mi;
}
