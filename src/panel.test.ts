import {assert, mockHost, mount, test} from 'orca/testing'
import * as panel from './panel'
import type {Snapshot} from './protocol'

test('hidden project setting saves and reads again', async () => {
  const empty: Snapshot = {readAt: 'now', period: 'Test period', state: 'ready', projects: [{name: 'Visible', tokens: 100}], unknown: 0, harnesses: [], workspaces: [], issues: []}
  const host = mockHost({capabilities: ['settings:own'], requests: {'attribution.read': () => host.data().settings.hiddenProjects
    ? {...empty, projects: [], unknown: 100} : empty}})
  const p = await mount(panel, {host})
  try {
    assert.ok(p.find({text: '100% attributed'}))
    await p.toggle({label: 'Hidden projects'})
    await p.type({label: 'Hidden project names'}, 'visible', {replace: true})
    await p.press({text: 'Save'})
    assert.equal(host.data().settings.hiddenProjects, 'visible')
    assert.ok(p.find({text: '0% attributed'}))
    assert.equal(p.errors.length, 0); assert.equal(p.warnings.length, 0)
  } finally {p.unmount()}
})

test('an empty machine shows an empty state, not zeros', async () => {
  const host = mockHost({requests: {'attribution.read': () => ({readAt: 'now', period: 'Unavailable', state: 'unavailable', projects: [], unknown: null, harnesses: [], workspaces: [], issues: []})}})
  const p = await mount(panel, {host})
  try {
    assert.ok(p.summary().includes('EmptyState "No usage logs yet"'))
    assert.equal(p.find({text: '0 / 0 tokens'}), null)
  } finally {p.unmount()}
})

test('share bars include unassigned tokens and disappear when the denominator is unknown', async () => {
  const snapshot: Snapshot = {readAt: 'now', period: 'Test period', state: 'ready', projects: [{name: 'Leader', tokens: 300}, {name: 'Second', tokens: 200}], unknown: 9500, harnesses: [{name: 'Harness', tokens: 10000}], workspaces: [], issues: []}
  const host = mockHost({requests: {'attribution.read': () => snapshot}})
  const p = await mount(panel, {host})
  try {
    assert.ok(p.find({text: '5% attributed'}))
    assert.ok(p.find({text: '500 / 10K tokens'}))
    assert.equal(p.find({type: 'Progress', label: 'Attributed share of all logged tokens'})?.props.value, 5)
    assert.equal(p.find({type: 'Progress', label: 'Leader: 3% of all logged tokens'})?.props.value, 3)
    assert.equal(p.find({type: 'Progress', label: 'Second: 2% of all logged tokens'})?.props.value, 2)
    assert.deepEqual(p.summary().filter(line => line.startsWith('Heading')), ['Heading "Attribution"', 'Heading "5% attributed"', 'Heading "Projects"'])
    snapshot.unknown = 500
    await p.press({label: 'Refresh'})
    assert.ok(p.find({text: '50% attributed'}))
    assert.ok(p.find({text: '500 / 1K tokens'}))
    snapshot.unknown = null
    await p.press({label: 'Refresh'})
    assert.ok(p.find({text: 'Unknown attributed'}))
    assert.ok(p.find({text: '500 / Unknown tokens'}))
    assert.equal(p.findAll({type: 'Progress'}).length, 0)
    assert.ok(p.find({text: 'Unknown'}))
    snapshot.projects = []; snapshot.unknown = 0
    await p.press({label: 'Refresh'})
    assert.ok(p.find({text: 'Unknown attributed'}))
    assert.ok(p.find({text: '0 / 0 tokens'}))
    snapshot.unknown = 100
    await p.press({label: 'Refresh'})
    assert.ok(p.find({text: '0% attributed'}))
    assert.equal(p.errors.length, 0); assert.equal(p.warnings.length, 0)
  } finally {p.unmount()}
})

test('range updates retain previous counts in flight and on rejected ranges', async () => {
  const snapshot: Snapshot = {readAt:'now',period:'Old range',state:'ready',projects:[{name:'Example',tokens:100}],unknown:0,harnesses:[],workspaces:[],issues:[]}
  let reject = false, observed = false
  const host = mockHost({requests:{'attribution.read': async () => {
    if (!observed) {observed=true; return snapshot}
    await new Promise(resolve => setTimeout(resolve, 25))
    if (reject) throw Error('Unavailable range')
    return {...snapshot, period:'New range', projects:[{name:'Example',tokens:200}]}
  }}})
  const p = await mount(panel,{host})
  try {
    const pending = p.press({text:'Today'})
    assert.ok(p.find({text:'100 / 100 tokens'}))
    await pending
    assert.ok(p.find({text:'200 / 200 tokens'}))
    reject=true
    await p.press({text:'7 days'})
    assert.ok(p.find({text:'200 / 200 tokens'}))
    assert.ok(p.find({text:'New range'}))
  } finally {p.unmount()}
})
