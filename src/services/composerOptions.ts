export const effortOptions = [
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ReasoningEffort = (typeof effortOptions)[number]

export const insertPreset = (draft: string, caret: number, preset: string) => ({
  text: draft.slice(0, caret) + preset + draft.slice(caret),
  caret: caret + preset.length,
})

export const effortLabels: Record<ReasoningEffort, [string, string]> = {
  default: ['默认', 'Default'],
  none: ['关闭', 'None'],
  minimal: ['极低', 'Minimal'],
  low: ['低', 'Low'],
  medium: ['中', 'Medium'],
  high: ['高', 'High'],
  xhigh: ['极高', 'Extra high'],
  max: ['最大', 'Max'],
}

// Match ordered characters, not edit distance or unordered character sets.
export const matchesModel = (model: string, query: string): boolean => {
  const chars = [...query.toLowerCase().trim()]
  let index = 0
  for (const char of model.toLowerCase()) {
    if (char === chars[index]) {
      index++
    }
  }
  return index === chars.length
}

export const searchStrengths = ['off', 'low', 'medium', 'high'] as const
export type SearchStrength = (typeof searchStrengths)[number]
export const searchLabels: Record<SearchStrength, [string, string]> = {
  off: ['关闭', 'Off'],
  low: ['低', 'Low'],
  medium: ['中', 'Medium'],
  high: ['高', 'High'],
}
