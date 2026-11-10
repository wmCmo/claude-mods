import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  ModelForkResult,
  Register,
  RenderSurface,
  SessionMessage,
  SessionRateLimit,
  ToolCallArgs,
  ToolCallResult,
  UiPressArgument,
} from 'claude-code'

import type { CompactionView, ContextFill, RenameStatus, TurnStats, WeeklyLimit } from '../types'

const CELLS = 10
const WARN_PERCENT = 80
const HOUR_MS = 60 * 60 * 1000
const WEEK_MS = 7 * 24 * HOUR_MS
// Button はラベルの左右に枠の分を取る（概算）。バンドの幅見積もりに使う
const BUTTON_PAD = 4
const COMMAND = 'inout'
const AUTONAME_COMMAND = 'autoname'
// セッションをまたいで保持する $.store のキー
const SHOW_IN_OUT_KEY = 'showInOut'
const COMPACTION_PANE = 'compaction'

const fill = atom({ plugin: 'context-bar', key: 'fill' } as const, null)
const weekly = atom({ plugin: 'context-bar', key: 'weekly' } as const, null)
const turns = atom({ plugin: 'context-bar', key: 'turns' } as const, {})
const baseline = atom({ plugin: 'context-bar', key: 'baseline' } as const, { tokens: null, usd: null })
const showInOut = atom({ plugin: 'context-bar', key: 'showInOut' } as const, false)
const compaction = atom({ plugin: 'context-bar', key: 'compaction' } as const, null)
const renameStatus = atom({ plugin: 'context-bar', key: 'renameStatus' } as const, 'idle')
const lastTurn = atom({ plugin: 'context-bar', key: 'lastTurn' } as const, null)
const RENAME_STATUS_MS = 4000
const RENAME_LABELS: Record<RenameStatus, string> = {
  idle: 'Rename',
  naming: 'Naming…',
  copied: 'Copied ✓',
  // アプリのタイトルは変わっていない：コピーしたものを貼り付けてもらう
  paste: 'Copied – paste to rename',
}

const TITLE_PROMPT = [
  'Name this conversation for a chat list.',
  'Reply with exactly one line: a single emoji that fits the topic, one space, then a short title of 2 to 6 words',
  'describing what this conversation is about as a whole, not just the latest message.',
  'Use English. No quotes, no trailing punctuation, nothing else.',
].join(' ')
const TITLE_MAX = 80
// デスクトップアプリだけが持つセッション名変更ツール
const DESKTOP_TITLE_TOOL = 'mcp__ccd_session_mgmt__set_session_title'

// モデルの返答から1行目だけを取り、引用符や「Title:」を外す。絵文字が無ければ補う
const cleanTitle = (raw: string): string | null => {
  const line = raw
    .split('\n')
    .map(part => part.trim())
    .find(part => part !== '')

  if (line === undefined) {
    return null
  }

  const title = line
    .replace(/^title:\s*/i, '')
    .replace(/^["'`*「『]+|["'`*」』.。]+$/g, '')
    .trim()
    .slice(0, TITLE_MAX)

  if (title === '') {
    return null
  }

  return /^\p{Extended_Pictographic}/u.test(title) ? title : `💬 ${title}`
}

const bar = (percent: number): string => {
  const filled = Math.min(CELLS, Math.round((percent / 100) * CELLS))

  return `${'█'.repeat(filled)}${'░'.repeat(CELLS - filled)}`
}

// 使用率をバー表示に整形する。初回応答前・compact直後は percent が無いので「—」を出す。
// 幅が足りないときは「(170k/200k)」を省く
const formatContext = (context: ContextFill, detail: boolean): string => {
  if (context.percent === undefined) {
    return `ctx ${'░'.repeat(CELLS)} —`
  }

  const kTokens = Math.round((context.tokens ?? 0) / 1000)
  const kWindow = Math.round(context.window / 1000)

  return `ctx ${bar(context.percent)} ${context.percent}%${detail ? ` (${kTokens}k/${kWindow}k)` : ''}`
}

type WeeklyParts = { head: string; pace: number | null; left: string | null }

// Notion の pace と同じ式：使用率 ÷ 週の経過率（経過率は 1% を下限にする）。
// 1.00 ならリセットの瞬間にちょうど 100%、1 を超えるとこのペースではリセット前に上限に届く
const weeklyPace = (percentUsed: number, resetsAt: number, now: number): number => {
  const elapsed = Math.max((WEEK_MS - (resetsAt - now)) / WEEK_MS, 0.01)

  return Math.round((percentUsed / 100 / elapsed) * 100) / 100
}

// バー・pace・リセットまでの残り時間（「2d 5h」）に分けて返す。pace だけ別の色にするため。
// 残り時間はタイムゾーンに依存しないよう相対表示にする
const formatWeekly = (limit: WeeklyLimit, now: number): WeeklyParts => {
  const percent = Math.round(limit.percentUsed)
  const head = `week ${bar(percent)} ${percent}%`
  const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)

  if (Number.isNaN(resetsAt)) {
    return { head, pace: null, left: null }
  }

  const hours = Math.max(0, Math.round((resetsAt - now) / HOUR_MS))
  const left = hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`

  return { head, pace: weeklyPace(limit.percentUsed, resetsAt, now), left }
}

// サブスクリプション外や初回応答前は seven_day が無いので null（非表示）
const pickWeekly = (rateLimits: SessionRateLimit[]): WeeklyLimit | null => {
  const window = rateLimits.find(limit => limit.kind === 'seven_day')

  return window === undefined ? null : { percentUsed: window.percentUsed, resetsAt: window.resetsAt }
}

const formatTokens = (count: number): string => {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`
  }

  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : `${count}`
}

const formatUsd = (usd: number): string => `$${usd.toFixed(usd < 1 ? 3 : 2)}`

// エンジンの表記（3s / 1m 4s）に合わせる
const formatDuration = (ms: number): string => {
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`
  }

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

const pad = (n: number): string => `${n}`.padStart(2, '0')

// 基準があれば「ctx +12.4k」、基準なし（セッション最初のターン・resume直後）は絶対量、減っていれば compact とみなす
const formatCtx = (stats: TurnStats): string | null => {
  if (stats.ctxTokens === undefined) {
    return null
  }

  if (stats.isCompacted) {
    return `ctx ${formatTokens(stats.ctxTokens)} (compacted)`
  }

  return stats.ctxDelta === undefined ? `ctx ${formatTokens(stats.ctxTokens)}` : `ctx +${formatTokens(stats.ctxDelta)}`
}

const formatInOut = (stats: TurnStats): string | null => {
  if (stats.input === undefined || stats.output === undefined) {
    return null
  }

  const cachedPercent = stats.input === 0 ? 0 : Math.round(((stats.cached ?? 0) / stats.input) * 100)

  return `${formatTokens(stats.input)} in (${cachedPercent}% cached) · ${formatTokens(stats.output)} out`
}

// Markdown 要素は1つ10000文字まで、制御文字はタブと改行のみ。余裕を持って分割する
const MARKDOWN_CHUNK = 9000

const sanitize = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')

// 段落 → 行 → 文字の順で、上限以内の塊に詰める
const pack = (text: string, limit: number): string[] => {
  const chunks: string[] = []
  let current = ''
  const push = (piece: string, separator: string) => {
    if (current === '') {
      current = piece
    } else if (current.length + separator.length + piece.length <= limit) {
      current += separator + piece
    } else {
      chunks.push(current)
      current = piece
    }
  }

  for (const paragraph of text.split('\n\n')) {
    if (paragraph.length <= limit) {
      push(paragraph, '\n\n')
      continue
    }

    for (const line of paragraph.split('\n')) {
      for (let start = 0; start < Math.max(line.length, 1); start += limit) {
        push(line.slice(start, start + limit), '\n')
      }
    }
  }

  if (current !== '') {
    chunks.push(current)
  }

  return chunks
}

// 塊の境目がコードブロックの途中なら、閉じてから次の塊で開き直す
const balanceFences = (chunks: string[]): string[] => {
  let isOpen = false

  return chunks.map(chunk => {
    const body = isOpen ? '```\n' + chunk : chunk
    const fences = body.split('\n').filter(line => line.trimStart().startsWith('```')).length
    isOpen = fences % 2 === 1

    return isOpen ? body + '\n```' : body
  })
}

// ペインの本文。要約は通常最初のメッセージ。残されたメッセージも役割見出し付きで続ける
const compactionText = (view: CompactionView): string =>
  view.messages
    .map(message => `### ${message.role === 'user' ? 'User' : 'Assistant'}\n\n${message.text === '' ? '_(no text)_' : message.text}`)
    .join('\n\n---\n\n')

const compactionMarkdown = (view: CompactionView): string[] =>
  balanceFences(pack(sanitize(compactionText(view)), MARKDOWN_CHUNK - 8))

const compactionHeader = (view: CompactionView): string => {
  const tokens =
    view.tokensBefore === undefined || view.tokensAfter === undefined
      ? ''
      : ` · ${formatTokens(view.tokensBefore)} → ${formatTokens(view.tokensAfter)} tokens`

  return `Compacted at ${view.doneAt} (${view.trigger})${tokens} · ${view.messages.length} messages kept`
}

const FALLBACK_MODEL = 'haiku'
const DIGEST_HEAD = 4
const DIGEST_BUDGET = 30_000
const DIGEST_MESSAGE_MAX = 1500

// フォークできないとき用の会話の抜粋：冒頭数件（何の会話か）＋入る限りの直近（今どうなっているか）
const digestConversation = (messages: readonly SessionMessage[]): string => {
  const lines = messages
    .filter(message => message.text.trim() !== '')
    .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.trim().slice(0, DIGEST_MESSAGE_MAX)}`)
  const head = lines.slice(0, DIGEST_HEAD)
  const tail: string[] = []
  let used = head.join('\n\n').length

  for (const line of lines.slice(DIGEST_HEAD).reverse()) {
    if (used + line.length > DIGEST_BUDGET) {
      break
    }

    tail.unshift(line)
    used += line.length
  }

  const skipped = lines.length - head.length - tail.length

  return [...head, ...(skipped > 0 ? [`(${skipped} messages omitted)`] : []), ...tail].join('\n\n')
}

// 会話全体をフォークしてタイトルを付けさせ（プロンプトキャッシュが効く）、組み込みの /rename とデスクトップアプリの両方に反映する。
// 結果はトーストではなくクリップボードに入れ、ボタンの表記（Copied）で知らせる。トーストは失敗時だけ。
// Rename ボタンと /autoname の共通処理。how はアプリの承認に渡す「ユーザーが何をしたか」、surface はコピー先
const renameFromConversation = async ($: EngineInterface, how: string, surface?: RenderSurface): Promise<void> => {
  if ((await read($, renameStatus)) === 'naming') {
    return
  }

  await update($, renameStatus, () => 'naming')
  let done: RenameStatus = 'idle'

  try {
    let answer: ModelForkResult = await $.model.fork({ prompt: TITLE_PROMPT })

    // 再起動・resume 直後はメインスレッドがまだリクエストを送っておらずフォークできない。
    // 会話はトランスクリプトにあるので、要約した本文を小さいモデルに渡して名付ける
    if (!answer.isAnswered && answer.reason === 'nothing-to-fork') {
      const digest = digestConversation(await $.session.messages())

      if (digest === '') {
        $.ui.toast('Rename: nothing in this conversation to name yet')

        return
      }

      answer = await $.model.complete({
        model: FALLBACK_MODEL,
        prompt: `${TITLE_PROMPT}

<conversation>
${digest}
</conversation>`,
        maxTokens: 60,
      })
    }

    if (!answer.isAnswered) {
      $.ui.toast(`Rename failed: ${answer.reason}`)

      return
    }

    const title = cleanTitle(answer.text)

    if (title === null) {
      $.ui.toast('Rename failed: the model returned no title')

      return
    }

    await $.command.run({ command: 'rename', args: title })

    // デスクトップアプリは /rename の custom-title を読まず、独自のタイトルを持つ。アプリのツールがあればそちらも変える
    const hasDesktopTitle = (await $.tool.list()).some(tool => tool.name === DESKTOP_TITLE_TOOL)
    // アプリ上なのにタイトル用ツールが無いセッション（SSH 先など）は、アプリの表示が変わらない。貼り付けて直してもらう
    let isAppTitleStale = false

    if (hasDesktopTitle) {
      // 型定義はこのツールを知らない（端末で生成されたため）ので入力だけ型を外す。実行時は名前で解決される
      const input = {
        tool: DESKTOP_TITLE_TOOL,
        session_id: 'self',
        title,
        consent: `The user ${how} to rename this session to "${title}".`,
      } as unknown as ToolCallArgs
      const set: ToolCallResult = await $.tool.call(input)

      if (set.deny !== undefined || set.isError === true) {
        $.ui.toast(`Renamed in Claude Code, but the app kept its title: ${set.deny ?? set.text ?? 'error'}`)
        isAppTitleStale = true
      }
    } else {
      isAppTitleStale = (await $.session.surfaces()).includes('desktop')
    }

    const copied = await $.ui.copy({ text: title, surface })

    if (!copied.isCopied) {
      $.ui.toast(`Renamed to ${title} (couldn't copy it: ${copied.reason})`)

      return
    }

    done = isAppTitleStale ? 'paste' : 'copied'
  } finally {
    await update($, renameStatus, () => done)

    // 「Copied」の表示は数秒で元の「Rename」に戻す
    if (done !== 'idle') {
      $.clock.after(RENAME_STATUS_MS, () => {
        void update($, renameStatus, status => (status === done ? 'idle' : status))
      })
    }
  }
}

const turnSummary = (lead: string, stats: TurnStats, inOut: boolean): string =>
  [lead, `done ${stats.doneAt}`, formatCtx(stats), stats.usd === undefined ? null : formatUsd(stats.usd), inOut ? formatInOut(stats) : null]
    .filter(part => part !== null)
    .join(' · ')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // 旧版（v0.1）がステータスラインに残した表示を消す
    $.ui.status(undefined)
    await $.command.register({ name: COMMAND, description: 'Toggle in/out token counts on the turn-finish line' })
    await $.command.register({ name: AUTONAME_COMMAND, description: 'Rename this session to an emoji + title generated from the conversation' })

    const { context, rateLimits, cost } = await $.session.usage()
    await update($, fill, () => ({ tokens: context.tokens, window: context.window, percent: context.percent }))
    await update($, weekly, () => pickWeekly(rateLimits))
    // resume 時もコストは以前の分から数えられるので、ここを基準にする。トークンは初回応答までわからない
    await update($, baseline, () => ({ tokens: context.tokens ?? null, usd: cost?.usd ?? null }))
    const stored = await $.store.get(SHOW_IN_OUT_KEY)
    await update($, showInOut, () => stored === true)

    return result
  })

  on('command.run', { command: COMMAND }, async $ => {
    const isShown = await update($, showInOut, value => !value)
    await $.store.set(SHOW_IN_OUT_KEY, isShown)

    return { text: isShown ? 'In/out token counts: shown.' : 'In/out token counts: hidden.' }
  })

  // command.run の中からは /rename もフォークも待てない（ホスト側の制約）ので、タイマーでフックの外に出して実行する
  on('command.run', { command: AUTONAME_COMMAND }, async $ => {
    $.clock.after(0, () => {
      renameFromConversation($, `ran /${AUTONAME_COMMAND}`).catch((error: unknown) => {
        $.ui.toast(`Rename failed: ${String(error)}`)
      })
    })

    return { text: 'Naming this session from the conversation…' }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const { tokens, window, percent } = e.context
      await update($, fill, () => ({ tokens, window, percent }))
    }

    if (e.changed.includes('rateLimits')) {
      await update($, weekly, () => pickWeekly(e.rateLimits))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // サブエージェントのターンは完了行を持たない（そのコストはメインのターンの差分に含まれる）
    if (e.agentId !== undefined) {
      return result
    }

    const { context, cost } = await $.session.usage()
    const before = await read($, baseline)
    const done = new Date(await $.clock.now())
    const tokens = context.tokens
    const usd = cost?.usd
    const delta = tokens === undefined || before.tokens === null ? undefined : tokens - before.tokens

    const stats: TurnStats = {
      doneAt: `${pad(done.getHours())}:${pad(done.getMinutes())}`,
      ctxTokens: tokens,
      ctxDelta: delta,
      isCompacted: delta !== undefined && delta < 0,
      usd: usd === undefined || before.usd === null ? undefined : usd - before.usd,
      input:
        e.usage === undefined
          ? undefined
          : e.usage.input_tokens + e.usage.cache_creation_input_tokens + e.usage.cache_read_input_tokens,
      cached: e.usage?.cache_read_input_tokens,
      output: e.usage?.output_tokens,
    }
    await update($, turns, all => ({ ...all, [String(e.durationMs)]: stats }))
    await update($, lastTurn, () => ({ durationMs: e.durationMs, stats }))
    await update($, baseline, prev => ({ tokens: tokens ?? prev.tokens, usd: usd ?? prev.usd }))

    return result
  })

  // メイン会話の compact が通ったら結果を保存し、バンドのボタンから見られるようにする
  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    if (result.skip !== undefined || e.agentId !== undefined) {
      return result
    }

    const done = new Date(await $.clock.now())
    const view: CompactionView = {
      doneAt: `${pad(done.getHours())}:${pad(done.getMinutes())}`,
      trigger: e.trigger,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      messages: result.messages.map(message => ({ role: message.role, text: message.text })),
    }
    await update($, compaction, () => view)

    return result
  })

  on('ui.render', { component: 'Pane', requestId: COMPACTION_PANE }, async ($, e) => {
    const view = await read($, compaction)
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    // 分割前の全文をそのままコピーする。押された面（端末・デスクトップ）のクリップボードへ
    const copy = async (press: UiPressArgument) => {
      if (view === null) {
        return
      }

      const copied = await $.ui.copy({ text: compactionText(view), surface: press.surface })
      $.ui.toast(copied.isCopied ? 'Compaction copied to clipboard' : `Copy failed: ${copied.reason}`)
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>{view === null ? 'No compaction yet.' : compactionHeader(view)} </Text>
          {view === null ? null : <Button key="copy" label="Copy" hotkey="c" onPress={copy} />}
          <Text key="gap"> </Text>
          <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: COMPACTION_PANE })} />
        </Box>
        {view === null ? null : compactionMarkdown(view).map((chunk, index) => <Markdown key={`body-${index}`} text={chunk} />)}
      </Box>
    )
  })

  // 「✻ Cooked for 1m 41s · done 22:54」行を描き直し、増分・コスト（・入出力）を足す。記録が無いターンはエンジンの行のまま
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const stats = (await read($, turns))[String(e.props.durationMs)]

    if (stats === undefined) {
      return next(e)
    }

    const { Text } = $.ui.resolve(e)
    const lead = `✻ ${e.props.word} for ${formatDuration(e.props.durationMs)}`

    return <Text dimColor>{turnSummary(lead, stats, await read($, showInOut))}</Text>
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const context = await read($, fill)
    const limit = await read($, weekly)
    const compacted = await read($, compaction)
    const status = await read($, renameStatus)
    // 端末は完了行に出しているので、二重に出さない
    const last = e.surface === 'terminal' ? null : await read($, lastTurn)
    const inOut = await read($, showInOut)

    if (e.props.hasSurvey || (context === null && limit === null && compacted === null)) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const openCompaction = () =>
      $.ui.open({ id: COMPACTION_PANE, title: `Compaction ${compacted?.doneAt ?? ''}`, focus: true, closeOnEscape: true })
    const rename = (press: UiPressArgument) => renameFromConversation($, 'pressed "Rename" in the context-bar band', press.surface)
    const segment = (key: string, text: string, percent: number) =>
      percent > WARN_PERCENT ? <Text key={key} color="yellow">{text}</Text> : <Text key={key}>{text}</Text>
    const week = limit === null ? null : formatWeekly(limit, await $.clock.now())
    const paceText = week?.pace == null ? '' : ` pace ${week.pace.toFixed(2)}`
    const leftText = week?.left == null ? '' : ` · ${week.left}`

    // 1行に収まらないときは、トークン数とリセットまでの時間を省いて pace を残す
    const width = (detail: boolean) =>
      (context === null ? 0 : formatContext(context, detail).length + 3) +
      (week === null ? 0 : week.head.length + paceText.length + (detail ? leftText.length : 0) + 3) +
      (compacted === null ? 0 : 'View compaction'.length + BUTTON_PAD + 3) +
      RENAME_LABELS[status].length + BUTTON_PAD
    const detail = width(true) <= e.props.bodyColumns

    return (
      <Box flexDirection="column">
      <Box>
        {context === null ? null : segment('ctx', formatContext(context, detail), context.percent ?? 0)}
        {context === null || week === null ? null : <Text key="sep" dimColor>{'   '}</Text>}
        {limit === null || week === null ? null : segment('week', week.head, limit.percentUsed)}
        {paceText === '' ? null : week !== null && week.pace !== null && week.pace > 1 ? (
          <Text key="pace" color="yellow">{paceText}</Text>
        ) : (
          <Text key="pace" dimColor>{paceText}</Text>
        )}
        {detail && leftText !== '' ? <Text key="left" dimColor>{leftText}</Text> : null}
        {compacted === null ? null : <Text key="sep2" dimColor>{'   '}</Text>}
        {compacted === null ? null : <Button key="view-compaction" label="View compaction" hotkey="v" onPress={openCompaction} />}
        <Text key="sep3" dimColor>{'   '}</Text>
        <Button key="rename" label={RENAME_LABELS[status]} hotkey="r" onPress={rename} />
      </Box>
      {last === null ? null : (
        <Text key="last-turn" dimColor>{turnSummary(`last turn ${formatDuration(last.durationMs)}`, last.stats, inOut)}</Text>
      )}
      </Box>
    )
  })
}
