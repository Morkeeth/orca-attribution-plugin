import {defineCheck} from 'orca/testing'
import type {Snapshot} from './protocol'

// Sample data for screenshots. Every name and number here is made up.
const sample: Snapshot = {
  readAt: '2026-11-19T12:00:00.000Z', period: '2026-11-13 → 2026-11-19 · local time', state: 'ready',
  range: {start: '2026-11-13', end: '2026-11-19'}, bounds: {start: '2026-10-01', end: '2026-11-19'},
  projects: [{name: 'web-app', tokens: 4_210_000}, {name: 'api-server', tokens: 2_640_000}, {name: 'docs-site', tokens: 910_000}, {name: 'infra', tokens: 380_000}],
  unknown: 1_160_000,
  harnesses: [{name: 'Claude Code', tokens: 6_020_000}, {name: 'Codex', tokens: 3_280_000}],
  workspaces: [{name: 'web-app', tokens: 4_210_000}, {name: 'api-server', tokens: 2_640_000}],
  issues: []
}

export default defineCheck({
  stranger: {results: {'workspace.list': {workspaces: [], truncated: false}}},
  sample: {requests: {'attribution.read': () => sample}}
})
