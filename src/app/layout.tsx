import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Aarogya Grid — National Medicine Supply Intelligence',
  description:
    'Forecasts medicine stock-outs across India’s primary health network and finds the stock already sitting nearby to prevent them.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
