import { Inter } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'

const inter = Inter({ subsets: ['latin'] })

/**
 * @type {import('next').Metadata}
 */
export const metadata = {
  title: 'ChatGPT Subtitle Translator',
  description: 'Web graphical user interface to translate SRT subtitles using OpenAI ChatGPT API',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
