import type {DateRange, RangeRequest} from './range'

export type Snapshot = {
  range?: DateRange
  bounds?: DateRange
  readAt: string
  period: string
  state: 'ready' | 'unavailable'
  projects: {name: string; tokens: number}[]
  /** Tokens with no project name, or with a hidden one. Null when nothing was read. */
  unknown: number | null
  harnesses: {name: string; tokens: number}[]
  workspaces: {name: string; tokens: number | null}[]
  issues: string[]
}

declare module 'orca' {
  interface PluginRequests {
    'attribution.read': {input: RangeRequest | undefined; output: Snapshot}
  }
  interface PluginPanelEvents {
    'attribution.changed': {reason: string}
  }
}
