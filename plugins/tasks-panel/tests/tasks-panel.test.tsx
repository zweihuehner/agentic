import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

declare const console: { log: (...args: unknown[]) => void }

const PANE = 'tasks-panel'
const SID = 'test-session'
const PLAN = `/tmp/proj/.claude/plans/${SID}.md`

type On = Parameters<TestBody>[1]
type Eng = Parameters<TestBody>[0]

type WorldOptions = {
  files?: Record<string, string>
  store?: Map<string, unknown>
  sessionId?: () => string
  env?: Record<string, string>
  dirs?: Record<string, { name: string; mtimeMs: number }[]>
  opened?: string[]
  closed?: string[]
  panes?: () => { id: string; isPlaced: boolean }[]
}

// What the engine would answer beneath the plugin
function world(on: On, o: WorldOptions = {}) {
  const clock = mock.clock(on)
  if (o.store) {
    const s = o.store
    on('store.get', ($, e) => ({ value: s.get(e.key) }))
    on('store.set', ($, e) => (s.set(e.key, e.value), { value: undefined }))
    on('store.delete', ($, e) => (s.delete(e.key), { value: undefined }))
    on('store.keys', () => ({ value: [...s.keys()] }))
  } else {
    mock.store(on)
  }
  mock.env(on, o.env ?? {})
  const files = o.files ?? {}
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.id', () => ({ value: o.sessionId?.() ?? SID }))
  on('session.root', () => ({ value: '/tmp/proj' }))
  on('command.register', () => ({ value: { command: 'tasks-panel' } }))
  on('fs.list', ($, e) => ({
    value: (o.dirs?.[e.path] ?? []).map(f => ({
      name: f.name,
      kind: 'file' as const,
      size: 1,
      isLink: false,
      mtimeMs: f.mtimeMs,
    })),
  }))
  on('fs.read', ($, e) =>
    e.path in files
      ? { value: files[e.path] as string }
      : { deny: 'no such file' },
  )
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('ui.open', ($, e) => {
    o.opened?.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    o.closed?.push(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: (o.panes?.() ?? []).map(p => ({
      ...p,
      title: 'tasks',
      isShown: p.isPlaced,
      isFocused: false,
    })),
  }))
  return { clock, files }
}

// Flattens a drawn tree into the lines a terminal would show, roughly
function lines(node: unknown): string[] {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') {
    return [String(node)]
  }
  if (Array.isArray(node)) return node.flatMap(lines)
  const el = node as {
    type: string
    props: Record<string, unknown>
    children?: unknown[]
  }
  const kids = el.children ?? []
  if (el.type === 'Text') return [kids.flatMap(lines).join('')]
  const isRow = el.props?.flexDirection === 'row'
  const parts = kids.map(lines)
  if (isRow) return [parts.map(p => p.join(' ')).join('  ')]
  const out = parts.flat()
  return el.props?.marginTop ? ['', ...out] : out
}

// Each drawn string with the color and dimness it inherits
type Span = { text: string; color?: string; dim: boolean }
function spans(node: unknown, color?: string, dim = false): Span[] {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') {
    return [{ text: String(node), color, dim }]
  }
  if (Array.isArray(node)) return node.flatMap(n => spans(n, color, dim))
  const el = node as { props?: Record<string, unknown>; children?: unknown[] }
  const c = (el.props?.color as string | undefined) ?? color
  const d = dim || el.props?.dimColor === true
  return (el.children ?? []).flatMap(n => spans(n, c, d))
}
const spanOf = (all: Span[], text: string) =>
  all.find(s => s.text.includes(text))

const create = async ($: Eng, subject: string, agentId?: string) => {
  const r = await $.tool.call({
    tool: 'TaskCreate',
    subject,
    description: '',
    ...(agentId ? { agentId } : {}),
  } as never)
  return (r.result as { task: { id: string } }).task.id
}
const upd = (
  $: Eng,
  taskId: string,
  rest: Record<string, unknown>,
  agentId?: string,
) =>
  $.tool.call({
    tool: 'TaskUpdate',
    taskId,
    ...rest,
    ...(agentId ? { agentId } : {}),
  } as never)

const start = ($: Eng, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.session.start({ cwd: '/tmp', surface, isInteractive: true })

async function seed($: Eng, surface: 'terminal' | 'desktop' = 'terminal') {
  await start($, surface)
  const t1 = await create($, 'reset token model')
  const t2 = await create($, 'decide: token lifetime: 15 min or 1 h?')
  const t3 = await create($, 'db migration')
  const t4 = await create($, 'reset email template')
  const t5 = await create($, '/reset endpoint')
  const t6 = await create($, 'decide: send from noreply@ or support@?')
  const t7 = await create($, 'tests')
  await upd($, t1, { status: 'completed' })
  await upd($, t3, { status: 'in_progress' })
  await upd($, t7, { status: 'in_progress', owner: 'tester' })
  await upd($, t4, { addBlockedBy: [t6] })
  await upd($, t5, { addBlockedBy: [t3] })
  return { t2 }
}

type TaskRow = {
  id: string
  subject: string
  status: string
  owner?: string
  blockedBy: string[]
}

// The task tools as the engine answers them; `list` is what TaskList returns
function answer(
  on: On,
  o: WorldOptions & {
    list?: () => TaskRow[]
    ask?: Promise<unknown>
  } = {},
) {
  const w = world(on, o)
  let next = 1
  on('tool.call', async ($, e) => {
    if (e.tool === 'TaskCreate') {
      return { result: { task: { id: String(next++), subject: e.subject } } }
    }
    if (e.tool === 'TaskUpdate') {
      return {
        result: { success: true, taskId: e.taskId, updatedFields: [] },
      }
    }
    if (e.tool === 'TaskList') return { result: { tasks: o.list?.() ?? [] } }
    if (e.tool === 'AskUserQuestion') {
      await o.ask
      return { result: { questions: [], answers: {} } }
    }
    return { result: {} }
  })
  return w
}

async function mount(
  $: Eng,
  placement: 'dock' | 'inline' = 'dock',
  surface: 'terminal' | 'desktop' = 'terminal',
) {
  return $.ui.mount({
    plugin: 'tasks-panel',
    surface,
    component: 'Pane',
    requestId: PANE,
    props: {
      title: 'tasks',
      isFocused: false,
      bodyColumns: 70,
      placement,
      scroll: { offset: 0, bodyRows: 30, contentRows: 0 },
      view: {},
    } as never,
  } as never)
}

const text = async (ui: { drawn: () => Promise<unknown> }) =>
  lines(await ui.drawn())

// ---------------------------------------------------------------------------
// Original suite

test('wide pane shows decisions, symbols and blockers', async ($, on) => {
  answer(on)
  const { t2 } = await seed($)
  const ui = await mount($)
  const t = await text(ui)
  console.log('--- wide\n' + t.join('\n'))
  expect(t[0]).toBe('tasks  1/5')
  expect(t).toContain('decide · 2')
  expect(t).toContain('? send from noreply@ or support@?  · blocks #4')
  expect(t).toContain('✓ #1 reset token model')
  expect(t).toContain('● #3 db migration')
  expect(t).toContain('● #7 tests · agent')
  expect(t).toContain('○ #4 reset email template  ?')
  expect(t).toContain('○ #5 /reset endpoint  ⛔3')

  await upd($, t2, { status: 'completed' })
  const after = await text(ui)
  expect(after).toContain('decide · 1')
  expect(after.join('\n')).not.toContain('token lifetime')
  await ui.unmount()
})

test('inline pane is compact', async ($, on) => {
  answer(on)
  await seed($)
  const ui = await mount($, 'inline')
  const t = await text(ui)
  console.log('--- inline\n' + t.join('\n'))
  expect(t.at(-1)).toBe('✓ 1 done  ○ 2 to do')
  expect(t[1]).toContain('+1')
  await ui.unmount()
})

test('empty pane says no tasks yet', async ($, on) => {
  answer(on)
  await start($)
  const ui = await mount($)
  expect(await text(ui)).toEqual(['no tasks yet'])
  await ui.unmount()
})

test('rules are injected into the system prompt', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({
    sections: [{ id: 'core', text: 'core', scope: 'shared' }],
  }))
  await start($)
  const r = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  const rules = r.sections.find(s => s.id === 'tasks-panel:rules')
  expect(rules?.text).toContain('decide: <short question>')
  expect(rules?.text).toContain(PLAN)
  expect(r.sections.map(s => s.id)).toContain('core')
})

// ---------------------------------------------------------------------------
// Extended coverage

test('row colors: done green+dim, doing orange normal, todo dim', async (
  $,
  on,
) => {
  answer(on)
  await seed($)
  const ui = await mount($)
  const s = spans(await ui.drawn())
  expect(spanOf(s, '✓')?.color).toBe('green')
  expect(spanOf(s, 'reset token model')?.dim).toBe(true)
  expect(spanOf(s, '●')?.color).toBe('claude')
  expect(spanOf(s, 'db migration')?.dim).toBe(false)
  expect(spanOf(s, '○')?.dim).toBe(true)
  expect(spanOf(s, 'reset email template')?.dim).toBe(true)
  expect(s.find(x => x.text.trim() === '?' && x.color === 'blue')).toBeTruthy()
  expect(spanOf(s, 'decide')?.color).toBe('blue')
  await ui.unmount()
})

test('more than 10 tasks collapse the done ones into one line', async (
  $,
  on,
) => {
  answer(on)
  await start($)
  const ids: string[] = []
  for (let i = 1; i <= 11; i++) ids.push(await create($, `job ${i}`))
  for (const id of ids.slice(0, 4)) await upd($, id, { status: 'completed' })
  await upd($, ids[4]!, { status: 'in_progress' })
  const ui = await mount($)
  const t = await text(ui)
  expect(t[0]).toBe('tasks  4/11')
  expect(t).toContain('✓ 4 done')
  expect(t.join('\n')).not.toContain('#1 job 1')
  expect(t).toContain('● #5 job 5')
  expect(t).toContain('○ #11 job 11')
  const done = spanOf(spans(await ui.drawn()), ' done')
  expect(done?.dim).toBe(true)

  // exactly 10 does not collapse
  await upd($, ids[10]!, { status: 'deleted' })
  const ten = await text(ui)
  expect(ten).not.toContain('✓ 4 done')
  expect(ten).toContain('✓ #1 job 1')
  await ui.unmount()
})

test('order: done, in progress, to do, then by numeric id', async ($, on) => {
  answer(on)
  await start($)
  const ids: string[] = []
  for (let i = 1; i <= 10; i++) ids.push(await create($, `t${i}`))
  await upd($, ids[9]!, { status: 'completed' })
  await upd($, ids[1]!, { status: 'in_progress' })
  const ui = await mount($)
  const rows = (await text(ui)).filter(l => /^[✓●○] #/.test(l))
  expect(rows[0]).toBe('✓ #10 t10')
  expect(rows[1]).toBe('● #2 t2')
  expect(rows[2]).toBe('○ #1 t1')
  expect(rows[3]).toBe('○ #3 t3')
  await ui.unmount()
})

test('one question from three sources shows once', async ($, on) => {
  let release!: () => void
  const asked = new Promise<void>(r => (release = r))
  answer(on, {
    files: {
      [PLAN]: [
        '# plan',
        '## Goal',
        'ship password reset',
        '## Open questions',
        '- Token lifetime: 15 min or 1 h?',
        '- which mail provider?',
      ].join('\n'),
    },
    ask: asked,
  })
  await start($)
  await create($, 'Decide: token lifetime — 15 min or 1 h?')
  const call = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Token lifetime: 15 min or 1 h?',
        header: 'Lifetime',
        options: [
          { label: '15 min', description: '' },
          { label: '1 h', description: '' },
        ],
      },
    ],
  } as never)
  const ui = await mount($)
  const t = await text(ui)
  console.log('--- dedup\n' + t.join('\n'))
  expect(t).toContain('decide · 2')
  expect(t.filter(l => /token lifetime/i.test(l))).toHaveLength(1)
  expect(t).toContain('? which mail provider?')
  release()
  await call
  await ui.unmount()
})

test('AskUserQuestion shows while pending, gone once answered', async (
  $,
  on,
) => {
  let release!: () => void
  const asked = new Promise<void>(r => (release = r))
  const opened: string[] = []
  const { clock } = answer(on, { ask: asked, opened })
  await start($)
  const ui = await mount($)
  expect(await text(ui)).toEqual(['no tasks yet'])
  const call = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Which database?',
        header: 'DB',
        options: [
          { label: 'pg', description: '' },
          { label: 'sqlite', description: '' },
        ],
      },
    ],
  } as never)
  await clock.settle()
  const pending = await text(ui)
  expect(pending).toContain('decide · 1')
  expect(pending).toContain('? Which database?')
  expect(opened).toEqual([PANE]) // auto-open on first decide item
  release()
  await call
  expect(await text(ui)).toEqual(['no tasks yet'])
  await ui.unmount()
})

test('TaskUpdate deleted removes the task', async ($, on) => {
  answer(on)
  await start($)
  const a = await create($, 'keep')
  const b = await create($, 'drop')
  await upd($, b, { status: 'deleted' })
  const ui = await mount($)
  const t = await text(ui)
  expect(t[0]).toBe('tasks  0/1')
  expect(t.join('\n')).not.toContain('drop')
  expect(t).toContain(`○ #${a} keep`)
  await ui.unmount()
})

test('addBlocks on a decide task blocks the other task', async ($, on) => {
  answer(on)
  await start($)
  const d = await create($, 'decide: cache or not?')
  const n = await create($, 'implement cache')
  await upd($, d, { addBlocks: [n] })
  const ui = await mount($)
  const t = await text(ui)
  expect(t).toContain(`? cache or not?  · blocks #${n}`)
  expect(t).toContain(`○ #${n} implement cache  ?`)
  await upd($, d, { status: 'completed' })
  const after = await text(ui)
  expect(after).toContain(`○ #${n} implement cache`)
  expect(after.join('\n')).not.toContain('decide')
  await ui.unmount()
})

test('decide prefix is case-insensitive and excluded from counts', async (
  $,
  on,
) => {
  answer(on)
  await start($)
  await create($, 'DECIDE:   pick a name?')
  await create($, 'Decide: pick a color?')
  await create($, 'normal work')
  const ui = await mount($)
  const t = await text(ui)
  expect(t[0]).toBe('tasks  0/1')
  expect(t).toContain('? pick a name?')
  expect(t).toContain('? pick a color?')
  await ui.unmount()
})

test('owner marks an in-progress task as agent', async ($, on) => {
  answer(on)
  await start($)
  const a = await create($, 'owned')
  await upd($, a, { owner: 'worker-1' })
  const ui = await mount($)
  // only in-progress rows show it
  expect((await text(ui)).join('\n')).not.toContain('agent')
  await upd($, a, { status: 'in_progress' })
  expect(await text(ui)).toContain(`● #${a} owned · agent`)
  const s = spanOf(spans(await ui.drawn()), 'agent')
  expect(s?.dim).toBe(true)
  await ui.unmount()
})

test('a subagent touching a task marks it as agent', async ($, on) => {
  answer(on)
  await start($)
  const a = await create($, 'by main')
  const b = await create($, 'by sub')
  await upd($, a, { status: 'in_progress' })
  await upd($, b, { status: 'in_progress' }, 'agent-123')
  const ui = await mount($)
  const t = await text(ui)
  expect(t).toContain(`● #${a} by main`)
  expect(t).toContain(`● #${b} by sub · agent`)
  await ui.unmount()
})

test('a task created by a subagent is marked as agent', async ($, on) => {
  answer(on)
  await start($)
  const a = await create($, 'sub made', 'agent-9')
  await upd($, a, { status: 'in_progress' })
  const ui = await mount($)
  expect(await text(ui)).toContain(`● #${a} sub made · agent`)
  await ui.unmount()
})

test('TaskList reconciles the mirror with the real list', async ($, on) => {
  let listed: TaskRow[] = []
  answer(on, { list: () => listed })
  await start($)
  await create($, 'stale one')
  await create($, 'two')
  listed = [
    { id: '2', subject: 'two renamed', status: 'completed', blockedBy: [] },
    {
      id: '5',
      subject: 'made elsewhere',
      status: 'in_progress',
      owner: 'w',
      blockedBy: [],
    },
    { id: '6', subject: 'waits', status: 'pending', blockedBy: ['5'] },
  ]
  await $.tool.call({ tool: 'TaskList' } as never)
  const ui = await mount($)
  const t = await text(ui)
  expect(t[0]).toBe('tasks  1/3')
  expect(t.join('\n')).not.toContain('stale one')
  expect(t).toContain('✓ #2 two renamed')
  expect(t).toContain('● #5 made elsewhere · agent')
  expect(t).toContain('○ #6 waits  ⛔5')
  await ui.unmount()
})

test('blocked by a completed task shows no ⛔', async ($, on) => {
  answer(on)
  await start($)
  const a = await create($, 'first')
  const b = await create($, 'second')
  await upd($, b, { addBlockedBy: [a] })
  const ui = await mount($)
  expect(await text(ui)).toContain(`○ #${b} second  ⛔${a}`)
  await upd($, a, { status: 'completed' })
  const t = await text(ui)
  expect(t).toContain(`○ #${b} second`)
  expect(t.join('\n')).not.toContain('⛔')
  await ui.unmount()
})

test('an in-progress task shows what still blocks it', async ($, on) => {
  answer(on)
  await start($)
  const a = await create($, 'first')
  const d = await create($, 'decide: which way?')
  const b = await create($, 'second')
  await upd($, b, { addBlockedBy: [a, d], status: 'in_progress' })
  const ui = await mount($)
  expect(await text(ui)).toContain(`● #${b} second  ?  ⛔${a}`)
  await ui.unmount()
})

test('plan file: goal, checkbox bullets, headings', async ($, on) => {
  const { clock, files } = answer(on, {
    files: {
      [PLAN]: [
        '# Password reset',
        '',
        '## Goal',
        '',
        '- Ship a self-serve password reset',
        'second line is ignored',
        '',
        '## Open questions ##',
        '- [ ] email from noreply or support?',
        '* plain star bullet?',
        '  - nested bullet?',
        'not a bullet',
        '',
        '## Notes',
        '- not a question',
      ].join('\n'),
    },
  })
  await start($)
  const ui = await mount($)
  const t = await text(ui)
  console.log('--- plan\n' + t.join('\n'))
  expect(t).toContain('goal Ship a self-serve password reset')
  expect(t).toContain('decide · 2')
  expect(t).toContain('? email from noreply or support?')
  expect(t).toContain('? plain star bullet?')
  // a sub-bullet is detail under a question, not a question of its own
  expect(t.join('\n')).not.toContain('nested bullet')
  expect(t.join('\n')).not.toContain('not a question')
  expect(t.join('\n')).not.toContain('not a bullet')

  // the 3s poll picks up an edit made outside Write/Edit
  files[PLAN] = '## Goal\nnew goal\n'
  await clock.advance(3100)
  const after = await text(ui)
  expect(after).toEqual(['goal new goal'])
  await ui.unmount()
})

test('plan file: checked-off bullets are not open questions', async (
  $,
  on,
) => {
  answer(on, {
    files: {
      [PLAN]: '## Open questions\n- [x] already answered?\n- [ ] still open?\n',
    },
  })
  await start($)
  const ui = await mount($)
  const t = await text(ui)
  expect(t).toContain('? still open?')
  expect(t.join('\n')).not.toContain('already answered')
  await ui.unmount()
})

test('no plan file and no tasks: no goal line', async ($, on) => {
  answer(on)
  await start($)
  await create($, 'x')
  const ui = await mount($)
  expect((await text(ui)).join('\n')).not.toContain('goal')
  await ui.unmount()
})

test('goal only: pane shows just the goal line', async ($, on) => {
  answer(on, { files: { [PLAN]: '## Goal\nfix the bug\n' } })
  await start($)
  const ui = await mount($)
  expect(await text(ui)).toEqual(['goal fix the bug'])
  await ui.unmount()
  const inline = await mount($, 'inline')
  expect(await text(inline)).toEqual(['goal fix the bug'])
  await inline.unmount()
})

test('plan path uses the session name when one was given', async ($, on) => {
  const named = '/tmp/proj/.claude/plans/my-feature.md'
  answer(on, {
    env: { HOME: '/home/u' },
    dirs: {
      '/home/u/.claude/sessions': [
        { name: 'a.json', mtimeMs: 2 },
        { name: 'b.json', mtimeMs: 1 },
      ],
    },
    files: {
      '/home/u/.claude/sessions/a.json': JSON.stringify({
        sessionId: 'other',
        name: 'nope',
      }),
      '/home/u/.claude/sessions/b.json': JSON.stringify({
        sessionId: SID,
        name: 'my feature',
        nameSource: 'user',
      }),
      [named]: '## Goal\nnamed goal\n',
    },
  })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const ui = await mount($)
  expect(await text(ui)).toEqual(['goal named goal'])
  const r = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  expect(r.sections[0]?.text).toContain(named)
  await ui.unmount()
})

test('rename before the plan exists: prompt path and read path agree', async (
  $,
  on,
) => {
  // Session starts unnamed; the prompt names <id>.md. The person renames the
  // session before Claude writes the plan; Claude then writes the path the
  // prompt gave it. The pane must still find the goal.
  const sessionFile = '/home/u/.claude/sessions/s.json'
  const { clock, files } = answer(on, {
    env: { HOME: '/home/u' },
    dirs: { '/home/u/.claude/sessions': [{ name: 's.json', mtimeMs: 1 }] },
    files: { [sessionFile]: JSON.stringify({ sessionId: SID }) },
  })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const r = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  expect(r.sections[0]?.text).toContain(PLAN)
  files[sessionFile] = JSON.stringify({
    sessionId: SID,
    name: 'renamed',
    nameSource: 'user',
  })
  await clock.advance(3100) // poll resolves the new name, file not there yet
  files[PLAN] = '## Goal\nwritten where the prompt said\n'
  await clock.advance(3100)
  const ui = await mount($)
  expect(await text(ui)).toEqual(['goal written where the prompt said'])
  await ui.unmount()
})

function namedSession(name: string, nameSource = 'user') {
  return {
    env: { HOME: '/home/u' },
    dirs: { '/home/u/.claude/sessions': [{ name: 's.json', mtimeMs: 1 }] },
    files: {
      '/home/u/.claude/sessions/s.json': JSON.stringify({
        sessionId: SID,
        name,
        nameSource,
      }),
    } as Record<string, string>,
  }
}

async function rulesPath($: Eng) {
  const r = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  return /\/tmp\/proj\/\.claude\/plans\/\S+\.md/.exec(
    r.sections[0]?.text ?? '',
  )?.[0]
}

test('a second live session with the same name gets its own file', async (
  $,
  on,
) => {
  const dup = '/tmp/proj/.claude/plans/dup.md'
  const store = new Map<string, unknown>([
    [`claim:${dup}`, { id: 'other-live-session', at: 0 }],
  ])
  answer(on, { ...namedSession('dup'), store })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  expect(await rulesPath($)).toBe(
    `/tmp/proj/.claude/plans/dup-${SID.slice(0, 8)}.md`,
  )
})

test('a stale claim on the name is taken over', async ($, on) => {
  const dup = '/tmp/proj/.claude/plans/dup.md'
  const store = new Map<string, unknown>([
    [`claim:${dup}`, { id: 'gone-session', at: 0 }],
  ])
  const { clock } = answer(on, { ...namedSession('dup'), store })
  await clock.set(10 * 60_000)
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  expect(await rulesPath($)).toBe(dup)
  expect((store.get(`claim:${dup}`) as { id: string }).id).toBe(SID)
})

test('session end releases the claim', async ($, on) => {
  const named = '/tmp/proj/.claude/plans/mine.md'
  const store = new Map<string, unknown>()
  on('session.end', () => ({ sessionId: SID }))
  answer(on, { ...namedSession('mine'), store })
  await start($)
  expect(store.has(`claim:${named}`)).toBe(true)
  await $.session.end({ reason: 'clear', sessionId: SID } as never)
  expect(store.has(`claim:${named}`)).toBe(false)
})

for (const source of ['derived', 'auto', '']) {
  test(`a "${source}" name is not a session name`, async ($, on) => {
    answer(on, namedSession('auto-name', source))
    on('prompt.compose', () => ({ sections: [] }))
    await start($)
    expect(await rulesPath($)).toBe(PLAN)
  })
}

test('/tasks-panel toggles the pane', async ($, on) => {
  const opened: string[] = []
  const closed: string[] = []
  let placed = false
  answer(on, { opened, closed, panes: () => [{ id: PANE, isPlaced: placed }] })
  await start($)
  await $.command.run({ command: 'tasks-panel', args: '' } as never)
  expect(opened).toEqual([PANE])
  expect(closed).toEqual([])
  placed = true
  await $.command.run({ command: 'tasks-panel', args: '' } as never)
  expect(closed).toEqual([PANE])
})

test('pane auto-opens once, on the first task', async ($, on) => {
  const opened: string[] = []
  answer(on, { opened })
  await start($)
  expect(opened).toEqual([])
  await create($, 'one')
  await create($, 'two')
  expect(opened).toEqual([PANE])
})

test('pane auto-opens on a plan open question written by Claude', async (
  $,
  on,
) => {
  const opened: string[] = []
  const { files } = answer(on, { opened })
  await start($)
  files[PLAN] = '## Open questions\n- which region?\n'
  await $.tool.call({
    tool: 'Write',
    file_path: PLAN,
    content: files[PLAN],
  } as never)
  expect(opened).toEqual([PANE])
})

// Survives a restart: a fresh load reads the store the last run wrote
const persisted = new Map<string, unknown>()

test('persistence: a run writes its tasks to the store', async ($, on) => {
  answer(on, { store: persisted })
  await start($)
  const a = await create($, 'survive me')
  await upd($, a, { status: 'in_progress' })
  await create($, 'decide: keep it?')
  expect([...persisted.keys()]).toContain(`session:${SID}`)
})

test('persistence: a fresh session.start restores them', async ($, on) => {
  const opened: string[] = []
  answer(on, { store: new Map(persisted), opened })
  await start($)
  const ui = await mount($)
  const t = await text(ui)
  expect(t).toContain('● #1 survive me')
  expect(t).toContain('? keep it?')
  expect(opened).toEqual([]) // already auto-opened in the earlier run
  await ui.unmount()
})

test('persistence: /resume to another session swaps the list', async (
  $,
  on,
) => {
  let sid = 'other-session'
  const store = new Map(persisted)
  answer(on, { store, sessionId: () => sid })
  on('classic.SessionStart', () => ({}))
  await start($)
  const ui = await mount($)
  expect(await text(ui)).toEqual(['no tasks yet'])
  sid = SID
  await $.classic.SessionStart({ source: 'resume' } as never)
  expect(await text(ui)).toContain('● #1 survive me')
  await ui.unmount()
})

test('store prunes entries older than 30 days', async ($, on) => {
  const store = new Map<string, unknown>([
    ['session:old', { tasks: [], at: 0 }],
    ['session:recent', { at: 39 * 86_400_000 }],
    ['tasks:legacy', { tasks: [], at: 0 }],
    ['path:legacy', '/x'],
    ['opened:legacy', true],
  ])
  const { clock } = answer(on, { store })
  await clock.set(40 * 86_400_000)
  await start($)
  await clock.settle()
  expect(store.has('session:old')).toBe(false)
  expect(store.has('session:recent')).toBe(true)
  expect(store.has('tasks:legacy')).toBe(false)
  expect(store.has('path:legacy')).toBe(false)
  expect(store.has('opened:legacy')).toBe(false)
})

test('store: a session that never had tasks leaves no key forever', async (
  $,
  on,
) => {
  const store = new Map<string, unknown>([
    ['session:never-had-tasks', { path: '/y', at: 0 }],
  ])
  const { clock } = answer(on, { store })
  await clock.set(400 * 86_400_000)
  await start($)
  await clock.settle()
  expect(store.has('session:never-had-tasks')).toBe(false)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`renders on ${surface} without refusal (dock + inline)`, async (
    $,
    on,
  ) => {
    answer(on)
    await seed($, surface)
    for (const placement of ['dock', 'inline'] as const) {
      const ui = await mount($, placement, surface)
      const t = await text(ui)
      console.log(`--- ${surface} ${placement}\n` + t.join('\n'))
      expect(t[0]).toBe('tasks  1/5')
      await ui.unmount()
    }
  })
}

test('warns once at start when the task tools are not enabled', async (
  $,
  on,
) => {
  const logged: string[] = []
  on('ui.log', (_$, e) => {
    logged.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  answer(on)
  await start($)
  expect(logged.join('\n')).toContain('CLAUDE_CODE_ENABLE_TODO_TOOLS')
})

test('stays quiet when the task tools are enabled', async ($, on) => {
  const logged: string[] = []
  on('ui.log', () => {
    logged.push('logged')
    return { value: undefined }
  })
  answer(on, { env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } })
  await start($)
  expect(logged).toEqual([])
})
