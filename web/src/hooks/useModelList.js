"use client"
import { useEffect, useState } from 'react'
import { createBrowserOpenAIClient } from '@/utils/openaiClient'

const DebounceDelay = 800

/**
 * @typedef ModelListState
 * @property {string[]} models
 * @property {boolean} isLoading
 * @property {string} error
 */

/**
 * Lists the models exposed by the configured endpoint once an API key is
 * available, debounced so that typing a key or a url does not fire a request
 * per keystroke. Providers without a `/models` endpoint resolve to an empty
 * list with the reason reported through `error`, keeping manual model entry as
 * the fallback.
 *
 * @param {string} apiKey
 * @param {string | undefined} baseUrl
 * @returns {ModelListState}
 */
export function useModelList(apiKey, baseUrl) {
  const [models, setModels] = useState(/** @type {string[]} */([]))
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!apiKey) {
      setModels([])
      setIsLoading(false)
      setError("")
      return
    }

    const controller = new AbortController()
    setIsLoading(true)
    setError("")

    const timeout = setTimeout(async () => {
      try {
        const openai = createBrowserOpenAIClient(apiKey, baseUrl, { maxRetries: 0 })
        const page = await openai.models.list({ signal: controller.signal })
        if (controller.signal.aborted) {
          return
        }
        const listed = page.data.map(x => x.id).filter(x => x).sort()
        setModels(listed)
        setIsLoading(false)
        if (listed.length === 0) {
          setError("Endpoint returned no models, enter a model manually.")
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return
        }
        console.error("[User Interface]", "Model List", error)
        setModels([])
        setIsLoading(false)
        setError(`Could not list models: ${error?.message ?? error}`)
      }
    }, DebounceDelay)

    return () => {
      clearTimeout(timeout)
      controller.abort()
    }
  }, [apiKey, baseUrl])

  return { models, isLoading, error }
}
