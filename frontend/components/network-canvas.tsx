'use client'

import { useEffect, useRef } from 'react'

interface Node {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  color: string // e.g. "99,197,124"
  alpha: number
  phase: number
  phaseSpeed: number
}

interface NetworkCanvasProps {
  className?: string
  /** Opacity multiplier for the whole canvas, 0–1. Default 1. */
  opacity?: number
  /** Max number of nodes. Default auto from area. */
  maxNodes?: number
}

// Project palette — matches oklch tokens in globals.css converted to RGB-ish values
// neon-green ≈ #4ade80-family, neon-cyan ≈ #22d3ee-family, indigo ≈ #818cf8, violet ≈ #a78bfa
const NODE_TYPES = [
  { rgb: '74,222,128',  r: 3.5 }, // neon-green  (primary)
  { rgb: '34,211,238',  r: 3.0 }, // neon-cyan   (accent)
  { rgb: '129,140,248', r: 2.6 }, // indigo
  { rgb: '167,139,250', r: 2.2 }, // violet
]

function makeNode(w: number, h: number): Node {
  const type = NODE_TYPES[Math.floor(Math.random() * NODE_TYPES.length)]
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.32,
    vy: (Math.random() - 0.5) * 0.32,
    r: type.r + Math.random() * 1.6,
    color: type.rgb,
    alpha: 0.72 + Math.random() * 0.28,
    phase: Math.random() * Math.PI * 2,
    phaseSpeed: 0.012 + Math.random() * 0.018,
  }
}

export function NetworkCanvas({ className = '', opacity = 1, maxNodes }: NetworkCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef    = useRef<number>(0)
  const nodesRef  = useRef<Node[]>([])
  const sizeRef   = useRef({ w: 0, h: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    function resize() {
      const parent = canvas!.parentElement
      const w = parent ? parent.offsetWidth  : window.innerWidth
      const h = parent ? parent.offsetHeight : window.innerHeight
      canvas!.width  = w
      canvas!.height = h
      sizeRef.current = { w, h }
      const count = Math.min(maxNodes ?? Math.floor((w * h) / 8500), 130)
      nodesRef.current = Array.from({ length: count }, () => makeNode(w, h))
    }

    function draw() {
      const { w, h } = sizeRef.current
      const nodes = nodesRef.current
      ctx!.clearRect(0, 0, w, h)

      const D = 148 // connection distance

      // --- edges ---
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x
          const dy = nodes[j].y - nodes[i].y
          const d  = Math.sqrt(dx * dx + dy * dy)
          if (d < D) {
            ctx!.beginPath()
            ctx!.moveTo(nodes[i].x, nodes[i].y)
            ctx!.lineTo(nodes[j].x, nodes[j].y)
            // use the primary node's color tinted
            ctx!.strokeStyle = `rgba(74,222,128,${(1 - d / D) * 0.38})`
            ctx!.lineWidth = 0.9
            ctx!.stroke()
          }
        }
      }

      // --- data packets: cyan dots travelling along every 6th edge ---
      const t = Date.now() * 0.001
      for (let i = 0; i < nodes.length; i += 6) {
        const j = i + 1
        if (j >= nodes.length) break
        const dx = nodes[j].x - nodes[i].x
        const dy = nodes[j].y - nodes[i].y
        const d  = Math.sqrt(dx * dx + dy * dy)
        if (d < D) {
          const p  = ((t * 0.38 + i * 0.27) % 1)
          const px = nodes[i].x + dx * p
          const py = nodes[i].y + dy * p
          ctx!.beginPath()
          ctx!.arc(px, py, 2.0, 0, Math.PI * 2)
          ctx!.fillStyle = 'rgba(34,211,238,0.85)'
          ctx!.fill()
        }
      }

      // --- nodes ---
      for (const n of nodes) {
        n.phase += n.phaseSpeed
        const pr = n.r * (1 + Math.sin(n.phase) * 0.22)

        // glow halo
        const grd = ctx!.createRadialGradient(n.x, n.y, 0, n.x, n.y, pr * 5)
        grd.addColorStop(0, `rgba(${n.color},0.42)`)
        grd.addColorStop(1, `rgba(${n.color},0)`)
        ctx!.beginPath()
        ctx!.arc(n.x, n.y, pr * 5, 0, Math.PI * 2)
        ctx!.fillStyle = grd
        ctx!.fill()

        // solid core
        ctx!.beginPath()
        ctx!.arc(n.x, n.y, pr, 0, Math.PI * 2)
        ctx!.fillStyle = `rgba(${n.color},${n.alpha})`
        ctx!.fill()

        // move
        n.x += n.vx
        n.y += n.vy
        if (n.x < -12) n.x = sizeRef.current.w + 12
        if (n.x > sizeRef.current.w + 12) n.x = -12
        if (n.y < -12) n.y = sizeRef.current.h + 12
        if (n.y > sizeRef.current.h + 12) n.y = -12
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    resize()
    draw()

    const ro = new ResizeObserver(() => { resize() })
    if (canvas.parentElement) ro.observe(canvas.parentElement)
    window.addEventListener('resize', resize)

    return () => {
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [maxNodes])

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 ${className}`}
      style={{ opacity, pointerEvents: 'none' }}
      aria-hidden="true"
    />
  )
}
