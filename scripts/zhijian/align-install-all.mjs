// Align 版本管理 with 校验: install+enable (overwrite semantics) every pack the
// center publishes that the host actually uses. Same-id existing → update_enable
// + uninstall superseded; new → install → enable. Dependency order respected.
import { createPackCenterManager } from '../../lib/host/pack-center-manager.js';
import { preflightManagedActivation } from '../../lib/host/pack-runtime.js';
import { builtinLegacyPack } from '../../lib/v2/compat.js';
import { buildZhijianDomainPack } from '../../lib/v2/zhijian-pack.js';
import { buildCollabDomainPack } from '../../lib/collab/templates.js';
import { resolveLibrary } from '../../lib/expert-library/registry.js';
import { readFile } from 'node:fs/promises';

const ROOT = '/root/zhijian/zhijianharness-main/pack-center';
const WORKSPACES = ['/root/zhijian', '/root/zhijian/dsh-expert-library', '/root/zhijian/dsh-pack-center-dev.ZGtty5'];
const ORDER = ['zhijian-realestate', 'bank-finance', 'pipeline-general', 'pipeline-domains', 'beike', 'zhijian-residential-advisory'];
const ctx = { logger: { warn: (m) => console.error('[warn]', m) } };
const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const config = { packsDir: 'domain-packs', knowledgeDir: 'knowledge' };
async function bases() {
  const out = [builtinLegacyPack(), buildZhijianDomainPack()];
  for (const path of WORKSPACES)
    out.push(buildCollabDomainPack([...(await resolveLibrary(ctx, path, config.knowledgeDir)).experts.values()]));
  return out;
}
const builtinVersions = {};
for (const base of await bases()) builtinVersions[base.pack.id] = base.pack.version;

const svc = createPackCenterManager({
  root: ROOT, origin: 'https://packs.meizu.life',
  capabilities: { pluginVersion: pkg.version, packSchemaVersions: [2] },
  builtinVersions,
  validateActivation: async (state) => {
    try { await preflightManagedActivation(ctx, { packsDir: config.packsDir }, await bases(), state); }
    catch (error) {
      throw new (await import('../../lib/host/pack-center-client.js')).PackCenterClientError(
        (await import('../../lib/host/pack-center-operations.js')).sanitizePackOperationError(error));
    }
  },
});
await svc.start();
const cat = await svc.catalog({});
const byId = new Map();
for (const item of cat.items) {
  const prev = byId.get(item.packId);
  if (prev === undefined || item.version.localeCompare(prev.version, 'en', { numeric: true }) > 0) byId.set(item.packId, item);
}
async function gen() { return (await svc.installations()).generation; }
async function waitOp(id, label) {
  for (let i = 0; i < 120; i++) {
    const cur = await svc.operation(id);
    if (cur.status === 'succeeded') { console.log(`  [${label}] succeeded`); return true; }
    if (cur.status === 'failed' || cur.status === 'interrupted') {
      console.log(`  [${label}] ${cur.status}: ${JSON.stringify(cur.output ?? {}).slice(0, 400)}`); return false;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`  [${label}] timeout`); return false;
}
const target = (item) => ({ manifestSha256: item.manifestSha256, artifactSha256: item.artifactSha256, contentTreeSha256: item.contentTreeSha256 });

let ok = 0, fail = 0;
for (const packId of ORDER) {
  const item = byId.get(packId);
  if (!item) { console.log(`[${packId}] not in catalog, skip`); continue; }
  const inst = await svc.installations();
  const current = inst.items.find(e => e.packId === packId && e.active);
  console.log(`[${packId}] local active: ${current?.version ?? 'none'} → center latest: ${item.version}`);
  if (current?.version === item.version) { console.log('  already aligned'); ok++; continue; }
  if (current) {
    const op = await svc.enqueue({ operationKey: `align-upg-${packId}-${Date.now()}`,
      kind: 'update_enable', expectedGeneration: await gen(), releaseId: item.releaseId,
      connectionRevision: (await svc.connection()).revision, target: target(item) });
    (await waitOp(op.operationId, 'update_enable')) ? ok++ : fail++;
  } else {
    const op = await svc.enqueue({ operationKey: `align-ins-${packId}-${Date.now()}`,
      kind: 'install', expectedGeneration: await gen(), releaseId: item.releaseId,
      connectionRevision: (await svc.connection()).revision, target: target(item) });
    if (!await waitOp(op.operationId, 'install')) { fail++; continue; }
    const en = await svc.enqueue({ operationKey: `align-en-${packId}-${Date.now()}`,
      kind: 'enable', expectedGeneration: await gen(), releaseId: item.releaseId });
    (await waitOp(en.operationId, 'enable')) ? ok++ : fail++;
  }
}
const fin = await svc.installations();
console.log(`--- aligned installed (generation ${fin.generation}) ---`);
for (const e of fin.items) console.log(' ', e.packId, e.version, e.active ? 'ACTIVE' : '(inactive)');
console.log(`done ok=${ok} fail=${fail}`);
await svc.close();
