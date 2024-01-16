import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata = {
  title: 'ChatGPT Subtitle Translator',
  description: 'Translate SRT subtitles using OpenAI ChatGPT API',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={inter.className + " light"}>{children}</body>
    </html>
  )
}
