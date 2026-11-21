// lib/songFetch.mjs — resolves a YouTube URL to a direct audio URL using a chain of fallback APIs
import axios from "axios";

const API_BUILDERS = [
  (url) => `https://kiraxmd-api.vercel.app/api/play?query=${encodeURIComponent(url)}`,
  (url) => `https://xenoytdl-2.vercel.app/api/youtube?url=${encodeURIComponent(url)}`,
  (url) => `https://jerrycoder.oggyapi.workers.dev/down/ytmp3-v1?url=${encodeURIComponent(url)}`,
  (url) => `https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(url)}`,
  (url) => `https://eliteprotech-apis.zone.id/ytdown?format=mp3&url=${encodeURIComponent(url)}`,
];

const AUDIO_KEYS = [
  "downloadUrl", "download_url", "download", "audioUrl", "audio_url", "audio",
  "mp3", "mp3Url", "mp3_url", "url", "link", "resultUrl", "result_url",
];

function findAudioCandidate(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string") {
    const v = value.trim();
    if (/^https?:\/\//i.test(v) && /(?:\.mp3(?:\?|$)|audio|mp3|download|ytmp3)/i.test(v)) return v;
    return null;
  }
  if (Array.isArray(value)) {
    for (const x of value) {
      const hit = findAudioCandidate(x, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const k of AUDIO_KEYS) {
      if (value[k]) {
        const hit = findAudioCandidate(value[k], depth + 1);
        if (hit) return hit;
      }
    }
    for (const [k, v] of Object.entries(value)) {
      if (/audio|mp3|download|result/i.test(k)) {
        const hit = findAudioCandidate(v, depth + 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/**
 * fetchSongAudio(youtubeUrl, { timeout }) → { audioUrl, title }
 * Tries each provider in order; throws if all fail.
 */
export async function fetchSongAudio(youtubeUrl, { timeout = 30000 } = {}) {
  const errors = [];
  for (const build of API_BUILDERS) {
    try {
      const res = await axios.get(build(youtubeUrl), {
        timeout,
        validateStatus: () => true,
        headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const audioUrl = findAudioCandidate(res.data);
      if (!audioUrl) throw new Error("no audio URL in response");
      const d = res.data || {};
      return { audioUrl, title: d.title || d.name || d.result?.title || "song" };
    } catch (e) {
      errors.push(e?.message || String(e));
    }
  }
  throw new Error(`All song providers failed (${errors.slice(0, 3).join(" | ")})`);
}

export default { fetchSongAudio };
