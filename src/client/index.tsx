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
import { ManageCard } from './manage-card.tsx'
import { PackCenterCard } from './pack-center-card.tsx'

/** Required services: conversation nodes, slots, and sessions navigation. */
export const inject = ['uiConversation', 'slots', 'sessions', 'settingsScope']

/**
 * rc.1 renamed the browser registry service `conversationEvents` →
 * `uiConversation` and moved registration under `.events`
 * (`UiConversation.events: ConversationEventRegistry`); the old name does not
 * exist anywhere in the rc.1 core tree. This package's own node_modules still
 * pins rc.8 typings that declare only the old name, so the read goes through a
 * narrow structural cast instead of the stale declaration. Drop the cast once
 * the local dependency tree resolves against rc.1.
 */
const conversationNodeRegistry = (ctx: ClientContext): { register(definition: typeof agentTeamsCardDefinition): void } =>
  (ctx as unknown as {
    uiConversation: { events: { register(definition: typeof agentTeamsCardDefinition): void } }
  }).uiConversation.events

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

  conversationNodeRegistry(ctx).register(agentTeamsCardDefinition)

  const settingsScope = ctx.settingsScope.bind<ExpertLibrarySettings>({ namespace: 'expert-library' })
  // 智见数据（原「专家库」）：纯粹的数据源管理 —— 外部 provider 注册/连通
  // 与工具执行模式。其余原区块拆至下方各分区。
  ctx.slots.register({
    name: 'settings.section',
    id: 'expert-library',
    order: 160,
    label: '智见数据',
    inject: () => ({ scope: settingsScope }),
  }, ExpertLibrarySettingsCard)

  // Read-only Domain Pack validation preview. Tenant version operations live in
  // the separate settings section labelled 「领域包」 below; this preview keeps
  // the existing local pack-health view distinct from center-managed versions.
  // 领域包：版本管理中心吸收本地校验（DomainPacksCard 的 Panel 作为
  // 「本地校验」Tab 嵌入）+ 运行参与（enabledPacks/packPriority）。
  ctx.slots.register({
    name: 'settings.section',
    id: 'expert-library-center',
    order: 165,
    label: '领域包',
    inject: () => ({ scope: settingsScope }),
  }, PackCenterCard)

  // 专家库手动管理（写侧）：专家/场景覆盖层 CRUD、技能 zip 安装、领域包重建。
  // 把高频操作固定成设置表单，避免每次靠 agent 执行的随机性；host 路由
  // /plugins/dsh-expert-library/manage/*（白名单脚本 + 惰性写覆盖层）。
  // 专家库：写侧管理（专家/场景/技能）+ 专家模型路由覆盖 + 运行配置。
  ctx.slots.register({
    name: 'settings.section',
    id: 'expert-library-manage',
    order: 170,
    label: '专家库',
    inject: () => ({ scope: settingsScope }),
  }, ManageCard)
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
