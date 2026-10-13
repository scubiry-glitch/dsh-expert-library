import { isRegisteredPortrait } from './review-portraits.ts'
/** Optional presentation only. Never grants permissions or changes execution gates. */
export const REVIEW_PORTRAITS = ['coordinator','finance','policy','market','engineer','reviewer'] as const
export interface ReviewUi {
  version: 1
  labels?: Partial<Record<'plan'|'outline'|'activity'|'results',string>>
  experts?: Record<string,{ label?: string; role?: string; portrait?: string; fallback?: typeof REVIEW_PORTRAITS[number] }>
  outlineTasks?: string[]
  artifacts?: { key:string; label:string; kind:'final'|'key'; fromTasks:string[]; names?:string[]; confirmTasks?:string[] }[]
}
const object = (x:unknown): x is Record<string,unknown> => !!x && typeof x==='object' && !Array.isArray(x)
const short = (x:unknown): x is string => typeof x==='string' && x.trim().length>0 && x.length<=160
const ids = (x:unknown): x is string[] => Array.isArray(x) && x.length<=200 && x.every(short)
export function safePortrait(x:unknown): x is string {
  return typeof x==='string' && ((x.startsWith('asset:') && isRegisteredPortrait(x.slice(6)))
    || (x.length<=350000 && /^data:image\/(?:png|webp|jpeg);base64,[A-Za-z0-9+/]+=*$/u.test(x)))
}
export function normalizeReviewUi(raw:unknown): { value?:ReviewUi; issues:string[] } {
  const issues:string[]=[]
  if(raw===undefined)return {issues}
  if(!object(raw)||raw.version!==1)return {issues:['Unsupported reviewUi; using default presentation']}
  const value:ReviewUi={version:1}
  if(object(raw.labels))for(const key of ['plan','outline','activity','results'] as const){const label=raw.labels[key];if(short(label))(value.labels??={})[key]=label;else if(label!==undefined)issues.push(`Invalid label ${key}`)}
  if(object(raw.experts))for(const [id,entry] of Object.entries(raw.experts).slice(0,200)){
    if(!short(id)||['__proto__','constructor','prototype'].includes(id)||!object(entry)){issues.push('Invalid expert presentation');continue}
    const expert:NonNullable<ReviewUi['experts']>[string]={}
    for(const key of ['label','role'] as const)if(short(entry[key]))expert[key]=entry[key]
    if(safePortrait(entry.portrait))expert.portrait=entry.portrait
    else if(entry.portrait!==undefined)issues.push(`Invalid portrait ${id}; using shared artwork`)
    if(REVIEW_PORTRAITS.includes(entry.fallback as typeof REVIEW_PORTRAITS[number]))expert.fallback=entry.fallback as typeof REVIEW_PORTRAITS[number]
    ;(value.experts??=Object.create(null))[id]=expert
  }
  if(ids(raw.outlineTasks))value.outlineTasks=raw.outlineTasks
  if(Array.isArray(raw.artifacts))for(const item of raw.artifacts.slice(0,80)){
    if(!object(item)||!short(item.key)||!short(item.label)||!['final','key'].includes(String(item.kind))||!ids(item.fromTasks)||!item.fromTasks.length
      ||(item.names!==undefined&&(!ids(item.names)||item.names.some(n=>/[\\/]/u.test(n))))||(item.confirmTasks!==undefined&&!ids(item.confirmTasks))){issues.push('Invalid artifact presentation; using declared deliverables');continue}
    if(value.artifacts?.some(a=>a.key===item.key)){issues.push(`Duplicate artifact key ${item.key}`);continue}
    ;(value.artifacts??=[]).push({key:item.key,label:item.label,kind:item.kind as 'final'|'key',fromTasks:item.fromTasks,...(item.names?{names:item.names as string[]}:{}),...(item.confirmTasks?{confirmTasks:item.confirmTasks as string[]}:{})})
  }
  return {value,issues}
}
export function mergeReviewUi(...raw:unknown[]):ReviewUi|undefined {
  let result:ReviewUi|undefined
  for(const entry of raw){const {value}=normalizeReviewUi(entry);if(!value)continue;const experts={...result?.experts};for(const [key,expert] of Object.entries(value.experts??{}))experts[key]={...experts[key],...expert};result={...result,...value,labels:{...result?.labels,...value.labels},experts}}
  return result
}
