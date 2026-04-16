import './globals.css';
import { DM_Sans, Noto_Sans_JP, JetBrains_Mono } from 'next/font/google';
import { Toaster } from 'sonner';

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
  display: 'swap',
});

const notoSansJP = Noto_Sans_JP({
  subsets: ['latin'],
  variable: '--font-noto-sans-jp',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
  weight: ['400', '500'],
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={`${dmSans.variable} ${notoSansJP.variable} ${jetbrainsMono.variable}`}>
      <head>
        <title>Agentic Analyst</title>
        <meta name="robots" content="noindex, nofollow" />
      </head>
      <body>
        {children}
        <Toaster position="top-right" />
      </body>
    </html>
  );
}
