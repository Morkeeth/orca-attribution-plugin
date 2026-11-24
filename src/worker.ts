import type {OrcaWorkerApi} from 'orca/worker'
import type {Snapshot} from './protocol'
import {LocalCollector, attribute, isHidden, parseHidden} from './local-collector'
import {resolveRange, dateString, type RangeRequest} from './range'
import {realpath} from 'node:fs/promises'

const collector = new LocalCollector()
let historyTimer: ReturnType<typeof setTimeout> | undefined

export function deactivate() {
  if (historyTimer) clearTimeout(historyTimer)
}

const isLocal = (w: {hostId?: string | null}) => !w.hostId || w.hostId === 'local'

/** Reads local usage logs and returns totals by project, harness and workspace folder for one date range. */
export async function snapshot(orca: OrcaWorkerApi, request?: RangeRequest, local = collector): Promise<Snapshot> {
  const readAt = new Date().toISOString()
  const out: Snapshot = {readAt, period: 'Unavailable', state: 'unavailable', projects: [], unknown: null, harnesses: [], workspaces: [], issues: []}

  let workspaces: any[] = []
  // workspace.list arrived in Orca 1.4.247; the manifest still allows 1.4.246.
  if (orca.host.has && !orca.host.has('workspace.list')) {
    out.issues.push('This Orca cannot list workspaces. Update Orca to 1.4.247 or later to name projects by workspace.')
  } else {
    try {
      const result = await orca.host.call('workspace.list')
      workspaces = result.workspaces
      if (result.truncated) out.issues.push('Orca returned a partial workspace list.')
    } catch {
      out.issues.push('Workspace metadata is unavailable.')
    }
  }
  let hidden: string[] = []
  try {
    hidden = parseHidden(await orca.settings.get('hiddenProjects'))
  } catch {
    out.issues.push('The Hidden projects setting could not be read. No project is hidden.')
  }

  try {
    const usage = await local.collect()
    out.issues.push(...usage.issues)
    // While history is still loading, ask the open panel to read again shortly.
    if (usage.issues.some(i => i.startsWith('Reading local history.')) && !historyTimer) {
      historyTimer = setTimeout(() => {
        historyTimer = undefined
        orca.panels.post('attribution.changed', {reason: 'local-history'})
      }, 2000)
      historyTimer.unref?.()
    }
    if (!usage.rows.length) out.issues.push('No logged usage found. Run Claude Code or Codex, then Refresh.')

    const today = dateString(new Date())
    out.bounds = {start: usage.rows.map(r => r.day).sort()[0] || today, end: today}
    const range = resolveRange(request, out.bounds)
    const rows = await attribute(usage.rows.filter(r => r.day >= range.start && r.day <= range.end), workspaces, local.home, hidden)

    const projects = new Map<string, number>(), harnesses = new Map<string, number>(), folders = new Map<string, number>()
    let unknown = 0
    for (const r of rows) {
      harnesses.set(r.source, (harnesses.get(r.source) || 0) + r.tokens)
      if (r.name) projects.set(r.name, (projects.get(r.name) || 0) + r.tokens)
      else unknown += r.tokens
      if (r.rule !== 'hidden') folders.set(r.folder, (folders.get(r.folder) || 0) + r.tokens)
    }

    out.projects = [...projects].map(([name, tokens]) => ({name, tokens})).sort((a, b) => b.tokens - a.tokens)
    out.harnesses = [...harnesses].map(([name, tokens]) => ({name, tokens}))
    out.unknown = usage.rows.length ? unknown : null
    out.state = usage.rows.length ? 'ready' : 'unavailable'
    out.range = range
    out.period = `${range.start} → ${range.end} · local time`
    // A folder total counts only sessions that started in exactly that folder. Home, shared and remote folders stay unknown.
    const canonical = await Promise.all(workspaces.map(w => realpath(w.path).catch(() => null)))
    const home = await realpath(local.home).catch(() => local.home)
    out.workspaces = workspaces
      .map((w, i) => ({w, path: canonical[i]}))
      .filter(({w}) => !isHidden(`${w.name} ${w.path}`, hidden))
      .map(({w, path}) => {
        const exact = path && path !== home && isLocal(w) && canonical.filter(p => p === path).length === 1
        return {name: w.name, tokens: exact ? folders.get(path) ?? null : null}
      })
  } catch (error) {
    if (request) throw error
    out.issues.push('Local usage logs could not be read.')
  }
  return out
}

export default function activate(orca: OrcaWorkerApi) {
  orca.panels.handle('attribution.read', input => snapshot(orca, input))
  for (const event of ['workspace.created', 'workspace.removed'] as const) {
    orca.events.on(event, () => orca.panels.post('attribution.changed', {reason: event}))
  }
}
