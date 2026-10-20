import './globals.css';
import './design-system.css';
import React from 'react';
import { IBM_Plex_Sans, IBM_Plex_Mono, Newsreader } from 'next/font/google';

const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const newsreader = Newsreader({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-newsreader',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata = {
  title: 'Glucose Twin · T2D digital twin research prototype',
  description: 'A synthetic-data digital twin that forecasts the next two hours of glucose from EHR context and wearable streams, with a backend-driven what-if.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} ${newsreader.variable}`}>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
