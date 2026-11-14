import { getStore } from "@netlify/blobs";

export const PLANS = {
  share: { label: "Share Account", price: 55 },
  solo: { label: "Solo Acc 1 Device", price: 115 },
};

export const call = (method, payload) =>
  process.env.TELEGRAM_BOT_TOKEN
    ? fetch("https://api.telegram.org/bot" + process.env.TELEGRAM_BOT_TOKEN + "/" + method, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).then((r) => r.json()).catch(() => null)
    : Promise.resolve(null);

const send = (chat_id, text, extra = {}) => call("sendMessage", { chat_id, text, ...extra });

export async function handleUpdate(u, origin) {
  const store = getStore("shop");
  const owner = String(process.env.OWNER_CHAT_ID || "");

  if (u.callback_query) {
    const q = u.callback_query;
    const from = String(q.from.id);
    const data = q.data || "";
    await call("answerCallbackQuery", { callback_query_id: q.id });

    if (data.startsWith("plan:")) {
      const key = data.slice(5);
      const plan = PLANS[key];
      if (!plan) return;
      await store.setJSON("chat:" + from, { plan: key, step: "photo" });
      const num = process.env.GCASH_NUMBER, name = process.env.GCASH_NAME;
      const pay = num && name
        ? "Please send ₱" + plan.price + " to:\nGCash: " + num + "\nName: " + name + "\n\nThen send your payment screenshot here."
        : "The seller has not set up payment details yet. Please wait for the seller.";
      return send(from, plan.label + " - ₱" + plan.price + "\n\n" + pay);
    }

    if ((data.startsWith("ok:") || data.startsWith("no:")) && from === owner) {
      const [act, cid, key] = data.split(":");
      await call("editMessageReplyMarkup", {
        chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] },
      });
      if (act === "ok") {
        await send(cid, "Payment confirmed! The seller will send your account shortly. Once you receive it, please fill in your details here:\n" + origin + "/?plan=" + key);
        return send(owner, "Confirmed. Form link sent to the customer. Now send them the account.");
      }
      await send(cid, "Sorry, your payment could not be verified. Please contact the seller.");
      return send(owner, "Rejected. The customer was notified.");
    }
    return;
  }

  const m = u.message;
  if (!m) return;
  const cid = String(m.chat.id);
  const text = (m.text || "").trim();

  if (text === "/id") return send(cid, "Your chat ID: " + cid);

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
    if (!owner) return send(cid, "The seller is not set up yet. Please try again later.");
    const plan = PLANS[s.plan];
    const who = m.from.username ? "@" + m.from.username : m.from.first_name;
    await call("sendPhoto", {
      chat_id: owner, photo: s.file,
      caption: "New order\n" + plan.label + " - ₱" + plan.price + "\nCustomer: " + who + " (id " + cid + ")\nRef: " + text.slice(0, 60),
      reply_markup: { inline_keyboard: [[
        { text: "✅ Confirm & send form link", callback_data: "ok:" + cid + ":" + s.plan },
        { text: "❌ Reject", callback_data: "no:" + cid + ":" + s.plan },
      ]] },
    });
    await store.delete("chat:" + cid);
    return send(cid, "Order received! Please wait while the seller verifies your payment.");
  }
      }
