/** Browser plugin for the Expert Teams activity floater and conversation card. */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ExpertLibrarySettings } from '../settings.ts'
import { createRoot } from 'react-dom/client'
// Module-loading import: the card registers into the conversation chat-node
// slot, whose keyed renderer map lives in the ui-conversation contract.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsScopeBinder } from '@deepseek-ai/dsh-client-ui-settings/client'

declare module '@deepseek-ai/cordis' {
  interface Context { settingsScope: SettingsScopeBinder }
}
import { ActivityPanel } from './ActivityPanel.tsx'
import { ExpertTeamsCard, type ExpertTeamsCardInjected } from './AgentTeamsCard.tsx'
import { agentTeamsCardDefinition } from './agent-teams-card-definition.ts'
import { FilesView } from './FilesView.tsx'
import { ExpertLibrarySettingsCard } from './settings-card.tsx'
import { DomainPacksCard } from './domain-packs-card.tsx'

/** Required services: conversation nodes, slots, and sessions navigation. */
export const inject = ['conversationEvents', 'slots', 'sessions', 'settingsScope']

/**
 * Mount the floater through a body portal (the web shell has no top-right
 * slot) and register the in-conversation team card, whose "activity panel"
 * button re-activates the floater via a window event — the recovery path
 * for a closed floater or a re-opened session.
 */
export function apply(ctx: ClientContext): void {
  const host = document.createElement('div')
  host.dataset.agentTeamsHost = ''
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(<ActivityPanel
    sessionsList={ctx.sessions.list}
    openSession={(id: SessionId) => { ctx.sessions.open(id) }}
  />)
  ctx.effect(() => () => {
    root.unmount()
    host.remove()
  }, 'expert-teams: activity panel')

  ctx.conversationEvents.register(agentTeamsCardDefinition)

  const settingsScope = ctx.settingsScope.bind<ExpertLibrarySettings>({ namespace: 'expert-library' })
  ctx.slots.register({
    name: 'settings.section',
    id: 'expert-library',
    order: 160,
    label: '专家库',
    inject: () => ({ scope: settingsScope }),
  }, ExpertLibrarySettingsCard)

  // Read-only Domain Pack preview (Phase 1 「设置页只读预览校验」): next to the
  // writable 专家库 runtime card, without any settings scope — the page only
  // reads the host `/plugins/dsh-expert-library/packs` route.
  ctx.slots.register({
    name: 'settings.section',
    id: 'expert-library-packs',
    order: 165,
    label: '领域包',
  }, DomainPacksCard)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'expert-teams',
    inject: (): ExpertTeamsCardInjected => ({
      openSession: (id: SessionId) => { ctx.sessions.open(id) },
      currentSessionId: () => ctx.sessions.list.getSnapshot().current,
    }),
  }, ExpertTeamsCard))

  // The 文件 tab beside 对话/轨迹: this conversation's input and produced
  // documents, with office previews through the univer plugin's viewer.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'expert-files',
    order: 5,
    label: () => '文件',
  }, FilesView))
}
