import {open, readdir, readFile, stat, mkdir, writeFile, rename, realpath} from 'node:fs/promises'
import {createInterface} from 'node:readline'
import {join, dirname, basename, relative, isAbsolute, resolve} from 'node:path'
import {homedir} from 'node:os'

export type Usage = {
  id: string
  session: string
  source: string
  day: string
  tokens: number
  cwd: string
  project: string | null
}
type FileCache = {
  ino: number
  offset: number
  modified: number
  cwd: string
  startCwd?: string
  project: string | null
  firstProject?: string | null
  session: string
  cumulative: number
  epoch?: number
  rows: Record<string, Usage>
}
type Cache = {version: number; files: Record<string, FileCache>}
type Workspace = {name: string; path: string; hostId?: string | null}

const CACHE_VERSION = 2
const SOURCES = [['Claude Code', '.claude/projects'], ['Codex', '.codex/sessions']] as const

const isSubagentLog = (path: string) => /[\\/]subagents[\\/]/.test(path)
const count = (v: unknown): number => (Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : 0)

/** Parses a comma-separated list of hidden project names from the plugin setting. */
export function parseHidden(setting: unknown): string[] {
  return String(setting || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

/**
 * True when a project name or folder contains one of the user's hidden names.
 * macOS resolves temp folders under /private; that system prefix is not a project name.
 */
export function isHidden(text: string, hidden: string[]): boolean {
  const haystack = text.replace(/(^|\s)\/private\//g, '$1/').toLowerCase()
  return hidden.some(name => haystack.includes(name))
}

/** Reads an opening `PROJECT: <name>` declaration. Quoted or later lines never count. */
export function projectMarker(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const m = /^\s*PROJECT:\s*([^\n·]+?)\s*(?:·|\n|$)/.exec(text)
  if (!m) return null
  const name = m[1].trim()
  return name.length <= 100 && !/[<>`{}\[\]]/.test(name) ? name : null
}

function textMarker(blocks: unknown): string | null {
  if (typeof blocks === 'string') return projectMarker(blocks)
  if (!Array.isArray(blocks)) return null
  const first = blocks.find(b => ['text', 'input_text', 'output_text'].includes(b?.type))
  return projectMarker(first?.text)
}

function dayOf(ts: unknown): string {
  const d = new Date(String(ts))
  if (!Number.isFinite(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function* jsonlFiles(root: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(root, {withFileTypes: true})
  } catch (e: any) {
    if (e.code === 'ENOENT') return
    throw e
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) yield* jsonlFiles(join(root, e.name))
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield join(root, e.name)
  }
}

/**
 * Reads token counters from local Claude Code and Codex session logs.
 * Only counters, dates, working folders and PROJECT labels are cached; message text never is.
 */
export class LocalCollector {
  private cache: Cache | null = null
  private pending: Promise<{rows: Usage[]; bytesRead: number; issues: string[]}> | null = null

  constructor(readonly home = homedir()) {}

  collect(maxBytes = 64 * 1024 * 1024) {
    if (!this.pending) this.pending = this.read(maxBytes).finally(() => { this.pending = null })
    return this.pending
  }

  private async loadCache(path: string): Promise<Cache> {
    if (this.cache) return this.cache
    try {
      const c = JSON.parse(await readFile(path, 'utf8'))
      if (c.version === CACHE_VERSION) this.cache = c
    } catch {}
    this.cache ||= {version: CACHE_VERSION, files: {}}
    return this.cache
  }

  private async read(maxBytes: number) {
    const cachePath = join(this.home, '.cache', 'orca-attribution', `usage-v${CACHE_VERSION}.json`)
    const cache = await this.loadCache(cachePath)
    const seen = new Set<string>(), issues: string[] = []
    let bytesRead = 0, incomplete = false

    // Newest files first across both harnesses, so recent days are complete first and
    // one large history cannot starve the other harness.
    const queue: {path: string; source: string; s: {ino: number; size: number; mtimeMs: number}}[] = []
    for (const [source, root] of SOURCES) {
      try {
        for await (const path of jsonlFiles(join(this.home, root))) {
          seen.add(path)
          try {
            queue.push({path, source, s: await stat(path)})
          } catch {
            issues.push(`A ${source} log could not be read.`)
          }
        }
      } catch {
        issues.push(`${source} log directory could not be read.`)
      }
    }
    queue.sort((a, b) => Number(b.s.mtimeMs) - Number(a.s.mtimeMs) || a.path.localeCompare(b.path))

    for (const {path, source, s} of queue) {
      let c = cache.files[path]
      const replaced = !c || c.ino !== s.ino || s.size < c.offset || (s.size === c.offset && s.mtimeMs !== c.modified)
      if (replaced) {
        c = {ino: Number(s.ino), offset: 0, modified: 0, cwd: '', project: null, session: basename(path, '.jsonl'), cumulative: 0, rows: {}}
      }
      if (s.size === c.offset && s.mtimeMs === c.modified) continue
      if (bytesRead >= maxBytes) {
        incomplete = true
        continue
      }
      try {
        const readEnd = Math.min(Number(s.size), c.offset + maxBytes - bytesRead)
        const result = await this.readLines(path, source, replaced ? c : structuredClone(c), readEnd, issues)
        c = result.cache
        bytesRead += result.bytes
        // Only the byte budget makes a read partial. An unfinished last line is retried quietly.
        if (readEnd < s.size) incomplete = true
        c.offset = result.consumed
        c.modified = Number(s.mtimeMs)
        cache.files[path] = c
      } catch {
        issues.push(`A ${source} log could not be read.`)
      }
    }

    for (const path of Object.keys(cache.files)) if (!seen.has(path)) delete cache.files[path]

    // A PROJECT declaration labels its whole session, including the turns before it and the
    // subagent logs that share its session id. Only a main session log labels its session; a subagent's own declaration labels only that subagent.
    const declared = new Map<string, string>()
    for (const [path, c] of Object.entries(cache.files)) {
      if (c.firstProject && !isSubagentLog(path)) declared.set(c.session, c.firstProject)
    }
    const rows = new Map<string, Usage>()
    for (const [path, c] of Object.entries(cache.files)) {
      const inherited = isSubagentLog(path) ? declared.get(c.session) : undefined
      for (const stored of Object.values(c.rows)) {
        const r = {...stored, project: stored.project || c.firstProject || inherited || null}
        const key = r.source + ':' + r.id, old = rows.get(key)
        if (!old || old.tokens < r.tokens) rows.set(key, r)
      }
    }

    if (bytesRead) {
      try {
        await mkdir(dirname(cachePath), {recursive: true, mode: 0o700})
        const temp = `${cachePath}.${process.pid}.tmp`
        await writeFile(temp, JSON.stringify(cache), {mode: 0o600})
        await rename(temp, cachePath)
      } catch {
        issues.push('The local usage cache could not be saved. The next read may take longer.')
      }
    }
    if (incomplete) issues.push('Reading local history. Counts are partial; the open panel continues loading in small batches.')
    return {rows: [...rows.values()], bytesRead, issues: [...new Set(issues)]}
  }

  /** Reads complete lines from c.offset up to readEnd. A partly written last line is retried next time. */
  private async readLines(path: string, source: string, c: FileCache, readEnd: number, issues: string[]) {
    const fd = await open(path, 'r')
    const stream = fd.createReadStream({start: c.offset, end: readEnd - 1, autoClose: false})
    const rl = createInterface({input: stream, crlfDelay: Infinity})
    let consumed = c.offset, bytes = 0
    try {
      for await (const line of rl) {
        const length = Buffer.byteLength(line) + 1
        if (consumed + length > readEnd) break
        consumed += length
        bytes += length
        let r: any
        try {
          r = JSON.parse(line)
        } catch {
          issues.push('A malformed usage record was skipped.')
          continue
        }
        this.record(r, source, c, consumed)
      }
    } finally {
      rl.close()
      stream.destroy()
      await fd.close()
    }
    return {consumed, bytes, cache: c}
  }

  private record(r: any, source: string, c: FileCache, position: number) {
    const p = r.payload || {}, m = r.message || {}
    if (typeof r.cwd === 'string') c.cwd = r.cwd
    if (source === 'Codex' && ['session_meta', 'turn_context'].includes(r.type) && typeof p.cwd === 'string') c.cwd = p.cwd
    // A session belongs to the folder it started in. Later `cd` commands move the logged
    // cwd into folders the agent only visited, so they do not move the attribution.
    if (c.cwd && !c.startCwd) c.startCwd = c.cwd
    if (r.type === 'session_meta' && typeof p.id === 'string') c.session = p.id
    if (typeof r.sessionId === 'string') c.session = r.sessionId

    // Message content is inspected only for an opening PROJECT declaration, then dropped.
    let marker: string | null = null
    if (['user', 'assistant'].includes(r.type) && !r.isMeta && !r.isCompactSummary) marker = textMarker(m.content)
    if (r.type === 'response_item' && p.type === 'message' && ['user', 'assistant'].includes(p.role)) marker = textMarker(p.content)
    if (marker) {
      c.project = marker
      c.firstProject ||= marker
    }

    let tokens = 0, id = ''
    if (source === 'Claude Code' && r.type === 'assistant' && m.usage) {
      const u = m.usage
      tokens = count(u.input_tokens) + count(u.output_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens)
      id = String(m.id || r.uuid || position)
    }
    if (source === 'Codex' && r.type === 'event_msg' && p.type === 'token_count' && p.info) {
      const u = p.info.total_token_usage
      if (u && Number.isSafeInteger(u.total_tokens)) {
        // Codex logs a running total. A drop means the counter restarted.
        const total = count(u.total_tokens)
        if (total < c.cumulative) c.epoch = (c.epoch || 0) + 1
        tokens = Math.max(0, total - c.cumulative)
        c.cumulative = total
        id = `epoch:${c.epoch || 0}:total:${total}`
      }
    }
    const day = dayOf(r.timestamp)
    if (!id || !day || !tokens) return
    const key = `${c.session}:${id}`
    const old = c.rows[key]
    // Streaming Claude records repeat the message id. Keep the largest counter snapshot.
    if (!old || old.tokens < tokens) c.rows[key] = {id: key, session: c.session, source, day, tokens, cwd: c.startCwd || c.cwd, project: c.project}
  }
}

const inside = (path: string, root: string) => {
  const r = relative(root, path)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/** Finds the repository that owns a folder, following a worktree's .git file to its main repository. */
async function repositoryName(path: string, home: string): Promise<string | null> {
  let dir = path
  while (dir !== dirname(dir) && dir !== home) {
    try {
      const git = await stat(join(dir, '.git'))
      let repo = dir
      if (git.isFile()) {
        const pointer = (await readFile(join(dir, '.git'), 'utf8')).trim().replace(/^gitdir:\s*/, '')
        const gitdir = resolve(dir, pointer)
        repo = dirname(resolve(gitdir, (await readFile(join(gitdir, 'commondir'), 'utf8')).trim()))
      }
      return basename(repo)
    } catch {}
    dir = dirname(dir)
  }
  return null
}

/**
 * Names the project for each usage row. Order: the session's PROJECT declaration, then the Orca
 * workspace that contains the folder the session started in, then the git repository around it.
 * Rows whose project matches a hidden name lose their name and count as unassigned.
 */
export async function attribute(rows: Usage[], workspaces: Workspace[], home = homedir(), hidden: string[] = []) {
  const roots: {path: string; name: string}[] = []
  for (const w of workspaces) {
    if ((w.hostId && w.hostId !== 'local') || w.path === home) continue
    try {
      roots.push({path: await realpath(w.path), name: w.name})
    } catch {}
  }

  const resolved = new Map<string, {name: string | null; rule: string; folder: string}>()
  for (const cwd of new Set(rows.map(r => r.cwd))) {
    let path = cwd
    try {
      if (cwd) path = await realpath(cwd)
    } catch {}
    let result = {name: null as string | null, rule: 'no repo cwd or PROJECT declaration', folder: path}
    if (cwd && cwd !== home) {
      const matches = roots.filter(w => inside(path, w.path)).sort((a, b) => b.path.length - a.path.length)
      // Two workspaces on the same folder are ambiguous, so neither name is used.
      if (matches.length && (matches.length === 1 || matches[0].path !== matches[1].path)) {
        result = {name: matches[0].name, rule: 'Orca workspace path', folder: path}
      } else {
        const repo = await repositoryName(path, home)
        if (repo) result = {name: repo, rule: 'session cwd inside git repository', folder: path}
      }
    }
    resolved.set(cwd, result)
  }

  return rows.map(r => {
    const byPath = resolved.get(r.cwd)!
    // An explicit PROJECT declaration outranks any folder evidence.
    const name = r.project || byPath.name
    const withheld = !!name && isHidden(`${name} ${r.cwd}`, hidden)
    const rule = withheld ? 'hidden' : r.project ? 'session PROJECT declaration' : byPath.rule
    return {...r, name: name && !withheld ? name : null, rule, folder: byPath.folder}
  })
}
