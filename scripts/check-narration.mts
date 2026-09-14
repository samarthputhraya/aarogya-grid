/**
 * Listen to the narration before a judge does.
 *
 * Run:  npx tsx scripts/check-narration.mts <log of record-submission --voice-only>
 *       npx tsx scripts/check-narration.mts docs/demo/voice-cache/<clip>.wav "expected text"
 *
 * Nobody on the build can hear a clip from a terminal, and a synthetic voice
 * fails in ways a transcript of the SCRIPT never shows: a number read digit by
 * digit, "ANM" read as a word, a flat line where the direction asked for an
 * ache. So each clip goes back through Gemini on Vertex AI in asia-south1, which
 * transcribes what it actually hears and describes how it is delivered. A clip
 * whose words drift from the line, or that is called robotic or flat, is named
 * so it can be re-directed before a take is recorded over it.
 *
 * This is a second opinion, not a substitute for a person listening once; the
 * owner hears the film before it is submitted.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

for (const name of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(name, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]] && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^["'](.*)["']$/, '$1');
    }
  } catch {
    /* absent */
  }
}
const { getClient, vertexLocation } = await import('../src/lib/ai/client');

const Verdict = z.object({
  heard: z.string(),
  wordsMatch: z.boolean(),
  mismatches: z.array(z.string()),
  delivery: z.enum(['natural', 'slightly_synthetic', 'robotic']),
  emotion: z.string(),
  problems: z.array(z.string()),
});

async function judge(file: string, expected: string) {
  const ai = getClient();
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/wav', data: readFileSync(file).toString('base64') } },
          {
            text:
              'This is one line of narration for a product demo video, meant to sound like a real Indian ' +
              'person speaking with feeling. The intended words are:\n"' + expected + '"\n\n' +
              'Transcribe exactly what you hear. Then say whether the words match the intended line (ignore ' +
              'punctuation and whether numbers are written as digits), and list any word or number that is ' +
              'mispronounced, skipped, or read oddly (for example digits read one by one, an acronym read as a ' +
              'word, a wrong stress). Rate the delivery honestly: natural, slightly_synthetic or robotic. ' +
              'Describe the emotion you hear in a few words, and list any problem a listener would notice ' +
              '(flat intonation, rushed, odd pauses, clipped ending, sounds like an advert). Reply as JSON: ' +
              '{"heard","wordsMatch","mismatches":[],"delivery","emotion","problems":[]}.',
          },
        ],
      },
    ],
    config: { responseMimeType: 'application/json', temperature: 0 },
  });
  try {
    return Verdict.parse(JSON.parse(res.text ?? '{}'));
  } catch {
    // A verdict the model wrote as broken JSON is a verdict not given, not a pass.
    return { heard: '', wordsMatch: false, mismatches: [], delivery: 'slightly_synthetic' as const, emotion: 'unreadable verdict', problems: ['the listening model returned malformed JSON; listen to this clip'] };
  }
}

const args = process.argv.slice(2);
const pairs: { id: string; file: string; text: string }[] = [];
if (args.length === 2 && args[0].endsWith('.wav')) {
  pairs.push({ id: 'clip', file: args[0], text: args[1] });
} else {
  // A --voice-only log: "  id   12.3 s  C:\...\hash.wav", with the lines themselves in S.
  const { lines } = JSON.parse(readFileSync(args[0], 'utf8')) as { lines: { id: string; file: string; speech: string }[] };
  for (const l of lines) pairs.push({ id: l.id, file: l.file, text: l.speech });
}

console.log('Narration check, Gemini in ' + vertexLocation() + '\n');
let flagged = 0;
for (const p of pairs) {
  const v = await judge(p.file, p.text);
  const bad = !v.wordsMatch || v.delivery !== 'natural' || v.problems.length > 0;
  if (bad) flagged++;
  console.log((bad ? 'CHECK ' : 'ok    ') + p.id.padEnd(10) + ' ' + v.delivery.padEnd(18) + ' ' + v.emotion);
  if (v.mismatches.length) console.log('        mismatches: ' + v.mismatches.join(' | '));
  if (v.problems.length) console.log('        problems:   ' + v.problems.join(' | '));
}
console.log('\n' + (flagged === 0 ? 'every line reads as intended' : flagged + ' line(s) to listen to'));
