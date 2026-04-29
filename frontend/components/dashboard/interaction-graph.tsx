'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useInteractionGraph } from '@/hooks/use-interaction-graph'

interface Node {
  id: string; x: number; y: number; vx: number; vy: number;
  radius: number; color: string; label: string; connections: string[]
}

type NodePosition = Pick<Node, 'x' | 'y' | 'vx' | 'vy'>

const TRACK_COLORS: Record<string, string> = {
  'Agent Services': '#4ade80',
  'Social & Coord': '#22d3ee',
  'Economy & Markets': '#facc15',
  'Open / Creative': '#f472b6',
}

const TRACK_LEGEND = [
  { label: 'Services', track: 'Agent Services' },
  { label: 'Social', track: 'Social & Coord' },
  { label: 'Markets', track: 'Economy & Markets' },
  { label: 'Open', track: 'Open / Creative' },
] as const

const POSITION_CACHE = new Map<string, NodePosition>()

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
  const { graph, loading } = useInteractionGraph()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<Node[]>([])
  const animRef  = useRef<number>(0)
  const hoveredRef = useRef<string | null>(null)
  const initializedRef = useRef(false)
  const graphNodes = useMemo<Node[]>(() => {
    const connectionsByNode = new Map<string, Set<string>>()

    for (const edge of graph.edges) {
      const sourceSet = connectionsByNode.get(edge.source) ?? new Set<string>()
      sourceSet.add(edge.target)
      connectionsByNode.set(edge.source, sourceSet)

      const targetSet = connectionsByNode.get(edge.target) ?? new Set<string>()
      targetSet.add(edge.source)
      connectionsByNode.set(edge.target, targetSet)
    }

    return graph.nodes.map((node) => ({
      id: node.id,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: Math.min(24, 12 + Math.sqrt(node.calls || 1) * 4),
      color: TRACK_COLORS[node.track] ?? '#a78bfa',
      label: node.label,
      connections: [...(connectionsByNode.get(node.id) ?? [])],
    }))
  }, [graph])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    if (graphNodes.length === 0) return

    let W = 0
    let H = 0

    const rebuildNodes = (preservePositions: boolean) => {
      if (!graphNodes.length) {
        nodesRef.current = []
        return
      }

      if (!preservePositions) {
        nodesRef.current = scatterNodes(graphNodes, W, H).map((node) => {
          POSITION_CACHE.set(node.id, {
            x: node.x,
            y: node.y,
            vx: node.vx,
            vy: node.vy,
          })
          return node
        })
        return
      }

      nodesRef.current = graphNodes.map((node) => {
        const cached = POSITION_CACHE.get(node.id)
        if (cached) {
          return {
            ...node,
            ...cached,
          }
        }

        const seeded = scatterNodes([node], W, H)[0]!
        POSITION_CACHE.set(node.id, {
          x: seeded.x,
          y: seeded.y,
          vx: seeded.vx,
          vy: seeded.vy,
        })
        return seeded
      })
    }

    const resize = () => {
      W = canvas.offsetWidth
      H = canvas.offsetHeight
      canvas.width  = W * window.devicePixelRatio
      canvas.height = H * window.devicePixelRatio
      ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0)

      rebuildNodes(initializedRef.current || POSITION_CACHE.size > 0)
      initializedRef.current = true

      nodesRef.current = nodesRef.current.map((node) => ({
        ...node,
        x: Math.min(Math.max(node.radius + 8, node.x), Math.max(node.radius + 8, W - node.radius - 8)),
        y: Math.min(Math.max(node.radius + 8, node.y), Math.max(node.radius + 8, H - node.radius - 8)),
      }))
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

        POSITION_CACHE.set(n.id, {
          x: n.x,
          y: n.y,
          vx: n.vx,
          vy: n.vy,
        })
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
  }, [graphNodes])

  return (
    <div className="rounded-2xl border border-border bg-card/60 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-foreground">Interaction Graph</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Registered applications and app-to-app calls · hover to highlight</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {TRACK_LEGEND.map((item) => (
            <span key={item.track} className="inline-flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: `${TRACK_COLORS[item.track]}99` }}
              />
              {item.label}
            </span>
          ))}
        </div>
      </div>
      {graphNodes.length === 0 ? (
        <div className="flex h-[360px] items-center justify-center rounded-xl border border-dashed border-border/70 px-6 text-center text-sm text-muted-foreground">
          {loading
            ? 'Loading indexed interactions...'
            : 'Awaiting registered applications.'}
        </div>
      ) : (
        <canvas
          ref={canvasRef}
          className="w-full rounded-xl"
          style={{ height: 360 }}
        />
      )}
    </div>
  )
}
