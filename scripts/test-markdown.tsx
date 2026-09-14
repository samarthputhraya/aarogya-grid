/**
 * The assistant's Markdown renderer, against the Markdown the model writes.
 *
 * Run with:  npx tsx scripts/test-markdown.mts     (part of `npm test`)
 *
 * WHY A RENDERER GETS A TEST AT ALL
 * ---------------------------------
 * It is forty lines of view code, and view code is normally left to the eye.
 * This one is not, for two reasons. It sits on the single screen a judge is
 * most likely to try, and its input is written by a language model -- so the
 * shapes it has to survive are not a fixed set somebody chose, they are
 * whatever the model produced this morning. A renderer that silently drops a
 * list is indistinguishable from an assistant that did not answer.
 *
 * The fixtures below are VERBATIM from measured runs, not invented. The long
 * one is the answer `scripts/rehearse-assistant.mts` got to "which facilities
 * are about to run out of a vital medicine" -- headings, a numbered list, a
 * bulleted list nested one level under it, bold facility names, and a quoted
 * rationale full of parentheses and a rupee sign.
 *
 * The last assertion is the one that matters most: no output of this renderer
 * may contain raw Markdown punctuation where formatting was intended, and no
 * path through it may emit an HTML tag the MODEL asked for. It builds React
 * elements; there is no `dangerouslySetInnerHTML` in the component, and this
 * test fails if a `<script>` in the model's text ever reaches the output as
 * markup rather than as text.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from '../src/components/ui/Markdown';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '   ' + name + (ok || !detail ? '' : '\n         ' + detail));
}

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

console.log('the assistant answer renderer');

// ---- verbatim from a measured run -----------------------------------------
const REAL = [
  'As of September 30, 2026, several facilities in Bastar are facing critical stock-outs of vital medicines. Here is the short list:',
  '',
  '### Facilities Running Out of Vital Medicines',
  '1. **DH Bastar-01** has 0 vials of **Ceftriaxone** (1 g) on hand, representing 0 days of cover and a 100% stock-out probability.',
  '2. **CHC Bastar-01** has 0 sachets of **Oral Rehydration Salts (WHO formula)** (20.5 g / 1 L) on hand.',
  '',
  '### Recommended Vital Medicine Transfer Today',
  '* **Move 41 vials of Ceftriaxone (1 g)** from **PHC Bastar-02** to **PHC Bastar-03**.',
  '  * **Rationale:** "PHC Bastar-02 can spare 41 vials (batch B012-HC002, expires in 649 days) ... costs ₹2,592 ... cutting stock-out risk to 4%."',
].join('\n');

{
  const html = render(REAL);
  check('the leading paragraph survives', html.includes('<p class="leading-relaxed">As of September 30, 2026'));
  check('a heading becomes an element, not a line starting with hashes', !html.includes('###'));
  check('...and keeps its text', html.includes('Facilities Running Out of Vital Medicines'));
  check('a numbered list becomes an ordered list', html.includes('<ol'));
  check('a bulleted list becomes an unordered list', html.includes('<ul'));
  check('both list items are present', (html.match(/<li/g) ?? []).length >= 4);
  check('bold becomes <strong>', html.includes('<strong class="font-semibold text-mist-50">DH Bastar-01</strong>'));
  check('no asterisk pairs survive as literal text', !/\*\*/.test(html));
  check('the nested bullet is nested inside its parent item', /<li[^>]*>[\s\S]*?<ul[\s\S]*?<\/ul>[\s\S]*?<\/li>/.test(html));
  check('a rupee figure inside a quoted rationale is untouched', html.includes('₹2,592'));
  check('a batch number is untouched', html.includes('B012-HC002'));
  check('the percentage is untouched', html.includes('4%'));
}

// ---- the shapes that break naive renderers ---------------------------------
{
  const html = render('A single line with no markup at all.');
  check('plain prose still renders', html.includes('A single line with no markup at all.'));
  check('...as one paragraph', (html.match(/<p/g) ?? []).length === 1);
}
{
  const html = render('Line one\nLine two');
  check('a soft line break inside a paragraph joins rather than splits', (html.match(/<p/g) ?? []).length === 1);
}
{
  const html = render('First.\n\nSecond.');
  check('a blank line does split a paragraph', (html.match(/<p/g) ?? []).length === 2);
}
{
  const html = render('- one\n- two\n\n1. alpha\n2. beta');
  check('a bulleted list and a numbered list stay separate lists', html.includes('<ul') && html.includes('<ol'));
}
{
  // The shape of a national answer of 14 Sep: each numbered facility, its
  // details as flush-left bullets, a blank line, the next number. It rendered as
  // seven lists that all began at 1.
  const html = render(
    '1. DH Zunheboto-01\n* Status: 0 sachets\n* Action: move 710\n\n2. CHC Kottayam-01\n* Status: 0 sachets\n\n3. PHC Dhalai-02',
  );
  check('flush-left bullets under a numbered item nest inside it', /<ol[^>]*><li[^>]*>DH Zunheboto-01<ul/.test(html), html.slice(0, 200));
  check('a numbered list resumed after a blank line keeps its number', html.includes('<ol start="2"') && html.includes('<ol start="3"'));
  check('the first list is not given a redundant start', !html.includes('start="1"'));
}
{
  const html = render('Use `AI.FORECAST` for this.');
  check('inline code becomes <code>', html.includes('<code'));
  check('...and the backticks are gone', !html.includes('`'));
}
{
  const html = render('This is *emphasis* and this is **strong**.');
  check('single asterisks become emphasis', html.includes('<em'));
  check('double asterisks are not read as two emphases', html.includes('<strong'));
}
{
  // A drug name legitimately containing an asterisk-free parenthetical, and a
  // multiplication sign the pick list uses. Neither is markup.
  const html = render('pick list: B010-DH001 × 12 (exp 2027-10-28)');
  check('a pick list line is left alone', html.includes('B010-DH001 × 12 (exp 2027-10-28)'));
}
{
  const html = render('');
  check('an empty answer renders nothing rather than throwing', html.length > 0 && !html.includes('<p'));
}

// ---- the safety property ----------------------------------------------------
{
  const hostile = 'Here is a list:\n- <script>alert(1)</script>\n- <img src=x onerror=alert(1)>\n\n<b>not bold</b>';
  const html = render(hostile);
  /*
   * The assertion is about TAGS, not about substrings. `onerror=` appears in
   * the output and must: it is part of the text the model wrote, escaped, and
   * shown to the reader. What must never appear is an element the model asked
   * for -- so the check is that every tag in the output is one this component
   * emits.
   */
  const tags = [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());
  const OURS = new Set(['div', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'code']);
  check('every tag in the output is one this component emits, none from the model',
    tags.every((t) => OURS.has(t)),
    tags.filter((t) => !OURS.has(t)).join(', '));
  check('...and is still shown to the reader as text', html.includes('&lt;script&gt;'));
  check("the model's own angle brackets are escaped", html.includes('&lt;img'));
}

console.log('');
console.log(failures === 0 ? 'PASS  the renderer survives what the model writes' : `FAIL  ${failures} checks`);
process.exit(failures === 0 ? 0 : 1);
