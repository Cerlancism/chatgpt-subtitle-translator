"use client"
import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { Button } from "@nextui-org/react";

import { MoonFilledIcon } from './MoonFilledIcon';
import { SunFilledIcon } from './SunFilledIcon';

/**
 * Icon only light/dark switch. The resolved theme is only known after mounting,
 * so the icon is rendered as a placeholder until then to avoid a hydration
 * mismatch on the statically exported page.
 */
export function ThemeSwitch() {
  const [isMounted, setIsMounted] = useState(false)
  const { resolvedTheme, setTheme } = useTheme()

  useEffect(() => setIsMounted(true), [])

  const isDark = resolvedTheme === "dark"

  return (
    <Button
      isIconOnly
      variant="light"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isMounted && isDark ? (
        <MoonFilledIcon className="text-xl text-default-500" />
      ) : (
        <SunFilledIcon className="text-xl text-default-500" />
      )}
    </Button>
  )
}
