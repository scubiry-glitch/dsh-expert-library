import { createHash } from 'node:crypto'
const object=(v:unknown): v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v)
const text=(v:unknown): v is string => typeof v==='string' && !!v.trim()
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
/** Return every deterministic field error so authors can repair one ledger in one pass. */
export function inspectV5Ledger(report:string, raw:string): {ledger?:Record<string,unknown>,errors:string[]} {
  let value:unknown
  try { value=JSON.parse(raw) } catch { return {errors:['invalid JSON']} }
  if(!object(value)) return {errors:['ledger must be an object']}
  const ledger=value
  const errors:string[]=[]
  if(ledger.schemaVersion!==2) errors.push('schemaVersion must be 2')
  if(ledger.reportSha256!==sha(report)) errors.push('exact reportSha256 required')
  if(!Array.isArray(ledger.sources)) errors.push('sources must be an array')
  if(!Array.isArray(ledger.claims)) errors.push('claims must be an array')
  if(!Array.isArray(ledger.unresolved)) errors.push('unresolved must be an array')
  if(!report.trim()) errors.push('nonempty report required')
  if(Array.isArray(ledger.claims)&&!ledger.claims.length) errors.push('actual core claims required')
  const sources=new Set<string>(),claims=new Set<string>()
  if(Array.isArray(ledger.sources)) for(const [i,entry] of ledger.sources.entries()) {
    const path=`sources[${i}]`
    if(!object(entry)) { errors.push(`${path} must be an object`);continue }
    if(!text(entry.id)) errors.push(`${path}.id required`)
    else if(sources.has(entry.id)) errors.push(`${path}.id must be unique`)
    else sources.add(entry.id)
    if(!text(entry.title)) errors.push(`${path}.title required`)
    if(!text(entry.accessedAt)||Number.isNaN(Date.parse(entry.accessedAt))) errors.push(`${path}.accessedAt must be a date string`)
    if(entry.kind==='provider_receipt') {
      if(!text(entry.provider)) errors.push(`${path}.provider required`)
      if(!object(entry.receipt)) errors.push(`${path}.receipt must be an object`)
      else for(const key of ['path','sha256','callPath','callSha256']) {
        const field=entry.receipt[key]
        if(!text(field)) errors.push(`${path}.receipt.${key} required`)
        else if((key==='sha256'||key==='callSha256')&&!/^[a-f0-9]{64}$/u.test(field)) errors.push(`${path}.receipt.${key} must be SHA-256`)
      }
    } else if(!text(entry.url)||!/^https?:\/\//u.test(entry.url)) errors.push(`${path}.url requires HTTP(S) URL or provider receipt`)
  }
  if(Array.isArray(ledger.claims)) for(const [i,entry] of ledger.claims.entries()) {
    const path=`claims[${i}]`
    if(!object(entry)) { errors.push(`${path} must be an object`);continue }
    if(!text(entry.id)) errors.push(`${path}.id required`)
    else if(claims.has(entry.id)) errors.push(`${path}.id must be unique`)
    else claims.add(entry.id)
    if(!text(entry.quote)||!report.includes(entry.quote)) errors.push(`${path}.quote must occur in report`)
    if(!['fact','inference','calculation'].includes(String(entry.kind))) errors.push(`${path}.kind must be fact, inference or calculation`)
    if(!Array.isArray(entry.sourceIds)||!entry.sourceIds.length) errors.push(`${path}.sourceIds must reference known sources`)
    else for(const [j,id] of entry.sourceIds.entries()) if(!text(id)||!sources.has(id)) errors.push(`${path}.sourceIds[${j}] must reference a known source`)
    if(entry.numeric===true) for(const key of ['unit','period','caliber']) {
      const field=entry[key]
      if(!text(field)||/^(unknown|未知|待确认)$/iu.test(field)) errors.push(`${path}.${key}: numeric claims require confirmed unit, period and caliber`)
    }
    if(entry.kind==='calculation'&&!text(entry.calculation)) errors.push(`${path}.calculation must be one nonempty string describing actual inputs, formula and result (example: "输入 A=2、B=3；公式 A+B；结果 5")`)
  }
  return errors.length?{errors}:{ledger,errors}
}

export function checkV5Ledger(report:string, raw:string): Record<string,unknown> {
  const result=inspectV5Ledger(report,raw)
  if(result.errors.length) throw new Error(`V5_SOURCE_LEDGER: ${result.errors.join('; ')}; retryable=true; repairBudgetCharged=false`)
  return result.ledger!
}

/** Freeze the figure argument after the actual chapters and evidence ledger are known. */
export function checkV5FigurePlan(report:string, raw:string, ledger:Record<string,unknown>): Record<string,unknown> {
  const fail=(s:string):never=>{throw new Error(`V5_FIGURE_PLAN: ${s}; retryable=true; repairBudgetCharged=false`)}
  let v:unknown;try{v=JSON.parse(raw)}catch{fail('invalid JSON')}
  if(!object(v)||v.schemaVersion!==1||v.reportSha256!==sha(report)||!Array.isArray(v.chapters)) return fail('schemaVersion=1, exact reportSha256 and chapters required')
  const matches=[...report.matchAll(/^##\s+(.+?)\s*$/gmu)]
  const chapters=matches.map((m,i)=>({title:m[1]!.trim(),body:report.slice(m.index!+m[0].length,matches[i+1]?.index??report.length)}))
    .filter(c=>!/^附(?:件|录)(?:[:：]|$)/u.test(c.title))
  if(!chapters.length||chapters.some(c=>!c.title)||new Set(chapters.map(c=>c.title)).size!==chapters.length) fail('unique analytical H2 chapters required')
  if(v.chapters.length!==chapters.length) fail('exactly one plan row per actual analytical chapter required')
  const claims=new Map((ledger.claims as Record<string,unknown>[]).map(c=>[c.id,c]))
  for(let i=0;i<chapters.length;i++){
    const row=v.chapters[i],chapter=chapters[i]!
    if(!object(row)||row.chapter!==chapter.title||!['claim','relation','encoding','decision','sourceQuote'].every(k=>text(row[k]))) fail(`chapter ${i+1}: title and figure argument required in report order`)
    if(!chapter.body.includes(row.sourceQuote as string)) fail(`chapter ${i+1}: sourceQuote must occur in its own chapter`)
    const sourceClaimIds=row.sourceClaimIds as unknown
    if(!Array.isArray(sourceClaimIds)||!sourceClaimIds.length||sourceClaimIds.some((id:unknown)=>!text(id)||!claims.has(id as string))) fail(`chapter ${i+1}: sourceClaimIds must bind known ledger claims`)
    if(!(sourceClaimIds as unknown[]).some((id:unknown)=>claims.get(id as string)?.quote===row.sourceQuote)) fail(`chapter ${i+1}: sourceQuote must bind one listed claim`)
    if(row.supportQuotes!==undefined&&(!Array.isArray(row.supportQuotes)||row.supportQuotes.some((q:unknown)=>!text(q)||!report.includes(q as string)))) fail(`chapter ${i+1}: supportQuotes must quote approved report`)
  }
  return v
}

/** Host compares the released chapter argument to the renderer's actual figure ledger. */
export function checkV5FigureImplementation(planRaw:string,craftRaw:string):void {
  const fail=(s:string):never=>{throw new Error(`V5_FIGURE_IMPLEMENTATION: ${s}; retryable=true; repairBudgetCharged=false`)}
  let plan:unknown,craft:unknown
  try{plan=JSON.parse(planRaw);craft=JSON.parse(craftRaw)}catch{fail('invalid JSON')}
  if(!object(plan)||!object(craft)||craft.figurePlanSha256!==sha(planRaw)||!Array.isArray(plan.chapters)||!Array.isArray(craft.figures)) fail('exact frozen figure plan hash and figure ledger required')
  const planned=(plan as Record<string,unknown>).chapters as Record<string,unknown>[]
  const figures=(craft as Record<string,unknown>).figures as unknown[]
  for(const row of planned){
    const candidates=figures.filter(f=>object(f)&&f.chapter===row.chapter&&f.claim===row.claim&&f.relation===row.relation&&f.sourceQuote===row.sourceQuote)
    if(!candidates.length) fail(`missing planned figure argument in ${String(row.chapter)}`)
    if(!candidates.some(f=>object(f)&&(f.encoding===row.encoding||text(f.planChangeReason)))) fail(`changed encoding in ${String(row.chapter)} needs a reason`)
  }
}
