#!/usr/bin/env python3
"""Scoped, rollback-protected promotion of the qualified round10 candidate.

Default is a read-only plan. Never removes unrelated files, replaces a whole
repository, touches credentials, reloads services, or starts business sessions.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--evidence-dir', type=Path, required=True)
    p.add_argument('--apply', action='store_true')
    args = p.parse_args()
    candidate = Path(__file__).resolve().parents[2]
    evidence = args.evidence_dir.resolve()
    backup_record = json.loads((evidence / 'backup.json').read_text())
    backup = Path(backup_record['backup'])
    manifest_path = backup / 'manifest.json'
    assert sha(manifest_path) == backup_record['manifestSha256'], 'BACKUP_MANIFEST_CHANGED'
    manifest = json.loads(manifest_path.read_text())
    target = Path(manifest['sourceRoot']).resolve()
    assert target != candidate and backup_record['candidate'] == str(candidate), 'PROMOTION_ROOT_MISMATCH'
    baseline = {f['path']: f for f in manifest['files']}
    roots = ['src', 'lib', 'packages', 'scripts', 'test', 'assets', 'domain-packs/builtin-library',
             'knowledge/skills/zhijian-report-craft', 'knowledge/skills/zhijian-designer-render']
    names = set(baseline)
    for root in roots:
        for path in (candidate / root).rglob('*'):
            relative = path.relative_to(candidate)
            if any(part in {'__pycache__', '.cache', 'node_modules', '.git'} for part in relative.parts):
                continue
            assert not path.is_symlink(), f'UNEXPECTED_CANDIDATE_SYMLINK: {relative}'
            if path.is_file() and path.suffix not in {'.log', '.pyc', '.pyo'} and '.bak' not in path.name:
                names.add(relative.as_posix())
    changes = []
    for name in sorted(names):
        source = candidate / name
        destination = target / name
        assert source.is_file() and not source.is_symlink(), f'CANDIDATE_SOURCE_MISSING: {name}'
        base = baseline.get(name)
        if base is not None:
            assert destination.is_file() and not destination.is_symlink() and sha(destination) == base['sha256'], f'BASELINE_CHANGED: {name}'
        else:
            assert not destination.exists(), f'NEW_FILE_CONFLICT: {name}'
        digest = sha(source)
        if base is None or digest != base['sha256']:
            changes.append({'path': name, 'beforeSha256': None if base is None else base['sha256'],
                            'afterSha256': digest, 'bytes': source.stat().st_size})
    plan = {'status': 'PLANNED', 'candidateRoot': str(candidate), 'targetRoot': str(target),
            'backup': str(backup), 'changes': changes, 'fileCount': len(changes),
            'servicesReloaded': False, 'businessSessionsStarted': False}
    if not args.apply:
        print(json.dumps(plan, ensure_ascii=False))
        return
    qualification = json.loads((evidence / 'candidate-qualification.json').read_text())
    assert qualification['status'] == 'PASS' and qualification['candidateRoot'] == str(candidate), 'CANDIDATE_NOT_QUALIFIED'
    spec = importlib.util.spec_from_file_location('round10_controller', candidate / 'scripts/qa/round10-real-rerun.py')
    controller = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(controller)
    actual_runtime = controller.runtime_at(candidate)
    assert qualification['runtime'] == actual_runtime, 'QUALIFIED_RUNTIME_CHANGED'
    assert qualification['materialIdentity'] == controller.material_identity(candidate), 'QUALIFIED_MATERIALS_CHANGED'
    build = qualification['build']
    assert build['exitCode'] == 0 and sha(Path(build['path'])) == build['sha256'], 'BUILD_EVIDENCE_CHANGED'
    assert qualification['tests'], 'TEST_EVIDENCE_MISSING'
    for test in qualification['tests']:
        assert test['status'] == 'PASS' and sha(Path(test['path'])) == test['sha256'], 'TEST_EVIDENCE_CHANGED'
    for name in ['member-host.json', 'quality-host.json', 'plan-host.json', 'goal-wait-host.json']:
        receipt = json.loads((evidence / name).read_text())
        assert receipt['status'] == 'PASS' and receipt['isolated'] and receipt['stopped'], name
        assert receipt['productionTouched'] is False and receipt['businessApiCalls'] == 0 and receipt['realLlmCalls'] == 0, name
        assert receipt['candidateRuntimeSha256'] == actual_runtime['sha256'] and receipt['candidateRuntimeFileCount'] == actual_runtime['fileCount'], name
    old = {row['path']: ((target / row['path']).read_bytes(), (target / row['path']).stat().st_mode & 0o777)
           for row in changes if row['beforeSha256'] is not None}
    applied = []
    def replace(path, data, mode):
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp = tempfile.mkstemp(prefix='.round10-', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.chmod(temp, mode)
            os.replace(temp, path)
        finally:
            if os.path.exists(temp): os.unlink(temp)
    try:
        for row in changes:
            source, destination = candidate / row['path'], target / row['path']
            assert sha(source) == row['afterSha256'], 'CANDIDATE_CHANGED_DURING_PROMOTION'
            if row['beforeSha256'] is not None: assert sha(destination) == row['beforeSha256'], 'TARGET_CHANGED_DURING_PROMOTION'
            else: assert not destination.exists(), 'TARGET_CREATED_DURING_PROMOTION'
            replace(destination, source.read_bytes(), source.stat().st_mode & 0o777)
            applied.append(row['path'])
        assert controller.runtime_at(target) == actual_runtime, 'PROMOTED_RUNTIME_MISMATCH'
        assert controller.material_identity(target) == qualification['materialIdentity'], 'PROMOTED_MATERIALS_MISMATCH'
    except BaseException:
        for name in reversed(applied):
            if name in old: replace(target / name, *old[name])
            else: (target / name).unlink()
        raise
    plan.update(status='PROMOTED', runtime=actual_runtime, materialIdentity=qualification['materialIdentity'])
    (evidence / 'runtime-promotion.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in plan.items() if k != 'changes'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
