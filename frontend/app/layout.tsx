import type { Metadata } from 'next'
import './globals.css'
import { SITE_METADATA } from '@/lib/site-data'

export const metadata: Metadata = {
  ...SITE_METADATA,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className="bg-background">
      <body className="font-sans antialiased">{children}</body>
    </html>
  )
}
