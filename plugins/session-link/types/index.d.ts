export type LinkView = {
  updatedAt: number
  sessions: Array<{
    name: string
    label: string | null
    glyph: string
    hue: string
    status: string
    isSelf: boolean
    cwd: string
    branch: string | null
    files: number
    recent: string[]
  }>
  overlaps: Array<{ path: string; names: string[] }>
  messages: Array<{
    from: string
    to: string
    text: string
    at: number
    fromLabel: string | null
    toLabel: string | null
    fromGlyph: string
    fromHue: string
    toGlyph: string
    toHue: string
  }>
}

declare module 'claude-code' {
  interface PluginState {
    'session-link': { view: LinkView | null }
  }
}
