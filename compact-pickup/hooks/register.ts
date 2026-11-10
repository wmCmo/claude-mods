import type { Register } from 'claude-code'

const COMMAND = 'compact-pickup'

export const register: Register = on => {
  // /compact-pickup が依頼した compact の完了を待っている間 true
  let isPickupPending = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Compact the conversation, then run /pickup',
      argumentHint: '[compact instructions]',
    })

    return next(e)
  })

  // command.run の中からは compact も別コマンドの実行もできない（ホスト側の制約）。
  // タイマーでこのフックの外に出してから /compact を実行し、完了を session.compact で拾う
  on('command.run', { command: COMMAND }, async ($, e) => {
    isPickupPending = true
    $.clock.after(0, () => {
      $.command.run({ command: 'compact', args: e.args }).catch((error: unknown) => {
        isPickupPending = false
        $.ui.toast(`${COMMAND}: /compact failed: ${String(error)}`)
      })
    })

    return { text: 'Compacting, then running /pickup…' }
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    // 待っているのはメイン会話の /compact（manual）だけ。サブエージェントや自動 compact は素通し
    if (!isPickupPending || e.trigger !== 'manual' || e.agentId !== undefined) {
      return result
    }

    isPickupPending = false

    if (result.skip !== undefined) {
      $.ui.toast(`${COMMAND}: compaction skipped, /pickup not run: ${result.skip}`)

      return result
    }

    $.command.run({ command: 'pickup' }).catch((error: unknown) => {
      $.ui.toast(`${COMMAND}: /pickup failed: ${String(error)}`)
    })

    return result
  })
}
