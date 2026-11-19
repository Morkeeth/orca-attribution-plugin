import {atom, read, set, plugin, settings, on, Stack, Row, Heading, Text, Button, Input, Table,
  Collapsible, Separator, Callout, EmptyState, IconButton, Progress, List, ListItem, Box, type PanelContext} from 'orca'
import type {Snapshot} from './protocol'
import type {RangeRequest} from './range'

const selectedRange = atom<RangeRequest>({preset: 'all'})
const customOpen = atom(false), startDate = atom(''), endDate = atom('')
const data = atom<Snapshot | null>(null), error = atom(''), busy = atom(false)
const hiddenProjects = atom(''), settingsReady = atom(false)
let reading: Promise<void> | null = null

const fmt = (n: number) => new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(n)
const pct = (n: number) => new Intl.NumberFormat('en', {style: 'percent', maximumFractionDigits: 1}).format(n)
const workspaceColumns = [{key: 'name', label: 'Workspace'}, {key: 'tokens', label: 'Folder tokens', align: 'end' as const}]
const presets = [['today', 'Today'], ['7', '7 days'], ['30', '30 days'], ['all', 'All']] as const

function refresh(): Promise<void> {
  if (reading) return reading
  set(busy, true)
  set(error, '')
  reading = (async () => {
    try {
      set(data, await plugin.request('attribution.read', read(selectedRange), {timeoutMs: 120000}))
    } catch (e) {
      set(error, e instanceof Error ? e.message : 'This period could not be read. Try Refresh.')
    } finally {
      set(busy, false)
      reading = null
    }
  })()
  return reading
}

async function saveHidden() {
  try {
    await settings.set('hiddenProjects', read(hiddenProjects).trim())
    // A read started before the setting was saved must not stand in for this one.
    if (reading) await reading
    await refresh()
  } catch {
    set(error, 'The setting could not be saved.')
  }
}

async function chooseRange(range: RangeRequest) {
  if (reading) return
  const previous = read(selectedRange)
  set(selectedRange, range)
  await refresh()
  // A rejected range keeps the previous counts and selection.
  if (read(error)) set(selectedRange, previous)
}

export function setup(ctx: PanelContext) {
  ctx.subscriptions.push(plugin.on('attribution.changed', refresh), on('workspace.changed', refresh))
  void settings.get().then(s => {
    set(hiddenProjects, String(s.hiddenProjects || ''))
    set(settingsReady, true)
  })
  void refresh()
}

export default function Panel() {
  const d = read(data)
  const workspaces = d?.workspaces.map((w, i) => ({key: String(i), cells: {name: w.name, tokens: w.tokens === null ? 'Unknown' : fmt(w.tokens)}})) || []
  const attributed = d ? d.projects.reduce((sum, p) => sum + p.tokens, 0) : null
  const total = d && d.unknown !== null && attributed !== null ? attributed + d.unknown : null
  const share = total !== null && total > 0 && attributed !== null ? pct(attributed / total) : 'Unknown'

  // Every bar uses all logged usage as its denominator, never just labelled usage.
  const projectRows = (items: Snapshot['projects']) => <List label="Project shares">
    {items.map(p => <ListItem key={p.name} icon="folder">
      <Stack gap="xs">
        <Row justify="between" gap="sm">
          <Text weight="medium" truncate>{p.name}</Text>
          <Text size="xs">{fmt(p.tokens)}{total ? ` · ${pct(p.tokens / total)}` : ''}</Text>
        </Row>
        {total
          ? <Progress label={`${p.name}: ${pct(p.tokens / total)} of all logged tokens`} labelHidden value={p.tokens / total * 100}/>
          : <Text size="xs">Share unavailable</Text>}
      </Stack>
    </ListItem>)}
  </List>

  return <Stack gap="lg">
    <Row justify="between" align="center">
      <Heading>Attribution</Heading>
      <IconButton size="sm" variant="ghost" icon="refresh" label="Refresh" tooltip="Read local logs again" onPress={refresh} disabled={read(busy)}/>
    </Row>
    <Stack gap="sm">
      <Row gap="xs" wrap>
        {presets.map(([preset, label]) =>
          <Button size="sm" variant={read(selectedRange).preset === preset ? 'outline' : 'ghost'} disabled={read(busy)} onPress={() => chooseRange({preset})}>{label}</Button>)}
        <Button size="sm" variant="ghost" icon="calendar" disabled={read(busy)} onPress={() => {
          set(startDate, d?.range?.start || '')
          set(endDate, d?.range?.end || '')
          set(customOpen, !read(customOpen))
        }}>Custom</Button>
      </Row>
      {read(customOpen) ? <Stack gap="sm">
        <Row gap="sm">
          <Input label="Start date" placeholder="YYYY-MM-DD" value={read(startDate)} onChange={v => set(startDate, v)}/>
          <Input label="End date" placeholder="YYYY-MM-DD" value={read(endDate)} onChange={v => set(endDate, v)}/>
        </Row>
        <Button size="sm" variant="outline" disabled={read(busy)} onPress={() => chooseRange({start: read(startDate), end: read(endDate)})}>Apply range</Button>
      </Stack> : null}
    </Stack>
    {read(error) ? <Callout tone="danger">{read(error)}</Callout> : null}
    {!d ? <Text>Reading local logs…</Text> : <Stack gap="md">
      {d.issues.length ? <Callout tone="warning">{d.issues.join(' ')}</Callout> : null}
      {d.state !== 'ready'
        ? <EmptyState icon="folder" title="No usage logs yet" description="Run Claude Code or Codex on this machine, then press Refresh."/>
        : <Stack gap="md">
          <Box paddingY="sm">
            <Stack gap="sm">
              <Text size="xs">{d.period}</Text>
              <Heading level={1}>{share} attributed</Heading>
              {total && attributed !== null ? <Progress label="Attributed share of all logged tokens" labelHidden value={attributed / total * 100}/> : null}
              <Text size="xs">{attributed === null ? 'Unknown' : fmt(attributed)} / {total === null ? 'Unknown' : fmt(total)} tokens</Text>
            </Stack>
          </Box>
          <Separator/>
          <Stack gap="xs">
            <Row justify="between"><Heading level={3}>Projects</Heading><Text size="xs">Logged tokens</Text></Row>
            {d.projects.length
              ? projectRows(d.projects.slice(0, 3))
              : <EmptyState icon="folder" title="No attributed projects" description="No session in this period started in a repository or declared a project."/>}
            {d.projects.length > 3 ? <Collapsible title="More projects">{projectRows(d.projects.slice(3))}</Collapsible> : null}
            <List label="Unassigned usage"><ListItem icon="info">
              <Row justify="between" gap="sm">
                <Text size="sm">Unassigned or hidden</Text>
                <Text size="sm" weight="medium">{d.unknown === null ? 'Unknown' : fmt(d.unknown)}</Text>
              </Row>
            </ListItem></List>
            <Text size="xs">Bars show share of all logged tokens.</Text>
          </Stack>
          <Separator/>
          <Collapsible title="Workspaces" description="Sessions that started in each folder">
            <Stack gap="sm">
              <Table label="Workspace tokens" columns={workspaceColumns} rows={workspaces} emptyText="No local workspaces" maxHeight="sm"/>
              <Text size="sm">Unknown means a home, shared or remote folder. Folder usage can include work outside Orca.</Text>
            </Stack>
          </Collapsible>
          <Collapsible title="Source details" description="Harnesses, period and limits">
            <Stack gap="sm">
              {d.harnesses.map(h => <Text size="sm">{h.name}: {fmt(h.tokens)} logged tokens</Text>)}
              <Text size="xs">Tokenizers differ. Counts include cached input and do not measure effort or cost.</Text>
              <Text size="sm">Panel read: {d.readAt}</Text>
            </Stack>
          </Collapsible>
        </Stack>}
      <Separator/>
      <Collapsible title="Hidden projects">
        <Stack gap="sm">
          <Text size="sm">Projects whose name or folder contains one of these words count as unassigned and are left out of the workspace list.</Text>
          <Input label="Hidden project names" placeholder="client-a, personal" value={read(hiddenProjects)} onChange={v => set(hiddenProjects, v)}/>
          <Button size="sm" variant="outline" onPress={saveHidden} disabled={read(busy) || !read(settingsReady)}>Save</Button>
        </Stack>
      </Collapsible>
      <Text size="xs">Local logs · read only · no network</Text>
    </Stack>}
  </Stack>
}
