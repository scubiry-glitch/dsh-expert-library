/** Verify the same task and craft resolvers the research DAG will call after activation. */
import type { Context } from '@deepseek-ai/cordis'
import { listScopedSkillCraftCatalog, resolveSelectedSkillContract, type SkillCraftConfig } from '../skill-craft.ts'
import { resolveTaskMaterialContract, TASK_MATERIAL_PACK, DOMAIN_MATERIAL_PACK } from '../task-material-binding.ts'
import type { RuntimeCenterSnapshot } from '../v2/runtime-pack.ts'

export async function preflightResearchMaterials(ctx: Context, selection: SkillCraftConfig,
  snapshot: RuntimeCenterSnapshot, workspaces: readonly string[]): Promise<void> {
  const active = snapshot.packs.find(pack => pack.packId === DOMAIN_MATERIAL_PACK)
  if (active === undefined) return
  const scope = { ...selection, getPackCenterSnapshot: async () => snapshot }
  for (const workspace of workspaces) {
    const catalog = await listScopedSkillCraftCatalog(ctx, scope, workspace)
    for (const id of ['zhijian-report-craft', 'zhijian-designer-render']) {
      if (!catalog.some(entry => entry.packId === DOMAIN_MATERIAL_PACK && entry.skillId === id
        && entry.root === active.root)) throw new Error(`CENTER_CRAFT_UNAVAILABLE: ${id}`)
    }
    await resolveSelectedSkillContract(ctx, scope, workspace, [
      { packId: DOMAIN_MATERIAL_PACK, skillId: 'zhijian-report-craft', reason: '研究正文与证据工艺' },
      { packId: DOMAIN_MATERIAL_PACK, skillId: 'zhijian-designer-render', variant: 'designer-paper', reason: '点睛图及 PDF 工艺' },
    ])
    if(catalog.some(entry=>entry.packId===DOMAIN_MATERIAL_PACK && entry.skillId==='zhijian-research-craft-v5')) {
      await resolveSelectedSkillContract(ctx,scope,workspace,[{packId:DOMAIN_MATERIAL_PACK,skillId:'zhijian-research-craft-v5',variant:'designer-paper',reason:'V5 activation preflight'}])
      for(const stage of ['view','synthesis','evidence','expression','writer','renderer']) resolveTaskMaterialContract(
        [{packId:TASK_MATERIAL_PACK,skillId:`research-v5-${stage}`,materialRole:'producer',required:true,reason:'V5 stage activation preflight'}],
        {packId:TASK_MATERIAL_PACK,templateId:`research-v5-${stage}`,required:true,variables:[]})
    }
    resolveTaskMaterialContract([
      { packId: DOMAIN_MATERIAL_PACK, skillId: 'zhijian-report-craft', materialRole: 'producer', required: true, reason: '正文工艺' },
      { packId: DOMAIN_MATERIAL_PACK, skillId: 'zhijian-designer-render', materialRole: 'producer', required: true, reason: '设计工艺' },
    ], { packId: TASK_MATERIAL_PACK, templateId: '98wiki-renderer-v1', required: true, variables: [] }, [
      { packId: DOMAIN_MATERIAL_PACK, skillId: 'zhijian-report-craft', root: active.root, packVersion: catalog.find(entry => entry.packId === DOMAIN_MATERIAL_PACK && entry.skillId === 'zhijian-report-craft')!.packVersion },
      { packId: DOMAIN_MATERIAL_PACK, skillId: 'zhijian-designer-render', root: active.root, packVersion: catalog.find(entry => entry.packId === DOMAIN_MATERIAL_PACK && entry.skillId === 'zhijian-designer-render')!.packVersion },
    ])
  }
}
