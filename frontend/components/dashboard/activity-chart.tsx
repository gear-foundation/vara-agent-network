'use client'

import { useState } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts'

const generateData = (days: number) => {
  const data = []
  let extr = 1200
  let calls = 400
  for (let i = days; i >= 0; i--) {
    extr = Math.max(800, extr + (Math.random() - 0.4) * 400)
    calls = Math.max(200, calls + (Math.random() - 0.4) * 150)
    const d = new Date()
    d.setDate(d.getDate() - i)
    data.push({
      date: d.toLocaleDateString('en', { month: 'short', day: 'numeric' }),
      extrinsics: Math.round(extr),
      crossCalls: Math.round(calls),
    })
  }
  return data
}

const DATA_7 = generateData(7)
const DATA_14 = generateData(14)
const DATA_30 = generateData(30)

const RANGES = [
  { label: '7D', data: DATA_7 },
  { label: '14D', data: DATA_14 },
  { label: '30D', data: DATA_30 },
]

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl border border-border bg-card/95 backdrop-blur p-3 shadow-xl">
      <div className="font-mono text-xs text-muted-foreground mb-2">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-xs">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-mono font-bold text-foreground">{p.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

export function ActivityChart() {
  const [range, setRange] = useState('14D')
  const data = RANGES.find((r) => r.label === range)?.data ?? DATA_14

  return (
    <div className="rounded-2xl border border-border bg-card/60 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="font-semibold text-foreground">Network Activity</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Extrinsics + cross-program calls over time</p>
        </div>
        <div className="flex gap-1.5">
          {RANGES.map((r) => (
            <button
              key={r.label}
              onClick={() => setRange(r.label)}
              className={`rounded-lg px-3 py-1.5 text-xs font-mono font-medium transition-all ${
                range === r.label
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
          <defs>
            <linearGradient id="gradExtr" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="oklch(0.72 0.22 155)" stopOpacity={0.3} />
              <stop offset="95%" stopColor="oklch(0.72 0.22 155)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradCalls" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="oklch(0.65 0.20 200)" stopOpacity={0.3} />
              <stop offset="95%" stopColor="oklch(0.65 0.20 200)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.18 0.02 265)" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: 'oklch(0.55 0.02 265)', fontSize: 10, fontFamily: 'monospace' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: 'oklch(0.55 0.02 265)', fontSize: 10, fontFamily: 'monospace' }}
            axisLine={false}
            tickLine={false}
            width={45}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="extrinsics"
            name="Extrinsics"
            stroke="oklch(0.72 0.22 155)"
            strokeWidth={2}
            fill="url(#gradExtr)"
          />
          <Area
            type="monotone"
            dataKey="crossCalls"
            name="Cross-Program Calls"
            stroke="oklch(0.65 0.20 200)"
            strokeWidth={2}
            fill="url(#gradCalls)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
