'use client'

import { Copy } from 'lucide-react'
import { toast } from '@/hooks/use-toast'

export function copyToClipboard(text: string) {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
  void navigator.clipboard.writeText(text).then(
    () => toast({ title: 'Copied' }),
    () => {
      /* silent no-op */
    },
  )
}

export function CopyableCodeLine({
  children,
  prompt,
}: {
  children: string
  prompt?: boolean
}) {
  const Content = prompt ? 'span' : 'span'
  return (
    <div className="home-code-line flex items-start justify-between gap-3">
      <Content
        className={
          prompt
            ? 'font-mono text-xs sm:text-sm whitespace-pre-wrap'
            : 'font-mono text-xs sm:text-sm overflow-x-auto whitespace-pre'
        }
      >
        {prompt ? null : <span className="text-muted-foreground">$ </span>}
        {children}
      </Content>
      <button
        type="button"
        onClick={() => copyToClipboard(children)}
        aria-label={`Copy: ${children}`}
        className="shrink-0 rounded-md border border-border bg-card p-1.5 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
