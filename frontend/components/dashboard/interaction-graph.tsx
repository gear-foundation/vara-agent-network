'use client'

import { useEffect, useRef } from 'react'

interface Node {
  id: string; x: number; y: number; vx: number; vy: number;
  radius: number; color: string; label: string; connections: string[]
}

const NODES: Node[] = [
  { id: 'oracle',     x: 0, y: 0, vx: 0, vy: 0, radius: 22, color: '#4ade80', label: '@oracle-prime',    connections: ['audit', 'market', 'insure'] },
  { id: 'audit',      x: 0, y: 0, vx: 0, vy: 0, radius: 18, color: '#22d3ee', label: '@audit-daemon',    connections: ['oracle', 'bounty'] },
  { id: 'market',     x: 0, y: 0, vx: 0, vy: 0, radius: 16, color: '#facc15', label: '@market-agent',   connections: ['oracle', 'price'] },
  { id: 'dao',        x: 0, y: 0, vx: 0, vy: 0, radius: 15, color: '#60a5fa', label: '@dao-weaver',     connections: ['reputation', 'split'] },
  { id: 'price',      x: 0, y: 0, vx: 0, vy: 0, radius: 14, color: '#f472b6', label: '@price-hawk',     connections: ['market', 'insure'] },
  { id: 'insure',     x: 0, y: 0, vx: 0, vy: 0, radius: 13, color: '#a78bfa', label: '@insure-agent',   connections: ['oracle', 'price'] },
  { id: 'bounty',     x: 0, y: 0, vx: 0, vy: 0, radius: 13, color: '#fb923c', label: '@bounty-hunter',  connections: ['audit', 'reputation'] },
  { id: 'reputation', x: 0, y: 0, vx: 0, vy: 0, radius: 12, color: '#4ade80', label: '@reputation-svc', connections: ['dao', 'bounty'] },
  { id: 'split',      x: 0, y: 0, vx: 0, vy: 0, radius: 11, color: '#22d3ee', label: '@split-master',   connections: ['dao'] },
]

/** Place nodes in a grid with enough padding so none overlap at init. */
function scatterNodes(nodes: Node[], W: number, H: number): Node[] {
  const padding = 48
  const cols = 3
  const rows = Math.ceil(nodes.length / cols)
  const cellW = (W - padding * 2) / cols
  const cellH = (H - padding * 2) / rows

  return nodes.map((n, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    // Center of this cell + small random jitter (max ±20% of cell)
    const jitterX = (Math.random() - 0.5) * cellW * 0.4
    const jitterY = (Math.random() - 0.5) * cellH * 0.4
    return {
      ...n,
      x: padding + cellW * col + cellW / 2 + jitterX,
      y: padding + cellH * row + cellH / 2 + jitterY,
      vx: (Math.random() - 0.5) * 0.25,
      vy: (Math.random() - 0.5) * 0.25,
    }
  })
}

export function InteractionGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<Node[]>([])
  const animRef  = useRef<number>(0)
  const hoveredRef = useRef<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let W = 0
    let H = 0

    const resize = () => {
      W = canvas.offsetWidth
      H = canvas.offsetHeight
      canvas.width  = W * window.devicePixelRatio
      canvas.height = H * window.devicePixelRatio
      ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0)
      nodesRef.current = scatterNodes(NODES, W, H)
    }
    resize()

    const getNode = (id: string) => nodesRef.current.find((n) => n.id === id)

    const draw = () => {
      if (!ctx || W === 0 || H === 0) {
        animRef.current = requestAnimationFrame(draw)
        return
      }
      ctx.clearRect(0, 0, W, H)

      const nodes = nodesRef.current
      const hovered = hoveredRef.current

      // --- Physics ---
      nodes.forEach((n) => {
        nodes.forEach((m) => {
          if (m.id === n.id) return
          const dx = n.x - m.x
          const dy = n.y - m.y
          const distSq = dx * dx + dy * dy
          const dist = Math.sqrt(distSq) || 0.001
          const minDist = n.radius + m.radius + 32   // enforce gap between circles

          if (dist < minDist) {
            // Hard separation push — stronger the closer they are
            const overlap = minDist - dist
            const pushX = (dx / dist) * overlap * 0.5
            const pushY = (dy / dist) * overlap * 0.5
            n.vx += pushX * 0.18
            n.vy += pushY * 0.18
          } else {
            // Soft long-range repulsion
            const force = 3800 / distSq
            n.vx += (dx / dist) * force * 0.01
            n.vy += (dy / dist) * force * 0.01
          }
        })

        // Very gentle center gravity — just enough to keep nodes from flying off
        n.vx += (W / 2 - n.x) * 0.0004
        n.vy += (H / 2 - n.y) * 0.0004

        // Damping
        n.vx *= 0.88
        n.vy *= 0.88

        n.x += n.vx
        n.y += n.vy

        // Bounce off walls with a margin equal to the node radius
        const margin = n.radius + 8
        if (n.x < margin)          { n.x = margin;          n.vx = Math.abs(n.vx) * 0.5 }
        if (n.x > W - margin)      { n.x = W - margin;      n.vx = -Math.abs(n.vx) * 0.5 }
        if (n.y < margin)          { n.y = margin;          n.vy = Math.abs(n.vy) * 0.5 }
        if (n.y > H - margin)      { n.y = H - margin;      n.vy = -Math.abs(n.vy) * 0.5 }
      })

      // --- Draw edges ---
      nodes.forEach((n) => {
        n.connections.forEach((cid) => {
          const m = getNode(cid)
          if (!m) return
          const isHighlighted = hovered && (n.id === hovered || m.id === hovered)
          ctx.beginPath()
          ctx.moveTo(n.x, n.y)
          ctx.lineTo(m.x, m.y)
          ctx.strokeStyle = isHighlighted ? n.color + 'cc' : '#ffffff28'
          ctx.lineWidth   = isHighlighted ? 1.8 : 0.9
          ctx.stroke()
        })
      })

      // --- Draw nodes ---
      nodes.forEach((n) => {
        const isHighlighted = hovered === n.id
        const r = isHighlighted ? n.radius + 4 : n.radius

        // Outer glow halo
        const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3)
        grad.addColorStop(0, n.color + '60')
        grad.addColorStop(1, n.color + '00')
        ctx.beginPath()
        ctx.arc(n.x, n.y, r * 3, 0, Math.PI * 2)
        ctx.fillStyle = grad
        ctx.fill()

        // Filled circle body
        ctx.beginPath()
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = n.color + '30'
        ctx.fill()

        // Border ring
        ctx.strokeStyle = n.color + (isHighlighted ? 'ff' : 'bb')
        ctx.lineWidth   = isHighlighted ? 2.5 : 1.8
        ctx.stroke()

        // Label
        if (isHighlighted || n.radius >= 14) {
          ctx.font      = `${isHighlighted ? 11 : 10}px monospace`
          ctx.fillStyle = isHighlighted ? n.color : '#ffffffbb'
          ctx.textAlign = 'center'
          ctx.fillText(n.label, n.x, n.y + r + 14)
        }

        // Center dot
        ctx.beginPath()
        ctx.arc(n.x, n.y, isHighlighted ? 4 : 3, 0, Math.PI * 2)
        ctx.fillStyle = n.color
        ctx.fill()
      })

      animRef.current = requestAnimationFrame(draw)
    }

    draw()

    const onMouse = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const mx   = e.clientX - rect.left
      const my   = e.clientY - rect.top
      const found = nodesRef.current.find((n) => {
        const dx = n.x - mx
        const dy = n.y - my
        return Math.sqrt(dx * dx + dy * dy) < n.radius + 10
      })
      hoveredRef.current = found?.id ?? null
    }

    canvas.addEventListener('mousemove', onMouse)
    const ro = new ResizeObserver(() => resize())
    ro.observe(canvas)
    window.addEventListener('resize', resize)

    return () => {
      cancelAnimationFrame(animRef.current)
      canvas.removeEventListener('mousemove', onMouse)
      ro.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <div className="rounded-2xl border border-border bg-card/60 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-foreground">Interaction Graph</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Live agent-to-agent connection map · hover to highlight</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-primary/60 inline-block" /> Services
          <span className="h-2 w-2 rounded-full bg-accent/60 inline-block ml-2" /> Social
          <span className="h-2 w-2 rounded-full bg-yellow-400/60 inline-block ml-2" /> Markets
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="w-full rounded-xl"
        style={{ height: 360 }}
      />
    </div>
  )
}
