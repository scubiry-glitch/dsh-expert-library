import { useEffect, useState } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { ExpertLibrarySettings } from '../settings.ts'

export interface ExpertLibrarySettingsCardProps {
  close: () => void
  scope: SettingsScope<ExpertLibrarySettings>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): string {
  return typeof value === 'number' ? String(value) : ''
}

/** Settings page for the Expert Library namespace. Secrets are intentionally absent. */
export function ExpertLibrarySettingsCard({ close, scope }: ExpertLibrarySettingsCardProps) {
  const snapshot = scope.getSnapshot()
  const value = snapshot.value
  const [draft, setDraft] = useState({
    stateDir: text(value?.stateDir),
    knowledgeDir: text(value?.knowledgeDir),
    memberProvider: text(value?.memberProvider),
    maxMembers: number(value?.maxMembers),
    promptSectionOrder: number(value?.promptSectionOrder),
    modelProvider: text(value?.defaultModel?.provider),
    modelName: text(value?.defaultModel?.model),
    reasoningEffort: text(value?.defaultModel?.reasoningEffort),
    announceToAgent: value?.announceToAgent ?? true,
  })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (snapshot.status !== 'ready' || value === undefined) return
    setDraft({
      stateDir: text(value.stateDir),
      knowledgeDir: text(value.knowledgeDir),
      memberProvider: text(value.memberProvider),
      maxMembers: number(value.maxMembers),
      promptSectionOrder: number(value.promptSectionOrder),
      modelProvider: text(value.defaultModel?.provider),
      modelName: text(value.defaultModel?.model),
      reasoningEffort: text(value.defaultModel?.reasoningEffort),
      announceToAgent: value.announceToAgent ?? true,
    })
  }, [snapshot.status, value])

  const set = (field: keyof typeof draft, next: string | boolean) => {
    setDraft(current => ({ ...current, [field]: next }))
    setMessage('')
  }

  const save = async () => {
    if (!snapshot.writable || saving) return
    setSaving(true)
    setMessage('')
    try {
      const writes: Array<[string, unknown]> = [
        ['stateDir', draft.stateDir],
        ['knowledgeDir', draft.knowledgeDir],
        ['memberProvider', draft.memberProvider],
        ['maxMembers', Number(draft.maxMembers)],
        ['promptSectionOrder', Number(draft.promptSectionOrder)],
        ['defaultModel', { provider: draft.modelProvider, model: draft.modelName, reasoningEffort: draft.reasoningEffort }],
        ['announceToAgent', draft.announceToAgent],
      ]
      for (const [field, next] of writes) {
        if (typeof next === 'string' && next.trim() === '') await scope.unset(field)
        else await scope.set(field, next)
      }
      setMessage('已保存')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (snapshot.status === 'loading') return <section><p>正在读取专家库设置…</p></section>
  if (snapshot.status === 'unavailable') return <section><h2>专家库</h2><p>当前 DSH 配置未开放 Expert Library 设置。</p></section>

  return <section style={{ maxWidth: 720 }}>
    <h2>专家库</h2>
    <p>配置成员运行时、默认模型和提示词策略。API Key 等秘密不会显示或写入此处。</p>
    <label>状态目录<input value={draft.stateDir} onChange={event => set('stateDir', event.target.value)} /></label>
    <label>知识目录<input value={draft.knowledgeDir} onChange={event => set('knowledgeDir', event.target.value)} /></label>
    <label>成员 Provider<input value={draft.memberProvider} onChange={event => set('memberProvider', event.target.value)} /></label>
    <label>最大成员数<input type="number" min="1" value={draft.maxMembers} onChange={event => set('maxMembers', event.target.value)} /></label>
    <label>提示词顺序<input type="number" min="0" value={draft.promptSectionOrder} onChange={event => set('promptSectionOrder', event.target.value)} /></label>
    <label>默认模型 Provider<input value={draft.modelProvider} onChange={event => set('modelProvider', event.target.value)} /></label>
    <label>默认模型<input value={draft.modelName} onChange={event => set('modelName', event.target.value)} /></label>
    <label>默认推理强度<input value={draft.reasoningEffort} onChange={event => set('reasoningEffort', event.target.value)} /></label>
    <label><input type="checkbox" checked={draft.announceToAgent} onChange={event => set('announceToAgent', event.target.checked)} /> 向 Agent 注入专家库使用协议</label>
    <div>
      <button type="button" disabled={!snapshot.writable || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
      <button type="button" onClick={close}>关闭</button>
      {message !== '' && <span role="status">{message}</span>}
    </div>
  </section>
}
