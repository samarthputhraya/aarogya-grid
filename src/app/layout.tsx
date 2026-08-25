import type { Metadata } from 'next';
import { Newsreader, Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

/*
 * Typefaces.
 *
 * The console shipped on the system stack, which on Windows means Segoe UI over
 * Consolas. That is a defensible default and a poor one for this particular
 * page: half the surface area of this product is a number, and Consolas sets
 * digits that are narrow, low-contrast and easy to misread at the sizes the
 * alert table uses. Three faces, each doing one job:
 *
 *   Newsreader  -- display only. This is an argument about a national health
 *                  system, not a SaaS product, and a serif says "report" where
 *                  a geometric sans says "startup". It appears in the hero and
 *                  section headings and nowhere near a data table.
 *   Inter       -- prose and UI labels. Chosen over the system stack for one
 *                  concrete reason: it renders identically on the assessor's
 *                  machine and ours, which matters when the deliverable is a
 *                  link someone else opens.
 *   JetBrains Mono -- every figure. Tabular by default, a tall x-height, and a
 *                  slashed zero, which is the difference between 0 and O in a
 *                  column of stock codes.
 *
 * All three are self-hosted by next/font at build time -- no request to Google
 * at runtime, no layout shift, and no third-party origin in the network tab of
 * a government-facing deployment. The system stacks stay as fallbacks so a
 * failed font load degrades to the previous design rather than to Times.
 */
const display = Newsreader({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-display-face',
  display: 'swap',
});

const sans = Inter({
  subsets: ['latin'],
  variable: '--font-sans-face',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-mono-face',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Aarogya Grid — National Medicine Supply Intelligence',
  description:
    'Forecasts medicine stock-outs across India’s primary health network and finds the stock already sitting nearby to prevent them.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`h-full ${display.variable} ${sans.variable} ${mono.variable}`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
