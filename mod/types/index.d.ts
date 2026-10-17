export type Layers = { pad: number; drums: number; bass: number; melody: number; arp: number }

export type OrchestraUi = {
  engine: 'off' | 'starting' | 'ready' | 'error'
  running: boolean
  volume: number
  mode: 'LIVE' | 'DEMO' | 'REPLAY'
  remixName: string
  remixPending: boolean
  bar: number
  beat: number
  chord: string
  mood: string
  energy: number
  layers: Layers
  reflected: string[]
  liveEvents: number
  progress: number | null
  message: string
}

declare module 'claude-code' {
  interface PluginState {
    'code-orchestra': { ui: OrchestraUi }
  }
}
