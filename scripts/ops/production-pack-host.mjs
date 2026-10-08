import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createPackCenterHost } from '../../lib/host/pack-center-host.js'

export async function openProductionPackHost(config) {
  // Read only the runtime settings needed for pack resolution. Passwords,
  // provider keys and manageToken never enter this process or its output.
  const selected=JSON.parse(execFileSync('python3',['-c',[
    'import json,sys,yaml',
    's=yaml.safe_load(open(sys.argv[1]))["expert-library"]',
    'keys=["packCenterDir","packCenterOrigin","knowledgeDir","packsDir","vendorPacksDir","enabledPacks","packPriority"]',
    'print(json.dumps({k:s[k] for k in keys if k in s}))'
  ].join('\n'),config.settingsPath],{encoding:'utf8'}))
  if(selected.packCenterOrigin!==config.origin||selected.packCenterDir!==config.packCenterDir)throw Error('PRODUCTION_TARGET_MISMATCH')
  if(!config.workspaces?.length)throw Error('WORKSPACES_REQUIRED_FOR_PREFLIGHT')
  // Relative packsDir is resolved from the DSH host, never the source checkout.
  process.chdir(config.dshHome ?? dirname(config.settingsPath))
  const home=config.dshHome ?? dirname(config.settingsPath)
  selected.vendorPacksDir ||= join(home,'vendor-packs')
  const registry=JSON.parse(await readFile(join(home,'storages/workspace.json'),'utf8'))
  const workspaces=Object.values(registry.tables.workspaces).map(x=>({path:x.path}))
  const ctx=new Context()
  ctx.provide('workspaceRegistry',{list:()=>workspaces})
  return createPackCenterHost(ctx,selected,()=>workspaces.map(x=>x.path))
}
