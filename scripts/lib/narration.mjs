/**
 * The narrator's voice, and the mix that puts it under the picture.
 *
 * Used by `scripts/record-submission.mjs`. Three jobs:
 *
 *   synthesize  one clip per scene, through Cloud Text-to-Speech's Gemini voice
 *               (`gemini-2.5-pro-tts`, Kore, en-IN), directed scene by scene
 *   durationOf  how long a clip really is, so the recording can wait for it
 *   mux         every clip, and the Hindi sample, placed at the moment its scene
 *               began on the recording, levelled, and encoded with the video
 *
 * WHY A DIRECTED VOICE
 * --------------------
 * The first narrated draft of this film read every line in one even tone, and a
 * story that starts with a clinic out of anti-snake venom and ends on a pilot ask
 * cannot be read in one tone without sounding like a machine reading. The Gemini
 * voice takes a direction per clip -- quiet and heavy for the problem, a small
 * smile when the software refuses the officer -- on top of one shared brief about
 * who is speaking and to whom, so the voice stays the same person throughout.
 *
 * WHERE IT RUNS
 * -------------
 * Text-to-Speech is not served from asia-south1. The owner agreed (14 Sep) that
 * the narration may be synthesized there: what is sent is the script, which is
 * already public in docs/demo-script.md, and nothing from the app or its data.
 * Every Gemini call the APP makes still stays in asia-south1.
 *
 * Clips are cached by a hash of voice, direction and text under
 * docs/demo/voice-cache/ (gitignored), so re-recording the picture does not
 * re-buy the voice unless a line changed.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GoogleAuth } from 'google-auth-library';

export const VOICE = { languageCode: 'en-IN', name: 'Kore', modelName: 'gemini-2.5-pro-tts' };

/** Who is speaking, to whom, and how -- shared by every clip so it stays one person. */
export const BRIEF =
  'You are the person who built this, narrating a short demo film to a panel of judges in India. ' +
  'Speak natural Indian English the way a real person talks to people in the same room: warm and ' +
  'conversational, at a lively natural pace, never slow or drawn out, with a real breath between ' +
  'thoughts and emphasis only where you mean it. Vary your pitch like a person does. Never sound ' +
  'like an advertisement, a news reader or a robot. ' +
  'Say numbers naturally, the way an Indian speaker would. In this line: ';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';

let client = null;
async function authClient() {
  if (!client) client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  return client;
}

/**
 * How loud the last 50 ms of a WAV clip is, in dBFS.
 *
 * The Gemini voice sometimes stops mid-syllable: the clip ends at full voice
 * instead of decaying, and the last word of the line is cut ("Grid" was heard as
 * "Breed"). A natural ending falls below -40 dB before the file ends; one that
 * is still above -35 dB has been truncated. It is not the encoding or the sample
 * rate -- the same request truncates on one take and not the next -- so a
 * truncated take is simply taken again.
 */
export function tailDb(file) {
  const buf = readFileSync(file);
  let at = 12;
  let rate = 24000;
  let bits = 16;
  let data = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      rate = buf.readUInt32LE(at + 12);
      bits = buf.readUInt16LE(at + 22);
    } else if (id === 'data') {
      data = buf.subarray(at + 8, Math.min(buf.length, at + 8 + size));
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!data || bits !== 16) return -120;
  const samples = Math.min(Math.floor(rate * 0.05), Math.floor(data.length / 2));
  let sum = 0;
  for (let i = data.length - samples * 2; i < data.length - 1; i += 2) {
    const v = data.readInt16LE(i) / 32768;
    sum += v * v;
  }
  return 10 * Math.log10(sum / samples + 1e-12);
}

/** A take that ends at full voice has lost its last syllable. */
const TRUNCATED_DB = -35;
const TAKES = 5;

/**
 * One scene's clip, as a 24 kHz mono WAV, from the cache when the line is unchanged.
 * `project` is billed for the call and must have the Text-to-Speech API enabled.
 */
export async function synthesize({ speech, direction }, { cacheDir, project }) {
  mkdirSync(cacheDir, { recursive: true });
  const key = createHash('sha256')
    .update(JSON.stringify({ VOICE, BRIEF, speech, direction }))
    .digest('hex')
    .slice(0, 24);
  const file = resolve(cacheDir, key + '.wav');
  if (existsSync(file) && tailDb(file) < TRUNCATED_DB) return file;
  // Keep the cleanest ending of up to TAKES tries.
  let best = existsSync(file) ? { db: tailDb(file), bytes: readFileSync(file) } : null;
  for (let take = 0; take < TAKES; take++) {
    const bytes = await requestClip({ speech, direction }, project);
    writeFileSync(file, bytes);
    const db = tailDb(file);
    if (!best || db < best.db) best = { db, bytes };
    if (db < TRUNCATED_DB) return file;
  }
  writeFileSync(file, best.bytes);
  return file;
}

async function requestClip({ speech, direction }, project) {
  const auth = await authClient();
  let lastError;
  // The Pro voice has a small per-minute quota on a new project, so a 429 is
  // waited out rather than treated as a failure.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await auth.request({
        url: 'https://texttospeech.googleapis.com/v1/text:synthesize',
        method: 'POST',
        headers: { 'x-goog-user-project': project },
        timeout: 120_000,
        data: {
          input: { text: speech, prompt: BRIEF + direction },
          voice: VOICE,
          audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
        },
      });
      return Buffer.from(res.data.audioContent, 'base64');
    } catch (e) {
      lastError = e;
      const status = e.response?.status ?? 0;
      if (status && status < 500 && status !== 429) break;
      await new Promise((r) => setTimeout(r, status === 429 ? 30_000 + attempt * 15_000 : 2000 * 2 ** attempt));
    }
  }
  throw new Error('text-to-speech failed: ' + (lastError?.response?.data?.error?.message ?? lastError?.message));
}

/** Seconds, as ffprobe reads the container. */
export function durationOf(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
    encoding: 'utf8',
  });
  return Number(out.trim());
}

const srtTime = (ms) => {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':') + ',' + String(Math.floor(ms % 1000)).padStart(3, '0');
};

/** Subtitles for an upload that wants them as a file rather than burned in. */
export function srt(cues) {
  return cues
    .map((c, i) => i + 1 + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\n' + c.text + '\n')
    .join('\n');
}

/**
 * Put the voice under the picture.
 *
 * `clips` are `{ file, at }` with `at` in milliseconds on the RAW recording;
 * `trimMs` is cut from the front (the blank page before the first scene) and
 * `endMs` is where the film ends on the raw recording. Each clip is levelled on
 * its own first, so a quiet line and an emphatic one sit at the same loudness,
 * then the mix is levelled for delivery (-16 LUFS, the level video platforms
 * normalise speech to).
 */
export function mux({ video, clips, trimMs, endMs, out }) {
  const args = ['-y', '-v', 'error', '-ss', (trimMs / 1000).toFixed(3), '-i', video];
  const parts = [];
  clips.forEach((c, i) => {
    args.push('-i', c.file);
    const delay = Math.max(0, Math.round(c.at - trimMs));
    parts.push(
      `[${i + 1}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `loudnorm=I=-18:TP=-2:LRA=9${c.gain ? `,volume=${c.gain}` : ''},adelay=${delay}|${delay}[a${i}]`,
    );
  });
  const inputs = clips.map((_, i) => `[a${i}]`).join('');
  const filter =
    parts.join(';') +
    `;${inputs}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11,` +
    `aresample=48000[mix]`;
  args.push(
    '-filter_complex', filter,
    '-map', '0:v', '-map', '[mix]',
    '-t', ((endMs - trimMs) / 1000).toFixed(3),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    out,
  );
  execFileSync(FFMPEG, args, { stdio: 'inherit' });
  return out;
}
