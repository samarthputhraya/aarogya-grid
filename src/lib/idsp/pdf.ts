import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from './bulletin';

/**
 * The text layer of a bulletin PDF, as positioned items per page.
 *
 * pdf.js, the same renderer a browser uses, run without a canvas: only the text
 * content is read, nothing is rasterised and nothing is executed from the
 * document (`isEvalSupported: false`).
 */
export async function textItems(bytes: Uint8Array): Promise<TextItem[][]> {
  const doc = await getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const pages: TextItem[][] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(
        content.items.flatMap((it) =>
          'str' in it ? [{ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width }] : [],
        ),
      );
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}
