import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string
    return DOMPurify.sanitize(raw)
  }, [text])
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
