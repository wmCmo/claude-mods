export type ContextFill = { tokens?: number; window: number; percent?: number }
export type WeeklyLimit = { percentUsed: number; resetsAt?: string }

// ターン1回分の記録。完了行の描画に使う
export type TurnStats = {
  doneAt: string
  // ターン終了時のコンテキスト量と、前ターン終了時からの増分（基準が無ければ undefined）
  ctxTokens?: number
  ctxDelta?: number
  isCompacted: boolean
  // セッション累計コストの前ターン終了時からの差分（USD）。台帳が無いホストでは undefined
  usd?: number
  // input は非キャッシュ・キャッシュ書込・キャッシュ読込の合計。中断・APIエラー時は undefined
  input?: number
  cached?: number
  output?: number
}

// 前ターン終了時点の値。増分・差分の基準
export type Baseline = { tokens: number | null; usd: number | null }

// 直近の compact の結果（要約と残されたメッセージ）。ペインで表示する
export type CompactionView = {
  doneAt: string
  trigger: string
  tokensBefore?: number
  tokensAfter?: number
  messages: { role: 'user' | 'assistant'; text: string }[]
}

// idle：Rename / naming：生成中 / copied：改名してコピー済み / paste：コピー済みだがアプリのタイトルは未変更（SSH など）
export type RenameStatus = 'idle' | 'naming' | 'copied' | 'paste'

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      fill: ContextFill | null
      weekly: WeeklyLimit | null
      // TurnDuration 行には turnId が無いため、durationMs（文字列化）をキーに突き合わせる
      turns: Record<string, TurnStats>
      baseline: Baseline
      showInOut: boolean
      compaction: CompactionView | null
      // Rename ボタンの状態。生成中は二重に押せず、完了後は数秒だけ「Copied」を出す
      renameStatus: RenameStatus
      // 直近のメイン会話のターン。デスクトップなど端末以外ではバンドの2行目に出す
      lastTurn: { durationMs: number; stats: TurnStats } | null
    }
  }
}
