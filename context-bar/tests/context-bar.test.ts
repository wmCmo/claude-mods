import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionUsage, TurnUsage } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
// 2026-10-05 22:54 JST
const NOW = Date.parse('2026-10-05T13:54:00Z')
const HOUR_MS = 60 * 60 * 1000
const INOUT = { command: 'inout', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

const USAGE: TurnUsage = {
  model: 'claude-opus-5-5',
  input_tokens: 2_000,
  cache_creation_input_tokens: 48_000,
  cache_read_input_tokens: 1_150_000,
  output_tokens: 8_400,
}

// エンジン側（プラグインの下）を最小限に再現する。usage() の返り値はテストから差し替える
const engine = (on: On) => {
  const current: { usage: SessionUsage } = {
    usage: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 1 } },
  }
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: current.usage }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.complete', (_$, e) => ({ text: e.answer, usage: e.usage }))

  return current
}

const turn = (durationMs: number, usage?: TurnUsage) => ({
  answer: '',
  durationMs,
  isAborted: false,
  turnId: `t${durationMs}`,
  reason: 'answer' as const,
  usage,
})

test('完了行にコンテキスト増分とコストが付き、/inout で入出力が出る', async ($, on) => {
  const current = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // 1ターン目：基準が無いのでコンテキストは絶対量
  current.usage = { ...current.usage, context: { tokens: 30_000, window: 1_000_000, percent: 3 }, cost: { usd: 1.2 } }
  await $.turn.complete(turn(14_000, USAGE))
  // 2ターン目：前ターン終了時からの増分
  current.usage = { ...current.usage, context: { tokens: 42_400, window: 1_000_000, percent: 4 }, cost: { usd: 1.5 } }
  await $.turn.complete(turn(101_000, USAGE))

  for (const surface of SURFACES) {
    const first = await $.ui.mount({ plugin: 'context-bar', surface, component: 'TurnDuration', props: { word: 'Crunched', durationMs: 14_000 } })
    expect((await first.find({ type: 'Text', text: /Crunched/ }))?.text).toBe('✻ Crunched for 14s · done 22:54 · ctx 30.0k · $0.200')
    await first.unmount()

    const second = await $.ui.mount({ plugin: 'context-bar', surface, component: 'TurnDuration', props: { word: 'Cooked', durationMs: 101_000 } })
    expect((await second.find({ type: 'Text', text: /Cooked/ }))?.text).toBe('✻ Cooked for 1m 41s · done 22:54 · ctx +12.4k · $0.300')
    await second.unmount()
  }

  const toggled = await $.command.run(INOUT)
  expect(toggled.text).toBe('In/out token counts: shown.')
  const shown = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'TurnDuration', props: { word: 'Cooked', durationMs: 101_000 } })
  expect((await shown.find({ type: 'Text', text: /Cooked/ }))?.text).toBe(
    '✻ Cooked for 1m 41s · done 22:54 · ctx +12.4k · $0.300 · 1.2M in (96% cached) · 8.4k out',
  )
  await shown.unmount()

  expect((await $.command.run(INOUT)).text).toBe('In/out token counts: hidden.')
})

test('compact でコンテキストが減ったターンは compacted と出す', async ($, on) => {
  const current = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  current.usage = { ...current.usage, context: { tokens: 600_000, window: 1_000_000, percent: 60 } }
  await $.turn.complete(turn(5_000, USAGE))
  current.usage = { ...current.usage, context: { tokens: 45_000, window: 1_000_000, percent: 5 } }
  await $.turn.complete(turn(9_000, USAGE))

  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs: 9_000 } })
  expect((await ui.find({ type: 'Text', text: /Baked/ }))?.text).toBe('✻ Baked for 9s · done 22:54 · ctx 45.0k (compacted) · $0.000')
  await ui.unmount()
})

test('週次リミットとコンテキストのバーが並び、80%超は黄色', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.measure', (_$, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: { tokens: 170_000, window: 200_000, percent: 85 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 37, resetsAt: new Date(NOW + 53 * HOUR_MS).toISOString() }],
    changed: ['context', 'rateLimits'],
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'context-bar',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    const ctx = await ui.find({ type: 'Text', text: /^ctx/ })
    const week = await ui.find({ type: 'Text', text: /^week/ })
    expect(ctx?.text).toBe('ctx █████████░ 85% (170k/200k)')
    expect(ctx?.props.color).toBe('yellow')
    expect(week?.text).toBe('week ████░░░░░░ 37%')
    expect(week?.props.color).toBeUndefined()
    // 37% ÷ 経過率 (168-53)/168 = 0.54：リセットまでに使い切らないペースなので目立たせない
    const pace = await ui.find({ type: 'Text', text: /pace/ })
    expect(pace?.text).toBe(' pace 0.54')
    expect(pace?.props.color).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /·/ }))?.text).toBe(' · 2d 5h')
    await ui.unmount()
  }
})

test('pace が 1 を超えると黄色、幅が足りなければトークン数と残り時間を省く', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.measure', (_$, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: { tokens: 170_000, window: 200_000, percent: 85 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 90, resetsAt: new Date(NOW + 53 * HOUR_MS).toISOString() }],
    changed: ['context', 'rateLimits'],
  })

  const ui = await $.ui.mount({
    plugin: 'context-bar',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 60, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  const pace = await ui.find({ type: 'Text', text: /pace/ })
  expect(pace?.text).toBe(' pace 1.31')
  expect(pace?.props.color).toBe('yellow')
  expect((await ui.find({ type: 'Text', text: /^ctx/ }))?.text).toBe('ctx █████████░ 85%')
  expect(await ui.find({ type: 'Text', text: /·/ })).toBeUndefined()
  await ui.unmount()
})

test('compact 後にバンドのボタンからペインで要約を開ける', async ($, on) => {
  mock.clock(on, { now: NOW })
  const opened: string[] = []
  on('session.compact', () => ({
    messages: [
      { role: 'user' as const, text: 'Summary: we built the context-bar mod.', toolUses: [] },
      { role: 'assistant' as const, text: 'Next: compaction viewer.', toolUses: [] },
    ],
    tokensBefore: 261_000,
    tokensAfter: 18_400,
  }))
  on('ui.open', (_$, e) => {
    opened.push(`${e.id} ${e.title ?? ''}`)

    return { value: { isPlaced: true as const } }
  })
  const copied: string[] = []
  const toasts: string[] = []
  on('ui.copy', (_$, e) => {
    copied.push(`${e.surface} ${e.text}`)

    return { value: { isCopied: true as const } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'old', toolUses: [] }] })

  const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: BAND })
    await band.press({ key: 'view-compaction' })
    await band.unmount()
  }
  expect(opened).toEqual(['compaction Compaction 22:54', 'compaction Compaction 22:54'])

  const PANE = { title: 'Compaction 22:54', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ plugin: 'context-bar', surface, component: 'Pane', requestId: 'compaction', props: PANE })
    expect((await pane.find({ type: 'Text', text: /^Compacted/ }))?.text).toBe(
      'Compacted at 22:54 (manual) · 261.0k → 18.4k tokens · 2 messages kept ',
    )
    const body = await pane.find({ key: 'body-0' })
    expect(body?.props.text).toBe(
      '### User\n\nSummary: we built the context-bar mod.\n\n---\n\n### Assistant\n\nNext: compaction viewer.',
    )
    await pane.press({ key: 'copy' })
    await pane.unmount()
  }

  // コピーは押された面のクリップボードへ、分割前の全文で
  const full = '### User\n\nSummary: we built the context-bar mod.\n\n---\n\n### Assistant\n\nNext: compaction viewer.'
  expect(copied).toEqual([`terminal ${full}`, `desktop ${full}`])
  expect(toasts).toEqual(['Compaction copied to clipboard', 'Compaction copied to clipboard'])
})

test('実寸の要約（1万字超・CRLF・コードブロック）でもペインが描ける', async ($, on) => {
  mock.clock(on, { now: NOW })
  const paragraph = (n: number) => `Paragraph ${n}: ${'検証用の文章です。'.repeat(40)}`
  const fence = '```ts\n' + Array.from({ length: 120 }, (_, i) => `const line${i} = ${i}`).join('\n') + '\n```'
  const summary = [
    ...Array.from({ length: 25 }, (_, i) => paragraph(i)),
    fence,
    ...Array.from({ length: 10 }, (_, i) => paragraph(100 + i)),
    'x'.repeat(12_000),
  ].join('\r\n\r\n')
  expect(summary.length).toBeGreaterThan(13_000)

  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: summary, toolUses: [] }] }))
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'old', toolUses: [] }] })

  const PANE = { title: 'Compaction', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
  for (const surface of SURFACES) {
    // 描けない木なら mount が reject する
    const pane = await $.ui.mount({ plugin: 'context-bar', surface, component: 'Pane', requestId: 'compaction', props: PANE })
    const chunks: string[] = []
    for (let i = 0; ; i++) {
      const found = await pane.find({ key: `body-${i}` })
      if (found === undefined) break
      chunks.push(String(found.props.text))
    }
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10_000)
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u0008\u000B-\u001F\u007F]/.test(chunk)).toBe(false)
      expect(chunk.split('\n').filter(line => line.trimStart().startsWith('```')).length % 2).toBe(0)
    }
    const joined = chunks.join('')
    expect(joined.includes('Paragraph 0:')).toBe(true)
    expect(joined.includes('Paragraph 109:')).toBe(true)
    expect(joined.includes('const line119 = 119')).toBe(true)
    await pane.unmount()
  }
})

test('Rename ボタンで会話からタイトルを作り /rename し、トーストではなくクリップボードとボタン表記で知らせる', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const copies: string[] = []
  on('ui.copy', (_$, e) => {
    copies.push(`${e.surface ?? 'default'} ${e.text}`)

    return { value: { isCopied: true as const } }
  })
  const renamed: string[] = []
  const toasts: string[] = []
  const prompts: string[] = []
  const replies = ['Title: "🧭 Context bar mod build."\nextra line', 'Hashigo pitch accent fixes']
  on('model.fork', (_$, e) => {
    prompts.push(e.prompt)

    return {
      value: {
        isAnswered: true as const,
        text: replies.shift() ?? '',
        usage: { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 250_000, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('command.run', { command: 'rename' }, (_$, e) => {
    renamed.push(e.args)

    return { text: `Renamed: ${e.args}` }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  // 端末にはデスクトップのタイトルツールが無い
  on('tool.list', () => ({ value: [] }))
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({ context: { tokens: 10_000, window: 1_000_000, percent: 1 }, rateLimits: [], changed: ['context'] })

  const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
  const band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.find({ key: 'rename' }))?.props.label).toBe('Rename')

  // 引用符・「Title:」・末尾の句点・2行目を落とす
  await band.press({ key: 'rename' })
  // 絵文字が無い返答には 💬 を補う
  await band.press({ key: 'rename' })

  expect(prompts.length).toBe(2)
  expect(prompts[0]).toContain('a single emoji')
  expect(renamed).toEqual(['🧭 Context bar mod build', '💬 Hashigo pitch accent fixes'])
  expect(copies).toEqual(['terminal 🧭 Context bar mod build', 'terminal 💬 Hashigo pitch accent fixes'])
  expect(toasts).toEqual([])
  // 完了直後は「Copied ✓」、数秒で「Rename」に戻る
  expect((await band.find({ key: 'rename' }))?.props.label).toBe('Copied ✓')
  await clock.advance(4000)
  await clock.settle()
  expect((await band.find({ key: 'rename' }))?.props.label).toBe('Rename')
  await band.unmount()
})

test('再起動直後でフォークできないときは、トランスクリプトの抜粋を haiku に渡して名付ける', async ($, on) => {
  mock.clock(on, { now: NOW })
  const copies: string[] = []
  on('ui.copy', (_$, e) => {
    copies.push(`${e.surface ?? 'default'} ${e.text}`)

    return { value: { isCopied: true as const } }
  })
  const renamed: string[] = []
  const toasts: string[] = []
  const completions: { model: string; prompt: string }[] = []
  // 1回目：会話あり → 抜粋で名付け。2回目：会話なし → 名付けない
  const transcripts = [
    [
      { role: 'user' as const, text: 'i want the context bar of how many % of context i have used', toolUses: [] },
      { role: 'assistant' as const, text: 'Built the context-bar mod.', toolUses: [] },
      ...Array.from({ length: 60 }, (_, i) => ({ role: 'user' as const, text: `step ${i} ${'x'.repeat(1000)}`, toolUses: [] })),
      { role: 'user' as const, text: 'i pressed the button and it says nothing-to-fork', toolUses: [] },
    ],
    [],
  ]
  on('model.fork', () => ({ value: { isAnswered: false as const, reason: 'nothing-to-fork' as const } }))
  on('session.messages', () => ({ value: transcripts.shift() ?? [] }))
  on('model.complete', (_$, e) => {
    completions.push({ model: e.model, prompt: e.prompt })

    return {
      value: {
        isAnswered: true as const,
        text: '🧩 Claude Code status mods',
        usage: { input_tokens: 9000, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('command.run', { command: 'rename' }, (_$, e) => {
    renamed.push(e.args)

    return { text: '' }
  })
  on('tool.list', () => ({ value: [] }))
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['context'] })

  const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
  const band = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'rename' })
  await band.press({ key: 'rename' })
  await band.unmount()

  expect(completions.length).toBe(1)
  expect(completions[0]?.model).toBe('haiku')
  const prompt = completions[0]?.prompt ?? ''
  // 冒頭（何の会話か）と直近（今どうなっているか）が入り、上限内に収まる
  expect(prompt).toContain('a single emoji')
  expect(prompt).toContain('User: i want the context bar')
  expect(prompt).toContain('User: i pressed the button and it says nothing-to-fork')
  expect(prompt).toMatch(/\(\d+ messages omitted\)/)
  expect(prompt.length).toBeLessThan(32_000)

  expect(renamed).toEqual(['🧩 Claude Code status mods'])
  expect(copies).toEqual(['desktop 🧩 Claude Code status mods'])
  expect(toasts).toEqual(['Rename: nothing in this conversation to name yet'])
})

test('デスクトップではアプリのタイトルも変える。拒否されたらそう伝える', async ($, on) => {
  mock.clock(on, { now: NOW })
  const copies: string[] = []
  on('ui.copy', (_$, e) => {
    copies.push(`${e.surface ?? 'default'} ${e.text}`)

    return { value: { isCopied: true as const } }
  })
  const TOOL = 'mcp__ccd_session_mgmt__set_session_title'
  const renamed: string[] = []
  const appTitles: unknown[] = []
  const toasts: string[] = []
  // core が返す形（result と、モデルが読む text、isError）を再現する
  const appAnswers = [
    { result: 'Renamed this session', text: 'Renamed this session' },
    { result: 'The person declined the new title', text: 'The person declined the new title', isError: true as const },
  ]
  on('model.fork', () => ({
    value: {
      isAnswered: true as const,
      text: '🧩 Building Claude Code status mods',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('command.run', { command: 'rename' }, (_$, e) => {
    renamed.push(e.args)

    return { text: '' }
  })
  on('tool.list', () => ({ value: [{ name: TOOL, description: 'Rename a CCD session', mcp: true }] }))
  on('tool.call', (_$, e) => {
    appTitles.push(e)

    return appAnswers.shift() ?? { result: '', text: '' }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['context'] })

  const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
  const band = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'rename' })
  expect((await band.find({ key: 'rename' }))?.props.label).toBe('Copied ✓')
  await band.press({ key: 'rename' })
  // アプリに拒否されたときは、貼り付けて直せるよう表記を変える
  expect((await band.find({ key: 'rename' }))?.props.label).toBe('Copied – paste to rename')
  await band.unmount()

  expect(renamed).toEqual(['🧩 Building Claude Code status mods', '🧩 Building Claude Code status mods'])
  expect(appTitles.length).toBe(2)
  expect(appTitles[0]).toMatchObject({ tool: TOOL, session_id: 'self', title: '🧩 Building Claude Code status mods' })
  expect(copies).toEqual(['desktop 🧩 Building Claude Code status mods', 'desktop 🧩 Building Claude Code status mods'])
  // 成功時はトーストなし。拒否は失敗なのでトーストで伝える
  expect(toasts).toEqual(['Renamed in Claude Code, but the app kept its title: The person declined the new title'])
})

test('/autoname でも同じ流れで改名する（入力なし）', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const copies: string[] = []
  on('ui.copy', (_$, e) => {
    copies.push(`${e.surface ?? 'default'} ${e.text}`)

    return { value: { isCopied: true as const } }
  })
  const TOOL = 'mcp__ccd_session_mgmt__set_session_title'
  const renamed: string[] = []
  const appCalls: unknown[] = []
  const toasts: string[] = []
  on('model.fork', () => ({
    value: {
      isAnswered: true as const,
      text: '📝 Chat log review',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('command.run', { command: 'rename' }, (_$, e) => {
    renamed.push(e.args)

    return { text: '' }
  })
  on('tool.list', () => ({ value: [{ name: TOOL, description: 'Rename a CCD session', mcp: true }] }))
  on('tool.call', (_$, e) => {
    appCalls.push(e)

    return { result: 'Renamed this session', text: 'Renamed this session' }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  const AUTONAME = { command: 'autoname', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
  expect((await $.command.run(AUTONAME)).text).toBe('Naming this session from the conversation…')
  // コマンドの返答はすぐ。改名はタイマーでフックの外に出てから
  expect(renamed).toEqual([])
  await clock.advance(0)
  await clock.settle()

  expect(renamed).toEqual(['📝 Chat log review'])
  expect(appCalls[0]).toMatchObject({ tool: TOOL, session_id: 'self', title: '📝 Chat log review' })
  expect(String((appCalls[0] as { consent?: string }).consent)).toContain('ran /autoname')
  // コマンドには押された面が無いので、コピー先はセッションの既定の面
  expect(copies).toEqual(['default 📝 Chat log review'])
  expect(toasts).toEqual([])
})

test('アプリ上でもタイトルツールが無いセッション（SSH 等）では、タイトルをコピーして「貼り付けて」と表記する', async ($, on) => {
  mock.clock(on, { now: NOW })
  const renamed: string[] = []
  const copied: string[] = []
  const toasts: string[] = []
  on('model.fork', () => ({
    value: {
      isAnswered: true as const,
      text: '🎙️ Plaud transcription automation for AP pilot',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('command.run', { command: 'rename' }, (_$, e) => {
    renamed.push(e.args)

    return { text: '' }
  })
  on('tool.list', () => ({ value: [{ name: 'mcp__ccd_view__show_pane', description: 'Show a pane', mcp: true }] }))
  on('session.surfaces', () => ({ value: ['desktop' as const] }))
  on('ui.copy', (_$, e) => {
    copied.push(`${e.surface} ${e.text}`)

    return { value: { isCopied: true as const } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['context'] })

  const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
  const band = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'rename' })
  expect((await band.find({ key: 'rename' }))?.props.label).toBe('Copied – paste to rename')
  await band.unmount()

  expect(renamed).toEqual(['🎙️ Plaud transcription automation for AP pilot'])
  expect(copied).toEqual(['desktop 🎙️ Plaud transcription automation for AP pilot'])
  expect(toasts).toEqual([])
})

test('デスクトップではバンドの2行目に直近のターンを出し、端末では出さない（端末は完了行に出る）', async ($, on) => {
  const current = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  current.usage = { ...current.usage, context: { tokens: 30_000, window: 1_000_000, percent: 3 }, cost: { usd: 1.2 } }
  await $.turn.complete(turn(14_000, USAGE))
  current.usage = { ...current.usage, context: { tokens: 36_100, window: 1_000_000, percent: 4 }, cost: { usd: 1.86 } }
  await $.turn.complete(turn(48_000, USAGE))

  const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
  const desk = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect((await desk.find({ type: 'Text', text: /^last turn/ }))?.text).toBe('last turn 48s · done 22:54 · ctx +6.1k · $0.660')
  await desk.unmount()

  const term = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await term.find({ type: 'Text', text: /^last turn/ })).toBeUndefined()
  await term.unmount()

  // 端末の完了行と同じ組み立て
  const line = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'TurnDuration', props: { word: 'Sautéed', durationMs: 48_000 } })
  expect((await line.find({ type: 'Text', text: /Sautéed/ }))?.text).toBe('✻ Sautéed for 48s · done 22:54 · ctx +6.1k · $0.660')
  await line.unmount()
})
