import { useEffect } from "react"

export function useGuideMetadata(title: string, description: string) {
  useEffect(() => {
    const previousTitle = document.title
    const tags = [
      ['meta[name="description"]', description],
      ['meta[property="og:title"]', title],
      ['meta[property="og:description"]', description],
      ['meta[property="og:url"]', window.location.href],
    ] as const
    const previous = tags.map(([selector, value]) => {
      const tag = document.querySelector<HTMLMetaElement>(selector)
      const original = tag?.content
      if (tag) tag.content = value
      return { tag, original }
    })
    document.title = title
    return () => {
      document.title = previousTitle
      for (const { tag, original } of previous) {
        if (tag && original !== undefined) tag.content = original
      }
    }
  }, [title, description])
}