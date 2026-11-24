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
