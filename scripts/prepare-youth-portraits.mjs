// Additive packaging; never touches pre-existing character files.
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {PORTRAIT_POSES} from '../src/review-portraits.ts'
const {default:sharp}=await import(process.env.SHARP_MODULE||'sharp')
const root=new URL('../assets/review/portraits/',import.meta.url),assets=[]
for(const pose of PORTRAIT_POSES){
 const source=`source/${pose.id}.png`,original=await readFile(new URL(source,root)),meta=await sharp(original).metadata()
 const alpha=(await sharp(original).stats()).channels[3]
 if(!meta.hasAlpha||!alpha||alpha.min!==0||alpha.max!==255)throw Error(`${pose.id}: transparent alpha required`)
 const size=Math.round(meta.width*.54),crop={left:Math.round(meta.width*.23),top:0,width:size,height:size}
 const body=await sharp(original).resize(512,512,{fit:'contain',background:'#00000000'}).webp({quality:86,alphaQuality:100}).toBuffer()
 const avatar=await sharp(original).extract(crop).resize(192,192).webp({quality:86,alphaQuality:100}).toBuffer()
 const file=`${pose.id}.webp`,avatarFile=`${pose.id}-avatar.webp`
 await writeFile(new URL(file,root),body);await writeFile(new URL(avatarFile,root),avatar)
 assets.push({...pose,source,file,avatar:avatarFile,width:512,height:512,avatarSize:192,crop,bytes:body.length,avatarBytes:avatar.length,sha256:createHash('sha256').update(body).digest('hex')})
}
await writeFile(new URL('youth-poses-manifest.json',root),JSON.stringify({version:1,generator:'built-in image_gen',prompts:'youth-poses-prompts.json',assets},null,2)+'\n')
console.log(`Added ${assets.length} characters and ${assets.length} avatar crops; ${assets.reduce((s,a)=>s+a.bytes+a.avatarBytes,0)} bytes`)
