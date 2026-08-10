'use client'

import { NextUIProvider } from '@nextui-org/react'
import { ThemeProvider as NextThemesProvider } from 'next-themes'

const THEME = "THEME"

export function Providers({ children }) {
    return (
        <NextUIProvider>
            <NextThemesProvider attribute="class" defaultTheme="light" storageKey={THEME}>
                {children}
            </NextThemesProvider>
        </NextUIProvider>
    )
}
