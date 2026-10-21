import React from 'react';
import { IBM_Plex_Sans_Condensed, JetBrains_Mono, Source_Serif_4, Geist, Geist_Mono } from 'next/font/google';
import './lab.css';

const condensed = IBM_Plex_Sans_Condensed({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--lab-condensed', display: 'swap' });
const jet = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--lab-mono-a', display: 'swap' });
const serif = Source_Serif_4({ subsets: ['latin'], weight: ['400', '600'], style: ['normal', 'italic'], variable: '--lab-serif', display: 'swap' });
const geist = Geist({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--lab-geist', display: 'swap' });
const geistMono = Geist_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--lab-geist-mono', display: 'swap' });

/** Art-direction prototypes. Not linked from the product; removed before release. */
export default function LabLayout({ children }: { children: React.ReactNode }) {
  return <div className={`lab-root ${condensed.variable} ${jet.variable} ${serif.variable} ${geist.variable} ${geistMono.variable}`}>{children}</div>;
}
