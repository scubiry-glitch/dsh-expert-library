/**
 * Install + enable every compatible center release into the local pack store,
 * using the same bases/preflight the live plugin uses. Safe to re-run: failed
 * operations can be retried by deleting state.json operations via the UI.
 */
import { createPackCenterManager } from '../../lib/host/pack-center-manager.js';
import { builtinLegacyPack } from '../../lib/v2/compat.js';
import { buildZhijianDomainPack } from '../../lib/v2/zhijian-pack.js';
import { buildCollabDomainPack } from '../../lib/collab/templates.js';
import { resolveLibrary } from '../../lib/expert-library/registry.js';
import { readFile } from 'node:fs/promises';

const ROOT = '/root/zhijian/zhijianharness-main/pack-center';
const WORKSPACES = ['/root/zhijian', '/root/zhijian/dsh-expert-library', '/root/zhijian/dsh-pack-center-dev.ZGtty5'];
// Dependency order (roots first).
const ORDER = ['macro-capital-analyst'];

const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const knowledgeDir = 'knowledge';
const ctx = { logger: { warn: (msg) => console.error('[warn]', msg) } };
const bases = [builtinLegacyPack(), buildZhijianDomainPack()];
for (const path of WORKSPACES) {
    bases.push(buildCollabDomainPack([...(await resolveLibrary(ctx, path, knowledgeDir)).experts.values()]));
}
const builtinVersions = {};
for (const base of bases) builtinVersions[base.pack.id] = base.pack.version;
console.log('builtinVersions:', builtinVersions);

const svc = createPackCenterManager({
    root: ROOT,
    origin: 'https://packs.meizu.life',
    capabilities: { pluginVersion: pkg.version, packSchemaVersions: [2] },
    builtinVersions,
});
await svc.start();
const conn = await svc.connection();
const cat = await svc.catalog({});
const byId = new Map(cat.items.map(item => [item.packId, item]));
let generation = (await svc.installations()).generation;

async function run(request, label) {
    const op = await svc.enqueue(request);
    console.log(`[${label}] queued ${op.operationId} (${op.status})`);
    for (let i = 0; i < 120; i++) {
        const current = await svc.operation(op.operationId);
        if (current.status === 'succeeded') {
            if (current.output?.result) generation = current.output.result.generation;
            console.log(`[${label}] succeeded:`, JSON.stringify(current.output?.result ?? {}));
            return true;
        }
        if (current.status === 'failed' || current.status === 'interrupted') {
            console.log(`[${label}] ${current.status}:`, JSON.stringify(current.output ?? current).slice(0, 500));
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log(`[${label}] timeout`);
    return false;
}

let ok = 0, skipped = 0, failed = 0;
for (const packId of ORDER) {
    const item = byId.get(packId);
    if (item === undefined) { console.log(`[${packId}] not in catalog — skip`); skipped++; continue; }
    if (!item.compatibility?.compatible) { console.log(`[${packId}] incompatible:`, item.compatibility?.reasons); skipped++; continue; }
    const releaseId = item.releaseId;
    const target = { manifestSha256: item.manifestSha256, artifactSha256: item.artifactSha256, contentTreeSha256: item.contentTreeSha256 };
    const installed = await run({
        operationKey: `zhijian-install-${packId}-${item.version}-${Date.now()}`,
        kind: 'install', expectedGeneration: generation,
        releaseId, connectionRevision: conn.revision, target,
    }, `${packId} install`);
    if (!installed) { failed++; continue; }
    const enabled = await run({
        operationKey: `zhijian-enable-${packId}-${item.version}-${Date.now()}`,
        kind: 'enable', expectedGeneration: generation, releaseId,
    }, `${packId} enable`);
    enabled ? ok++ : failed++;
}

const inst = await svc.installations();
console.log('--- final installations (generation', inst.generation, ') ---');
for (const entry of inst.items) console.log(' ', entry.packId, entry.current?.version, 'active:', entry.active);
console.log(`done: enabled=${ok} failed=${failed} skipped=${skipped}`);
await svc.close();
