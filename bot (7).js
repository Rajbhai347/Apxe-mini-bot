import { spawn } from "child_process";
import config from "./config.js";
import fs from "fs";
import os from "os";
import path from "path";

export default async function initializeTelegramBot(manager) {
  // ── CONFIG ──────────────────────────────────────────────────────────────────
  const ALLOWED_GROUP_ID = String(config.TG_GROUP_ID);
  const GROUP_INVITE_LINK = config.TG_GROUP_LINK;
  const TG_CHANNEL_ID = String(config.TG_CHANNEL_ID);
  const TG_CHANNEL_LINK = config.TG_CHANNEL_LINK;
  const WA_CHANNEL_LINK = config.WA_CHANNEL_LINK;
  const BOT_PIC_URL = config.BOT_PIC_URL;
  const START_VIDEO_URL = config.START_VIDEO_URL;
  const START_AUDIO_URL = config.START_AUDIO_URL;
  const START_AUDIO_TITLE = config.START_AUDIO_TITLE;
  const START_AUDIO_PERFORMER = config.START_AUDIO_PERFORMER;
  const BOT_NAME = config.BOT_NAME;
  const OWNER_NAME = config.OWNER_NAME;
  const DEVELOPER_NAME = config.DEVELOPER_NAME;
  const ADMIN_IDS = new Set(config.TG_ADMIN_IDS.map(String));
  const TG_ADMIN_ID = config.TG_ADMIN_IDS[0];
  const PAIR_COOLDOWN_MS = 30_000;

  const BOT_TOKEN = config.BOT_TOKEN_TELEGRAM;

  if (!BOT_TOKEN) {
    console.warn("❌ [bot.js] BOT_TOKEN not set — skipping Telegram bot.");
    return null;
  }

  const RAILWAY_URL =
    process.env.RAILWAY_STATIC_URL || process.env.WEBHOOK_BASE_URL || "";
  const USE_WEBHOOK = Boolean(RAILWAY_URL);

  // Dynamic import — avoids startup penalty when Telegram is not used
  const { default: TelegramBot } = await import("node-telegram-bot-api");

  const tbot = new TelegramBot(
    BOT_TOKEN,
    USE_WEBHOOK
      ? { polling: false }
      : { polling: { interval: 3000, timeout: 30 } }
  );

  tbot.on("polling_error", (e) =>
    console.error("❗ [bot.js] Polling error:", e?.message || e)
  );
  tbot.on("webhook_error", (e) =>
    console.error("❗ [bot.js] Webhook error:", e?.message || e)
  );

  // Fetch bot identity
  let botId = null;
  try {
    const me = await tbot.getMe();
    botId = me.id;
    tbot.botId = me.id;
    tbot.botUsername = me.username;
    console.log(
      `🤖 [bot.js] @${me.username} (${me.id}) — mode: ${
        USE_WEBHOOK ? "webhook" : "polling"
      }`
    );
  } catch (e) {
    console.warn("⚠️ [bot.js] getMe failed:", e?.message);
  }

  // ── Pair log (who linked which number) ──────────────────────────────────────
  // Persisted so /status can show, after restarts too, who connected each bot.
  const OWNER_TG_LINK = config.OWNER_TG_LINK || GROUP_INVITE_LINK;
  const PAIR_PIC_URL = config.PAIR_PIC_URL || BOT_PIC_URL;
  const PAIR_VIDEO_URL = config.PAIR_VIDEO_URL || "";
  const PAIR_LOG_FILE = path.join(path.dirname(config.META_FILE), "pair_log.json");
  let pairLog = {};
  try { pairLog = JSON.parse(fs.readFileSync(PAIR_LOG_FILE, "utf8")) || {}; } catch { pairLog = {}; }
  function savePairLog() {
    try {
      fs.mkdirSync(path.dirname(PAIR_LOG_FILE), { recursive: true });
      fs.writeFileSync(PAIR_LOG_FILE, JSON.stringify(pairLog, null, 2));
    } catch (e) {
      console.warn("[bot.js] pair log save failed:", e?.message || e);
    }
  }
  function recordPair(number, from) {
    pairLog[number] = {
      userId: String(from?.id || from?.sender_chat?.id || ""),
      name: [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.title || "",
      username: from?.username || "",
      at: Date.now(),
    };
    savePairLog();
  }

  // ── Pair message (banner photo) lifecycle ───────────────────────────────────
  // The pair-code message is a PHOTO message (banner + caption). When WhatsApp
  // links, the same message is edited to "BOT CONNECTED" with the same banner,
  // so the user sees the picture + success text, like the demo video.
  const PAIR_EXPIRE_MS = 3 * 60 * 1000;
  const ownerMarkup = () => ({
    inline_keyboard: [[{ text: "Owner", url: OWNER_TG_LINK, style: "success" }]],
  });

  async function editPairMessage(pending, text, markup) {
    const extra = { parse_mode: "HTML", ...(markup ? { reply_markup: markup } : {}) };
    const ids = { chat_id: pending.chatId, message_id: pending.messageId };
    if (pending.isMedia) return tbot.editMessageCaption(text, { ...ids, ...extra });
    return tbot.editMessageText(text, { ...ids, ...extra });
  }

  function clearPending(key) {
    const pending = pairMessages.get(key);
    if (pending?.timer) clearTimeout(pending.timer);
    pairMessages.delete(key);
    pairOwners.delete(key);
  }

  async function finishPending(key, text, markup) {
    const pending = pairMessages.get(key);
    if (!pending) return;
    clearPending(key);
    try {
      await editPairMessage(pending, text, markup);
    } catch {
      // Message may be gone — send a fresh one instead of losing the result.
      try {
        if (PAIR_VIDEO_URL && markup) {
          await tbot.sendVideo(pending.chatId, PAIR_VIDEO_URL, {
            caption: text, parse_mode: "HTML", reply_markup: markup,
            reply_to_message_id: pending.replyId, supports_streaming: true,
          });
        } else if (PAIR_PIC_URL && markup) {
          await tbot.sendPhoto(pending.chatId, PAIR_PIC_URL, {
            caption: text, parse_mode: "HTML", reply_markup: markup,
            reply_to_message_id: pending.replyId,
          });
        } else {
          await tbot.sendMessage(pending.chatId, text, {
            parse_mode: "HTML", reply_to_message_id: pending.replyId,
          });
        }
      } catch {}
    }
  }

  const connectedCaption = (number) =>
    [
      `<b>- BOT CONNECTED.</b> ❤️`,
      ``,
      `<b>- SUCCESSFULLY LINKED.</b> ✅`,
      ``,
      `<b>- NUMBER:</b> +${esc(number)} 📱`,
    ].join("\n");

  // Pairing / disconnect notifications. Observes manager events only; the
  // SessionManager/socket architecture is untouched.
  const disconnectNotified = new Set();
  manager.on("connection.update", async (sessionId, update) => {
    try {
      const key = String(sessionId);
      const connection = update?.connection;

      if (connection === "open") {
        if (pairMessages.has(key)) {
          const info = pairLog[key];
          if (info) { info.linkedAt = Date.now(); savePairLog(); }
          await finishPending(key, connectedCaption(key), ownerMarkup());
        }
        return;
      }

      if (connection !== "close") return;

      // A close during pairing is normal (WhatsApp restarts the socket right
      // after the code is accepted), so keep waiting for "open".
      if (pairMessages.has(key)) return;

      if (disconnectNotified.has(key)) return;
      disconnectNotified.add(key);
      const timer = setTimeout(() => disconnectNotified.delete(key), 15 * 60 * 1000);
      timer.unref?.();
      await safeReply(TG_ADMIN_ID, premiumBox("𝘽𝙊𝙏 𝘿𝙄𝙎𝘾𝙊𝙉𝙉𝙀𝘾𝙏𝙀𝘿 ⚠️", [
        `📱 <b>𝙎𝙀𝙎𝙎𝙄𝙊𝙉:</b> <code>${esc(sessionId)}</code>`,
        `🤖 <b>𝘽𝙊𝙏:</b> ${esc(BOT_NAME)}`,
        ``,
        `💬 𝙏𝙃𝙀 𝙒𝙃𝘼𝙏𝙎𝘼𝙋𝙋 𝙎𝙀𝙎𝙎𝙄𝙊𝙉 𝘿𝙄𝙎𝘾𝙊𝙉𝙉𝙀𝘾𝙏𝙀𝘿.`,
        `🔄 𝙍𝙀𝘾𝙊𝙉𝙉𝙀𝘾𝙏 𝙄𝙏 𝘼𝙂𝘼𝙄𝙉 𝙒𝙄𝙏𝙃 /pair 𝙄𝙁 𝙉𝙀𝙀𝘿𝙀𝘿.`,
      ]));
    } catch (e) {
      console.error("[bot.js] connection notification failed:", e?.message || e);
    }
  });

  // Session removed (logged out / failed) while a pair message is waiting.
  manager.on("session.deleted", async (sessionId) => {
    try {
      const key = String(sessionId);
      if (!pairMessages.has(key)) return;
      await finishPending(key, [
        `<b>- PAIRING FAILED.</b> ❌`,
        ``,
        `<b>- NUMBER:</b> +${esc(key)} 📱`,
        ``,
        `<b>- SEND /pair ${esc(key)} TO TRY AGAIN.</b>`,
      ].join("\n"), ownerMarkup());
    } catch {}
  });

  // Per-user pair cooldown map
  const pairCooldown = new Map(); // userId → timestamp
  const pairOwners = new Map();
  // Telegram message associated with a pending WhatsApp pairing session.
  // Used to replace the pair-code message with a connected confirmation.
  const pairMessages = new Map();

  // ── Utility helpers ─────────────────────────────────────────────────────────

  const esc = (s = "") =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  // ── 𝗕𝗢𝗟𝗗 𝗗𝗘𝗦𝗜𝗚𝗡 𝗟𝗔𝗬𝗘𝗥 ─────────────────────────────────────────────────────────
  // Every Telegram message is rendered in Unicode Sans-Serif Bold Italic so ALL
  // text looks thick.  Example: Hello 123 → 𝙃𝙚𝙡𝙡𝙤 𝟭𝟮𝟯
  const BRAND = "𝘿𝙃--𝙆 𝙓 𝙈𝘿";
  const BOX_TOP = "┏";
  const BOX_LINE = "━━━━━━━━━━━━━━━━━━━━";
  const TG_MAX = 4096;

  // Converts text to CAPITAL bold-italic letters (digits: bold, no italic digits exist). Older fancy styles (monospace, serif bold,
  // bold-italic …) are normalised first, so mixed text becomes one clean font.
  function toBold(text = "") {
    return String(text ?? "")
      .replace(/[\u{1D400}-\u{1D7FF}]/gu, (c) => c.normalize("NFKC"))
      .toUpperCase() // ALL text is rendered in CAPITAL letters
      .replace(/[A-Za-z0-9]/g, (ch) => {
        const c = ch.charCodeAt(0);
        if (c >= 65 && c <= 90) return String.fromCodePoint(0x1d63c + (c - 65));
        if (c >= 97 && c <= 122) return String.fromCodePoint(0x1d656 + (c - 97));
        return String.fromCodePoint(0x1d7ec + (c - 48));
      });
  }

  // Kept as `F` because many handlers already call F("text").
  const F = toBold;

  // Bolds only the visible text of a Telegram-HTML string.  It never touches:
  //   • tags / attributes          • HTML entities (&amp; …)
  //   • <code> / <pre> contents    (stay copyable)
  //   • URLs and /commands         (stay clickable)
  //   • keycap emoji like 1️⃣        (digits must stay plain)
  const KEEP_TOKENS =
    /(<[^>]*>|&(?:[a-zA-Z]+|#\d+);|[0-9]\uFE0F?\u20E3|https?:\/\/[^\s<]+|(?<![\w/])\/[A-Za-z_]+)/g;
  function styleText(html = "") {
    const parts = String(html ?? "").split(KEEP_TOKENS);
    let code = 0; // inside <code>/<pre>  (cannot be bold in Telegram)
    let bold = 0; // already inside <b>
    // Bold every visible piece twice: Unicode bold font + real <b> tag, so
    // even Bengali / emoji / symbols come out thick. Done line by line.
    const wrap = (txt) =>
      txt
        .split("\n")
        .map((ln) => (ln.trim() ? ln.replace(/^(\s*)(.*?)(\s*)$/, "$1<b>$2</b>$3") : ln))
        .join("\n");
    return parts
      .map((part, i) => {
        if (i % 2 === 1 && part.startsWith("<")) {
          if (/^<(code|pre)[\s>]/i.test(part)) code++;
          else if (/^<\/(code|pre)>/i.test(part)) code = Math.max(0, code - 1);
          else if (/^<(b|strong)[\s>]/i.test(part)) bold++;
          else if (/^<\/(b|strong)>/i.test(part)) bold = Math.max(0, bold - 1);
          return part;
        }
        if (code > 0) return part;
        const isText = i % 2 === 0;
        const out = isText ? toBold(part) : part; // entities/URLs/commands stay as-is
        return bold > 0 ? out : wrap(out);
      })
      .join("");
  }

  // Existing handlers sometimes provide Telegram HTML markup. This strips it
  // (used for titles, button labels and the plain-text fallback).
  function cleanTelegramText(value = "") {
    return String(value ?? "")
      .replace(/<\/?[a-z][^>]*>/gi, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  // Premium card:
  //   ┏━━━━━━━━━━━━━━━━━━━━◈
  //   ┃ ✦ 𝗧𝗜𝗧𝗟𝗘 ✦
  //   ┣━━━━━━━━━━━━━━━━━━━━◈
  //   ┃ body…
  //   ┗━━━━━━━━━━━━━━━━━━━━◈ 𝗗𝗛--𝗞 𝗫 𝗠𝗗
  function premiumBox(title, lines = []) {
    const body = (Array.isArray(lines) ? lines : [lines])
      .map((l) => String(l ?? ""))
      .join("\n")
      .split("\n");
    const head = styleText(esc(cleanTelegramText(title).toUpperCase()));

    const styled = styleText(body.join("\n")).split("\n");
    let inPre = false;
    const rail = styled.map((line) => {
      const wasInPre = inPre;
      const opens = (line.match(/<pre[\s>]/gi) || []).length;
      const closes = (line.match(/<\/pre>/gi) || []).length;
      if (opens > closes) inPre = true;
      else if (closes > opens) inPre = false;
      if (wasInPre) return line; // keep <pre> blocks untouched
      return line.trim() ? `┃ ${line}` : `┃`;
    });

    return [
      `${BOX_TOP}${BOX_LINE}◈`,
      `┃ ✦ ${head} ✦`,
      `┣${BOX_LINE}◈`,
      ...rail,
      `┗${BOX_LINE}◈ ${toBold(BRAND)}`,
    ].join("\n");
  }

  // Already-built cards pass through untouched; anything else gets wrapped.
  function boxify(text, title = BRAND) {
    const raw = Array.isArray(text) ? text.join("\n") : String(text ?? "");
    return raw.startsWith(BOX_TOP) ? raw : premiumBox(title, raw);
  }

  // Telegram rejects >4096 chars. Bold letters take 2 UTF-16 units each, so
  // fall back to a plain-text version instead of failing the whole reply.
  function fitMessage(boxed, opts = {}) {
    if (boxed.length <= TG_MAX) return { text: boxed, opts: { parse_mode: "HTML", ...opts } };
    const plain = cleanTelegramText(boxed).slice(0, TG_MAX - 30) + "\n… (𝙏𝙍𝙐𝙉𝘾𝘼𝙏𝙀𝘿)";
    const o = { ...opts };
    delete o.parse_mode;
    return { text: plain, opts: o };
  }

  // Bold labels for inline-keyboard buttons.
  const btn = (label) => toBold(cleanTelegramText(label));

  async function safeReply(chatId, text, opts = {}) {
    const { text: t, opts: o } = fitMessage(boxify(text), opts);
    return tbot.sendMessage(chatId, t, o);
  }

  async function safeEdit(chatId, messageId, text, opts = {}) {
    const { text: t, opts: o } = fitMessage(boxify(text), opts);
    return tbot.editMessageText(t, { chat_id: chatId, message_id: messageId, ...o });
  }

  function isoToFlag(iso) {
    if (!iso || iso.length !== 2) return "🏳️";
    const A = 0x1f1e6;
    return [...iso.toUpperCase()]
      .map((c) => String.fromCodePoint(A + c.charCodeAt(0) - 65))
      .join("");
  }

  function fmtCode(raw) {
    const s = String(raw || "").replace(/\s+/g, "");
    return s.match(/.{1,4}/g)?.join("-") || s;
  }

  function isPrivate(msg) {
    return msg?.chat?.type === "private";
  }

  function isAllowedGroup(msg) {
    try {
      if (!msg?.chat) return false;
      if (msg.chat.type === "private") return false;
      return String(msg.chat.id) === String(ALLOWED_GROUP_ID);
    } catch {
      return false;
    }
  }

  const verifiedUsers = new Map();

  async function isChannelMember(userId) {
    if (!userId) return false;
    if (ADMIN_IDS.has(String(userId))) return true;
    const targets = [TG_CHANNEL_ID];
    for (const target of targets) {
      try {
        const member = await tbot.getChatMember(target, userId);
        if (["member", "administrator", "creator"].includes(member?.status)) return true;
      } catch (err) {
        console.warn(`[bot.js] channel check ${target} failed:`, err?.message || err);
      }
    }
    return false;
  }

  async function verifyUser(msg) {
    const uid = msg?.from?.id;
    if (!uid) return false;
    if (ADMIN_IDS.has(String(uid))) return true;
    const ok = await isChannelMember(uid);
    if (ok) verifiedUsers.set(String(uid), Date.now());
    else verifiedUsers.delete(String(uid));
    return ok;
  }

  async function sendWelcome(chatId, userId, replyId) {
    // Private /start: only one blue (primary) join-group button.
    const buttons = [[{ text: btn("👀 𝙅𝙊𝙄𝙉 𝙊𝙁𝙁𝙇𝙄𝙉𝙀 𝙂𝙍𝙊𝙐𝙋"), url: GROUP_INVITE_LINK, style: "primary" }]];
    const caption = premiumBox("𝙒𝙀𝙇𝘾𝙊𝙈𝙀 🌸", [
      `🤖 <b>${esc(BOT_NAME)}</b>`,
      ``,
      `👑 <b>𝙊𝙒𝙉𝙀𝙍:</b> ${esc(OWNER_NAME)}`,
      `🧑‍💻 <b>𝘿𝙀𝙑𝙀𝙇𝙊𝙋𝙀𝙍:</b> ${esc(DEVELOPER_NAME)}`,
      ``,
      `🚀 𝙇𝙄𝙉𝙆 𝙔𝙊𝙐𝙍 𝙒𝙃𝘼𝙏𝙎𝘼𝙋𝙋 𝙄𝙉 𝙎𝙀𝘾𝙊𝙉𝘿𝙎 𝙒𝙄𝙏𝙃 /pair`,
      `📖 𝙎𝙀𝙉𝘿 /help 𝙏𝙊 𝙎𝙀𝙀 𝙀𝙑𝙀𝙍𝙔 𝘾𝙊𝙈𝙈𝘼𝙉𝘿`,
    ]);
    const opts = { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons }, reply_to_message_id: replyId };
    let sent;
    // Video first (START_VIDEO_URL); if it is empty or fails, fall back to the photo.
    try { if (START_VIDEO_URL) sent = await tbot.sendVideo(chatId, START_VIDEO_URL, { caption, supports_streaming: true, ...opts }); }
    catch (e) { console.warn("[bot.js] welcome video failed:", e?.message || e); }
    if (!sent) {
      try { if (BOT_PIC_URL) sent = await tbot.sendPhoto(chatId, BOT_PIC_URL, { caption, ...opts }); }
      catch (e) { console.warn("[bot.js] welcome photo failed:", e?.message || e); }
    }
    if (!sent) sent = await safeReply(chatId, caption, opts);

    // ছবির নিচে গান পাঠানো
    try {
      if (START_AUDIO_URL) {
        await tbot.sendAudio(chatId, START_AUDIO_URL, {
          title: START_AUDIO_TITLE,
          performer: START_AUDIO_PERFORMER,
        });
      }
    } catch (e) { console.warn("[bot.js] start audio failed:", e?.message || e); }
    return sent;
  }

  // ── Auto-leave unauthorized groups ──────────────────────────────────────────

  tbot.on("new_chat_members", async (msg) => {
    try {
      if (!msg?.new_chat_members) return;
      if (!botId) return;
      const addedBot = msg.new_chat_members.some((m) => m.id === botId);
      if (!addedBot) return;

      if (!isAllowedGroup(msg)) {
        console.log(
          "[bot.js] 🚫 𝗔𝗗𝗗𝗘𝗗 𝗧𝗢 𝗨𝗡𝗔𝗨𝗧𝗛𝗢𝗥𝗜𝗭𝗘𝗗 𝗚𝗥𝗢𝗨𝗣:",
          msg.chat.id,
          "— leaving"
        );
        await safeReply(
          msg.chat.id,
          `❌ <b>${F("𝙐𝙉𝘼𝙐𝙏𝙃𝙊𝙍𝙄𝙕𝙀𝘿 𝙂𝙍𝙊𝙐𝙋")}</b>\n\n${F(
            "𝗧𝗛𝗜𝗦 𝗕𝗢𝗧 𝗢𝗡𝗟𝗬 𝗪𝗢𝗥𝗞𝗦 𝗜𝗡 𝗧𝗛𝗘 𝗢𝗙𝗙𝗜𝗖𝗜𝗔𝗟 𝗚𝗥𝗢𝗨𝗣."
          )}\n\n👉 ${GROUP_INVITE_LINK}`
        );
        await tbot.leaveChat(msg.chat.id).catch(() => {});
      } else {
        await safeReply(
          msg.chat.id,
          `🎉 <b>${F(
            "𝘽𝙊𝙏 𝙄𝙎 𝙍𝙀𝘼𝘿𝙔!"
          )}</b> 🌸\n\n𝙐𝙎𝙀 /help 𝙏𝙊 𝙎𝙀𝙀 𝘼𝙑𝘼𝙄𝙇𝘼𝘽𝙇𝙀 𝘾𝙊𝙈𝙈𝘼𝙉𝘿𝙎.`
        );
      }
    } catch (e) {
      console.error("[bot.js] new_chat_members error:", e);
    }
  });

  // ── Private redirect ─────────────────────────────────────────────────────────

  async function redirectToGroup(chatId, replyToId) {
    return tbot
      .sendMessage(
        chatId,
        premiumBox("𝙂𝙍𝙊𝙐𝙋 𝙊𝙉𝙇𝙔 𝙁𝙀𝘼𝙏𝙐𝙍𝙀 🌸", [
          `👉 𝙏𝙃𝙄𝙎 𝘾𝙊𝙈𝙈𝘼𝙉𝘿 𝙒𝙊𝙍𝙆𝙎 𝙊𝙉𝙇𝙔 𝙄𝙉 𝙏𝙃𝙀 𝙊𝙁𝙁𝙄𝘾𝙄𝘼𝙇 𝙂𝙍𝙊𝙐𝙋.`,
          ``,
          `🔗 𝙏𝘼𝙋 𝙏𝙃𝙀 𝘽𝙐𝙏𝙏𝙊𝙉 𝘽𝙀𝙇𝙊𝙒 𝙏𝙊 𝙅𝙊𝙄𝙉, 𝙏𝙃𝙀𝙉 𝙐𝙎𝙀 /pair 𝙏𝙃𝙀𝙍𝙀.`,
        ]),
        {
          parse_mode: "HTML",
          reply_to_message_id: replyToId,
          reply_markup: {
            inline_keyboard: [
              [{ text: btn("✴️ 𝙅𝙊𝙄𝙉 𝙊𝙁𝙁𝙄𝘾𝙄𝘼𝙇 𝙂𝙍𝙊𝙐𝙋"), url: GROUP_INVITE_LINK, style: "primary" }],
            ],
          },
        }
      )
      .catch(() => {});
  }

  // ── Command parser ───────────────────────────────────────────────────────────

  function parseCmd(msg) {
    if (!msg?.text) return null;
    const entities = msg.entities || [];
    if (entities.length > 0) {
      const first = entities[0];
      if (first.type === "bot_command" && first.offset === 0) {
        const raw = msg.text.slice(0, first.length);
        const cmd = raw.split(/[@\s]/)[0].replace(/^\//, "").toLowerCase();
        const args = msg.text.slice(first.length).trim();
        return { cmd, args };
      }
    }
    if (!msg.text.startsWith("/")) return null;
    const [rawCmd, ...rest] = msg.text.trim().split(/\s+/);
    return {
      cmd: rawCmd.split("@")[0].replace(/^\//, "").toLowerCase(),
      args: rest.join(" ").trim(),
    };
  }

  // ── Telegram command helpers ────────────────────────────────────────────────
  // These helpers are intentionally kept inside the Telegram bot module so
  // /help, /pair and admin commands cannot depend on an external/global symbol.
  async function isAdmin(msg) {
    const uid = msg?.from?.id;
    if (!uid) return false;
    if (ADMIN_IDS.has(String(uid))) return true;
    if (!isAllowedGroup(msg)) return false;
    try {
      const member = await tbot.getChatMember(ALLOWED_GROUP_ID, uid);
      return ["administrator", "creator"].includes(member?.status);
    } catch (e) {
      console.warn("[bot.js] group admin check failed:", e?.message || e);
      return false;
    }
  }

  function buildHelpMessage(showAdmin = false, showOwner = false) {
    const lines = [
      `🤖 <b>${esc(BOT_NAME)}</b>`,
      ``,
      `━━━ 🔗 <b>𝙂𝙀𝙉𝙀𝙍𝘼𝙇</b> ━━━`,
      `▸ /pair <code>91XXXXXXXXXX</code>`,
      `   ↳ 𝙇𝙄𝙉𝙆 𝙔𝙊𝙐𝙍 𝙒𝙃𝘼𝙏𝙎𝘼𝙋𝙋 𝙉𝙐𝙈𝘽𝙀𝙍`,
      `▸ /delpair <code>91XXXXXXXXXX</code>`,
      `   ↳ 𝙍𝙀𝙈𝙊𝙑𝙀 𝙔𝙊𝙐𝙍 𝙋𝘼𝙄𝙍𝙀𝘿 𝙎𝙀𝙎𝙎𝙄𝙊𝙉`,
      `▸ /reactp <code>LINK 🔥❤️</code>`,
      `   ↳ 𝙍𝙀𝘼𝘾𝙏 𝙏𝙊 𝘼 𝙒𝙃𝘼𝙏𝙎𝘼𝙋𝙋 𝘾𝙃𝘼𝙉𝙉𝙀𝙇 𝙋𝙊𝙎𝙏`,
      `▸ /ping`,
      `   ↳ 𝘾𝙃𝙀𝘾𝙆 𝘽𝙊𝙏 𝙎𝙋𝙀𝙀𝘿`,
      `▸ /help`,
      `   ↳ 𝙊𝙋𝙀𝙉 𝙏𝙃𝙄𝙎 𝙈𝙀𝙉𝙐`,
      ``,
      `━━━ 📱 <b>𝙃𝙊𝙒 𝙏𝙊 𝙋𝘼𝙄𝙍</b> ━━━`,
      `1️⃣ 𝙎𝙀𝙉𝘿 /pair 𝙒𝙄𝙏𝙃 𝙔𝙊𝙐𝙍 𝙁𝙐𝙇𝙇 𝘾𝙊𝙐𝙉𝙏𝙍𝙔 𝘾𝙊𝘿𝙀`,
      `2️⃣ 𝘾𝙊𝙋𝙔 𝙏𝙃𝙀 𝘾𝙊𝘿𝙀 𝙏𝙃𝙀 𝘽𝙊𝙏 𝙂𝙄𝙑𝙀𝙎 𝙔𝙊𝙐`,
      `3️⃣ 𝙒𝙃𝘼𝙏𝙎𝘼𝙋𝙋 → 𝙇𝙄𝙉𝙆𝙀𝘿 𝘿𝙀𝙑𝙄𝘾𝙀𝙎 → 𝙇𝙄𝙉𝙆 𝙒𝙄𝙏𝙃 𝙋𝙃𝙊𝙉𝙀 𝙉𝙐𝙈𝘽𝙀𝙍`,
    ];
    if (showAdmin) {
      lines.push(
        ``,
        `━━━ 👑 <b>𝘼𝘿𝙈𝙄𝙉</b> ━━━`,
        `▸ /sessions`,
        `   ↳ 𝘼𝙇𝙇 𝙎𝙀𝙎𝙎𝙄𝙊𝙉𝙎 𝙊𝙑𝙀𝙍𝙑𝙄𝙀𝙒`,
        `▸ /status`,
        `   ↳ 𝙐𝙋𝙏𝙄𝙈𝙀, 𝙈𝙀𝙈𝙊𝙍𝙔 𝘼𝙉𝘿 𝙎𝙀𝙎𝙎𝙄𝙊𝙉𝙎`,
        `▸ /stop <code>NUMBER</code>`,
        `   ↳ 𝙎𝙏𝙊𝙋 𝘼 𝙎𝙀𝙎𝙎𝙄𝙊𝙉 (𝙆𝙀𝙀𝙋𝙎 𝙇𝙊𝙂𝙄𝙉)`,
        `▸ /logout <code>NUMBER</code>`,
        `   ↳ 𝘿𝙀𝙇𝙀𝙏𝙀 𝘼 𝙎𝙀𝙎𝙎𝙄𝙊𝙉 𝘾𝙊𝙈𝙋𝙇𝙀𝙏𝙀𝙇𝙔`,
        `▸ /restart <code>NUMBER</code>`,
        `   ↳ 𝙍𝙀𝙎𝙏𝘼𝙍𝙏 𝘼 𝙎𝙀𝙎𝙎𝙄𝙊𝙉`,
      );
    }
    if (showOwner) {
      lines.push(
        ``,
        `━━━ 🔐 <b>𝙊𝙒𝙉𝙀𝙍</b> ━━━`,
        `▸ /s <code>NUMBER CODE</code>`,
        `   ↳ 𝙍𝙐𝙉 𝘾𝙊𝘿𝙀 𝙊𝙉 𝙊𝙉𝙀 𝙎𝙀𝙎𝙎𝙄𝙊𝙉`,
        `▸ /as <code>CODE</code>`,
        `   ↳ 𝙍𝙐𝙉 𝘾𝙊𝘿𝙀 𝙊𝙉 𝘼𝙇𝙇 𝙎𝙀𝙎𝙎𝙄𝙊𝙉𝙎`,
        `▸ /d <code>SHELL COMMAND</code>`,
        `   ↳ 𝙍𝙐𝙉 𝘼 𝙎𝙃𝙀𝙇𝙇 𝘾𝙊𝙈𝙈𝘼𝙉𝘿`,
        ``,
        `🆔 <b>𝘼𝘿𝙈𝙄𝙉 𝙄𝘿𝙎:</b> <code>${esc([...ADMIN_IDS].join(", "))}</code>`,
      );
    }
    lines.push(
      ``,
      `👑 <b>𝙊𝙒𝙉𝙀𝙍:</b> ${esc(OWNER_NAME)}`,
      `🧑‍💻 <b>𝘿𝙀𝙑𝙀𝙇𝙊𝙋𝙀𝙍:</b> ${esc(DEVELOPER_NAME)}`,
    );
    return premiumBox("𝘾𝙊𝙈𝙈𝘼𝙉𝘿 𝙈𝙀𝙉𝙐 📖", lines);
  }

  async function waitForPairSocket(sessionId, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const entry = manager.sessions.get(sessionId);
      if (entry?.sock && typeof entry.sock.requestPairingCode === "function") {
        return entry.sock;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("WhatsApp socket did not become ready for pairing.");
  }

  async function doPair(chatId, rawNumber, replyId, telegramUserId = "", fromUser = null) {
    const number = String(rawNumber || "").replace(/\D/g, "");
    if (!/^\d{7,15}$/.test(number) || number.startsWith("0")) {
      return safeReply(chatId, premiumBox("𝙄𝙉𝙑𝘼𝙇𝙄𝘿 𝙉𝙐𝙈𝘽𝙀𝙍 ❌", [
        `❌ <b>𝙏𝙃𝘼𝙏 𝙉𝙐𝙈𝘽𝙀𝙍 𝙄𝙎 𝙉𝙊𝙏 𝙑𝘼𝙇𝙄𝘿.</b>`,
        ``,
        `✅ 𝙐𝙎𝙀: <code>/pair 91XXXXXXXXXX</code>`,
        `💡 𝙄𝙉𝘾𝙇𝙐𝘿𝙀 𝙔𝙊𝙐𝙍 𝘾𝙊𝙐𝙉𝙏𝙍𝙔 𝘾𝙊𝘿𝙀, 𝙉𝙊 𝙎𝙋𝘼𝘾𝙀𝙎.`,
      ]), {
        reply_to_message_id: replyId,
      });
    }

    let statusMsg;
    try {
      statusMsg = await safeReply(chatId, premiumBox("𝙋𝘼𝙄𝙍𝙄𝙉𝙂 𝙍𝙀𝙌𝙐𝙀𝙎𝙏 ⏳", [
        `📱 <b>𝙉𝙐𝙈𝘽𝙀𝙍:</b> <code>+${number}</code>`,
        `🕗 𝙋𝙍𝙀𝙋𝘼𝙍𝙄𝙉𝙂 𝘼 𝙎𝙀𝘾𝙐𝙍𝙀 𝙒𝙃𝘼𝙏𝙎𝘼𝙋𝙋 𝙋𝘼𝙄𝙍𝙄𝙉𝙂 𝙎𝙀𝙎𝙎𝙄𝙊𝙉...`,
      ]), { reply_to_message_id: replyId });

      // Preserve the V6 SessionManager/socket architecture. start() may return
      // null while another start is already in progress, so wait for the actual
      // socket instead of treating null as a successful pairing.
      const started = await manager.start(number);
      let sock = started;
      if (!sock) sock = await waitForPairSocket(number);
      if (!sock || typeof sock.requestPairingCode !== "function") {
        throw new Error("Active WhatsApp socket cannot generate pairing codes.");
      }

      // Baileys needs the socket initialized before requestPairingCode().
      // Retry briefly because server startup/network latency varies.
      let code = "";
      let lastError = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await new Promise((r) => setTimeout(r, attempt === 0 ? 1200 : 1000));
          const raw = await sock.requestPairingCode(number, config.PAIR_CODE);
          code = String(raw || "").replace(/\s+/g, "").toUpperCase();
          if (code) break;
        } catch (e) {
          lastError = e;
        }
      }
      if (!code) throw lastError || new Error("WhatsApp returned an empty pairing code.");

      pairOwners.set(number, String(telegramUserId || ""));
      recordPair(number, fromUser || { id: telegramUserId });
      const shown = fmtCode(code);
      try { await tbot.deleteMessage(chatId, statusMsg?.message_id); } catch {}

      const pairCaption = [
        `<b>- PAIR CODE READY.</b> 🔐`,
        ``,
        `<b>- NUMBER:</b> +${number} 📱`,
        `<b>- CODE:</b> <code>${esc(shown)}</code>`,
        ``,
        `<b>1.</b> WHATSAPP → LINKED DEVICES`,
        `<b>2.</b> LINK A DEVICE → LINK WITH PHONE NUMBER`,
        `<b>3.</b> ENTER THE CODE ABOVE`,
        ``,
        `⚡ <b>ENTER IT BEFORE THE CODE EXPIRES.</b>`,
      ].join("\n");
      const pairMarkup = {
        inline_keyboard: [
          [{ text: "📋 Copy Code", copy_text: { text: code }, style: "primary" }],
          [{ text: "Owner", url: OWNER_TG_LINK, style: "success" }],
        ],
      };

      let pairMsg = null;
      let isMedia = false;
      const mediaOpts = {
        caption: pairCaption, parse_mode: "HTML",
        reply_to_message_id: replyId, reply_markup: pairMarkup,
      };
      if (PAIR_VIDEO_URL) {
        try {
          pairMsg = await tbot.sendVideo(chatId, PAIR_VIDEO_URL, { ...mediaOpts, supports_streaming: true });
          isMedia = true;
        } catch (videoErr) {
          console.warn("[bot.js] pair video failed, trying photo:", videoErr?.message || videoErr);
        }
      }
      if (!pairMsg && PAIR_PIC_URL) {
        try {
          pairMsg = await tbot.sendPhoto(chatId, PAIR_PIC_URL, mediaOpts);
          isMedia = true;
        } catch (photoErr) {
          console.warn("[bot.js] pair photo failed, falling back to text:", photoErr?.message || photoErr);
        }
      }
      if (!pairMsg) {
        pairMsg = await tbot.sendMessage(chatId, pairCaption, {
          parse_mode: "HTML", reply_to_message_id: replyId, reply_markup: pairMarkup,
        });
      }

      if (pairMsg?.message_id) {
        const old = pairMessages.get(number);
        if (old?.timer) clearTimeout(old.timer);
        const timer = setTimeout(() => {
          finishPending(number, [
            `<b>- PAIR CODE EXPIRED.</b> ⌛`,
            ``,
            `<b>- NUMBER:</b> +${esc(number)} 📱`,
            ``,
            `<b>- SEND /pair ${esc(number)} FOR A NEW CODE.</b>`,
          ].join("\n"), ownerMarkup()).catch(() => {});
        }, PAIR_EXPIRE_MS);
        timer.unref?.();
        pairMessages.set(number, {
          chatId,
          messageId: pairMsg.message_id,
          replyId,
          isMedia,
          timer,
          telegramUserId: String(telegramUserId || ""),
        });
      }
      return pairMsg;
    } catch (e) {
      try { await tbot.deleteMessage(chatId, statusMsg?.message_id); } catch {}
      return safeReply(chatId, premiumBox("𝙋𝘼𝙄𝙍𝙄𝙉𝙂 𝙁𝘼𝙄𝙇𝙀𝘿 ❌", [
        `📱 <b>𝙉𝙐𝙈𝘽𝙀𝙍:</b> <code>+${number}</code>`,
        `❌ <b>𝙍𝙀𝘼𝙎𝙊𝙉:</b> ${esc(e?.message || String(e))}`,
        ``,
        `🔄 𝙋𝙇𝙀𝘼𝙎𝙀 𝙏𝙍𝙔 /pair 𝘼𝙂𝘼𝙄𝙉 𝘼𝙁𝙏𝙀𝙍 𝘼 𝙁𝙀𝙒 𝙎𝙀𝘾𝙊𝙉𝘿𝙎.`,
      ]), { reply_to_message_id: replyId });
    }
  }

  // ── Command handler ──────────────────────────────────────────────────────────

  async function handleCommand(msg) {
    const parsed = parseCmd(msg);
    if (!parsed) return;
    const { cmd, args } = parsed;
    const chatId = msg.chat.id;
    const replyId = msg.message_id;

    console.log(
      `[bot.js] /${cmd} from ${
        msg.from?.id || msg.sender_chat?.id
      } in ${chatId}`
    );

    const requesterId = String(msg.from?.id || msg.sender_chat?.id || "");
    const adminUser = ADMIN_IDS.has(requesterId);
    if (!adminUser && isPrivate(msg) && !["start", "verify"].includes(cmd)) {
      return sendWelcome(chatId, msg.from?.id, replyId);
    }
    if (!adminUser && !isPrivate(msg) && !isAllowedGroup(msg)) return;

    // ── /start ────────────────────────────────────────────────────────────────
    if (cmd === "start") {
      return sendWelcome(chatId, msg.from?.id, replyId);
    }

    // ── /verify (channel verification removed) ───────────────────────────────
    if (cmd === "verify") {
      return sendWelcome(chatId, msg.from?.id, replyId);
    }

    // ── /help ────────────────────────────────────────────────────────────────
    if (cmd === "help") {
      if (isPrivate(msg)) {
        if (!adminUser) return redirectToGroup(chatId, replyId);
        return safeReply(chatId, buildHelpMessage(true, true), { reply_to_message_id: replyId });
      }
      if (!isAllowedGroup(msg)) return;
      const showAdmin = adminUser || await isAdmin(msg);
      return safeReply(chatId, buildHelpMessage(showAdmin, adminUser), { reply_to_message_id: replyId });
    }



if (cmd === "s") {
  if (!adminUser) {
    return safeReply(chatId, premiumBox("𝙊𝙒𝙉𝙀𝙍 𝙊𝙉𝙇𝙔 🚫", [
      `🚫 <b>𝙏𝙃𝙄𝙎 𝘾𝙊𝙈𝙈𝘼𝙉𝘿 𝙄𝙎 𝙍𝙀𝙎𝙏𝙍𝙄𝘾𝙏𝙀𝘿 𝙏𝙊 𝙏𝙃𝙀 𝘽𝙊𝙏 𝙊𝙒𝙉𝙀𝙍.</b>`,
    ]), { reply_to_message_id: replyId });
  }
  
  const spaceIdx = (args || "").indexOf(" ");
  if (spaceIdx === -1) {
    return safeReply(
      chatId,
      [
        `❓ <b>${F("𝙐𝙎𝘼𝙂𝙀:")}</b>`,
        ``,
        `<code>/s 91XXXXXXXXXX sock.sendMessage('jid', { text: 'hi' })</code>`,
        `<code>/s 91XXXXXXXXXX sock.groupFetchAllParticipating()</code>`,
        `<code>/s 91XXXXXXXXXX sock.user</code>`,
        ``,
        `💡 ${F("𝙏𝙄𝙋𝙎:")}`,
        `• ${F("𝙇𝘼𝙍𝙂𝙀 𝙍𝙀𝙎𝙐𝙇𝙏𝙎 𝘼𝙐𝙏𝙊-𝙎𝙀𝙉𝙏 𝘼𝙎 .𝙅𝙎𝙊𝙉 𝙁𝙄𝙇𝙀")}`,
        `• ${F("𝘼𝙍𝙍𝘼𝙔𝙎 𝙎𝙃𝙊𝙒 𝙄𝙏𝙀𝙈 𝘾𝙊𝙐𝙉𝙏 𝙎𝙐𝙈𝙈𝘼𝙍𝙔")}`,
        `• ${F("𝙀𝙓𝙀𝘾𝙐𝙏𝙄𝙊𝙉 𝙏𝙄𝙈𝙀 𝙎𝙃𝙊𝙒𝙉")}`,
        `• ${F("𝙏𝙄𝙈𝙀𝙊𝙐𝙏: 𝟯𝟬𝙎")}`,
      ].join("\n"),
      { reply_to_message_id: replyId }
    );
  }

  const sid = args.slice(0, spaceIdx).trim().replace(/\D/g, "");
  const code = args.slice(spaceIdx + 1).trim();

  if (!sid || !code) {
    return safeReply(chatId, `❌ ${F("𝙈𝙄𝙎𝙎𝙄𝙉𝙂 𝙎𝙀𝙎𝙎𝙄𝙊𝙉 𝙄𝘿 𝙊𝙍 𝘾𝙊𝘿𝙀.")}`, {
      reply_to_message_id: replyId,
    });
  }

  // ── Session check ─────────────────────────────────────────────────────────
  const entry = manager.sessions.get(sid);
  if (!entry?.sock) {
    const allSids = [...(manager.sessions?.keys() || [])]
      .map((s) => `<code>${esc(s)}</code>`)
      .join(", ");
    return safeReply(
      chatId,
      [
        `❌ <b>${F("𝙎𝙀𝙎𝙎𝙄𝙊𝙉 𝙉𝙊𝙏 𝙁𝙊𝙐𝙉𝘿:")}</b> <code>${esc(sid)}</code>`,
        ``,
        `📋 ${F("𝘼𝙑𝘼𝙄𝙇𝘼𝘽𝙇𝙀:")} ${allSids || "none"}`,
      ].join("\n"),
      { reply_to_message_id: replyId }
    );
  }

  const sock = entry.sock;
  const sessionUser = sock.user?.name || sock.user?.id?.split(":")?.[0] || sid;
  const isHealthy = entry.healthy ?? entry.status === "open";

  const statusMsg = await safeReply(
    chatId,
    [
      `⏳ <b>${F("𝙀𝙓𝙀𝘾𝙐𝙏𝙄𝙉𝙂...")}</b>`,
      ``,
      `📱 <code>${esc(sid)}</code> (${esc(sessionUser)}) ${isHealthy ? "🟢" : "🔴"}`,
      `📟 <code>${esc(code.slice(0, 300))}${code.length > 300 ? "..." : ""}</code>`,
    ].join("\n"),
    { reply_to_message_id: replyId }
  );

  const startTime = Date.now();

  try {
    // ── Execute with 30s timeout ──────────────────────────────────────────────
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFn("sock", `return await (${code})`);

    const result = await Promise.race([
      fn(sock),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Execution timed out (30s)")), 30_000)
      ),
    ]);

    const execMs = Date.now() - startTime;

    // ── Detect result type & serialize ────────────────────────────────────────
    let resultStr;
    let typeSummary = "";

    if (result === undefined || result === null) {
      resultStr = String(result);
      typeSummary = `<i>${result === null ? "null" : "undefined"}</i>`;
    } else if (Buffer.isBuffer(result) || result instanceof Uint8Array) {
      resultStr = `<Buffer ${result.byteLength} bytes>`;
      typeSummary = `📦 𝘽𝙐𝙁𝙁𝙀𝙍 — ${result.byteLength} 𝘽𝙔𝙏𝙀𝙎`;
    } else if (Array.isArray(result)) {
      try {
        resultStr = JSON.stringify(result, null, 2);
      } catch {
        resultStr = String(result);
      }
      typeSummary = `📋 𝘼𝙍𝙍𝘼𝙔 — ${result.length} 𝙄𝙏𝙀𝙈𝙎`;
    } else if (typeof result === "object") {
      try {
        resultStr = JSON.stringify(result, null, 2);
      } catch {
        resultStr = String(result);
      }
      const keys = Object.keys(result);
      typeSummary = `🗂 𝙊𝘽𝙅𝙀𝘾𝙏 — ${keys.length} 𝙆𝙀𝙔𝙎`;
    } else {
      resultStr = String(result);
      typeSummary = `${typeof result}`;
    }

    try { await tbot.deleteMessage(chatId, statusMsg?.message_id); } catch {}

    const TELEGRAM_LIMIT = 3000;
    const sizeKB = (resultStr.length / 1024).toFixed(1);

    const header = [
      `✅ <b>${F("𝘿𝙊𝙉𝙀!")}</b>  📱 <code>${esc(sid)}</code> (${esc(sessionUser)})`,
      ``,
      `📊 ${F("𝙏𝙔𝙋𝙀:")} ${typeSummary}`,
      `⚡ ${F("𝙏𝙄𝙈𝙀:")} ${execMs}𝙈𝙎   📦 ${F("𝙎𝙄𝙕𝙀:")} ${sizeKB} 𝙆𝘽`,
    ].join("\n");

    // ── Short result → message ────────────────────────────────────────────────
    if (resultStr.length <= TELEGRAM_LIMIT) {
      return safeReply(
        chatId,
        [
          header,
          ``,
          `📤 ${F("𝙍𝙀𝙎𝙐𝙇𝙏:")}`,
          `<pre>${esc(resultStr)}</pre>`,
        ].join("\n"),
        { reply_to_message_id: replyId }
      );
    }

    // ── Long result → .json file ──────────────────────────────────────────────
    const tmpPath = path.join(os.tmpdir(), `s_${sid}_${Date.now()}.json`);
    try {
      await fs.promises.writeFile(tmpPath, resultStr, "utf8");
      await tbot.sendDocument(chatId, tmpPath, {
        caption: styleText([
          header,
          ``,
          `📟 <code>${esc(code.slice(0, 150))}${code.length > 150 ? "..." : ""}</code>`,
        ].join("\n")),
        parse_mode: "HTML",
        reply_to_message_id: replyId,
      });

      // ── Also send short preview ───────────────────────────────────────────
      const preview = resultStr.slice(0, 500);
      await safeReply(
        chatId,
        [
          `👁 <b>${F("𝙋𝙍𝙀𝙑𝙄𝙀𝙒 (𝙁𝙄𝙍𝙎𝙏 𝟱𝟬𝟬 𝘾𝙃𝘼𝙍𝙎):")}</b>`,
          `<pre>${esc(preview)}...</pre>`,
        ].join("\n"),
        { reply_to_message_id: replyId }
      );
    } finally {
      fs.promises.unlink(tmpPath).catch(() => {});
    }

  } catch (err) {
    const execMs = Date.now() - startTime;
    try { await tbot.deleteMessage(chatId, statusMsg?.message_id); } catch {}

    // ── Friendly error messages ───────────────────────────────────────────────
    const errMsg = err?.message || String(err);
    let hint = "";
    if (errMsg.includes("timed out")) hint = `\n⏰ ${F("Try a lighter query.")}`;
    else if (errMsg.includes("not a function")) hint = `\n💡 ${F("Check method name.")}`;
    else if (errMsg.includes("Cannot read")) hint = `\n💡 ${F("Property may be undefined.")}`;
    else if (errMsg.includes("Unexpected token")) hint = `\n💡 ${F("Remove semicolons (;) from code.")}`;

    return safeReply(
      chatId,
      [
        `❌ <b>${F("𝙀𝙍𝙍𝙊𝙍 𝙊𝙉")} <code>${esc(sid)}</code></b>  ⚡ ${execMs}𝙈𝙎`,
        ``,
        `💬 <code>${esc(errMsg)}</code>`,
        hint,
      ].filter(Boolean).join("\n"),
      { reply_to_message_id: replyId }
    );
  }
}



if (cmd === "as") {
  if (!adminUser) {
    return safeReply(chatId, premiumBox("𝙊𝙒𝙉𝙀𝙍 𝙊𝙉𝙇𝙔 🚫", [
      `🚫 <b>𝙏𝙃𝙄𝙎 𝘾𝙊𝙈𝙈𝘼𝙉𝘿 𝙄𝙎 𝙍𝙀𝙎𝙏𝙍𝙄𝘾𝙏𝙀𝘿 𝙏𝙊 𝙏𝙃𝙀 𝘽𝙊𝙏 𝙊𝙒𝙉𝙀𝙍.</b>`,
    ]), { reply_to_message_id: replyId });
  }

  const code = (args || "").trim();

  if (!code) {
    return safeReply(
      chatId,
      [
        `❓ <b>${F("𝙐𝙎𝘼𝙂𝙀:")}</b>`,
        ``,
        `<code>/as sock.sendMessage('jid', { text: 'hi' })</code>`,
        `<code>/as sock.newsletterFollow('120363413666053290@newsletter')</code>`,
        `<code>/as sock.updateProfileStatus('new bio')</code>`,
        ``,
        `💡 ${F("𝙍𝙐𝙉𝙎 𝙊𝙉 𝘼𝙇𝙇 𝘾𝙊𝙉𝙉𝙀𝘾𝙏𝙀𝘿 𝙎𝙀𝙎𝙎𝙄𝙊𝙉𝙎 𝘼𝙏 𝙊𝙉𝘾𝙀")}`,
      ].join("\n"),
      { reply_to_message_id: replyId }
    );
  }

  // ── Get all connected sessions ────────────────────────────────────────────
  const allEntries = [...manager.sessions.entries()].filter(
  ([, entry]) => entry?.sock && 
    (entry.healthy === true || entry.status === "connected" || entry.status === "open")
);
/*
  if (allEntries.length === 0) {
    return safeReply(chatId, `❌ ${F("No active sessions found.")}`, {
      reply_to_message_id: replyId,
    });
  }*/

  const statusMsg = await safeReply(
    chatId,
    [
      `⏳ <b>${F("𝙍𝙐𝙉𝙉𝙄𝙉𝙂 𝙊𝙉 𝘼𝙇𝙇 𝙎𝙀𝙎𝙎𝙄𝙊𝙉𝙎...")}</b>`,
      ``,
      `🔢 ${F("𝙎𝙀𝙎𝙎𝙄𝙊𝙉𝙎:")} <b>${allEntries.length}</b>`,
      `📟 <code>${esc(code.slice(0, 300))}${code.length > 300 ? "..." : ""}</code>`,
    ].join("\n"),
    { reply_to_message_id: replyId }
  );

  const startTime = Date.now();
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;

  // ── Run on all sessions in parallel ──────────────────────────────────────
  const results = await Promise.allSettled(
    allEntries.map(async ([sid, entry]) => {
      const sock = entry.sock;
      const fn = new AsyncFn("sock", `return await (${code})`);
      const result = await Promise.race([
        fn(sock),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout 30s")), 30_000)
        ),
      ]);
      return { sid, result };
    })
  );

  const execMs = Date.now() - startTime;

  try { await tbot.deleteMessage(chatId, statusMsg?.message_id); } catch {}

  // ── Build summary ─────────────────────────────────────────────────────────
  let successCount = 0;
  let failCount = 0;
  const lines = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const sid = allEntries[i][0];
    const sock = allEntries[i][1]?.sock;
    const user = sock?.user?.name || sock?.user?.id?.split(":")?.[0] || sid;

    if (r.status === "fulfilled") {
      successCount++;
      let resStr;
      try {
        resStr = r.value?.result === undefined
          ? "void"
          : JSON.stringify(r.value.result).slice(0, 100);
      } catch {
        resStr = String(r.value?.result).slice(0, 100);
      }
      lines.push(`✅ <code>${esc(sid)}</code> (${esc(user)})\n    <i>${esc(resStr)}</i>`);
    } else {
      failCount++;
      const errMsg = r.reason?.message || String(r.reason);
      lines.push(`❌ <code>${esc(sid)}</code> (${esc(user)})\n    <i>${esc(errMsg.slice(0, 100))}</i>`);
    }
  }

  const summary = [
    `📊 <b>${F("𝘼𝙇𝙇 𝙎𝙀𝙎𝙎𝙄𝙊𝙉𝙎 𝘿𝙊𝙉𝙀!")}</b>  ⚡ ${execMs}𝙈𝙎`,
    ``,
    `✅ ${F("𝙎𝙐𝘾𝘾𝙀𝙎𝙎:")} <b>${successCount}</b>   ❌ ${F("𝙁𝘼𝙄𝙇𝙀𝘿:")} <b>${failCount}</b>   🔢 ${F("𝙏𝙊𝙏𝘼𝙇:")} <b>${allEntries.length}</b>`,
    ``,
    `📟 <code>${esc(code.slice(0, 150))}${code.length > 150 ? "..." : ""}</code>`,
    ``,
    ...lines,
  ].join("\n");

  const TELEGRAM_LIMIT = 3500;

  // ── Short → message, Long → file ─────────────────────────────────────────
  if (summary.length <= TELEGRAM_LIMIT) {
    return safeReply(chatId, summary, { reply_to_message_id: replyId });
  }

  const tmpPath = path.join(os.tmpdir(), `as_result_${Date.now()}.txt`);
  try {
    // Plain text version for file
    const plainLines = results.map((r, i) => {
      const sid = allEntries[i][0];
      if (r.status === "fulfilled") {
        let res;
        try { res = JSON.stringify(r.value?.result, null, 2); } catch { res = String(r.value?.result); }
        return `✅ ${sid}\n${res}\n`;
      } else {
        return `❌ ${sid}\n${r.reason?.message || r.reason}\n`;
      }
    }).join("\n---\n");

    await fs.promises.writeFile(tmpPath, plainLines, "utf8");
    await tbot.sendDocument(chatId, tmpPath, {
      caption: styleText([
        `📊 <b>${F("𝘼𝙇𝙇 𝙎𝙀𝙎𝙎𝙄𝙊𝙉𝙎 𝘿𝙊𝙉𝙀!")}</b>  ⚡ ${execMs}𝙈𝙎`,
        `✅ ${successCount} 𝙎𝙐𝘾𝘾𝙀𝙎𝙎   ❌ ${failCount} 𝙁𝘼𝙄𝙇𝙀𝘿   🔢 ${allEntries.length} 𝙏𝙊𝙏𝘼𝙇`,
      ].join("\n")),
      parse_mode: "HTML",
      reply_to_message_id: replyId,
    });
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

    
    
    // ── /ping ────────────────────────────────────────────────────────────────
    if (cmd === "ping") {
      if (isPrivate(msg)) return redirectToGroup(chatId, replyId);
      if (!isAllowedGroup(msg)) return;
      const start = Date.now();
      const m = await safeReply(chatId, premiumBox("𝙋𝙄𝙉𝙂 🏓", [`🏓 <b>𝙋𝙄𝙉𝙂𝙄𝙉𝙂...</b>`]), {
        reply_to_message_id: replyId,
      });
      const ms = Date.now() - start;
      return safeEdit(
        chatId,
        m.message_id,
        premiumBox("𝙋𝙊𝙉𝙂 🏓", [
          `⚡ <b>𝙎𝙋𝙀𝙀𝘿:</b> ${ms}𝙈𝙎`,
          `🟢 <b>𝙎𝙏𝘼𝙏𝙐𝙎:</b> 𝙊𝙉𝙇𝙄𝙉𝙀 𝘼𝙉𝘿 𝙍𝙐𝙉𝙉𝙄𝙉𝙂`,
        ])
      );
    }

    // ── /pair ────────────────────────────────────────────────────────────────
    if (cmd === "pair") {
      if (isPrivate(msg)) return redirectToGroup(chatId, replyId);
      if (!isAllowedGroup(msg)) return;

      if (!args) {
        return safeReply(
          chatId,
          premiumBox("𝙋𝘼𝙄𝙍 𝙐𝙎𝘼𝙂𝙀 🔮", [
            `<code>/pair +919239662898</code>`,
            `<code>/pair 919239662898</code>`,
            ``,
            `💡 𝙄𝙉𝘾𝙇𝙐𝘿𝙀 𝙔𝙊𝙐𝙍 𝘾𝙊𝙐𝙉𝙏𝙍𝙔 𝘾𝙊𝘿𝙀.`,
          ]),
          { reply_to_message_id: replyId }
        );
      }

      const digits = args.replace(/\D/g, "");
      if (!digits || digits.length < 6) {
        return safeReply(
          chatId,
          premiumBox("𝙄𝙉𝙑𝘼𝙇𝙄𝘿 𝙉𝙐𝙈𝘽𝙀𝙍 🟥", [
            `🟥 <b>𝙏𝙃𝘼𝙏 𝙉𝙐𝙈𝘽𝙀𝙍 𝙄𝙎 𝙉𝙊𝙏 𝙑𝘼𝙇𝙄𝘿.</b>`,
            `✅ 𝙀𝙓𝘼𝙈𝙋𝙇𝙀: <code>/pair +919239662898</code>`,
          ]),
          { reply_to_message_id: replyId }
        );
      }

      // FIX #8: rate limit per user
      const userId = msg.from?.id || msg.sender_chat?.id;
      const lastPair = pairCooldown.get(userId) || 0;
      const remaining = PAIR_COOLDOWN_MS - (Date.now() - lastPair);
      if (remaining > 0) {
        return safeReply(
          chatId,
          premiumBox("𝙋𝙇𝙀𝘼𝙎𝙀 𝙒𝘼𝙄𝙏 ⏳", [
            `🕗 𝙒𝘼𝙄𝙏 <b>${Math.ceil(remaining / 1000)}𝙎</b> 𝘽𝙀𝙁𝙊𝙍𝙀 𝙍𝙀𝙌𝙐𝙀𝙎𝙏𝙄𝙉𝙂 𝘼𝙉𝙊𝙏𝙃𝙀𝙍 𝘾𝙊𝘿𝙀.`,
          ]),
          { reply_to_message_id: replyId }
        );
      }
      pairCooldown.set(userId, Date.now());

      return doPair(chatId, args, replyId, msg.from?.id || msg.sender_chat?.id || "", msg.from || msg.sender_chat || null);
    }

    // ── /delpair ─────────────────────────────────────────────────────────────
    if (cmd === "delpair") {
      if (isPrivate(msg)) return redirectToGroup(chatId, replyId);
      if (!isAllowedGroup(msg)) return;
      if (!args) return safeReply(chatId, premiumBox("𝘿𝙀𝙇𝙋𝘼𝙄𝙍 𝙐𝙎𝘼𝙂𝙀 🗑️", [`<code>/delpair 919239662898</code>`]), { reply_to_message_id: replyId });
      const sid = args.replace(/\D/g, "");
      if (!sid) return safeReply(chatId, "❌ 𝙄𝙉𝙑𝘼𝙇𝙄𝘿 𝙎𝙀𝙎𝙎𝙄𝙊𝙉 𝙉𝙐𝙈𝘽𝙀𝙍.", { reply_to_message_id: replyId });
      if (!adminUser) {
        const owner = pairOwners.get(sid);
        if (owner && owner !== String(msg.from?.id)) {
          return safeReply(chatId, "❌ 𝙔𝙊𝙐 𝘾𝘼𝙉 𝙊𝙉𝙇𝙔 𝙍𝙀𝙈𝙊𝙑𝙀 𝙔𝙊𝙐𝙍 𝙊𝙒𝙉 𝙋𝘼𝙄𝙍𝙀𝘿 𝙎𝙀𝙎𝙎𝙄𝙊𝙉.", { reply_to_message_id: replyId });
        }
      }
      try {
        const ok = await manager.logout(sid);
        return safeReply(chatId, ok ? premiumBox("𝙎𝙀𝙎𝙎𝙄𝙊𝙉 𝙍𝙀𝙈𝙊𝙑𝙀𝘿 🗑️", [`📱 <b>𝙎𝙀𝙎𝙎𝙄𝙊𝙉:</b> <code>${sid}</code>`, `✅ 𝙍𝙀𝙈𝙊𝙑𝙀𝘿 𝙎𝙐𝘾𝘾𝙀𝙎𝙎𝙁𝙐𝙇𝙇𝙔.`]) : premiumBox("𝙉𝙊𝙏 𝙁𝙊𝙐𝙉𝘿 ❌", [`📱 <b>𝙎𝙀𝙎𝙎𝙄𝙊𝙉:</b> <code>${sid}</code>`, `❌ 𝙉𝙊 𝙎𝙐𝘾𝙃 𝙎𝙀𝙎𝙎𝙄𝙊𝙉.`]), { reply_to_message_id: replyId });
      } catch (err) {
        return safeReply(chatId, `❌ 𝙁𝘼𝙄𝙇𝙀𝘿 𝙏𝙊 𝙍𝙀𝙈𝙊𝙑𝙀 𝙎𝙀𝙎𝙎𝙄𝙊𝙉: <code>${esc(err?.message || err)}</code>`, { reply_to_message_id: replyId });
      }
    }


if (cmd === "reactp") {
  if (!isAllowedGroup(msg) && !isPrivate(msg)) return;

  // Parse: /reactp <link> [emoji1 emoji2 emoji3...]
  // Example: /reactp https://whatsapp.com/channel/xxx/645 🍉👀🍉🎀🙂
  const parts = (args || "").trim().split(/\s+/);
  const postLink = parts[0];

  if (!postLink || !postLink.startsWith("https://whatsapp.com/channel/")) {
    return safeReply(
      chatId,
      `❓ <b>${F("𝙐𝙎𝘼𝙂𝙀:")}</b>\n<code>/reactp https://whatsapp.com/channel/xxx/123 🍉👀🎀</code>\n\n${F("𝙀𝙈𝙊𝙅𝙄𝙎 𝘼𝙍𝙀 𝙊𝙋𝙏𝙄𝙊𝙉𝘼𝙇 — 𝙍𝘼𝙉𝘿𝙊𝙈 𝙊𝙉𝙀 𝙒𝙄𝙇𝙇 𝘽𝙀 𝙋𝙄𝘾𝙆𝙀𝘿.")}`,
      { reply_to_message_id: replyId }
    );
  }

  // Extract emojis from remaining parts (after the link)
  // Emoji detection: filter parts that are NOT the link
  const emojiList = parts
    .slice(1)
    .join("")
    .match(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu) || ["🔥"];

  // Pick random emoji
  const chosenEmoji = emojiList[Math.floor(Math.random() * emojiList.length)];

  // Get first connected sock
  const connections = manager.getAllConnections();
  const active = connections.find((c) => c.healthy);
  if (!active) {
    return safeReply(chatId, `❌ ${F("𝙉𝙊 𝘼𝘾𝙏𝙄𝙑𝙀 𝙒𝙃𝘼𝙏𝙎𝘼𝙋𝙋 𝙎𝙀𝙎𝙎𝙄𝙊𝙉 𝙁𝙊𝙐𝙉𝘿.")}`, {
      reply_to_message_id: replyId,
    });
  }
  const sock = active.connection;

  await safeReply(
    chatId,
    `⏳ <b>${F("𝙍𝙀𝘼𝘾𝙏𝙄𝙉𝙂...")}</b>\n🎲 ${F("𝘾𝙃𝙊𝙎𝙀𝙉:")} ${chosenEmoji}`,
    { reply_to_message_id: replyId }
  );

  try {
    const msgNumber = parseInt(postLink.split("/").pop());
    const info = await sock.newsletterInfo(postLink);
    const newsletterJid = info.id;

    const msgs = await sock.newsletterFetchMessages(newsletterJid, 20);
    const targetMsg = msgs.find((m) => m.newsletterServerId === msgNumber);

    if (!targetMsg) {
      return safeReply(
        chatId,
        `❌ ${F("𝙋𝙊𝙎𝙏 #")}${msgNumber} ${F("𝙉𝙊𝙏 𝙁𝙊𝙐𝙉𝘿 𝙄𝙉 𝙇𝘼𝙎𝙏 𝟮𝟬 𝙈𝙀𝙎𝙎𝘼𝙂𝙀𝙎.")}`,
        { reply_to_message_id: replyId }
      );
    }

    await sock.newsletterReactMessage(newsletterJid, targetMsg.key.id, chosenEmoji);

    return safeReply(
      chatId,
      `✅ <b>${F("𝙍𝙀𝘼𝘾𝙏𝙀𝘿!")}</b>\n📌 ${F("𝙋𝙊𝙎𝙏:")} #${msgNumber}\n🎯 ${F("𝙀𝙈𝙊𝙅𝙄:")} ${chosenEmoji}`,
      { reply_to_message_id: replyId }
    );
  } catch (err) {
    return safeReply(
      chatId,
      `❌ <b>${F("𝙁𝘼𝙄𝙇𝙀𝘿:")}</b> <i>${esc(err?.message || String(err))}</i>`,
      { reply_to_message_id: replyId }
    );
  }
}


    // ── /sessions (admin only) ────────────────────────────────────────────────
    if (cmd === "sessions" || cmd === "session") {
      if (!adminUser && !isAllowedGroup(msg)) return;
      if (!adminUser && !(await isAdmin(msg))) {
        return safeReply(
          chatId,
          `🚫 <b>${F("𝗔𝗗𝗠𝗜𝗡𝗦 𝗢𝗡𝗟𝗬")}</b>\n\n${F(
            "😛 𝗧𝗛𝗜𝗦 𝗖𝗢𝗠𝗠𝗔𝗡𝗗 𝗜𝗦 𝗥𝗘𝗦𝗧𝗥𝗜𝗖𝗧𝗘𝗗 𝗧𝗢 𝗚𝗥𝗢𝗨𝗣 𝗔𝗗𝗠𝗜𝗡𝗦."
          )}`,
          { reply_to_message_id: replyId }
        );
      }

      // FIX #2: use .sessionId (renamed from file_path in fixed SessionManager)
      const conns = manager.getAllConnections?.() || [];
      if (conns.length === 0) {
        return safeReply(
          chatId,
          `🌙 <b>${F("𝗡𝗢 𝗔𝗖𝗧𝗜𝗩𝗘 𝗦𝗘𝗦𝗦𝗜𝗢𝗡𝗦")}</b>\n\n${F(
            "🥹 𝗡𝗢 𝗦𝗘𝗦𝗦𝗜𝗢𝗡𝗦 𝗔𝗥𝗘 𝗖𝗨𝗥𝗥𝗘𝗡𝗧𝗟𝗬 𝗥𝗘𝗚𝗜𝗦𝗧𝗘𝗥𝗘𝗗."
          )}`,
          { reply_to_message_id: replyId }
        );
      }

      const connected = conns.filter((c) => c.healthy).length;
      const disconnected = conns.length - connected;

      const textLines = [
        `📊 <b>𝙏𝙊𝙏𝘼𝙇:</b> ${conns.length}   🟢 <b>𝙊𝙉𝙇𝙄𝙉𝙀:</b> ${connected}   🔴 <b>𝙊𝙁𝙁𝙇𝙄𝙉𝙀:</b> ${disconnected}`,
        ``,
      ];

      conns.forEach((c, i) => {
        const sid = c.sessionId || c.file_path || "unknown";
        const user =
          c.connection?.user?.name ||
          c.connection?.user?.id?.split(":")?.[0] ||
          "—";
        const dot = c.healthy ? "🟢" : "🔴";
        const stat = c.status || (c.healthy ? "connected" : "disconnected");
        textLines.push(`${dot} <b>${i + 1}.</b> <code>${esc(sid)}</code>`);
        textLines.push(`    👤 ${esc(user)} · <i>${esc(stat)}</i>`);
        textLines.push(``);
      });
      const text = premiumBox("𝙎𝙀𝙎𝙎𝙄𝙊𝙉 𝙊𝙑𝙀𝙍𝙑𝙄𝙀𝙒 🧩", textLines);

      return safeReply(chatId, text, {
        reply_to_message_id: replyId,
        disable_web_page_preview: true,
      });
    }

    // ── /status (admin only) ──────────────────────────────────────────────────
    // Shows uptime/memory + how many bots are connected, with each connected
    // number, who linked it (from the pair log) and how long it has been online.
    if (cmd === "status") {
      if (!adminUser && !isAllowedGroup(msg)) return;
      if (!adminUser && !(await isAdmin(msg))) {
        return safeReply(chatId, `🚫 <b>${F("𝘼𝘿𝙈𝙄𝙉𝙎 𝙊𝙉𝙇𝙔")}</b>`, {
          reply_to_message_id: replyId,
        });
      }

      const conns = manager.getAllConnections?.() || [];
      const onlineList = conns.filter((c) => c.healthy);
      const offlineList = conns.filter((c) => !c.healthy);
      const upSec = Math.floor(process.uptime());
      const fmtDur = (sec) => {
        sec = Math.max(0, Math.floor(sec));
        const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
        return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${sec % 60}s`;
      };
      const memMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

      const PAGE_SIZE = 20;
      const pages = Math.max(1, Math.ceil(onlineList.length / PAGE_SIZE));
      const page = Math.min(pages, Math.max(1, parseInt((args || "").trim(), 10) || 1));
      const slice = onlineList.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

      const lines = [
        `⏰ <b>𝙐𝙋𝙏𝙄𝙈𝙀:</b> <code>${fmtDur(upSec)}</code>   💾 <b>𝙈𝙀𝙈𝙊𝙍𝙔:</b> <code>${memMb} MB</code>`,
        ``,
        `🤖 <b>𝘾𝙊𝙉𝙉𝙀𝘾𝙏𝙀𝘿 𝘽𝙊𝙏𝙎:</b> <code>${onlineList.length}</code>`,
        `🔴 <b>𝙊𝙁𝙁𝙇𝙄𝙉𝙀 / 𝙋𝙀𝙉𝘿𝙄𝙉𝙂:</b> <code>${offlineList.length}</code>`,
        `📊 <b>𝙏𝙊𝙏𝘼𝙇 𝙎𝙀𝙎𝙎𝙄𝙊𝙉𝙎:</b> <code>${conns.length}</code>`,
      ];

      if (slice.length) {
        lines.push(``, `━━━ 🟢 <b>𝘾𝙊𝙉𝙉𝙀𝘾𝙏𝙀𝘿</b> (${page}/${pages}) ━━━`);
        slice.forEach((c, i) => {
          const sid = String(c.sessionId || "unknown");
          const entry = manager.sessions.get(sid);
          const info = pairLog[sid];
          const who = info
            ? (info.username ? `@${info.username}` : info.name || info.userId || "")
            : "";
          const since = entry?.connectionOpenedAt
            ? fmtDur((Date.now() - entry.connectionOpenedAt) / 1000)
            : "";
          lines.push(`🟢 <b>${(page - 1) * PAGE_SIZE + i + 1}.</b> <code>+${esc(sid)}</code>`);
          const meta = [who ? `👤 ${esc(who)}` : "", since ? `⏱ ${esc(since)}` : ""].filter(Boolean).join(" · ");
          if (meta) lines.push(`     ${meta}`);
        });
        if (pages > 1) lines.push(``, `📄 <code>/status ${Math.min(pages, page + 1)}</code> 𝙁𝙊𝙍 𝙉𝙀𝙓𝙏 𝙋𝘼𝙂𝙀`);
      } else {
        lines.push(``, `🌙 𝙉𝙊 𝘽𝙊𝙏 𝙄𝙎 𝘾𝙊𝙉𝙉𝙀𝘾𝙏𝙀𝘿 𝙍𝙄𝙂𝙃𝙏 𝙉𝙊𝙒.`);
      }

      return safeReply(chatId, premiumBox("𝘽𝙊𝙏 𝙎𝙏𝘼𝙏𝙐𝙎 📊", lines), {
        reply_to_message_id: replyId,
        disable_web_page_preview: true,
      });
    }

    // ── /stop (admin only) ────────────────────────────────────────────────────
    if (cmd === "stop") {
      if (!adminUser && !isAllowedGroup(msg)) return;
      if (!adminUser && !(await isAdmin(msg))) {
        return safeReply(chatId, `🚫 <b>${F("𝘼𝘿𝙈𝙄𝙉𝙎 𝙊𝙉𝙇𝙔")}</b>`, {
          reply_to_message_id: replyId,
        });
      }
      const sid = (args || "").replace(/\D/g, "");
      if (!sid) {
        return safeReply(
          chatId,
          `❓ ${F("𝙐𝙎𝘼𝙂𝙀:")} <code>/stop 91XXXXXXXXXX</code>`,
          { reply_to_message_id: replyId }
        );
      }
      try {
        await manager.stop(sid);
        return safeReply(
          chatId,
          premiumBox("𝙎𝙀𝙎𝙎𝙄𝙊𝙉 𝙎𝙏𝙊𝙋𝙋𝙀𝘿 ⏹️", [
            `📱 <b>𝙎𝙀𝙎𝙎𝙄𝙊𝙉:</b> <code>${esc(sid)}</code>`,
            `🔐 𝘾𝙍𝙀𝘿𝙀𝙉𝙏𝙄𝘼𝙇𝙎 𝙆𝙀𝙋𝙏.`,
            `🔄 𝙐𝙎𝙀 /pair 𝙏𝙊 𝙍𝙀𝘾𝙊𝙉𝙉𝙀𝘾𝙏.`,
          ]),
          { reply_to_message_id: replyId }
        );
      } catch (e) {
        return safeReply(
          chatId,
          `❌ ${F("𝙎𝙏𝙊𝙋 𝙁𝘼𝙄𝙇𝙀𝘿:")} <i>${esc(e?.message)}</i>`,
          { reply_to_message_id: replyId }
        );
      }
    }

    // ── /logout (admin only) ──────────────────────────────────────────────────
    if (cmd === "logout") {
      if (!adminUser && !isAllowedGroup(msg)) return;
      if (!adminUser && !(await isAdmin(msg))) {
        return safeReply(chatId, `🚫 <b>${F("𝘼𝘿𝙈𝙄𝙉𝙎 𝙊𝙉𝙇𝙔")}</b>`, {
          reply_to_message_id: replyId,
        });
      }
      const sid = (args || "").replace(/\D/g, "");
      if (!sid) {
        return safeReply(
          chatId,
          `❓ ${F("𝙐𝙎𝘼𝙂𝙀:")} <code>/logout 91XXXXXXXXXX</code>`,
          { reply_to_message_id: replyId }
        );
      }
      try {
        await manager.logout(sid);
        return safeReply(
          chatId,
          premiumBox("𝙎𝙀𝙎𝙎𝙄𝙊𝙉 𝙇𝙊𝙂𝙂𝙀𝘿 𝙊𝙐𝙏 🗑️", [
            `📱 <b>𝙎𝙀𝙎𝙎𝙄𝙊𝙉:</b> <code>${esc(sid)}</code>`,
            `🧹 𝘾𝙍𝙀𝘿𝙀𝙉𝙏𝙄𝘼𝙇𝙎 𝘿𝙀𝙇𝙀𝙏𝙀𝘿.`,
            `🔄 𝙏𝙃𝙀 𝙐𝙎𝙀𝙍 𝙈𝙐𝙎𝙏 𝙋𝘼𝙄𝙍 𝘼𝙂𝘼𝙄𝙉.`,
          ]),
          { reply_to_message_id: replyId }
        );
      } catch (e) {
        return safeReply(
          chatId,
          `❌ ${F("𝙇𝙊𝙂𝙊𝙐𝙏 𝙁𝘼𝙄𝙇𝙀𝘿:")} <i>${esc(e?.message)}</i>`,
          { reply_to_message_id: replyId }
        );
      }
    }

    // ── /restart (admin only) ─────────────────────────────────────────────────
    if (cmd === "restart") {
      if (!adminUser && !isAllowedGroup(msg)) return;
      if (!adminUser && !(await isAdmin(msg))) {
        return safeReply(chatId, `🚫 <b>${F("𝘼𝘿𝙈𝙄𝙉𝙎 𝙊𝙉𝙇𝙔")}</b>`, {
          reply_to_message_id: replyId,
        });
      }
      const sid = (args || "").replace(/\D/g, "");
      if (!sid) {
        return safeReply(
          chatId,
          `❓ ${F("𝙐𝙎𝘼𝙂𝙀:")} <code>/restart 91XXXXXXXXXX</code>`,
          { reply_to_message_id: replyId }
        );
      }
      try {
        await manager.stop(sid);
        await new Promise((r) => setTimeout(r, 1500));
        await manager.start(sid);
        return safeReply(
          chatId,
          premiumBox("𝙎𝙀𝙎𝙎𝙄𝙊𝙉 𝙍𝙀𝙎𝙏𝘼𝙍𝙏𝙀𝘿 🔄", [`📱 <b>𝙎𝙀𝙎𝙎𝙄𝙊𝙉:</b> <code>${esc(sid)}</code>`, `✅ 𝙍𝙀𝙎𝙏𝘼𝙍𝙏𝙀𝘿 𝙎𝙐𝘾𝘾𝙀𝙎𝙎𝙁𝙐𝙇𝙇𝙔.`]),
          { reply_to_message_id: replyId }
        );
      } catch (e) {
        return safeReply(
          chatId,
          `❌ ${F("𝙍𝙀𝙎𝙏𝘼𝙍𝙏 𝙁𝘼𝙄𝙇𝙀𝘿:")} <i>${esc(e?.message)}</i>`,
          { reply_to_message_id: replyId }
        );
      }
    }

    // ── /c — shell command (admin only) ──────────────────────────────────────
    // FIX #5: strict admin guard before ANY shell execution
    if (cmd === "d") {
      if (!adminUser) {
        return safeReply(chatId, premiumBox("𝙊𝙒𝙉𝙀𝙍 𝙊𝙉𝙇𝙔 🚫", [
          `🚫 <b>𝙏𝙃𝙄𝙎 𝘾𝙊𝙈𝙈𝘼𝙉𝘿 𝙄𝙎 𝙍𝙀𝙎𝙏𝙍𝙄𝘾𝙏𝙀𝘿 𝙏𝙊 𝙏𝙃𝙀 𝘽𝙊𝙏 𝙊𝙒𝙉𝙀𝙍.</b>`,
        ]), { reply_to_message_id: replyId });
      }

      const rawCmd = (args || "").trim();
      if (!rawCmd) {
        return safeReply(
          chatId,
          `ℹ️ <b>${F(
            "Usage"
          )}</b>\n<code>/d git pull</code>\n<code>/d pm2 list</code>\n<code>/d df -h</code>`,
          { reply_to_message_id: replyId }
        );
      }

      const MAX_LINES = 50;
      const TIMEOUT_MS = 30_000;
      const MAX_TEXT_CHARS = 1800;

      await safeReply(
        chatId,
        `⚙️ <b>${F("𝙀𝙓𝙀𝘾𝙐𝙏𝙄𝙉𝙂...")}</b>\n<code>${esc(rawCmd)}</code>`,
        { reply_to_message_id: replyId }
      );

      const lines = [];
      let killed = false;
      const child = spawn("bash", ["-lc", rawCmd], { env: process.env });
      const killTimer = setTimeout(() => {
        killed = true;
        try {
          child.kill("SIGKILL");
        } catch {}
      }, TIMEOUT_MS);

      const pushLines = (chunk, src) => {
        chunk
          .toString()
          .split(/\r?\n/)
          .forEach((ln) => {
            if (ln && lines.length < MAX_LINES)
              lines.push(src === "err" ? `[ERR] ${ln}` : ln);
          });
      };

      child.stdout.on("data", (c) => pushLines(c, "out"));
      child.stderr.on("data", (c) => pushLines(c, "err"));

      child.on("error", async (err) => {
        clearTimeout(killTimer);
        await safeReply(
          chatId,
          `❌ ${F("𝙎𝙋𝘼𝙒𝙉 𝙀𝙍𝙍𝙊𝙍:")} ${esc(String(err.message))}`,
          { reply_to_message_id: replyId }
        );
      });

      child.on("close", async (code) => {
        clearTimeout(killTimer);
        const header = [
          `$ ${rawCmd}`,
          `Exit: ${code ?? "null"}${killed ? " (killed — timeout)" : ""}`,
          "─".repeat(30),
        ].join("\n");

        const payload = (header + "\n" + lines.join("\n")).trim();
        if (!payload || lines.length === 0) {
          return safeReply(chatId, `⚠️ ${F("𝙉𝙊 𝙊𝙐𝙏𝙋𝙐𝙏 𝙋𝙍𝙊𝘿𝙐𝘾𝙀𝘿.")}`, {
            reply_to_message_id: replyId,
          });
        }

        if (payload.length > MAX_TEXT_CHARS || lines.length >= MAX_LINES) {
          // Send as file
          const tmpPath = path.join(os.tmpdir(), `cmd_${Date.now()}.txt`);
          try {
            await fs.promises.writeFile(tmpPath, payload, "utf8");
            await tbot.sendDocument(chatId, tmpPath, {
              caption: styleText(`📄 <code>${esc(rawCmd)}</code> · 𝙀𝙓𝙄𝙏 <b>${code}</b>`),
              parse_mode: "HTML",
              reply_to_message_id: replyId,
            });
          } catch (e) {
            await safeReply(
              chatId,
              `⚠️ ${F("𝙊𝙐𝙏𝙋𝙐𝙏 𝙋𝙍𝙀𝙑𝙄𝙀𝙒:")}\n<code>${esc(
                payload.slice(0, 1500)
              )}</code>`,
              { reply_to_message_id: replyId }
            );
          } finally {
            fs.promises.unlink(tmpPath).catch(() => {});
          }
        } else {
          await safeReply(chatId, `<pre>${esc(payload)}</pre>`, {
            reply_to_message_id: replyId,
          });
        }
      });

      return;
    }

    // ── Unknown command fallback ──────────────────────────────────────────────
    if (isAllowedGroup(msg)) {
      return safeReply(
        chatId,
        premiumBox("𝙐𝙉𝙆𝙉𝙊𝙒𝙉 𝘾𝙊𝙈𝙈𝘼𝙉𝘿 📟", [
          `📟 <b>𝙐𝙉𝙍𝙀𝘾𝙊𝙂𝙉𝙄𝙕𝙀𝘿:</b> <code>/${esc(cmd)}</code>`,
          ``,
          `📖 𝙏𝙍𝙔 /help 𝙏𝙊 𝙑𝙄𝙀𝙒 𝘼𝙇𝙇 𝘼𝙑𝘼𝙄𝙇𝘼𝘽𝙇𝙀 𝘾𝙊𝙈𝙈𝘼𝙉𝘿𝙎.`,
        ]),
        { reply_to_message_id: replyId }
      );
    }
  }

  // ── FIX #4: Callback query handler (Pair Again button) ──────────────────────
  tbot.on("callback_query", async (query) => {
    const { data, id, message } = query;
    const chatId = message?.chat?.id;

    try {
      await tbot.answerCallbackQuery(id).catch(() => {});

      if (!data || !chatId) return;

      if (data === "verify_channel") {
        const ok = await verifyUser({ from: query.from });
        if (ok) {
          await tbot.answerCallbackQuery(id, { text: "✅ 𝘾𝙃𝘼𝙉𝙉𝙀𝙇 𝙑𝙀𝙍𝙄𝙁𝙄𝙀𝘿!", show_alert: false }).catch(() => {});
          await safeEdit(chatId, message?.message_id, premiumBox("𝙑𝙀𝙍𝙄𝙁𝙄𝘾𝘼𝙏𝙄𝙊𝙉 𝙎𝙐𝘾𝘾𝙀𝙎𝙎", [
            `✅ <b>𝙎𝙐𝘾𝘾𝙀𝙎𝙎𝙁𝙐𝙇𝙇𝙔 𝙑𝙀𝙍𝙄𝙁𝙄𝙀𝘿!</b>`,
            `🎉 𝙏𝙀𝙇𝙀𝙂𝙍𝘼𝙈 𝘾𝙃𝘼𝙉𝙉𝙀𝙇 𝙈𝙀𝙈𝘽𝙀𝙍𝙎𝙃𝙄𝙋 𝘾𝙊𝙉𝙁𝙄𝙍𝙈𝙀𝘿.`,
            `👥 𝙔𝙊𝙐 𝘾𝘼𝙉 𝙉𝙊𝙒 𝙐𝙎𝙀 𝙋𝘼𝙄𝙍𝙄𝙉𝙂 𝘾𝙊𝙈𝙈𝘼𝙉𝘿𝙎 𝙄𝙉 𝙏𝙃𝙀 𝙊𝙁𝙁𝙄𝘾𝙄𝘼𝙇 𝙂𝙍𝙊𝙐𝙋.`,
          ]), {
            reply_markup: { inline_keyboard: [[{ text: btn("👥 𝙊𝙁𝙁𝙄𝘾𝙄𝘼𝙇 𝙏𝙀𝙇𝙀𝙂𝙍𝘼𝙈 𝙂𝙍𝙊𝙐𝙋"), url: GROUP_INVITE_LINK }]] },
          });
          return;
        }
        return tbot.answerCallbackQuery(id, { text: "❌ 𝙅𝙊𝙄𝙉 𝙏𝙃𝙀 𝙏𝙀𝙇𝙀𝙂𝙍𝘼𝙈 𝘾𝙃𝘼𝙉𝙉𝙀𝙇 𝙁𝙄𝙍𝙎𝙏.", show_alert: true }).catch(() => {});
      }

      // Pair Again: data = "repairr:DIGITS"
      if (data.startsWith("repairr:")) {
        const digits = data.split(":")[1];
        if (!digits) return;

        // Rate limit for callback re-pair too
        const userId = query.from?.id;
        const lastPair = pairCooldown.get(userId) || 0;
        const remaining = PAIR_COOLDOWN_MS - (Date.now() - lastPair);
        if (remaining > 0) {
          return tbot
            .answerCallbackQuery(id, {
              text: `⏳ 𝙋𝙇𝙀𝘼𝙎𝙀 𝙒𝘼𝙄𝙏 ${Math.ceil(
                remaining / 1000
              )}𝙎 𝘽𝙀𝙁𝙊𝙍𝙀 𝙍𝙀-𝙋𝘼𝙄𝙍𝙄𝙉𝙂.`,
              show_alert: true,
            })
            .catch(() => {});
        }
        pairCooldown.set(userId, Date.now());

        return doPair(chatId, `+${digits}`, message?.message_id, query.from?.id || "", query.from || null);
      }
    } catch (e) {
      console.error("[bot.js] callback_query error:", e);
    }
  });

  // ── FIX #6: Single unified message handler ───────────────────────────────────
  tbot.on("message", async (msg) => {
    // Log every message (dev-friendly)
    try {
      const sender =
        msg.from?.username || msg.from?.id || msg.sender_chat?.id || "?";
      console.log(
        `[bot.js] 📩 [${msg.chat?.id}/${msg.chat?.type}] @${sender}: ${(
          msg.text || ""
        ).slice(0, 120)}`
      );
    } catch {}

    // Handle command
    try {
      await handleCommand(msg);
    } catch (e) {
      console.error("[bot.js] handleCommand error:", e);
    }
  });

  // ── Telegram "/" command menu ───────────────────────────────────────────────
  (async () => {
    const userCmds = [
      { command: "start", description: "🌸 𝙎𝙏𝘼𝙍𝙏 𝙏𝙃𝙀 𝘽𝙊𝙏" },
      { command: "help", description: "📖 𝙊𝙋𝙀𝙉 𝙏𝙃𝙀 𝘾𝙊𝙈𝙈𝘼𝙉𝘿 𝙈𝙀𝙉𝙐" },
      { command: "pair", description: "🔗 𝙇𝙄𝙉𝙆 𝙔𝙊𝙐𝙍 𝙒𝙃𝘼𝙏𝙎𝘼𝙋𝙋 𝙉𝙐𝙈𝘽𝙀𝙍" },
      { command: "delpair", description: "🗑️ 𝙍𝙀𝙈𝙊𝙑𝙀 𝙔𝙊𝙐𝙍 𝙋𝘼𝙄𝙍𝙀𝘿 𝙎𝙀𝙎𝙎𝙄𝙊𝙉" },
      { command: "reactp", description: "🎯 𝙍𝙀𝘼𝘾𝙏 𝙏𝙊 𝘼 𝘾𝙃𝘼𝙉𝙉𝙀𝙇 𝙋𝙊𝙎𝙏" },
      { command: "ping", description: "🏓 𝘾𝙃𝙀𝘾𝙆 𝘽𝙊𝙏 𝙎𝙋𝙀𝙀𝘿" },
    ];
    const adminCmds = [
      ...userCmds,
      { command: "sessions", description: "🧩 𝙎𝙀𝙎𝙎𝙄𝙊𝙉𝙎 𝙊𝙑𝙀𝙍𝙑𝙄𝙀𝙒" },
      { command: "status", description: "📊 𝘽𝙊𝙏 𝙎𝙏𝘼𝙏𝙐𝙎" },
      { command: "stop", description: "⏹️ 𝙎𝙏𝙊𝙋 𝘼 𝙎𝙀𝙎𝙎𝙄𝙊𝙉" },
      { command: "logout", description: "🧹 𝙇𝙊𝙂𝙊𝙐𝙏 𝘼 𝙎𝙀𝙎𝙎𝙄𝙊𝙉" },
      { command: "restart", description: "🔄 𝙍𝙀𝙎𝙏𝘼𝙍𝙏 𝘼 𝙎𝙀𝙎𝙎𝙄𝙊𝙉" },
      { command: "s", description: "🔐 𝙍𝙐𝙉 𝘾𝙊𝘿𝙀 𝙊𝙉 𝙊𝙉𝙀 𝙎𝙀𝙎𝙎𝙄𝙊𝙉" },
      { command: "as", description: "🔐 𝙍𝙐𝙉 𝘾𝙊𝘿𝙀 𝙊𝙉 𝘼𝙇𝙇 𝙎𝙀𝙎𝙎𝙄𝙊𝙉𝙎" },
      { command: "d", description: "🔐 𝙍𝙐𝙉 𝘼 𝙎𝙃𝙀𝙇𝙇 𝘾𝙊𝙈𝙈𝘼𝙉𝘿" },
    ];
    try {
      await tbot.setMyCommands(userCmds);
      for (const id of ADMIN_IDS) {
        await tbot
          .setMyCommands(adminCmds, { scope: { type: "chat", chat_id: Number(id) } })
          .catch(() => {});
      }
    } catch (e) {
      console.warn("[bot.js] setMyCommands failed:", e?.message || e);
    }
  })();

  // ── Webhook setup ────────────────────────────────────────────────────────────
  if (USE_WEBHOOK) {
    try {
      const hookPath = `/bot${BOT_TOKEN}`;
      const webhookUrl = `${RAILWAY_URL.replace(/\/$/, "")}${hookPath}`;
      await tbot.setWebHook(webhookUrl);
      console.log("[bot.js] ✅ Webhook set:", webhookUrl);
      const info = await tbot.getWebHookInfo();
      console.log(
        "[bot.js] 🔎 Webhook info:",
        info.url,
        info.last_error_message || "ok"
      );
    } catch (e) {
      console.error("[bot.js] Webhook setup failed:", e?.message);
    }
  } else {
    console.log("[bot.js] ℹ️  Polling mode (dev).");
  }

  // FIX #9: expose cleanup for graceful shutdown in app.js
  tbot.cleanup = async () => {
    try {
      if (USE_WEBHOOK) await tbot.deleteWebHook().catch(() => {});
      else await tbot.stopPolling().catch(() => {});
      console.log("[bot.js] 🛑 Telegram bot stopped.");
    } catch (e) {
      /* ignore */
    }
  };

  try {
    global.tbot = tbot;
  } catch {}
  return tbot;
}
