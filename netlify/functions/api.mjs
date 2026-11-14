import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { PLANS, call, handleUpdate } from "../lib/bot.mjs";

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

export default async (req) => {
  const path = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  if (path === "settings" && req.method === "GET") {
    const s = (await store().get("settings", { type: "json" })) || {};
    return json({ name: s.name || "My Shop", plans: PLANS });
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

  if (path === "login" && req.method === "POST") {
    if (!secret() || !same(sha(body.password || ""), sha(secret()))) return json({ error: "Wrong password" }, 401);
    const exp = String(Date.now() + 7 * 864e5);
    return json({ token: exp + "." + sign(exp) });
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

  return json({ error: "Not found" }, 404);
};
