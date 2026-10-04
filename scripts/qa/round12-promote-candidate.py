#!/usr/bin/env python3
"""Promote only backed-up/plugin paths. Default plans; --apply needs qualification.

No service actions, dependency install, session creation, domain-center mutation,
or real overlay changes. Persist a journal before writes; ambiguous/interrupted
attempts require explicit inspection, never automatic replay.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile

ROOTS = ('src', 'lib', 'packages', 'scripts', 'test', 'assets',
         'domain-packs/builtin-library', 'domain-packs/zhijian-realestate',
         'knowledge/skills/zhijian-report-craft', 'knowledge/skills/zhijian-designer-render')
MISSING_R11 = ['domain-packs/zhijian-realestate/skill-packages/zhijian-designer-render.json',
               'domain-packs/zhijian-realestate/skill-packages/zhijian-report-craft.json']


def need(condition, code):
    if not condition: raise RuntimeError(code)


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def load(path): return json.loads(path.read_text())


def replace(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.round12-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def save(path, value): replace(path, (json.dumps(value, ensure_ascii=False, indent=2)+'\n').encode())


def checked_path(root, name):
    parts = Path(name).parts
    need(isinstance(name, str) and parts and not Path(name).is_absolute()
         and '..' not in parts and '\\' not in name, 'PROMOTION_PATH_INVALID')
    target = root
    for part in parts:
        target /= part
        need(not target.is_symlink(), 'PROMOTION_PATH_ALIAS')
    return target


def build_plan(candidate, evidence):
    receipt = load(evidence / 'backup.json')
    backup = Path(receipt['backup'])
    need(receipt.get('status') == 'VERIFIED' and receipt.get('candidate') == str(candidate), 'BACKUP_CANDIDATE_MISMATCH')
    need(sha(backup / 'manifest.json') == receipt['manifestSha256'], 'BACKUP_MANIFEST_CHANGED')
    manifest = load(backup / 'manifest.json')
    need(manifest.get('status') == 'VERIFIED', 'BACKUP_NOT_VERIFIED')
    target = Path(manifest['sourceRoot']).resolve()
    need(target != candidate and not target.is_relative_to(candidate) and not candidate.is_relative_to(target), 'PROMOTION_ROOT_MISMATCH')
    for archive in manifest['archives']:
        need(sha(backup / archive['name']) == archive['sha256'], 'BACKUP_ARCHIVE_CHANGED')
    need(manifest.get('missingComparedWithR11') == receipt.get('missingComparedWithR11') == MISSING_R11, 'ABSENCE_BASELINE_CHANGED')
    full = receipt['completeR11DomainBackup']; full_root = Path(full['backup'])
    need(sha(full_root / 'manifest.json') == full['manifestSha256'], 'COMPLETE_DOMAIN_BACKUP_MANIFEST_CHANGED')
    full_manifest = load(full_root / 'manifest.json')
    need(full_manifest.get('status') == 'VERIFIED' and full_manifest['baselineDomainPack'] == full['identity'], 'COMPLETE_DOMAIN_BACKUP_INVALID')
    need(sha(full_root / full_manifest['archive']['name']) == full_manifest['archive']['sha256'], 'COMPLETE_DOMAIN_BACKUP_CHANGED')
    baseline = {f['path']: f for f in manifest['files']}
    need(len(baseline) == len(manifest['files']), 'BASELINE_DUPLICATE_PATH')
    names = set(baseline)
    for name in MISSING_R11:
        need(name not in baseline and not checked_path(target, name).exists(), 'ABSENCE_BASELINE_CHANGED')
    for root in ROOTS:
        for path in (candidate / root).rglob('*'):
            relative = path.relative_to(candidate)
            if any(part in {'__pycache__', '.cache', 'node_modules', '.git'} for part in relative.parts): continue
            checked_path(candidate, relative.as_posix())
            if path.is_file() and path.suffix not in {'.log', '.pyc', '.pyo'} and '.bak' not in path.name:
                names.add(relative.as_posix())
    changes = []
    for name in sorted(names):
        source, destination = checked_path(candidate, name), checked_path(target, name)
        need(source.is_file(), 'CANDIDATE_SOURCE_MISSING')
        base = baseline.get(name)
        if base is not None:
            need(destination.is_file() and sha(destination) == base['sha256'], 'BASELINE_CHANGED')
        else: need(not destination.exists(), 'NEW_FILE_CONFLICT')
        digest = sha(source)
        if base is None or digest != base['sha256']:
            changes.append({'path': name, 'beforeSha256': None if base is None else base['sha256'],
                            'afterSha256': digest, 'bytes': source.stat().st_size,
                            'afterMode': source.stat().st_mode & 0o777})
    return {'status': 'PLANNED', 'candidateRoot': str(candidate), 'targetRoot': str(target),
            'backup': str(backup), 'backupManifestSha256': receipt['manifestSha256'],
            'completeR11DomainBackup': full, 'absenceCasPaths': MISSING_R11,
            'changes': changes, 'fileCount': len(changes), 'servicesReloaded': False,
            'businessSessionsStarted': False, 'dependenciesInstalled': False,
            'realDomainOverlayUpdated': False, 'domainCenterChanged': False}


def qualify(candidate, evidence):
    q = load(evidence / 'candidate-qualification.json')
    need(q.get('status') == 'PASS' and q.get('candidateRoot') == str(candidate), 'CANDIDATE_NOT_QUALIFIED')
    spec = importlib.util.spec_from_file_location('r12_promotion_controller', candidate / 'scripts/qa/round12-real-rerun.py')
    c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
    runtime = c.runtime_at(candidate)
    need(q['runtime'] == runtime, 'QUALIFIED_RUNTIME_CHANGED')
    need(q['materialIdentity'] == c.material_identity(candidate), 'QUALIFIED_MATERIALS_CHANGED')
    need(q['domainPackIdentity'] == c.domain_identity(candidate), 'QUALIFIED_DOMAIN_CHANGED')
    need(q.get('sourceIdentity') == c.source_identity(candidate), 'QUALIFIED_SOURCE_CHANGED')
    need(q.get('dependencyIdentity') == c.dependency_identity(candidate), 'QUALIFIED_DEPENDENCIES_CHANGED')
    def evidence_file(row):
        path = Path(row['path']).resolve()
        need(path.is_relative_to(evidence) and sha(path) == row['sha256'], 'QUALIFICATION_EVIDENCE_CHANGED')
    need(type(q['build'].get('exitCode')) is int and q['build']['exitCode'] == 0, 'BUILD_FAILED')
    evidence_file(q['build']); need(bool(q.get('tests')), 'TEST_EVIDENCE_MISSING')
    for test in q['tests']:
        need(test.get('status') == 'PASS', 'TESTS_FAILED'); evidence_file(test)
    for name in c.m.HOST_REPORTS:
        host = load(evidence / name)
        need(host.get('status') == 'PASS' and host.get('isolated') is True and host.get('stopped') is True
             and host.get('productionTouched') is False and host.get('businessApiCalls') == 0
             and host.get('realLlmCalls') == 0 and host.get('domainPackIdentity') == q['domainPackIdentity']
             and host.get('candidateRuntimeSha256') == runtime['sha256']
             and host.get('candidateRuntimeFileCount') == runtime['fileCount'], 'HOST_EVIDENCE_INVALID')
    return c, q


def apply_plan(plan, evidence, verify, write_file=replace):
    candidate, target = Path(plan['candidateRoot']), Path(plan['targetRoot'])
    journal = evidence / 'promotion-journal.json'
    need(not journal.exists() and not (evidence / 'runtime-promotion.json').exists(), 'PROMOTION_ATTEMPT_EXISTS_REQUIRES_EXPLICIT_INSPECTION')
    old = {}
    for row in plan['changes']:
        source, destination = checked_path(candidate, row['path']), checked_path(target, row['path'])
        need(sha(source) == row['afterSha256'], 'CANDIDATE_CHANGED_BEFORE_PROMOTION')
        if row['beforeSha256'] is None: need(not destination.exists(), 'TARGET_CREATED_BEFORE_PROMOTION')
        else:
            need(destination.is_file() and sha(destination) == row['beforeSha256'], 'TARGET_CHANGED_BEFORE_PROMOTION')
            old[row['path']] = (destination.read_bytes(), destination.stat().st_mode & 0o777)
    state = {**plan, 'status': 'APPLYING', 'appliedPaths': []}
    save(journal, state)
    applied = []
    try:
        for row in plan['changes']:
            source, destination = checked_path(candidate, row['path']), checked_path(target, row['path'])
            need(sha(source) == row['afterSha256'], 'CANDIDATE_CHANGED_DURING_PROMOTION')
            if row['beforeSha256'] is None: need(not destination.exists(), 'TARGET_CREATED_DURING_PROMOTION')
            else: need(sha(destination) == row['beforeSha256'], 'TARGET_CHANGED_DURING_PROMOTION')
            # Persist intention before each atomic replacement. A killed process
            # leaves inspectable uncertainty; --apply does not blindly continue.
            state['pendingPath'] = row['path']; save(journal, state)
            write_file(destination, source.read_bytes(), row['afterMode'])
            applied.append(row)
            state['appliedPaths'].append(row['path']); state.pop('pendingPath', None); save(journal, state)
        identity = verify(target)
    except BaseException:
        conflicts = []
        pending = state.get('pendingPath')
        if pending and pending not in {row['path'] for row in applied}:
            row = next(row for row in plan['changes'] if row['path'] == pending)
            destination = checked_path(target, pending)
            if destination.is_file() and sha(destination) == row['afterSha256']:
                applied.append(row)
            elif row['beforeSha256'] is None and not destination.exists(): pass
            elif destination.is_file() and sha(destination) == row['beforeSha256']: pass
            else: conflicts.append(pending)
        for row in reversed(applied):
            destination = checked_path(target, row['path'])
            if not destination.is_file() or sha(destination) != row['afterSha256']:
                conflicts.append(row['path']); continue
            if row['path'] in old: replace(destination, *old[row['path']])
            else: destination.unlink()
        state.update(status='ROLLBACK_CONFLICT' if conflicts else 'ROLLED_BACK', rollbackConflicts=conflicts)
        save(journal, state)
        raise
    state.update(status='PROMOTED', **identity)
    save(journal, state); save(evidence / 'runtime-promotion.json', state)
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    candidate = Path(__file__).resolve().parents[2]; evidence = args.evidence_dir.resolve()
    plan = build_plan(candidate, evidence)
    if args.apply:
        c, q = qualify(candidate, evidence)
        def verify(target):
            need(c.runtime_at(target) == q['runtime'], 'PROMOTED_RUNTIME_MISMATCH')
            need(c.material_identity(target) == q['materialIdentity'], 'PROMOTED_MATERIALS_MISMATCH')
            need(c.domain_identity(target) == q['domainPackIdentity'], 'PROMOTED_DOMAIN_MISMATCH')
            need(c.source_identity(target) == q['sourceIdentity'], 'PROMOTED_SOURCE_MISMATCH')
            return {key:q[key] for key in ('runtime','materialIdentity','domainPackIdentity','sourceIdentity')}
        plan = apply_plan(plan, evidence, verify)
    print(json.dumps(plan, ensure_ascii=False))


if __name__ == '__main__': main()
