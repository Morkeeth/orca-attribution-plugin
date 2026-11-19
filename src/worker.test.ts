import {assert, test} from 'orca/testing'
import * as worker from './worker'
import {LocalCollector} from './local-collector'
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

// A minimal worker API: the snapshot reads only workspace.list and one setting.
const fakeOrca = (workspaces: unknown[], settings: Record<string, string> = {}) => ({
  host: {call: async () => ({workspaces, truncated: false})},
  settings: {get: async (key: string) => settings[key] ?? ''},
  panels: {post: () => {}}
}) as any

test('an empty home is unavailable, not zero', async () => {
  const home = await mkdtemp(join(tmpdir(), 'attribution-empty-'))
  try {
    const d = await worker.snapshot(fakeOrca([]), undefined, new LocalCollector(home))
    assert.equal(d.state, 'unavailable'); assert.equal(d.unknown, null); assert.equal(d.projects.length, 0)
    assert.ok(d.issues.some(i => i.includes('No logged usage found')))
  } finally {await rm(home, {recursive: true, force: true})}
})

test('hidden names move usage to unassigned and drop the workspace row; exact folders only', async () => {
  const home = await mkdtemp(join(tmpdir(), 'attribution-hidden-'))
  try {
    const a = join(home, 'alpha'), b = join(home, 'client-b'), logs = join(home, '.claude/projects/x')
    for (const p of [join(a, '.git'), join(b, '.git'), logs]) await mkdir(p, {recursive: true})
    const msg = (cwd: string, id: string, n: number) => JSON.stringify({type: 'assistant', timestamp: '2026-11-18T12:00:00Z', sessionId: id, cwd, message: {id, usage: {input_tokens: n}}})
    await writeFile(join(logs, 'a.jsonl'), msg(a, 'a', 100) + '\n')
    await writeFile(join(logs, 'b.jsonl'), msg(b, 'b', 50) + '\n')
    const ws = [{id: '1', kind: 'folder', name: 'alpha', path: a, branch: null, hostId: 'local'},
      {id: '2', kind: 'folder', name: 'client-b', path: b, branch: null, hostId: 'local'},
      {id: '3', kind: 'folder', name: 'remote', path: a, branch: null, hostId: 'ssh:box'}]
    const local = new LocalCollector(home)
    const fresh = await worker.snapshot(fakeOrca(ws), undefined, local)
    assert.deepEqual(fresh.projects, [{name: 'alpha', tokens: 100}, {name: 'client-b', tokens: 50}])
    assert.equal(fresh.unknown, 0)

    const d = await worker.snapshot(fakeOrca(ws, {hiddenProjects: 'Client'}), undefined, local)
    assert.deepEqual(d.projects, [{name: 'alpha', tokens: 100}])
    assert.equal(d.unknown, 50)
    // A folder listed twice (here a remote alias) is ambiguous, so it stays unknown.
    assert.deepEqual(d.workspaces, [{name: 'alpha', tokens: null}, {name: 'remote', tokens: null}])
    const single = await worker.snapshot(fakeOrca(ws.slice(0, 1)), undefined, new LocalCollector(home))
    assert.deepEqual(single.workspaces, [{name: 'alpha', tokens: 100}])
    // Hidden sessions never add tokens to a visible workspace row.
    await writeFile(join(logs, 'c.jsonl'), JSON.stringify({type: 'assistant', timestamp: '2026-11-18T12:00:00Z', sessionId: 'c', cwd: a,
      message: {id: 'c', usage: {input_tokens: 7}, content: [{type: 'text', text: 'PROJECT: Client notes'}]}}) + '\n')
    const mixed = await worker.snapshot(fakeOrca(ws.slice(0, 1), {hiddenProjects: 'client'}), undefined, new LocalCollector(home))
    assert.deepEqual(mixed.workspaces, [{name: 'alpha', tokens: 100}])
    assert.equal(mixed.unknown, 57)
  } finally {await rm(home, {recursive: true, force: true})}
})
