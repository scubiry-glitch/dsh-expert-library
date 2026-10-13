/** Package the generated Zhijian hand-drawn character art at UI resolution, preserving alpha.
 * Sources and prompts: output/imagegen/zhijian-experts/manifest.json.
 * Run only after all 14 imagegen originals are available. Requires rsvg-convert.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'output/imagegen/zhijian-experts')
const out = join(root, 'assets/expert-teams')
const names = ['team-lead','researcher','engineer','designer','qa-engineer','security-reviewer','data-analyst','docs-coordinator','action-working','action-thinking','action-reporting','action-celebrating','action-sleeping','action-sending']
for (const name of names) if (!existsSync(join(source, name+'.png'))) throw Error(`Missing generated source: ${name}`)
mkdirSync(out, {recursive:true})
function wrapper(bytes) { return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="256" height="256" viewBox="0 0 256 256"><image width="256" height="256" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/png;base64,${bytes.toString('base64')}"/></svg>` }
for (const name of names) {
 const scratch = join(out, '.'+name+'.source.svg')
 try {
  writeFileSync(scratch, wrapper(readFileSync(join(source,name+'.png'))))
  const size = name === 'team-lead' ? '512' : '256'
  execFileSync('rsvg-convert',['-w',size,'-h',size,'-o',join(out,name+'.png'),scratch])
  writeFileSync(join(out,name+'.svg'),wrapper(readFileSync(join(out,name+'.png'))))
 } finally { rmSync(scratch,{force:true}) }
}
// The standalone page uses embedded assets, so it works with a scoped token
// without requiring the browser's unrelated workspace login cookie.
const review = join(root,'assets/review/review.js')
let js = readFileSync(review,'utf8')
const start = js.indexOf('const crewArt = '), end = js.indexOf('\nfunction portrait',start)
if (start < 0 || end < 0) throw Error('Review artwork table not found')
const map = Object.fromEntries(names.map(name=>[name,'data:image/png;base64,'+readFileSync(join(out,name+'.png')).toString('base64')]))
writeFileSync(review, js.slice(0,start)+'const crewArt = '+JSON.stringify(map)+js.slice(end))
console.log(`Packaged ${names.length} Zhijian roles/actions and updated standalone review images`)
