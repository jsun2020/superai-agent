import type { ModelInfo } from '../types/settings'

export const OFFICIAL_DEFAULT_MODEL_ID = 'claude-opus-4-7'
export const OPENAI_CODEX_OFFICIAL_PROVIDER_ID = 'official-openai-codex'
export const OPENAI_CODEX_DEFAULT_MODEL_ID = 'codex-default'

export const OFFICIAL_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4-7',
    name: 'Opus 4.7',
    description: 'Most capable for ambitious work',
    context: '1m',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Sonnet 4.6',
    description: 'Most efficient for everyday tasks',
    context: '200k',
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    description: 'Fastest for quick answers',
    context: '200k',
  },
]

export const OPENAI_CODEX_MODELS: ModelInfo[] = [
  {
    id: OPENAI_CODEX_DEFAULT_MODEL_ID,
    name: 'Codex 默认模型',
    description: '使用本机 Codex CLI 配置',
    context: '',
  },
]
