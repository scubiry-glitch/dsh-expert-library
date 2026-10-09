import { createPackCenterManager } from '../../lib/host/pack-center-manager.js';
import { builtinLegacyPack } from '../../lib/v2/compat.js';
import { buildZhijianDomainPack } from '../../lib/v2/zhijian-pack.js';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const bases = [builtinLegacyPack(), buildZhijianDomainPack()];
const builtinVersions = {};
for (const base of bases) builtinVersions[base.pack.id] = base.pack.version;

const svc = createPackCenterManager({
  root: '/root/zhijian/zhijianharness-main/pack-center',
  origin: 'https://packs.meizu.life',
  capabilities: { pluginVersion: pkg.version, packSchemaVersions: [2] },
  builtinVersions,
});
await svc.start();
const cat = await svc.catalog({});
const item = cat.items.find(i => i.packId === 'macro-capital-analyst');
const generation = (await svc.installations()).generation;
console.log('generation:', generation, 'release:', item.releaseId, item.version);
const op = await svc.enqueue({
  operationKey: `zhijian-enable-macro-${Date.now()}`,
  kind: 'enable', expectedGeneration: generation, releaseId: item.releaseId,
});
for (let i = 0; i < 60; i++) {
  const cur = await svc.operation(op.operationId);
  if (cur.status === 'succeeded') { console.log('enabled:', JSON.stringify(cur.output)); break; }
  if (cur.status === 'failed' || cur.status === 'interrupted') { console.log(cur.status, JSON.stringify(cur.output ?? {}).slice(0, 600)); break; }
  await new Promise(r => setTimeout(r, 1000));
}
const inst = await svc.installations();
console.log('installations generation', inst.generation);
for (const e of inst.items) console.log(' ', e.packId, e.current?.version, 'active:', e.active);
await svc.close();
