import {
  downloadContentFromMessage,
  getContentType,
} from "@whiskeysockets/baileys";

// ── View-once helper ──────────────────────────────────────────────────────────
// WhatsApp often sends a *stripped* copy of a view-once message when someone
// replies to it (no media key / no direct path), so downloading the quoted copy
// fails.  To make `.vv` reliable we remember every incoming view-once message
// (and download its media right away) and look it up later by message id.

const WRAPPERS = new Set([
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
]);
const PLAIN_WRAPPERS = new Set([
  "ephemeralMessage",
  "documentWithCaptionMessage",
  "editedMessage",
]);
const MEDIA = new Set(["imageMessage", "videoMessage", "audioMessage"]);

const MAX_ENTRIES = 40;
const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_BYTES = 30 * 1024 * 1024;
const cache = new Map(); // messageId → { ts, mediaType, content, buffer, pending }

function prune() {
  const now = Date.now();
  for (const [id, e] of cache) if (now - e.ts > TTL_MS) cache.delete(id);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

/** Finds { mediaType, content } of a view-once media inside any wrapper. */
export function extractViewOnce(message) {
  let m = message;
  let viewOnce = false;
  for (let i = 0; i < 6 && m && typeof m === "object"; i++) {
    const keys = Object.keys(m).filter(
      (k) => k !== "messageContextInfo" && k !== "senderKeyDistributionMessage"
    );
    const wrapKey = keys.find((k) => WRAPPERS.has(k));
    if (wrapKey) {
      viewOnce = true;
      m = m[wrapKey]?.message;
      continue;
    }
    const plainKey = keys.find((k) => PLAIN_WRAPPERS.has(k));
    if (plainKey) {
      m = m[plainKey]?.message || m[plainKey]?.message?.message;
      continue;
    }
    break;
  }
  if (!m || typeof m !== "object") return null;
  const type = getContentType(m);
  if (!type || !MEDIA.has(type)) return null;
  const content = m[type];
  if (!content) return null;
  if (!viewOnce && content.viewOnce !== true) return null;
  return { mediaType: type, content };
}

async function downloadBuffer(content, mediaType) {
  const stream = await downloadContentFromMessage(
    content,
    mediaType.replace("Message", "")
  );
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error("Downloaded media was empty");
  return buf;
}

/** Call for EVERY incoming raw message. Cheap when it is not view-once. */
export function rememberViewOnce(rawMsg) {
  try {
    const id = rawMsg?.key?.id;
    if (!id || cache.has(id)) return;
    const found = extractViewOnce(rawMsg.message);
    if (!found) return;
    const entry = { ts: Date.now(), ...found, buffer: null, pending: null };
    cache.set(id, entry);
    prune();
    const size = Number(found.content.fileLength) || 0;
    if (size && size > MAX_BYTES) return;
    entry.pending = downloadBuffer(found.content, found.mediaType)
      .then((b) => {
        entry.buffer = b;
      })
      .catch(() => {})
      .finally(() => {
        entry.pending = null;
      });
  } catch {}
}

function unwrapPlain(m) {
  let cur = m;
  for (let i = 0; i < 5 && cur; i++) {
    const k = Object.keys(cur).find((x) => PLAIN_WRAPPERS.has(x));
    if (!k) break;
    cur = cur[k]?.message;
  }
  return cur || m;
}

function findQuoted(raw) {
  const m = unwrapPlain(raw?.message || {});
  for (const k of Object.keys(m)) {
    const ci = m[k]?.contextInfo;
    if (ci?.quotedMessage) return { quotedMessage: ci.quotedMessage, stanzaId: ci.stanzaId };
  }
  return null;
}

/**
 * Resolves the view-once media a `.vv` command replied to.
 * Returns { mediaType, content, buffer } or { error }.
 */
export async function resolveViewOnce(message) {
  const q = findQuoted(message.raw);
  const quotedId = message.quoted?.id || q?.stanzaId;

  // 1) saved copy from when the message first arrived (most reliable)
  const saved = quotedId ? cache.get(quotedId) : null;
  if (saved) {
    if (saved.pending) await saved.pending;
    if (saved.buffer) return { mediaType: saved.mediaType, content: saved.content, buffer: saved.buffer };
    try {
      const buffer = await downloadBuffer(saved.content, saved.mediaType);
      return { mediaType: saved.mediaType, content: saved.content, buffer };
    } catch {}
  }

  // 2) the quoted copy attached to the reply
  let found = q?.quotedMessage ? extractViewOnce(q.quotedMessage) : null;
  if (!found && message.quoted?.msg) {
    const t = message.quoted.type;
    if (MEDIA.has(t) && message.quoted.msg.viewOnce === true) {
      found = { mediaType: t, content: message.quoted.msg };
    } else if (WRAPPERS.has(t)) {
      found = extractViewOnce({ [t]: message.quoted.msg });
    }
  }
  if (!found) return { error: "NOT_VIEW_ONCE" };

  try {
    const buffer = await downloadBuffer(found.content, found.mediaType);
    return { ...found, buffer };
  } catch (e) {
    return {
      error: "DOWNLOAD_FAILED",
      detail: e?.message || String(e),
      note: "This view-once message arrived before the bot saw it, or it expired.",
    };
  }
}

/** Builds the Baileys payload for a resolved view-once media. */
export function buildPayload({ mediaType, content, buffer }) {
  if (mediaType === "imageMessage") {
    return { image: buffer, caption: content.caption || "*📸 VIEW ONCE IMAGE*\n\n_Successfully retrieved!_" };
  }
  if (mediaType === "videoMessage") {
    return {
      video: buffer,
      caption: content.caption || "*🎥 VIEW ONCE VIDEO*\n\n_Successfully retrieved!_",
      mimetype: content.mimetype || "video/mp4",
    };
  }
  return { audio: buffer, mimetype: content.mimetype || "audio/mpeg", ptt: !!content.ptt };
}
