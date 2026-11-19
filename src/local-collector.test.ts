import {test, assert} from 'orca/testing'
import {mkdtemp, mkdir, writeFile, appendFile, readFile, rm, utimes} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {LocalCollector, attribute, parseHidden, projectMarker} from './local-collector'
import {resolveRange} from './range'
import {snapshot} from './worker'

test('cold install reads both harnesses without settings or a server; incremental cache keeps no prompts', async () => {
  const home = await mkdtemp(join(tmpdir(),'attribution-cold-'))
  try {
    const claude = join(home,'.claude/projects/example'), codex = join(home,'.codex/sessions/2026/11/18'), repo = join(home,'example')
    for (const path of [claude,codex,join(repo,'.git')]) await mkdir(path,{recursive:true})
    const c = join(claude,'c.jsonl'), x = join(codex,'x.jsonl')
    const message = (id: string, tokens: number) => ({type:'assistant',timestamp:'2026-11-18T12:00:00Z',sessionId:'claude',cwd:repo,message:{id,usage:{input_tokens:tokens,output_tokens:20,cache_read_input_tokens:30,cache_creation_input_tokens:40},content:[{type:'text',text:'SECRET PROMPT NEVER CACHE'}]}})
    await writeFile(c,JSON.stringify(message('one',10))+'\n'+JSON.stringify(message('one',10))+'\n')
    await writeFile(x,[{type:'session_meta',payload:{id:'codex',cwd:home}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'PROJECT: Declared project · LANE: test\nSECRET PROMPT'}]}},...[100,100,160].map(total => ({type:'event_msg',timestamp:'2026-11-18T12:00:00Z',payload:{type:'token_count',info:{total_token_usage:{total_tokens:total}}}}))].map(r=>JSON.stringify(r)).join('\n')+'\n')
    const collector = new LocalCollector(home)
    const first = await collector.collect()
    assert.equal(first.rows.reduce((n,r)=>n+r.tokens,0),260)
    assert.equal((await collector.collect()).bytesRead,0)
    assert.equal((await new LocalCollector(home).collect()).bytesRead,0)
    const attributed = await attribute(first.rows,[{path:repo,name:'Example'}],home)
    assert.equal(attributed.find(r=>r.source==='Claude Code')?.name,'Example')
    assert.equal(attributed.find(r=>r.source==='Codex')?.name,'Declared project')
    assert.ok(!(await readFile(join(home,'.cache/orca-attribution/usage-v2.json'),'utf8')).includes('SECRET'))
    const fake = {settings:{get:async()=>''},host:{call:async()=>({workspaces:[{path:repo,name:'Example'}]})}} as any
    const d = await snapshot(fake,undefined,collector)
    assert.equal(d.state,'ready'); assert.equal(d.unknown,0)
    assert.equal(d.projects.reduce((n,r)=>n+r.tokens,0),260)
    await appendFile(c,JSON.stringify(message('two',100)).slice(0,-1))
    assert.equal((await collector.collect()).rows.length,3)
    await appendFile(c,'}\n')
    assert.equal((await collector.collect()).rows.reduce((n,r)=>n+r.tokens,0),450)
    await writeFile(c,JSON.stringify(message('new',1))+'\n')
    assert.equal((await collector.collect()).rows.reduce((n,r)=>n+r.tokens,0),251)
  } finally {await rm(home,{recursive:true,force:true})}
})

test('range presets use inclusive local dates, calendar arithmetic and reject missing periods', () => {
  const bounds={start:'2026-01-01',end:'2026-11-18'}
  assert.deepEqual(resolveRange({preset:'today'},bounds,'2026-11-18'),{start:'2026-11-18',end:'2026-11-18'})
  assert.deepEqual(resolveRange({preset:'7'},bounds,'2026-11-18'),{start:'2026-11-12',end:'2026-11-18'})
  assert.deepEqual(resolveRange({preset:'30'},bounds,'2026-03-15'),{start:'2026-02-14',end:'2026-03-15'})
  assert.deepEqual(resolveRange({preset:'all'},bounds),bounds)
  for (const r of [{start:'2026-02-30',end:'2026-03-01'},{start:'2025-12-01',end:'2026-01-01'},{start:'2026-11-19',end:'2026-11-18'}]) {
    let failed=false;try {resolveRange(r,bounds)}catch {failed=true} assert.ok(failed)
  }
  assert.equal(projectMarker('Instructions\nPROJECT: Wrong'),null)
  assert.equal(projectMarker('> PROJECT: Wrong'),null)
  assert.equal(projectMarker('PROJECT: Research\nLooking at the logs'),'Research')
  assert.equal(projectMarker('PROJECT: Research · LANE: map'),'Research')
})

test('worktree cwd resolves its real repository and quoted PROJECT lines stay ignored', async () => {
  const home = await mkdtemp(join(tmpdir(),'attribution-git-'))
  try {
    const main = join(home,'actual-repo'), worktree = join(home,'lane-folder'), gitdir=join(main,'.git/worktrees/lane')
    await mkdir(gitdir,{recursive:true}); await mkdir(worktree)
    await writeFile(join(worktree,'.git'),`gitdir: ${gitdir}\n`)
    await writeFile(join(gitdir,'commondir'),'../..\n')
    const rows=await attribute([{id:'one',session:'s',source:'Codex',day:'2026-11-18',tokens:100,cwd:worktree,project:null}],[],home)
    assert.equal(rows[0].name,'actual-repo')
    assert.equal(projectMarker('PROJECT: <project>'),null)
  } finally {await rm(home,{recursive:true,force:true})}
})

test('bounded reads resume and Codex reset starts a new baseline', async () => {
  const home=await mkdtemp(join(tmpdir(),'attribution-bounded-'))
  try {
    const dir=join(home,'.codex/sessions');await mkdir(dir,{recursive:true})
    const records=[{type:'session_meta',payload:{id:'reset',cwd:home}},...[100,100,40,100].map(n=>({type:'event_msg',timestamp:'2026-11-18T12:00:00Z',payload:{type:'token_count',info:{total_token_usage:{total_tokens:n}}}}))]
    await writeFile(join(dir,'one.jsonl'),records.map(r=>JSON.stringify(r)).join('\n')+'\n')
    const c=new LocalCollector(home)
    const first=await c.collect(400);assert.ok(first.bytesRead<=400)
    assert.ok(first.issues.some(s=>s.includes('partial')))
    let result=first
    for (let i=0;i<5;i++) result=await c.collect(400)
    assert.equal(result.rows.reduce((n,r)=>n+r.tokens,0),160)
    assert.equal(result.bytesRead,0)
  } finally {await rm(home,{recursive:true,force:true})}
})

test('hidden names ignore the macOS /private prefix but still match the name', async () => {
  const row = (cwd: string, project: string) => ({id: cwd, session: 's', source: 'Codex', day: '2026-11-18', tokens: 10, cwd, project})
  const rows = await attribute([row('/private/var/folders/ab/T/demo', 'Demo'), row('/tmp/client-x', 'Jobs'), row('/nowhere', 'Client notes')], [], '/nonexistent-home', parseHidden('private, client'))
  assert.equal(rows[0].name, 'Demo'); assert.equal(rows[0].rule, 'session PROJECT declaration')
  assert.equal(rows[1].name, null); assert.equal(rows[1].rule, 'hidden')
  assert.equal(rows[2].name, null); assert.equal(rows[2].rule, 'hidden')
  assert.equal((await attribute([row('/x', 'Private')], [], '/h'))[0].name, 'Private')
})

test('real-data regressions: a session keeps one project after cd, its declaration wins and covers subagents', async () => {
  const home = await mkdtemp(join(tmpdir(), 'attribution-session-'))
  try {
    const start = join(home, 'started-here'), visited = join(home, 'visited'), logs = join(home, '.claude/projects/p')
    for (const p of [join(start, '.git'), join(visited, '.git'), join(logs, 'decl/subagents')]) await mkdir(p, {recursive: true})
    const msg = (session: string, cwd: string, id: string, text = '') => JSON.stringify({type: 'assistant', timestamp: '2026-11-18T12:00:00Z', sessionId: session, cwd,
      message: {id, usage: {input_tokens: 10}, content: [{type: 'text', text}]}})
    // No declaration: the agent cd's into another repository, the session stays with its start folder.
    await writeFile(join(logs, 'drift.jsonl'), [msg('drift', start, 'd1'), msg('drift', visited, 'd2'), msg('drift', visited, 'd3')].join('\n') + '\n')
    // A declaration in the first reply labels the turn before it, later folders and the subagent log.
    await writeFile(join(logs, 'decl.jsonl'), [msg('decl', start, 'e1'), msg('decl', start, 'e2', 'PROJECT: Research · LANE: map'), msg('decl', visited, 'e3')].join('\n') + '\n')
    await writeFile(join(logs, 'decl/subagents/agent-1.jsonl'), msg('decl', visited, 's1') + '\n')
    const rows = await attribute((await new LocalCollector(home).collect()).rows, [], home)
    const by = (name: string | null) => rows.filter(r => r.name === name).reduce((n, r) => n + r.tokens, 0)
    assert.equal(by('started-here'), 30); assert.equal(by('Research'), 40); assert.equal(by('visited'), 0)
    // A subagent's own declaration never relabels its parent session.
    await writeFile(join(logs, 'decl/subagents/agent-2.jsonl'), msg('drift', visited, 's2', 'PROJECT: Elsewhere') + '\n')
    const again = await attribute((await new LocalCollector(home).collect()).rows, [], home)
    assert.equal(again.filter(r => r.name === 'started-here').reduce((n, r) => n + r.tokens, 0), 30)
    assert.equal(again.filter(r => r.name === 'Elsewhere').reduce((n, r) => n + r.tokens, 0), 10)
  } finally {await rm(home, {recursive: true, force: true})}
})

test('a large Claude history cannot starve Codex: newest files are read first across harnesses', async () => {
  const home = await mkdtemp(join(tmpdir(), 'attribution-fair-'))
  try {
    const claude = join(home, '.claude/projects/a'), codex = join(home, '.codex/sessions/x')
    await mkdir(claude, {recursive: true}); await mkdir(codex, {recursive: true})
    const big = Array.from({length: 50}, (_, i) => JSON.stringify({type: 'assistant', timestamp: '2026-11-01T12:00:00Z', sessionId: 'old', cwd: home, message: {id: 'm' + i, usage: {input_tokens: 1}}})).join('\n') + '\n'
    await writeFile(join(claude, 'old.jsonl'), big)
    await utimes(join(claude, 'old.jsonl'), new Date('2026-11-01'), new Date('2026-11-01'))
    await writeFile(join(codex, 'new.jsonl'), [{type: 'session_meta', payload: {id: 'new', cwd: home}},
      {type: 'event_msg', timestamp: '2026-11-18T12:00:00Z', payload: {type: 'token_count', info: {total_token_usage: {total_tokens: 70}}}}].map(r => JSON.stringify(r)).join('\n') + '\n')
    const first = await new LocalCollector(home).collect(400)
    assert.equal(first.rows.filter(r => r.source === 'Codex').reduce((n, r) => n + r.tokens, 0), 70)
    // A log that ends in half a record is not 'partial history' forever.
    await appendFile(join(codex, 'new.jsonl'), '{"type":"event_msg"')
    const c = new LocalCollector(home)
    for (let i = 0; i < 10; i++) await c.collect()
    assert.ok(!(await c.collect()).issues.some(i => i.includes('partial')))
  } finally {await rm(home, {recursive: true, force: true})}
})
