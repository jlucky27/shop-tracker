import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { PLANS, call, handleUpdate, getStock, enc, dec, replaceUnit } from "../lib/bot.mjs";

export const config = { path: "/api/*" };

const store = () => getStore("shop");
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const secret = () => process.env.ADMIN_PASSWORD || "";
const sign = (t) => crypto.createHmac("sha256", secret()).update(t).digest("hex");
const same = (x, y) => { const a = Buffer.from(x), b = Buffer.from(y); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const authed = (req) => {
  const [exp, sig] = (req.headers.get("authorization") || "").replace("Bearer ", "").split(".");
  return !!(secret() && exp && sig && Number(exp) > Date.now() && same(sig, sign(exp)));
};
const clean = (v, n = 120) => String(v ?? "").trim().slice(0, n);
const getOrders = async () => (await store().get("orders", { type: "json" })) || [];
const newToken = () => { const exp = String(Date.now() + 7 * 864e5); return exp + "." + sign(exp); };

export default async (req) => {
  const path = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  if (path === "settings" && req.method === "GET") {
    const s = (await store().get("settings", { type: "json" })) || {};
    return json({ name: s.name || "My Shop", plans: PLANS });
  }

  if (path === "logo" && req.method === "GET") {
    const d = await store().get("logo", { type: "json" }).catch(() => null);
    if (!d) return new Response("", { status: 404 });
    return new Response(Buffer.from(d.data, "base64"), { headers: { "content-type": "image/png", "cache-control": "no-cache" } });
  }

  if (path === "report" && req.method === "POST") {
    if (body.website) return json({ ok: true });
    const plan = PLANS[body.plan];
    if (!plan || !clean(body.tg)) return json({ error: "Missing details" }, 400);
    const orders = await getOrders();
    orders.push({
      id: crypto.randomUUID(), created: Date.now(), plan: body.plan, price: plan.price,
      tg: clean(body.tg), email: clean(body.email), profile: clean(body.profile),
      password: clean(body.password), device: clean(body.device),
      purchased: clean(body.purchased, 10), loc: clean(body.loc), status: "Active",
    });
    await store().setJSON("orders", orders);
    if (process.env.OWNER_CHAT_ID) {
      await call("sendMessage", { chat_id: process.env.OWNER_CHAT_ID, text: "Customer details received: " + clean(body.tg) + " (" + plan.label + ", ₱" + plan.price + ")" });
    }
    return json({ ok: true });
  }

  if (path === "tg" && req.method === "POST") {
    const want = process.env.WEBHOOK_SECRET;
    if (want && req.headers.get("x-telegram-bot-api-secret-token") !== want) return json({ error: "Forbidden" }, 403);
    try { await handleUpdate(body, new URL(req.url).origin); } catch (e) { console.error(e); }
    return json({ ok: true });
  }

  if (path === "tglogin" && req.method === "POST") {
    const k = "login:" + clean(body.t, 64).replace(/[^a-f0-9]/g, "");
    const r = await store().get(k, { type: "json" }).catch(() => null);
    if (!r || r.exp < Date.now()) return json({ error: "Link expired" }, 401);
    await store().delete(k);
    return json({ token: newToken() });
  }

  if (path === "login" && req.method === "POST") {
    const f = (await store().get("fails", { type: "json" }).catch(() => null)) || { n: 0, until: 0 };
    if (f.until > Date.now()) return json({ error: "Too many tries. Wait 15 minutes or send /admin to the bot." }, 429);
    if (!secret() || !same(sha(body.password || ""), sha(secret()))) {
      f.n += 1;
      if (f.n >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.n = 0; }
      await store().setJSON("fails", f);
      return json({ error: "Wrong password" }, 401);
    }
    if (f.n) await store().setJSON("fails", { n: 0, until: 0 });
    return json({ token: newToken() });
  }

  if (!authed(req)) return json({ error: "Unauthorized" }, 401);

  if (path === "setwebhook" && req.method === "POST") {
    const secret_token = process.env.WEBHOOK_SECRET || undefined;
    const d = await call("setWebhook", { url: new URL(req.url).origin + "/api/tg", secret_token, allowed_updates: ["message", "callback_query"] });
    return json(d || { ok: false, description: "TELEGRAM_BOT_TOKEN is missing in Netlify" });
  }

  if (path === "orders" && req.method === "GET") return json({ orders: await getOrders(), plans: PLANS });

  if (path === "status" && req.method === "POST") {
    const orders = await getOrders();
    const o = orders.find((x) => x.id === body.id);
    if (o && ["Active", "Expired", "Cancelled"].includes(body.status)) o.status = body.status;
    await store().setJSON("orders", orders);
    return json({ ok: true });
  }

  if (path === "delete" && req.method === "POST") {
    await store().setJSON("orders", (await getOrders()).filter((x) => x.id !== body.id));
    return json({ ok: true });
  }

  if (path === "name" && req.method === "POST") {
    await store().setJSON("settings", { name: clean(body.name, 40) || "My Shop" });
    return json({ ok: true });
  }

  if (path === "logo" && req.method === "POST") {
    const m = String(body.data || "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    if (!m || m[1].length > 400000) return json({ error: "Image is too large or not valid" }, 400);
    await store().setJSON("logo", { data: m[1] });
    return json({ ok: true });
  }

  if (path === "logodel" && req.method === "POST") {
    await store().delete("logo");
    return json({ ok: true });
  }

  if (path === "stock" && req.method === "GET") {
    return json({ stock: (await getStock()).map(({ secret, ...u }) => u) });
  }

  if (path === "stockadd" && req.method === "POST") {
    if (!process.env.STOCK_KEY) return json({ error: "STOCK_KEY is missing in Netlify" }, 400);
    const stock = await getStock();
    let added = 0, skipped = 0;
    for (const line of String(body.text || "").split("\n")) {
      if (!line.trim()) continue;
      const p = line.split(",").map((x) => x.trim());
      const plan = (p[0] || "").toLowerCase();
      if (!PLANS[plan] || !p[1] || !p[2]) { skipped++; continue; }
      stock.push({
        id: crypto.randomUUID(), plan, email: p[1].slice(0, 120), profile: (p[3] || "").slice(0, 60),
        secret: enc(JSON.stringify({ password: p[2], pin: p[4] || "" })), status: "Available",
      });
      added++;
    }
    await store().setJSON("stock", stock);
    return json({ added, skipped });
  }

  if (path === "reveal" && req.method === "POST") {
    const u = (await getStock()).find((x) => x.id === body.id);
    if (!u) return json({ error: "Not found" }, 404);
    try { return json(JSON.parse(dec(u.secret))); } catch (e) { return json({ error: "Cannot decrypt. Check STOCK_KEY." }, 400); }
  }

  if (path === "stockdel" && req.method === "POST") {
    await store().setJSON("stock", (await getStock()).filter((x) => x.id !== body.id));
    return json({ ok: true });
  }

  if (path === "replace" && req.method === "POST") return json(await replaceUnit(body.id));

  return json({ error: "Not found" }, 404);
};
