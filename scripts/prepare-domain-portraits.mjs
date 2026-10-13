// Asset packaging only: retain generated originals and alpha, encode display sizes.
// SHARP_MODULE can point at an existing local Sharp installation.
import {readFile, writeFile, stat} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {EXPERT_PORTRAITS} from '../src/review-portraits.ts'
const {default:sharp} = await import(process.env.SHARP_MODULE || 'sharp')
const root = new URL('../assets/review/portraits/', import.meta.url)
const assets = []
for (const expert of EXPERT_PORTRAITS) {
  const id = `expert-${expert.expertId}`, source = `source/${id}.png`
  const path = new URL(source, root)
  try { await stat(path) } catch (error) { if (process.argv.includes('--partial')) continue; throw error }
  const original = await readFile(path), metadata = await sharp(original).metadata()
  const alpha = (await sharp(original).stats()).channels[3]
  if (!metadata.hasAlpha || !alpha || alpha.min !== 0 || alpha.max !== 255) throw Error(`${id}: missing transparent alpha`)
  // Face + shoulders, selected from consistent waist-up artwork; round masking belongs to CSS.
  const size = Math.round(metadata.width * .54)
  const crop = {left:Math.round(metadata.width * .23), top:0, width:size, height:size}
  const body = await sharp(original).resize(512,512,{fit:'contain',background:'#00000000'}).webp({quality:86,alphaQuality:100}).toBuffer()
  const avatar = await sharp(original).extract(crop).resize(192,192).webp({quality:86,alphaQuality:100}).toBuffer()
  await writeFile(new URL(`${id}.webp`,root),body)
  await writeFile(new URL(`${id}-avatar.webp`,root),avatar)
  assets.push({...expert,id,source,file:`${id}.webp`,avatar:`${id}-avatar.webp`,width:512,height:512,avatarSize:192,crop,bytes:body.length,avatarBytes:avatar.length,sha256:createHash('sha256').update(body).digest('hex'),sourceSha256:createHash('sha256').update(original).digest('hex')})
}
await writeFile(new URL('domain-manifest.json',root),JSON.stringify({version:1,generator:'built-in image_gen',prompts:'domain-prompts.json',style:'暖色手绘、纸张质感、透明背景；半身像与头像共用同一人物',assets},null,2)+'\n')
console.log(`Packaged ${assets.length} named portraits, ${assets.length} avatar crops; ${assets.reduce((sum,a)=>sum+a.bytes+a.avatarBytes,0)} display bytes`)
