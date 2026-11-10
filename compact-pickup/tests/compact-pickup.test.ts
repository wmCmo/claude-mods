import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionCompactResult } from 'claude-code'

const RUN = { command: 'compact-pickup', args: 'keep the deploy plan', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]
const MANUAL = { trigger: 'manual' as const, instructions: 'keep the deploy plan', messages: SUMMARY }

// エンジン側：/compact と /pickup の実行を記録するだけ。compact 自体はテストが session.compact を直接起こして再現する
const engine = (on: On, compactResult: SessionCompactResult) => {
  const ran: string[] = []
  const clock = mock.clock(on, { now: 0 })
  on('command.run', { command: 'compact' }, (_$, e) => {
    ran.push(`compact ${e.args}`)

    return { text: 'compacting' }
  })
  on('command.run', { command: 'pickup' }, (_$, e) => {
    ran.push(e.command)

    return { text: 'picked up' }
  })
  on('session.compact', () => compactResult)
  on('ui.toast', (_$, e) => {
    ran.push(`toast ${e.text}`)

    return { value: undefined }
  })

  return { ran, clock }
}

test('compact が通ったら /pickup を実行する', async ($, on) => {
  const { ran, clock } = engine(on, { messages: SUMMARY })

  expect((await $.command.run(RUN)).text).toBe('Compacting, then running /pickup…')
  await clock.advance(0)
  await clock.settle()
  expect(ran).toEqual(['compact keep the deploy plan'])

  // 自動 compact では /pickup は走らない
  await $.session.compact({ ...MANUAL, trigger: 'auto' })
  await clock.settle()
  expect(ran).toEqual(['compact keep the deploy plan'])

  // キューの /compact が走った時点を再現
  await $.session.compact(MANUAL)
  await clock.settle()
  expect(ran).toEqual(['compact keep the deploy plan', 'pickup'])

  // 次に手動で compact しても /pickup は走らない
  await $.session.compact(MANUAL)
  await clock.settle()
  expect(ran).toEqual(['compact keep the deploy plan', 'pickup'])
})

test('compact が拒否されたら /pickup を実行しない', async ($, on) => {
  const { ran, clock } = engine(on, { skip: 'blocked by PreCompact hook' })

  await $.command.run(RUN)
  await clock.advance(0)
  await $.session.compact(MANUAL)
  await clock.settle()

  expect(ran).toEqual([
    'compact keep the deploy plan',
    'toast compact-pickup: compaction skipped, /pickup not run: blocked by PreCompact hook',
  ])
})
