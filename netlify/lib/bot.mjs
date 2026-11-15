import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export const PLANS = {
  share: { label: "Share Account", price: 55 },
  solo: { label: "Solo Acc 1 Device", price: 115 },
};

const st = () => getStore("shop");
const owner = () => String(process.env.OWNER_CHAT_ID || "");
const today = () => new Date().toISOString().slice(0, 10);
const plusMonth = () => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toISOString().slice(0, 10); };

export const call = (method, payload) =>
  process.env.TELEGRAM_BOT_TOKEN
    ? fetch("https://api.telegram.org/bot" + process.env.TELEGRAM_BOT_TOKEN + "/" + method, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).then((r) => r.json()).catch(() => null)
    : Promise.resolve(null);

const send = (chat_id, text, extra = {}) => call("sendMessage", { chat_id, text, ...extra });

const key = () => crypto.createHash("sha256").update(process.env.STOCK_KEY || "").digest();
export const enc = (t) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const b = Buffer.concat([c.update(String(t), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), b].map((x) => x.toString("base64")).join(".");
};
export const dec = (t) => {
  const [iv, tag, b] = t.split(".").map((x) => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(b), d.final()]).toString("utf8");
};

export const getStock = async () => (await st().get("stock", { type: "json" }).catch(() => null)) || [];

const creds = (u, s) =>
  "Email: " + u.email + "\nPassword: " + s.password + (u.profile ? "\nProfile: " + u.profile : "") + (s.pin ? "\nPIN: " + s.pin : "");

async function deliver(po, id, origin) {
  const plan = PLANS[po.plan];
  const stock = await getStock();
  const unit = stock.find((u) => u.plan === po.plan && u.status === "Available");
  if (!unit) {
    await send(owner(), "Out of stock for " + plan.label + ". Add stock in the owner page, then press Confirm again.");
    return false;
  }
  let s;
  try { s = JSON.parse(dec(unit.secret)); } catch (e) {
    await send(owner(), "Could not read the account. Check STOCK_KEY in Netlify.");
    return false;
  }
  Object.assign(unit, { status: "Sold", buyer: po.who, chat: po.cid, ref: po.ref, sold: today(), expires: plusMonth() });
  await st().setJSON("stock", stock);
  await st().setJSON("po:" + id, { ...po, status: "done" });
  await send(po.cid, "Payment confirmed! Here is your account:\n\n" + creds(unit, s) + "\n\nValid until " + unit.expires + ". Please do not change the password or profile settings.\n\nNow please fill in your details here:\n" + origin + "/?plan=" + po.plan);
  const left = stock.filter((u) => u.plan === po.plan && u.status === "Available").length;
  await send(owner(), "Sold\n" + plan.label + " - ₱" + plan.price + "\nCustomer: " + po.who + "\nAccount: " + unit.email + (unit.profile ? ", profile " + unit.profile : "") + "\nRef no.: " + po.ref + "\nExpires: " + unit.expires + "\nStock left: " + left + " " + plan.label + (left < 2 ? "\n⚠️ Low stock" : ""));
  return true;
}

export async function replaceUnit(id) {
  const stock = await getStock();
  const old = stock.find((u) => u.id === id && u.status === "Sold");
  if (!old) return { ok: false, error: "Account not found" };
  const nu = stock.find((u) => u.plan === old.plan && u.status === "Available");
  if (!nu) return { ok: false, error: "No stock available for this plan" };
  let s;
  try { s = JSON.parse(dec(nu.secret)); } catch (e) { return { ok: false, error: "Cannot read stock. Check STOCK_KEY." }; }
  old.status = "Replaced";
  Object.assign(nu, { status: "Sold", buyer: old.buyer, chat: old.chat, ref: old.ref, sold: today(), expires: old.expires });
  await st().setJSON("stock", stock);
  await send(old.chat, "Here is your replacement account:\n\n" + creds(nu, s) + "\n\nValid until " + nu.expires + ".");
  await send(owner(), "Replaced for " + old.buyer + "\nOld: " + old.email + "\nNew: " + nu.email + (nu.profile ? ", profile " + nu.profile : ""));
  return { ok: true };
}

export async function handleUpdate(u, origin) {
  const store = st();

  if (u.callback_query) {
    const q = u.callback_query;
    const from = String(q.from.id);
    const data = q.data || "";
    await call("answerCallbackQuery", { callback_query_id: q.id });

    if (data.startsWith("plan:")) {
      const k = data.slice(5);
      const plan = PLANS[k];
      if (!plan) return;
      await store.setJSON("chat:" + from, { plan: k, step: "photo" });
      const num = process.env.GCASH_NUMBER, name = process.env.GCASH_NAME;
      const pay = num && name
        ? "Please send ₱" + plan.price + " to:\nGCash: " + num + "\nName: " + name + "\n\nThen send your payment screenshot here."
        : "The seller has not set up payment details yet. Please wait for the seller.";
      return send(from, plan.label + " - ₱" + plan.price + "\n\n" + pay);
    }

    if ((data.startsWith("ok:") || data.startsWith("no:")) && from === owner()) {
      const id = data.slice(3);
      const po = await store.get("po:" + id, { type: "json" }).catch(() => null);
      const clear = () => call("editMessageReplyMarkup", {
        chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] },
      });
      if (!po || po.status !== "pending") {
        await clear();
        return send(owner(), "That order was already handled.");
      }
      if (data.startsWith("ok:")) {
        if (await deliver(po, id, origin)) await clear();
        return;
      }
      await store.setJSON("po:" + id, { ...po, status: "rejected" });
      await clear();
      await send(po.cid, "Sorry, your payment could not be verified. Please contact the seller.");
      return send(owner(), "Rejected. The customer was notified.");
    }
    return;
  }

  const m = u.message;
  if (!m) return;
  const cid = String(m.chat.id);
  const text = (m.text || "").trim();

  if (text === "/id") return send(cid, "Your chat ID: " + cid);

  if (text === "/admin") {
    if (cid !== owner()) return;
    const t = crypto.randomBytes(24).toString("hex");
    await store.setJSON("login:" + t, { exp: Date.now() + 5 * 60 * 1000 });
    return send(cid, "Tap the button to open the dashboard. The link works once and expires in 5 minutes.",
      { reply_markup: { inline_keyboard: [[{ text: "Open dashboard", url: origin + "/admin.html#t=" + t }]] } });
  }

  if (text.startsWith("/start")) {
    const s = (await store.get("settings", { type: "json" }).catch(() => null)) || {};
    return send(cid,
      "Hi! Welcome to " + (s.name || "our shop") + " 👋\n\nHere's how ordering works:\n1. Pick a plan\n2. Send your payment\n3. Send your screenshot and reference number\n4. Wait for the seller's confirmation\n\nWhich plan would you like?",
      { reply_markup: { inline_keyboard: Object.entries(PLANS).map(([k, p]) => [{ text: p.label + " - ₱" + p.price, callback_data: "plan:" + k }]) } });
  }

  const s = await store.get("chat:" + cid, { type: "json" }).catch(() => null);
  if (!s) return send(cid, "Send /start to place an order.");

  if (s.step === "photo") {
    if (!m.photo) return send(cid, "Please send your payment receipt as a photo.");
    await store.setJSON("chat:" + cid, { ...s, step: "ref", file: m.photo[m.photo.length - 1].file_id });
    return send(cid, "What is the reference number shown on your receipt?");
  }

  if (s.step === "ref" && text) {
    if (!owner()) return send(cid, "The seller is not set up yet. Please try again later.");
    const plan = PLANS[s.plan];
    const who = m.from.username ? "@" + m.from.username : m.from.first_name;
    const id = crypto.randomUUID().slice(0, 8);
    await store.setJSON("po:" + id, { cid, plan: s.plan, ref: text.slice(0, 60), who, status: "pending" });
    await call("sendPhoto", {
      chat_id: owner(), photo: s.file,
      caption: "New order\n" + plan.label + " - ₱" + plan.price + "\nCustomer: " + who + " (id " + cid + ")\nRef: " + text.slice(0, 60),
      reply_markup: { inline_keyboard: [[
        { text: "✅ Confirm & send account", callback_data: "ok:" + id },
        { text: "❌ Reject", callback_data: "no:" + id },
      ]] },
    });
    await store.delete("chat:" + cid);
    return send(cid, "Order received! Please wait while the seller verifies your payment.");
  }
             }
