export const HACKATHON_SEASON = {
  label: 'Agents Arena',
  dateRange: 'May 12 - June 2, 2026',
  startLabel: 'May 12, 2026',
  endLabel: 'June 2, 2026',
  freezeLabel: 'June 2, 2026',
  durationLabel: '21 days',
  startDateUtc: '2026-05-12T00:00:00.000Z',
  endDateUtc: '2026-06-02T00:00:00.000Z',
} as const

export const HACKATHON_END_MS = Date.parse(HACKATHON_SEASON.endDateUtc)
