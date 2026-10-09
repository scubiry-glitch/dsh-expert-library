import { createPackCenterManager } from '../../lib/host/pack-center-manager.js';
import { preflightManagedActivation } from '../../lib/host/pack-runtime.js';
import { builtinLegacyPack } from '../../lib/v2/compat.js';
import { buildZhijianDomainPack } from '../../lib/v2/zhijian-pack.js';
import { buildCollabDomainPack } from '../../lib/collab/templates.js';
import { resolveLibrary } from '../../lib/expert-library/registry.js';
import { readFile } from 'node:fs/promises';

const ROOT = '/root/zhijian/zhijianharness-main/pack-center';
const WORKSPACES = ['/root/zhijian', '/root/zhijian/dsh-expert-library', '/root/zhijian/dsh-pack-center-dev.ZGtty5'];
const ctx = { logger: { warn: (m) => console.error('[warn]', m) } };
const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
async function bases() {
  const out = [builtinLegacyPack(), buildZhijianDomainPack()];
  for (const path of WORKSPACES)
    out.push(buildCollabDomainPack([...(await resolveLibrary(ctx, path, config.knowledgeDir)).experts.values()]));
  return out;
}
const config = { packsDir: 'domain-packs', knowledgeDir: 'knowledge' };
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
const latest = cat.items.filter(i => i.packId === 'macro-capital-analyst')
  .sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }))[0];
console.log('latest release:', latest.version, latest.releaseId.slice(0, 8));

async function waitOp(id) {
  for (let i = 0; i < 90; i++) {
    const cur = await svc.operation(id);
    if (cur.status === 'succeeded') { console.log('  succeeded:', JSON.stringify(cur.output ?? {})); return cur; }
    if (cur.status === 'failed' || cur.status === 'interrupted') {
      console.log('  ' + cur.status + ':', JSON.stringify(cur.output ?? {}).slice(0, 600)); return cur;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}
async function gen() { return (await svc.installations()).generation; }

// 1) switch active pointer to the newest release = overwrite-upgrade
let op = await svc.enqueue({ operationKey: `zhijian-upgrade-macro-${Date.now()}`,
  kind: 'update_enable', expectedGeneration: await gen(), releaseId: latest.releaseId,
  connectionRevision: (await svc.connection()).revision,
  target: { manifestSha256: latest.manifestSha256, artifactSha256: latest.artifactSha256, contentTreeSha256: latest.contentTreeSha256 } });
console.log('update_enable →', latest.version); await waitOp(op.operationId);

// 2) uninstall the superseded release(s) — true overwrite, only one version remains
const inst = await svc.installations();
for (const e of inst.items) {
  if (e.packId !== 'macro-capital-analyst') continue;
  const rid = e.releaseId ?? e.current?.releaseId;
  if (rid && rid !== latest.releaseId) {
    console.log('uninstall superseded', (e.current?.version ?? '?'), rid.slice(0, 8));
    const u = await svc.enqueue({ operationKey: `zhijian-uninstall-macro-old-${rid.slice(0, 8)}-${Date.now()}`,
      kind: 'uninstall', expectedGeneration: await gen(), releaseId: rid });
    await waitOp(u.operationId);
  }
}
const fin = await svc.installations();
console.log('--- final (generation', fin.generation, ') ---');
console.log(JSON.stringify(fin.items, null, 1).slice(0, 1200));
await svc.close();
