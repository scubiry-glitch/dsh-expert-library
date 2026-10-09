// Overwrite-style upgrade: same packId → switch the ACTIVE version to the new
// release (update_enable). The old release stays in cache only as a rollback
// anchor; the effective version is replaced, which is the visible "覆盖升级".
import { createPackCenterManager } from '../../lib/host/pack-center-manager.js';
import { preflightManagedActivation } from '../../lib/host/pack-runtime.js';
import { builtinLegacyPack } from '../../lib/v2/compat.js';
import { buildZhijianDomainPack } from '../../lib/v2/zhijian-pack.js';
import { buildCollabDomainPack } from '../../lib/collab/templates.js';
import { resolveLibrary } from '../../lib/expert-library/registry.js';
import { readFile } from 'node:fs/promises';

const ROOT = '/root/zhijian/zhijianharness-main/pack-center';
const WORKSPACES = ['/root/zhijian', '/root/zhijian/dsh-expert-library', '/root/zhijian/dsh-pack-center-dev.ZGtty5'];
const config = { packsDir: 'domain-packs', knowledgeDir: 'knowledge' };
const ctx = { logger: { warn: (m) => console.error('[warn]', m) } };

const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
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
  // Same preflight the live plugin uses: validate the merged runtime before commit.
  validateActivation: async (state) => {
    const selection = { packsDir: config.packsDir };
    try {
      await preflightManagedActivation(ctx, selection, await bases(), state);
    } catch (error) {
      throw new (await import('../../lib/host/pack-center-client.js')).PackCenterClientError(
        (await import('../../lib/host/pack-center-operations.js')).sanitizePackOperationError(error));
    }
  },
});
await svc.start();
const cat = await svc.catalog({});
const item = cat.items.find(i => i.packId === 'macro-capital-analyst');
if (!item) { console.log('not in catalog'); process.exit(1); }
const inst = await svc.installations();
const current = inst.items.find(e => e.packId === 'macro-capital-analyst');
const generation = inst.generation;
console.log('local current:', current?.current?.version ?? 'none', '| target:', item.version, '| generation:', generation);

let op;
if (current?.current) {
  console.log('same-name found → overwrite-upgrade (update_enable)');
  op = await svc.enqueue({ operationKey: `zhijian-upgrade-macro-${Date.now()}`,
    kind: 'update_enable', expectedGeneration: generation, releaseId: item.releaseId,
    connectionRevision: (await svc.connection()).revision,
    target: { manifestSha256: item.manifestSha256, artifactSha256: item.artifactSha256, contentTreeSha256: item.contentTreeSha256 } });
} else {
  console.log('no local version → install');
  const r = await svc.enqueue({ operationKey: `zhijian-install-macro-${Date.now()}`,
    kind: 'install', expectedGeneration: generation, releaseId: item.releaseId,
    connectionRevision: (await svc.connection()).revision,
    target: { manifestSha256: item.manifestSha256, artifactSha256: item.artifactSha256, contentTreeSha256: item.contentTreeSha256 } });
  await waitOp(svc, r.operationId);
  const g2 = (await svc.installations()).generation;
  console.log('install done, generation →', g2, '→ enable (覆盖式激活)');
  op = await svc.enqueue({ operationKey: `zhijian-enable-macro-${Date.now()}`,
    kind: 'enable', expectedGeneration: g2, releaseId: item.releaseId });
}
await waitOp(svc, op.operationId);
const fin = await svc.installations();
console.log('--- final (generation', fin.generation, ') ---');
for (const e of fin.items) console.log(' ', e.packId, e.current?.version, 'active:', e.active);
await svc.close();

async function waitOp(svc, id) {
  for (let i = 0; i < 90; i++) {
    const cur = await svc.operation(id);
    if (cur.status === 'succeeded') { console.log('succeeded:', JSON.stringify(cur.output ?? {})); return; }
    if (cur.status === 'failed' || cur.status === 'interrupted') {
      console.log(cur.status + ':', JSON.stringify(cur.output ?? {}).slice(0, 600)); process.exit(1);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('timeout'); process.exit(1);
}
