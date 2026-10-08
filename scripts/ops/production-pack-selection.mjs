import { readFile, writeFile, rename, unlink, stat, lstat, realpath, cp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { dirname, join, basename } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { hashContentDirectory } from '../../packages/pack-contract/index.mjs'

// Explicitly listed local aliases only. Keep the original source and symlink
// backup, verify copied bytes before replacing the alias with a regular dir.
export async function materializePackAliases(config) {
  for(const path of config.materializeAliases??[]){
    if(!(await lstat(path)).isSymbolicLink())continue
    const source=await realpath(path)
    if(dirname(source)!==await realpath(dirname(path)))throw Error('ALIAS_TARGET_OUTSIDE_PACK_DIRECTORY')
    const temp=join(dirname(path),`.${basename(path)}-materialize-${process.pid}`)
    const backup=join(dirname(path),`.${basename(path)}-alias-${Date.now()}`)
    const before=await hashContentDirectory(source)
    await cp(source,temp,{recursive:true,dereference:false,filter:p=>basename(p)!=='.git'})
    if((await hashContentDirectory(temp)).contentTreeSha256!==before.contentTreeSha256)throw Error('ALIAS_COPY_DIGEST_MISMATCH')
    if(await realpath(path)!==source||(await hashContentDirectory(source)).contentTreeSha256!==before.contentTreeSha256)throw Error('ALIAS_SOURCE_CHANGED')
    await rename(path,backup)
    try{await rename(temp,path)}catch(e){await rename(backup,path);throw e}
    console.log(JSON.stringify({stage:'local_alias_materialized',path,backup,contentTreeSha256:before.contentTreeSha256}))
  }
}

/** Explicit legacy selection, separate from center-managed activation. */
export async function syncProductionSelection(config) {
  if(!config.legacyEnabledPacks)return
  if(!config.legacyEnabledPacks.length||config.legacyEnabledPacks.includes(config.packId))throw Error('INVALID_LEGACY_SELECTION')
  const home=config.dshHome??dirname(config.settingsPath)
  const require=createRequire(join(home,'profiles/web/package.json'))
  const {parseDocument}=require('yaml')
  const source=await readFile(config.settingsPath,'utf8'), doc=parseDocument(source)
  if(doc.errors.length)throw Error('SETTINGS_YAML_INVALID')
  const before=doc.toJS(), expected=structuredClone(before)
  expected['expert-library'].enabledPacks=config.legacyEnabledPacks
  const marker=join(config.receiptDir,'runtime-restart-required.json')
  let pending=false
  try{await stat(marker);pending=true}catch(e){if(e.code!=='ENOENT')throw e}
  if(!isDeepStrictEqual(before,expected)){
    if(!config.runtimeService)throw Error('RUNTIME_SERVICE_REQUIRED')
    doc.get('expert-library').set('enabledPacks',config.legacyEnabledPacks)
    const output=doc.toString()
    if(!isDeepStrictEqual(parseDocument(output).toJS(),expected))throw Error('UNEXPECTED_SETTINGS_CHANGE')
    // Backup remains in the existing protected host configuration area.
    const backup=`${config.settingsPath}.before-pack-${config.version}-${Date.now()}`
    await writeFile(backup,source,{mode:0o600,flag:'wx'})
    await writeFile(marker,JSON.stringify({service:config.runtimeService,backup}),{mode:0o600})
    const temp=`${config.settingsPath}.${process.pid}.tmp`
    await writeFile(temp,output,{mode:0o600})
    if(await readFile(config.settingsPath,'utf8')!==source)throw Error('SETTINGS_CHANGED_CONCURRENTLY')
    await rename(temp,config.settingsPath)
    pending=true
    console.log('Updated explicit legacy selection; preserved other settings')
  }
  if(pending){
    if(!/^[-a-zA-Z0-9_.]+\.service$/.test(config.runtimeService??''))throw Error('INVALID_RUNTIME_SERVICE')
    execFileSync('systemctl',['restart',config.runtimeService],{stdio:'ignore',timeout:60000})
    execFileSync('systemctl',['is-active','--quiet',config.runtimeService],{timeout:10000})
    if(config.healthUrl){
      const deadline=Date.now()+120000;let ready=false
      while(Date.now()<deadline){
        try{const r=await fetch(config.healthUrl,{redirect:'manual',signal:AbortSignal.timeout(5000)});if([200,302,303,401].includes(r.status)){ready=true;break}}catch{}
        await new Promise(r=>setTimeout(r,1000))
      }
      if(!ready)throw Error('PRODUCTION_HTTP_NOT_READY')
    }
    await unlink(marker)
    console.log('Production runtime restarted with selected legacy packs')
  }
}
