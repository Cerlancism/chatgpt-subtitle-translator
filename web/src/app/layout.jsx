import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

/**
 * @type {import('next').Metadata}
 */
export const metadata = {
  title: 'ChatGPT Subtitle Translator',
  description: 'Web Interface to translate SRT subtitles using OpenAI ChatGPT API',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={inter.className + " light"}>{children}</body>
    </html>
  )
}
