/**
 * Generate the whale mascot role/action artwork shipped with the expert
 * library. The host half serves these from /plugins/dsh-expert-library/assets
 * (allowlisted in src/index.ts); the client references them via artwork.ts.
 *
 * Each image is a flat, friendly side-facing whale on a role-colored tile.
 * The avatar tiles are cropped to a circle by the client CSS, so the tile is
 * drawn full-bleed. Regenerating is idempotent: run `node scripts/generate-artwork.mjs`.
 *
 * Requires `rsvg-convert` on PATH (svg → png).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'assets', 'expert-teams')
mkdirSync(OUT, { recursive: true })

/** Role color map: id → tile color + subtle light tint for the gradient. */
const ROLES = {
  'team-lead':          { base: '#3B5BDB', light: '#5C7CFA' },
  'researcher':         { base: '#0CA678', light: '#38D9A9' },
  'engineer':           { base: '#5F3DC4', light: '#845EF7' },
  'designer':           { base: '#E64980', light: '#F783AC' },
  'qa-engineer':        { base: '#F76707', light: '#FF922B' },
  'security-reviewer':  { base: '#E03131', light: '#FF6B6B' },
  'data-analyst':       { base: '#1098AD', light: '#3BC9DB' },
  'docs-coordinator':   { base: '#2F9E44', light: '#51CF66' },
  'action-working':     { base: '#1C7ED6', light: '#4DABF7' },
  'action-thinking':    { base: '#7048E8', light: '#9775FA' },
  'action-reporting':   { base: '#66A80F', light: '#94D82D' },
  'action-celebrating': { base: '#F59F00', light: '#FFD43B' },
  'action-sleeping':    { base: '#868E96', light: '#ADB5BD' },
  'action-sending':     { base: '#AE3EC9', light: '#DA77F2' },
}

/** Distinct idle glyphs per action so the states read at a glance. */
const ACTION_MARK = {
  'action-working': '<g stroke="#ffffff" stroke-width="7" stroke-linecap="round" fill="none"><path d="M160 150 l14 0"/><path d="M167 143 l0 14"/></g>',
  'action-thinking': '<g fill="#ffffff"><circle cx="168" cy="138" r="6"/><circle cx="182" cy="132" r="4.5"/><circle cx="193" cy="123" r="3"/></g>',
  'action-reporting': '<g stroke="#ffffff" stroke-width="7" stroke-linecap="round" fill="none"><path d="M168 132 v20 M164 140 h20 M172 132 v28"/></g>',
  'action-celebrating': '<g fill="#ffffff"><path d="M158 142 q-10 -16 -2 -20 q4 -2 6 2 q8 -12 14 -6 q-4 12 -14 22 q-2 4 -4 2 Z"/></g>',
  'action-sleeping': '<g fill="#ffffff"><text x="196" y="146" font-family="Arial, sans-serif" font-size="34" font-weight="bold">Z</text></g>',
  'action-sending': '<g fill="#ffffff"><path d="M180 130 l30 12 -30 12 z"/><path d="M150 142 l20 8 -20 8 z"/></g>',
}

function whaleSvg(color, actionMark = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color.light}"/>
      <stop offset="1" stop-color="${color.base}"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" fill="url(#bg)"/>
  <g opacity="0.18" fill="#ffffff">
    <circle cx="210" cy="52" r="46"/>
    <circle cx="30" cy="210" r="34"/>
  </g>
  <!-- water spout -->
  <g stroke="#ffffff" stroke-width="8" stroke-linecap="round" fill="none" opacity="0.92">
    <path d="M108 60 Q104 44 108 28"/>
    <path d="M122 58 Q127 40 132 24"/>
    <path d="M92 66 Q88 52 84 40"/>
  </g>
  <!-- tail -->
  <path d="M166 128 Q206 96 218 108 Q207 128 218 148 Q206 160 166 128 Z" fill="#ffffff"/>
  <!-- body -->
  <path d="M58 128 Q58 86 100 78 Q146 68 178 86 Q206 100 206 128 Q206 156 178 172 Q146 190 100 180 Q58 172 58 128 Z" fill="#ffffff"/>
  <!-- belly -->
  <path d="M78 148 Q104 174 156 174 Q182 174 194 158 Q182 184 142 186 Q98 188 78 148 Z" fill="#e7ebf0"/>
  <!-- eye -->
  <circle cx="94" cy="120" r="6.5" fill="#1f2733"/>
  <!-- smile -->
  <path d="M86 144 Q100 154 118 152" stroke="#1f2733" stroke-width="5" stroke-linecap="round" fill="none"/>
  ${actionMark}
</svg>`
}

let count = 0
for (const [id, color] of Object.entries(ROLES)) {
  const mark = ACTION_MARK[id] ?? ''
  const svg = whaleSvg(color, mark)
  const svgPath = join(OUT, `${id}.svg`)
  const pngPath = join(OUT, `${id}.png`)
  writeFileSync(svgPath, svg)
  execFileSync('rsvg-convert', ['-w', '256', '-h', '256', '-o', pngPath, svgPath])
  count += 1
}

console.log(`Generated ${count} whale artwork PNGs into ${OUT}`)
