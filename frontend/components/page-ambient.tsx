'use client'

import { NetworkCanvas } from '@/components/network-canvas'

type PageAmbientProps = {
  quiet?: boolean
}

export function PageAmbient({ quiet = false }: PageAmbientProps) {
  return (
    <div className={quiet ? 'page-ambient page-ambient--quiet' : 'page-ambient'} aria-hidden="true">
      <NetworkCanvas
        className="page-ambient__canvas"
        maxNodes={quiet ? 34 : 46}
        opacity={quiet ? 0.1 : 0.16}
      />
      <div className="page-ambient__glow page-ambient__glow--one" />
      <div className="page-ambient__glow page-ambient__glow--two" />
    </div>
  )
}
