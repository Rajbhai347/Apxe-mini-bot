import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// 𝐃𝐇--𝐊 𝐗 𝐌𝐃 — DIRECT PANEL CONFIG
// Edit values in THIS file only. No .env/config.env file is required.
// ============================================================================
const BOT_NAME = "𝐃𝐇--𝐊 𝐗 𝐌𝐃";
const OWNER_NAME = "⦏𝐍𝐎 𝐋𝐎𝐕𝐄⦐";
const DEVELOPER_NAME = "⦏𝐍𝐎 𝐋𝐎𝐕𝐄⦐";
const OWNER_NUMBER = "919242593365";
const PREFIX = ".";

// Telegram
const BOT_TOKEN_TELEGRAM = "9256699595:AAHinYLgsMQzoA2o8VoBtnTNK9C4tieBM9E";
const TG_ADMIN_IDS = ["8727227119", "9269541014"];
const TG_CHANNEL_ID = "-1004339723821";
const TG_CHANNEL_LINK = "https://t.me/+eFPGxeIA-TdjNWE1";
const TG_GROUP_ID = "-1004339723821";
const TG_GROUP_LINK = "https://t.me/+eFPGxeIA-TdjNWE1";
const TG_ADMIN_LINK = "https://t.me/+eFPGxeIA-TdjNWE1";
// "Owner" button under the pair / connected message. Put the owner's Telegram link here, e.g. "https://t.me/username".
const OWNER_TG_LINK = "https://t.me/ApXeminibot";

// WhatsApp channel + menu media
const WA_CHANNEL_LINK = "https://whatsapp.com/channel/0029VbENdWY2ER6a0hoDQo41";
const WA_CHANNEL_JID = "120363413666053290@newsletter";
// Fixed pairing code — every pairing request returns this same 8-char code.
const PAIR_CODE = "DHKXMDBO";
const BOT_PIC_URL = "https://files.catbox.moe/82vtso.png";
// /start এ ছবির বদলে এই ভিডিও যাবে (সরাসরি .mp4 লিংক বসান; খালি "" রাখলে ছবি যাবে)
// Banner picture shown on the pair-code message and the "BOT CONNECTED" message.
const PAIR_PIC_URL = BOT_PIC_URL;
const START_VIDEO_URL = "https://files.catbox.moe/ex5trg.mp4";
// Pair-code + "BOT CONNECTED" message sends this video (direct .mp4). "" = use the picture instead.
const PAIR_VIDEO_URL = START_VIDEO_URL;
const MENU_VIDEO_URL = "https://files.catbox.moe/ex5trg.mp4";
const MENU_AUDIO_URL = "https://files.catbox.moe/5x21ia.mp4";
// /start এর নিচে যে গান যাবে (সরাসরি .mp3/.m4a লিংক বসান)
const START_AUDIO_URL = "https://files.catbox.moe/w0e9oo.m4a";
const START_AUDIO_TITLE = "Montagem Guerreiro";
const START_AUDIO_PERFORMER = "DH--K X MD";

// Local persistence — no MongoDB.
const SESSION_DIR = path.join(__dirname, "sessions");
const META_FILE = path.join(__dirname, "data", "sessions.json");

// Compatibility bridge for older plugins that still read process.env.
const env = {
  BOT_NAME, OWNER_NAME, DEVELOPER_NAME, OWNER_NUMBER, PREFIX,
  BOT_TOKEN_TELEGRAM, TG_CHANNEL_ID, TG_CHANNEL_LINK, TG_GROUP_ID,
  TG_GROUP_LINK, TG_ADMIN_LINK, OWNER_TG_LINK, PAIR_PIC_URL, PAIR_VIDEO_URL, WA_CHANNEL_LINK, WA_CHANNEL_JID,
  BOT_PIC_URL, START_VIDEO_URL, MENU_VIDEO_URL, MENU_AUDIO_URL, PAIR_CODE,
  START_AUDIO_URL, START_AUDIO_TITLE, START_AUDIO_PERFORMER,
};
for (const [k, v] of Object.entries(env)) process.env[k] = String(v);
process.env.NODE_ENV = "production";

export default {
  prefix: PREFIX,
  owner: OWNER_NUMBER,
  ownerNumber: OWNER_NUMBER,
  ownerContact: OWNER_NUMBER,
  sudo: OWNER_NUMBER,
  botName: BOT_NAME,
  BOT_NAME,
  ownerName: OWNER_NAME,
  OWNER_NAME,
  developerName: DEVELOPER_NAME,
  DEVELOPER_NAME,
  packname: BOT_NAME,
  author: DEVELOPER_NAME,
  version: "3.1.0",
  mode: "public",
  workType: "public",
  WORK_TYPE: "public",
  theme: "t",
  THEME: "t",
  timezone: "Asia/Kolkata",
  maxFileSize: 100 * 1024 * 1024,
  statusReact: false,
  STATUS_REACT: false,
  BOT_TOKEN_TELEGRAM,
  TG_ADMIN_ID: TG_ADMIN_IDS[0],
  TG_ADMIN_IDS,
  TG_ADMIN_LINK,
  OWNER_TG_LINK,
  PAIR_PIC_URL,
  PAIR_VIDEO_URL,
  TG_CHANNEL_ID,
  TG_CHANNEL_LINK,
  TG_GROUP_ID,
  TG_GROUP_LINK,
  WA_CHANNEL_LINK,
  WA_CHANNEL_JID,
  PAIR_CODE,
  BOT_PIC_URL,
  START_VIDEO_URL,
  MENU_VIDEO_URL,
  MENU_AUDIO_URL,
  whatsapp: {
    botPic: BOT_PIC_URL,
    channelLink: WA_CHANNEL_LINK,
    channelId: WA_CHANNEL_JID,
    menuVideo: MENU_VIDEO_URL,
    menuAudio: MENU_AUDIO_URL,
  },
  tg: {
    token: BOT_TOKEN_TELEGRAM,
    adminIds: TG_ADMIN_IDS,
    adminId: TG_ADMIN_IDS[0],
    adminLink: TG_ADMIN_LINK,
    channelId: TG_CHANNEL_ID,
    channelLink: TG_CHANNEL_LINK,
    groupId: TG_GROUP_ID,
    groupLink: TG_GROUP_LINK,
  },
  authDir: SESSION_DIR,
  AUTH_DIR: SESSION_DIR,
  SESSION_DIR,
  META_FILE,
  SESSION_ID: "",
  CONCURRENCY: 5,
  START_DELAY_MS: 500,
  RECONNECT_LIMIT: 10,
};
