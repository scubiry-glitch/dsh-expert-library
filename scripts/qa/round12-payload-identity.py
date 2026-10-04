#!/usr/bin/env python3
"""R12-only input and installed production-dependency identities; no writes/network.

Source includes the promotion's code/resource roots and root build/lock files.
Dependency identity follows package-root Node node_modules lookup with realpath
semantics, including each package's non-node_modules files and dependency edges.
It is independent of candidate/main absolute paths, not a whole-Host attestation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re

SOURCE_ROOTS = ('src', 'lib', 'packages', 'scripts', 'test', 'assets',
                'domain-packs/builtin-library', 'domain-packs/zhijian-realestate',
                'knowledge/skills/zhijian-report-craft', 'knowledge/skills/zhijian-designer-render')
ROOT_FILES = ('.gitignore', '.npmrc', 'LICENSE', 'README.md', 'cordis.patch.yml',
              'package.json', 'package-lock.json', 'pnpm-lock.yaml',
              'tsconfig.json', 'tsconfig.client.json', 'tsdown.config.ts')
IGNORED = {'__pycache__', '.cache', 'node_modules', '.git'}
PACKAGE_NAME = re.compile(r'(?:@[a-zA-Z0-9_.~-]+/)?[a-zA-Z0-9_.~-]+')


def need(condition, code):
    if not condition:
        raise RuntimeError(code)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def read_stable(path):
    need(path.is_file() and not path.is_symlink(), 'IDENTITY_FILE_MISSING_OR_ALIAS')
    before = path.stat()
    raw = path.read_bytes()
    after = path.stat()
    need((before.st_ino, before.st_size, before.st_mtime_ns) ==
         (after.st_ino, after.st_size, after.st_mtime_ns), 'IDENTITY_FILE_CHANGED_DURING_READ')
    return raw


def file_record(root, path):
    raw = read_stable(path)
    return {'path': path.relative_to(root).as_posix(), 'bytes': len(raw),
            'sha256': hashlib.sha256(raw).hexdigest()}


def source_identity(root):
    root = Path(root).absolute()
    need(all(not p.is_symlink() for p in (root, *root.parents)), 'SOURCE_ROOT_ALIAS')
    need((root / 'package.json').is_file(), 'SOURCE_PACKAGE_MISSING')
    names = {name for name in ROOT_FILES if (root / name).exists() or (root / name).is_symlink()}
    # Any additional build config is still bound, without admitting local docs.
    names.update(p.name for p in root.glob('tsconfig*.json'))
    names.update(p.name for p in root.glob('tsdown.config.*'))
    for relative in SOURCE_ROOTS:
        base = root / relative
        need(all(not p.is_symlink() for p in (base, *base.parents)), 'SOURCE_PATH_ALIAS')
        if not base.exists():
            continue
        for directory, folders, files in os.walk(base, followlinks=False):
            directory = Path(directory)
            for name in folders:
                if name not in IGNORED:
                    need(not (directory / name).is_symlink(), 'SOURCE_PATH_ALIAS')
            folders[:] = sorted(name for name in folders if name not in IGNORED)
            for name in files:
                path = directory / name
                if path.suffix in ('.log', '.pyc', '.pyo') or '.bak' in name:
                    continue
                names.add(path.relative_to(root).as_posix())
    records = [file_record(root, root / name) for name in sorted(names)]
    return {'schemaVersion': 1, 'scope': 'round12-promotion-source-resources-locks',
            'sha256': digest(records), 'fileCount': len(records),
            'sizeBytes': sum(row['bytes'] for row in records)}


def dependency_map(value, field):
    deps = value.get(field, {})
    need(isinstance(deps, dict) and all(isinstance(name, str) and PACKAGE_NAME.fullmatch(name)
         and name not in ('.', '..') and all(p not in ('.', '..') for p in name.split('/'))
         and isinstance(spec, str) and spec for name, spec in deps.items()), 'DEPENDENCY_MANIFEST_INVALID')
    return deps


def resolve_package(from_root, name, optional=False):
    # Node resolves imports relative to the real package directory unless
    # --preserve-symlinks is enabled; this controlled R12 launcher does not set it.
    start = Path(from_root).resolve()
    for parent in (start, *start.parents):
        if parent.name == 'node_modules':
            continue
        target = parent / 'node_modules' / name
        if target.exists() or target.is_symlink():
            try:
                actual = target.resolve(strict=True)
            except (OSError, RuntimeError):
                raise RuntimeError('DEPENDENCY_PACKAGE_ALIAS_UNRESOLVED') from None
            need(actual.is_dir() and (actual / 'package.json').is_file(), 'DEPENDENCY_PACKAGE_INVALID')
            return actual
    if optional:
        return None
    raise RuntimeError('PRODUCTION_DEPENDENCY_NOT_INSTALLED: ' + name)


def package_files(root):
    records = []
    for directory, folders, files in os.walk(root, followlinks=False):
        directory = Path(directory)
        for name in folders:
            if name != 'node_modules':
                need(not (directory / name).is_symlink(), 'DEPENDENCY_INTERNAL_ALIAS')
        folders[:] = sorted(name for name in folders if name != 'node_modules')
        for name in sorted(files):
            path = directory / name
            records.append(file_record(root, path))
    records.sort(key=lambda row: row['path'])
    need(0 < len(records) <= 100000, 'DEPENDENCY_FILE_LIMIT')
    return {'sha256': digest(records), 'fileCount': len(records),
            'sizeBytes': sum(row['bytes'] for row in records)}


def dependency_identity(root):
    root = Path(root).resolve()
    manifest = json.loads(read_stable(root / 'package.json'))
    packages, seen = [], {}

    def visit(package_root):
        key = str(package_root)
        if key in seen:
            return seen[key]
        need(len(packages) < 1024, 'DEPENDENCY_PACKAGE_LIMIT')
        index = len(packages)
        seen[key] = index
        metadata_bytes = read_stable(package_root / 'package.json')
        metadata = json.loads(metadata_bytes)
        need(isinstance(metadata.get('name'), str) and isinstance(metadata.get('version'), str),
             'DEPENDENCY_PACKAGE_IDENTITY_MISSING')
        tree = package_files(package_root)
        row = {'id': index, 'name': metadata['name'], 'version': metadata['version'],
               'files': tree, 'dependencies': []}
        packages.append(row)
        regular = dependency_map(metadata, 'dependencies')
        optional = dependency_map(metadata, 'optionalDependencies')
        for name, spec in sorted({**regular, **optional}.items()):
            target = resolve_package(package_root, name, optional=name in optional)
            row['dependencies'].append({'name': name, 'requested': spec,
                                        'target': None if target is None else visit(target)})
        need(read_stable(package_root / 'package.json') == metadata_bytes,
             'DEPENDENCY_MANIFEST_CHANGED_DURING_READ')
        return index

    regular = dependency_map(manifest, 'dependencies')
    optional = dependency_map(manifest, 'optionalDependencies')
    roots = []
    for name, spec in sorted({**regular, **optional}.items()):
        target = resolve_package(root, name, optional=name in optional)
        roots.append({'name': name, 'requested': spec, 'target': None if target is None else visit(target)})
    body = {'rootDependencies': roots, 'packages': packages}
    return {'schemaVersion': 1, 'scope': 'installed-production-dependency-closure',
            'sha256': digest(body), 'packageCount': len(packages),
            'fileCount': sum(row['files']['fileCount'] for row in packages),
            'sizeBytes': sum(row['files']['sizeBytes'] for row in packages), **body}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=('source', 'dependencies', 'all'))
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    value = {}
    if args.kind in ('source', 'all'):
        value['sourceIdentity'] = source_identity(args.root)
    if args.kind in ('dependencies', 'all'):
        value['dependencyIdentity'] = dependency_identity(args.root)
    print(json.dumps(value, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
