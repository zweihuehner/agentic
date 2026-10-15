import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ask, Plan, Task } from '../types'

const PANE = 'tasks-panel'
const COLLAPSE_OVER = 10
const STORE_DAYS = 30

const tasks = atom({ plugin: 'tasks-panel', key: 'tasks' } as const, [])
const asks = atom({ plugin: 'tasks-panel', key: 'asks' } as const, [])
const plan = atom({ plugin: 'tasks-panel', key: 'plan' } as const, null)

type $ = EngineInterface

// ---------------------------------------------------------------------------
// Plan file: <project root>/.claude/plans/<session name or id>.md

function slug(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

// One store record per session, stamped on every write so pruning can find
// sessions that never made a task
type Saved = { tasks?: Task[]; path?: string; opened?: boolean; at: number }

async function getSaved($: $): Promise<Saved | undefined> {
  const id = await $.session.id()
  return (await $.store.get(`session:${id}`)) as Saved | undefined
}

async function patchSaved($: $, patch: Partial<Saved>): Promise<void> {
  const id = await $.session.id()
  const had = (await $.store.get(`session:${id}`)) as Saved | undefined
  await $.store.set(`session:${id}`, {
    ...had,
    ...patch,
    at: await $.clock.now(),
  })
}

// The session registry only changes on a rename, so it is read at most every
// NAME_TTL, not on every plan poll
const NAME_TTL = 30_000
let nameCache: { id: string; name: string | undefined; at: number } | null =
  null

// The name the person gave the session (-n or /rename), from the session
// registry; derived and auto-generated names don't count as set.
async function sessionName($: $, id: string): Promise<string | undefined> {
  const now = await $.clock.now()
  if (nameCache?.id === id && now - nameCache.at < NAME_TTL) {
    return nameCache.name
  }
  const home = await $.env.get('HOME')
  if (!home) return undefined
  const dir = `${home}/.claude/sessions`
  const entries = await $.fs.list(dir).catch(() => [])
  const files = entries
    .filter(f => f.kind === 'file' && f.name.endsWith('.json'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  let name: string | undefined
  for (const f of files) {
    const text = await $.fs.read(`${dir}/${f.name}`).catch(() => '')
    if (!text.includes(id)) continue
    try {
      const entry = JSON.parse(text)
      if (entry.sessionId !== id) continue
      // Only a name the person gave (-n, /rename); older builds and
      // background jobs record names without saying where they came from
      const isGiven = entry.nameSource === 'user'
      const slugged = typeof entry.name === 'string' ? slug(entry.name) : ''
      name = slugged && isGiven ? slugged : undefined
      break
    } catch {
      continue
    }
  }
  nameCache = { id, name, at: now }
  return name
}

// Resolves this session's plan file, keeping a path once its file exists so
// a later rename doesn't orphan the plan.
//
// A session claims its plan file in the store and renews the claim while it
// runs, so two live sessions never share one: a second session with the same
// name gets <name>-<short id>.md instead.
async function resolvePlanPath($: $): Promise<string> {
  const id = await $.session.id()
  const root = await $.session.root()
  const name = await sessionName($, id)
  const now = await $.clock.now()
  const dir = `${root}/.claude/plans`
  const byName = name ? `${dir}/${name}.md` : undefined
  const wanted =
    byName && (await canClaim($, byName, id, now))
      ? byName
      : `${dir}/${name ? `${name}-${id.slice(0, 8)}` : id}.md`
  const kept = (await getSaved($))?.path
  let path = wanted
  if (kept !== undefined && kept !== wanted) {
    const isThere = await $.fs.exists(kept).catch(() => false)
    if (isThere && (await canClaim($, kept, id, now))) path = kept
  }
  await claim($, path, id, now)
  if (path !== kept) await patchSaved($, { path })
  return path
}

type Claim = { id: string; at: number }
const CLAIM_TTL = 120_000
const CLAIM_RENEW = 30_000

async function canClaim($: $, path: string, id: string, now: number) {
  const held = (await $.store.get(`claim:${path}`)) as Claim | undefined
  return !held || held.id === id || now - held.at > CLAIM_TTL
}

async function claim($: $, path: string, id: string, now: number) {
  const held = (await $.store.get(`claim:${path}`)) as Claim | undefined
  if (held?.id === id && now - held.at < CLAIM_RENEW) return
  await $.store.set(`claim:${path}`, { id, at: now })
}

// Gives the plan file up when the session ends or is cleared
async function releaseClaim($: $, id: string): Promise<void> {
  const saved = (await $.store.get(`session:${id}`)) as Saved | undefined
  if (saved?.path === undefined) return
  const held = (await $.store.get(`claim:${saved.path}`)) as Claim | undefined
  if (held?.id === id) await $.store.delete(`claim:${saved.path}`)
}

function parsePlan(text: string): { goal: string | null; questions: string[] } {
  let section = ''
  let goal: string | null = null
  const questions: string[] = []
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      section = (heading[1] ?? '').toLowerCase()
      continue
    }
    if (/^#\s/.test(line)) {
      section = ''
      continue
    }
    if (section === 'goal' && goal === null && line.trim()) {
      goal = line.trim().replace(/^[-*+]\s+/, '')
    }
    // Top-level bullets only; a ticked checkbox is an answered question
    const bullet = /^[-*+]\s+(\[[ xX]?\]\s+)?(.+)$/.exec(line)
    const isTicked = /x/i.test(bullet?.[1] ?? '')
    if (section === 'open questions' && bullet?.[2] && !isTicked) {
      questions.push(bullet[2].trim())
    }
  }
  return { goal, questions }
}

async function refreshPlan($: $): Promise<void> {
  const changed = await readPlan($)
  if (changed) await maybeAutoOpen($)
}

// Reads the plan file into state; true when what the pane shows changed
async function readPlan($: $): Promise<boolean> {
  const path = await resolvePlanPath($)
  const text = await $.fs.read(path).catch(() => null)
  const next: Plan =
    text === null
      ? { path, goal: null, questions: [] }
      : { path, ...parsePlan(text) }
  const current = await read($, plan)
  if (JSON.stringify(current) === JSON.stringify(next)) return false
  await update($, plan, () => next)
  return true
}

// ---------------------------------------------------------------------------
// Task state, mirrored from TaskCreate / TaskUpdate / TaskList calls

async function loadTasks($: $): Promise<void> {
  const saved = await getSaved($)
  await update($, tasks, () => saved?.tasks ?? [])
  await update($, asks, () => [])
}

async function pruneStore($: $): Promise<void> {
  const now = await $.clock.now()
  const cutoff = now - STORE_DAYS * 86_400_000
  const current = `session:${await $.session.id()}`
  for (const key of await $.store.keys()) {
    if (key === current) continue
    // Keys from before records were merged into one per session
    const isLegacy = /^(tasks|path|opened):/.test(key)
    const saved = (await $.store.get(key)) as { at?: number } | undefined
    const at = saved?.at ?? 0
    const isOld = key.startsWith('session:') && at < cutoff
    const isStaleClaim = key.startsWith('claim:') && at < now - CLAIM_TTL
    if (isLegacy || isOld || isStaleClaim) await $.store.delete(key)
  }
}

// Saves run one after another, each reading the state as it is then, so the
// last save always holds the latest list even when tool calls run in parallel
let saving: Promise<void> = Promise.resolve()

async function saveLatest($: $): Promise<void> {
  await patchSaved($, { tasks: await read($, tasks) })
}

async function changeTasks($: $, fn: (list: Task[]) => Task[]): Promise<void> {
  await update($, tasks, list => fn(list ?? []))
  saving = saving.then(() => saveLatest($)).catch(() => undefined)
  await saving
  await maybeAutoOpen($)
}

function upsert(list: Task[], id: string, fn: (t: Task) => Task): Task[] {
  const found = list.some(t => t.id === id)
  const base: Task = {
    id,
    subject: `task ${id}`,
    status: 'pending',
    blockedBy: [],
    byAgent: false,
  }
  return found
    ? list.map(t => (t.id === id ? fn(t) : t))
    : [...list, fn(base)]
}

const union = (a: string[], b: readonly string[] = []) => [
  ...new Set([...a, ...b]),
]

// Opens the pane once per session, when the first task or decision shows up
async function maybeAutoOpen($: $): Promise<void> {
  if ((await getSaved($))?.opened) return
  const view = buildView(
    await read($, tasks),
    await read($, asks),
    await read($, plan),
  )
  if (view.rows.length === 0 && view.decide.length === 0) return
  await patchSaved($, { opened: true })
  await $.ui.open({ id: PANE, title: 'tasks' })
}

// ---------------------------------------------------------------------------
// What the pane shows

type DecideItem = { text: string; blocks: string[] }
type Row = Task & { waitsOnDecision: boolean; blockers: string[] }
type View = {
  goal: string | null
  decide: DecideItem[]
  rows: Row[]
  done: number
  total: number
}

const DECIDE = /^\s*decide:\s*/i
const RANK = { completed: 0, in_progress: 1, pending: 2 } as const
const questionKey = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function buildView(list: Task[], pending: Ask[], p: Plan | null): View {
  const decideTasks = list.filter(t => DECIDE.test(t.subject))
  const normal = list.filter(t => !DECIDE.test(t.subject))
  const openDecide = new Set(
    decideTasks.filter(t => t.status !== 'completed').map(t => t.id),
  )
  const openNormal = new Set(
    normal.filter(t => t.status !== 'completed').map(t => t.id),
  )

  const decide: DecideItem[] = []
  const seen = new Map<string, DecideItem>()
  const add = (text: string, blocks: string[] = []) => {
    const key = questionKey(text)
    if (!key) return
    const had = seen.get(key)
    if (had) {
      had.blocks = union(had.blocks, blocks)
      return
    }
    const item = { text, blocks }
    seen.set(key, item)
    decide.push(item)
  }
  for (const t of decideTasks) {
    if (t.status === 'completed') continue
    const blocks = normal
      .filter(n => openNormal.has(n.id) && n.blockedBy.includes(t.id))
      .map(n => n.id)
    add(t.subject.replace(DECIDE, ''), blocks)
  }
  for (const a of pending) for (const q of a.questions) add(q)
  for (const q of p?.questions ?? []) add(q)

  const rows = normal
    .map(t => ({
      ...t,
      waitsOnDecision: t.blockedBy.some(b => openDecide.has(b)),
      blockers: t.blockedBy.filter(b => openNormal.has(b)),
    }))
    .sort(
      (a, b) =>
        RANK[a.status] - RANK[b.status] ||
        Number(a.id) - Number(b.id) ||
        a.id.localeCompare(b.id),
    )

  return {
    goal: p?.goal ?? null,
    decide,
    rows,
    done: normal.filter(t => t.status === 'completed').length,
    total: normal.length,
  }
}

// ---------------------------------------------------------------------------

const RULES = (path: string) => `# Task panel
The user follows your progress in a task panel. These rules are for the main conversation; a subagent leaves tasks and the plan file to it.
- For any request with more than one step, create tasks with TaskCreate before starting and keep their status current.
- When something needs the user's decision (a design choice, a tradeoff, unclear requirements), create a task "decide: <short question>" with the options and your recommendation in its description; don't silently pick one. Set dependent tasks blockedBy it, keep working on independent tasks, and when the user answers, record the decision in the description and mark it completed.
- At the start of a new piece of work, write the goal as one line under "## Goal" in ${path}; create the file if needed and update it only when the goal changes, not for side questions. Open questions that aren't tasks go under "## Open questions" in the same file.`

const TODO_TOOLS_HINT =
  'task tools may be off: add "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" to the ' +
  'env block of ~/.claude/settings.json and restart Claude Code'

const isOk = (r: { deny?: string; isError?: boolean }) =>
  r.deny === undefined && r.isError !== true

export const register: Register = on => {
  let isRefreshing = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tasks-panel',
      description: 'Show or hide the tasks pane',
      immediate: true,
    })
    await loadTasks($)
    await refreshPlan($)
    // Without it newer models may not get the task tools, and the pane would
    // stay empty with no hint why
    if ((await $.env.get('CLAUDE_CODE_ENABLE_TODO_TOOLS')) !== '1') {
      $.ui.log(TODO_TOOLS_HINT)
    }
    // One poll at a time; a failed poll waits for the next tick
    $.clock.every(3000, () => {
      if (isRefreshing) return
      isRefreshing = true
      refreshPlan($)
        .catch(() => undefined)
        .finally(() => {
          isRefreshing = false
        })
    })
    pruneStore($).catch(() => undefined)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await releaseClaim($, e.sessionId).catch(() => undefined)
    return next(e)
  })

  // /clear, /resume and /branch reset $.state and may change the session id
  on(
    'classic.SessionStart',
    { source: ['clear', 'resume', 'fork'] },
    async ($, e, next) => {
      nameCache = null
      await loadTasks($)
      await refreshPlan($)
      return next(e)
    },
  )

  on('command.run', { command: 'tasks-panel' }, async $ => {
    const mine = (await $.ui.panes()).find(p => p.id === PANE)
    if (mine?.isPlaced) {
      await $.ui.close({ id: PANE })
      return {}
    }
    await $.ui.open({ id: PANE, title: 'tasks' })
    return {}
  })

  // The rules ride in the system prompt, so compaction never drops them
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.traits.includes('teammate')) return composed
    // The same path the pane reads, so the two never drift apart
    const path = (await read($, plan))?.path ?? (await resolvePlanPath($))
    const section = {
      id: 'tasks-panel:rules',
      text: RULES(path),
      scope: 'session',
    } as const
    return { sections: [...composed.sections, section] }
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.tool !== 'TaskCreate' || !isOk(ran)) return ran
    const id = (ran.result as { task?: { id?: string } })?.task?.id
    if (id === undefined) return ran
    await changeTasks($, list =>
      upsert(list, String(id), t => ({
        ...t,
        subject: e.subject,
        byAgent: t.byAgent || e.agentId !== undefined,
      })),
    )
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.tool !== 'TaskUpdate' || !isOk(ran)) return ran
    const result = ran.result as { success?: boolean } | undefined
    if (result?.success === false) return ran
    const id = String(e.taskId)
    const status = e.status
    await changeTasks($, list => {
      if (status === 'deleted') return list.filter(t => t.id !== id)
      // A task this mod never saw created is left to the next TaskList,
      // unless the update names its subject
      const isKnown = list.some(t => t.id === id)
      if (!isKnown && e.subject === undefined) return list
      let out = upsert(list, id, t => ({
        ...t,
        subject: e.subject ?? t.subject,
        status: status ?? t.status,
        owner: e.owner ?? t.owner,
        blockedBy: union(t.blockedBy, e.addBlockedBy?.map(String)),
        byAgent: t.byAgent || e.agentId !== undefined || Boolean(e.owner),
      }))
      for (const blocked of e.addBlocks ?? []) {
        out = out.map(t =>
          t.id === String(blocked)
            ? { ...t, blockedBy: union(t.blockedBy, [id]) }
            : t,
        )
      }
      return out
    })
    return ran
  })

  // TaskList answers the whole list: reconcile with it
  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.tool !== 'TaskList' || !isOk(ran)) return ran
    const listed = (ran.result as { tasks?: Task[] } | undefined)?.tasks
    if (!Array.isArray(listed)) return ran
    await changeTasks($, list =>
      listed.map(l => {
        const had = list.find(t => t.id === String(l.id))
        return {
          id: String(l.id),
          subject: l.subject,
          status: l.status,
          owner: l.owner ?? had?.owner,
          blockedBy: (l.blockedBy ?? []).map(String),
          byAgent: (had?.byAgent ?? false) || Boolean(l.owner),
        }
      }),
    )
    return ran
  })

  // A question Claude is asking shows until it is answered
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.tool !== 'AskUserQuestion') return next(e)
    const ask: Ask = {
      id: e.tool_use_id ?? String(await $.clock.now()),
      questions: e.questions.map(q => q.question),
    }
    await update($, asks, list => [...(list ?? []), ask])
    await maybeAutoOpen($)
    try {
      return await next(e)
    } finally {
      await update($, asks, list => (list ?? []).filter(a => a.id !== ask.id))
    }
  })

  // Claude editing the plan file shows at once, not on the next poll
  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const ran = await next(e)
    if ('file_path' in e && String(e.file_path).includes('.claude/plans/')) {
      await refreshPlan($)
      await maybeAutoOpen($)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = buildView(
      await read($, tasks),
      await read($, asks),
      await read($, plan),
    )
    const width = e.props.bodyColumns
    const isCompact = e.props.placement === 'inline'
    const count = `${view.done}/${view.total}`

    const goalLine = (
      <Text wrap="truncate-end">
        <Text dimColor>goal </Text>
        {view.goal}
      </Text>
    )

    if (view.rows.length === 0 && view.decide.length === 0) {
      return view.goal ? goalLine : <Text dimColor>no tasks yet</Text>
    }

    const header = (title: string | null) => (
      <Box flexDirection="row" width={width} columnGap={2}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text dimColor>tasks</Text>
            {title ? `  ${title}` : ''}
          </Text>
        </Box>
        <Text>{count}</Text>
      </Box>
    )

    const decideRow = (item: DecideItem, extra?: string) => (
      <Text wrap="truncate-end">
        <Text color="blue">? </Text>
        {item.text}
        {item.blocks.length > 0 && (
          <Text dimColor>
            {'  · blocks '}
            {item.blocks.map(b => `#${b}`).join(' ')}
          </Text>
        )}
        {extra && <Text dimColor>{extra}</Text>}
      </Text>
    )

    // "?" waits on a decision, "⛔N" on open task N
    const blockMarks = (t: Row) => [
      t.waitsOnDecision && <Text color="blue">{'  ?'}</Text>,
      t.blockers.length > 0 && (
        <Text dimColor>
          {'  '}
          {t.blockers.map(b => `⛔${b}`).join(' ')}
        </Text>
      ),
    ]

    const taskRow = (t: Row) => {
      if (t.status === 'completed') {
        return (
          <Text wrap="truncate-end">
            <Text color="green">✓ </Text>
            <Text dimColor>
              #{t.id} {t.subject}
            </Text>
          </Text>
        )
      }
      if (t.status === 'in_progress') {
        return (
          <Text wrap="truncate-end">
            <Text color="claude">● </Text>#{t.id} {t.subject}
            {t.byAgent && <Text dimColor> · agent</Text>}
            {blockMarks(t)}
          </Text>
        )
      }
      return (
        <Text wrap="truncate-end">
          <Text dimColor>
            ○ #{t.id} {t.subject}
          </Text>
          {blockMarks(t)}
        </Text>
      )
    }

    const doing = view.rows.filter(t => t.status === 'in_progress')
    const todo = view.rows.filter(t => t.status === 'pending').length

    if (isCompact) {
      const [first, ...rest] = view.decide
      return (
        <Box flexDirection="column">
          {header(view.goal)}
          {first && decideRow(first, rest.length ? `  +${rest.length}` : '')}
          {doing.map(taskRow)}
          <Text dimColor>{`✓ ${view.done} done  ○ ${todo} to do`}</Text>
        </Box>
      )
    }

    const isCollapsed = view.rows.length > COLLAPSE_OVER
    const shown = isCollapsed
      ? view.rows.filter(t => t.status !== 'completed')
      : view.rows

    return (
      <Box flexDirection="column">
        {header(null)}
        {view.goal && goalLine}
        {view.decide.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text>
              <Text color="blue">decide</Text>
              <Text dimColor> · {view.decide.length}</Text>
            </Text>
            {view.decide.map(item => decideRow(item))}
          </Box>
        )}
        {view.rows.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>tasks</Text>
            {isCollapsed && view.done > 0 && (
              <Text dimColor>✓ {view.done} done</Text>
            )}
            {shown.map(taskRow)}
          </Box>
        )}
      </Box>
    )
  })
}
