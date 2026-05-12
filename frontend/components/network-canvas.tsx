'use client'

import { useEffect, useRef } from 'react'

interface Node {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  typeIndex: number
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
  /** If true, draw one frame and never animate. For decorative background use. */
  freeze?: boolean
}

const NODE_TYPES = [
  { rgb: '74,222,128',  r: 3.5 },
  { rgb: '34,211,238',  r: 3.0 },
  { rgb: '129,140,248', r: 2.6 },
  { rgb: '167,139,250', r: 2.2 },
]

const EDGE_DIST = 148
const EDGE_DIST_SQ = EDGE_DIST * EDGE_DIST
const TARGET_FPS = 12
const FRAME_INTERVAL = 1000 / TARGET_FPS
// Sprite is rendered at this radius in source pixels, then scaled at drawImage time.
const SPRITE_BASE_RADIUS = 6
const SPRITE_HALO_MULT = 5
const SPRITE_PADDING = 2

type Sprite = { canvas: HTMLCanvasElement; baseDrawSize: number }

function buildSprite(rgb: string, dpr: number): Sprite {
  const halo = SPRITE_BASE_RADIUS * SPRITE_HALO_MULT
  const size = Math.ceil((halo + SPRITE_PADDING) * 2 * dpr)
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const cx = c.getContext('2d')!
  cx.scale(dpr, dpr)
  const center = (halo + SPRITE_PADDING)
  const grd = cx.createRadialGradient(center, center, 0, center, center, halo)
  grd.addColorStop(0, `rgba(${rgb},0.42)`)
  grd.addColorStop(1, `rgba(${rgb},0)`)
  cx.fillStyle = grd
  cx.beginPath()
  cx.arc(center, center, halo, 0, Math.PI * 2)
  cx.fill()
  cx.fillStyle = `rgba(${rgb},1)`
  cx.beginPath()
  cx.arc(center, center, SPRITE_BASE_RADIUS, 0, Math.PI * 2)
  cx.fill()
  return { canvas: c, baseDrawSize: size / dpr }
}

function makeNode(w: number, h: number): Node {
  const typeIndex = Math.floor(Math.random() * NODE_TYPES.length)
  const type = NODE_TYPES[typeIndex]
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.32,
    vy: (Math.random() - 0.5) * 0.32,
    r: type.r + Math.random() * 1.6,
    typeIndex,
    alpha: 0.72 + Math.random() * 0.28,
    phase: Math.random() * Math.PI * 2,
    phaseSpeed: 0.012 + Math.random() * 0.018,
  }
}

export function NetworkCanvas({ className = '', opacity = 1, maxNodes, freeze = false }: NetworkCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef    = useRef<number>(0)
  const nodesRef  = useRef<Node[]>([])
  const sizeRef   = useRef({ w: 0, h: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 1.5)
    const sprites: Sprite[] = NODE_TYPES.map((t) => buildSprite(t.rgb, dpr))

    function resize() {
      const parent = canvas!.parentElement
      const w = parent ? parent.offsetWidth  : window.innerWidth
      const h = parent ? parent.offsetHeight : window.innerHeight
      canvas!.width  = Math.floor(w * dpr)
      canvas!.height = Math.floor(h * dpr)
      canvas!.style.width  = `${w}px`
      canvas!.style.height = `${h}px`
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      sizeRef.current = { w, h }
      const count = Math.min(maxNodes ?? Math.floor((w * h) / 12000), 90)
      nodesRef.current = Array.from({ length: count }, () => makeNode(w, h))
    }

    let lastDraw = 0
    let visible = true
    let intersecting = true

    function step(now: number) {
      if (!visible || !intersecting) {
        rafRef.current = 0
        return
      }
      rafRef.current = requestAnimationFrame(step)
      if (now - lastDraw < FRAME_INTERVAL) return
      lastDraw = now
      draw()
    }

    function ensureRunning() {
      if (visible && intersecting && rafRef.current === 0) {
        rafRef.current = requestAnimationFrame(step)
      }
    }

    function draw() {
      const { w, h } = sizeRef.current
      const nodes = nodesRef.current
      ctx!.clearRect(0, 0, w, h)

      // --- edges (squared-distance, single strokeStyle per pass) ---
      ctx!.lineWidth = 0.9
      for (let i = 0; i < nodes.length; i++) {
        const ni = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const nj = nodes[j]
          const dx = nj.x - ni.x
          const dy = nj.y - ni.y
          const dsq = dx * dx + dy * dy
          if (dsq < EDGE_DIST_SQ) {
            const alpha = (1 - Math.sqrt(dsq) / EDGE_DIST) * 0.38
            ctx!.strokeStyle = `rgba(74,222,128,${alpha})`
            ctx!.beginPath()
            ctx!.moveTo(ni.x, ni.y)
            ctx!.lineTo(nj.x, nj.y)
            ctx!.stroke()
          }
        }
      }

      // --- data packets ---
      const t = performance.now() * 0.001
      ctx!.fillStyle = 'rgba(34,211,238,0.85)'
      for (let i = 0; i < nodes.length; i += 6) {
        const j = i + 1
        if (j >= nodes.length) break
        const dx = nodes[j].x - nodes[i].x
        const dy = nodes[j].y - nodes[i].y
        const dsq = dx * dx + dy * dy
        if (dsq < EDGE_DIST_SQ) {
          const p  = ((t * 0.38 + i * 0.27) % 1)
          const px = nodes[i].x + dx * p
          const py = nodes[i].y + dy * p
          ctx!.beginPath()
          ctx!.arc(px, py, 2.0, 0, Math.PI * 2)
          ctx!.fill()
        }
      }

      // --- nodes (pre-rendered sprites) ---
      for (let k = 0; k < nodes.length; k++) {
        const n = nodes[k]
        n.phase += n.phaseSpeed
        const pr = n.r * (1 + Math.sin(n.phase) * 0.22)
        const sprite = sprites[n.typeIndex]
        const drawSize = sprite.baseDrawSize * pr / SPRITE_BASE_RADIUS
        ctx!.globalAlpha = n.alpha
        ctx!.drawImage(sprite.canvas, n.x - drawSize / 2, n.y - drawSize / 2, drawSize, drawSize)

        n.x += n.vx
        n.y += n.vy
        if (n.x < -12) n.x = w + 12
        if (n.x > w + 12) n.x = -12
        if (n.y < -12) n.y = h + 12
        if (n.y > h + 12) n.y = -12
      }
      ctx!.globalAlpha = 1
    }

    resize()

    if (reduceMotion || freeze) {
      draw()
      const ro = new ResizeObserver(() => { resize(); draw() })
      if (canvas.parentElement) ro.observe(canvas.parentElement)
      return () => ro.disconnect()
    }

    const onVisibility = () => {
      visible = !document.hidden
      ensureRunning()
    }
    document.addEventListener('visibilitychange', onVisibility)

    const io = new IntersectionObserver(
      (entries) => {
        intersecting = entries[0]?.isIntersecting ?? true
        ensureRunning()
      },
      { threshold: 0 }
    )
    io.observe(canvas)

    const ro = new ResizeObserver(() => { resize() })
    if (canvas.parentElement) ro.observe(canvas.parentElement)
    window.addEventListener('resize', resize)

    rafRef.current = requestAnimationFrame(step)

    return () => {
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', resize)
    }
  }, [maxNodes, freeze])

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 ${className}`}
      style={{ opacity, pointerEvents: 'none' }}
      aria-hidden="true"
    />
  )
}
