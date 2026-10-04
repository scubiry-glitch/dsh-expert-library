"""R12 identity/qualification guards with isolated files, no production imports or APIs."""
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value

identity = module('r12_identity_test', ROOT / 'scripts/qa/round12-payload-identity.py')
guard = module('r12_identity_controller_fixture', ROOT / 'scripts/qa/round12-controller-offline-guards.py')
promotion = module('r12_identity_promotion_test', ROOT / 'scripts/qa/round12-promote-candidate.py')


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) if isinstance(value, dict) else value)


class Identity(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'candidate'; self.root.mkdir()
        put(self.root / 'package.json', {'dependencies': {'alpha': '1.0.0'}})
        self.package('alpha', {'beta': '1.0.0'})
        self.package('beta')

    def package(self, name, dependencies=None, root=None):
        target = (root or self.root) / 'node_modules' / name
        put(target / 'package.json', {'name': name, 'version': '1.0.0', 'dependencies': dependencies or {}})
        put(target / 'index.js', 'export const fixture = true;')
        return target

    def test_absolute_candidate_path_does_not_enter_dependency_identity(self):
        other = self.root.parent / 'installed'; shutil.copytree(self.root, other)
        self.assertEqual(identity.dependency_identity(self.root), identity.dependency_identity(other))
        self.assertNotIn(str(self.root), json.dumps(identity.dependency_identity(self.root)))

    def test_transitive_dependency_code_is_bound(self):
        before = identity.dependency_identity(self.root)
        put(self.root / 'node_modules/beta/index.js', 'changed transitive behavior')
        self.assertNotEqual(identity.dependency_identity(self.root), before)

    def test_package_version_is_bound(self):
        before = identity.dependency_identity(self.root)
        put(self.root / 'node_modules/beta/package.json', {'name': 'beta', 'version': '2.0.0'})
        self.assertNotEqual(identity.dependency_identity(self.root), before)

    def test_node_nearest_package_resolution_and_realpath_semantics(self):
        nested = self.package('beta', root=self.root / 'node_modules/alpha')
        put(nested / 'index.js', 'nested beta is resolved first')
        result = identity.dependency_identity(self.root)
        self.assertEqual(result['packageCount'], 2)
        unchanged = copy.deepcopy(result)
        put(self.root / 'node_modules/beta/index.js', 'unused hoisted package is outside the selected closure')
        self.assertEqual(identity.dependency_identity(self.root), unchanged)

    def test_pnpm_style_package_root_symlink_is_supported(self):
        real = self.root / 'node_modules/.pnpm/alpha@1/node_modules/alpha'
        real.parent.mkdir(parents=True)
        (self.root / 'node_modules/alpha').rename(real)
        (self.root / 'node_modules/alpha').symlink_to(real, target_is_directory=True)
        sibling = real.parent / 'beta'; sibling.symlink_to(self.root / 'node_modules/beta', target_is_directory=True)
        self.assertEqual(identity.dependency_identity(self.root)['packageCount'], 2)

    def test_cycles_are_finite_and_recorded(self):
        put(self.root / 'node_modules/beta/package.json', {'name': 'beta', 'version': '1.0.0', 'dependencies': {'alpha': '1.0.0'}})
        result = identity.dependency_identity(self.root)
        self.assertEqual(result['packageCount'], 2)
        self.assertEqual(result['packages'][1]['dependencies'][0]['target'], 0)

    def test_optional_missing_dependency_has_explicit_absence(self):
        put(self.root / 'node_modules/alpha/package.json', {'name': 'alpha', 'version': '1.0.0', 'optionalDependencies': {'absent': '1.0.0'}})
        result = identity.dependency_identity(self.root)
        self.assertIsNone(result['packages'][0]['dependencies'][0]['target'])
        before = result; self.package('absent')
        self.assertNotEqual(identity.dependency_identity(self.root), before)

    def test_missing_required_dependency_rejected(self):
        shutil.rmtree(self.root / 'node_modules/beta')
        with self.assertRaisesRegex(RuntimeError, 'PRODUCTION_DEPENDENCY_NOT_INSTALLED'):
            identity.dependency_identity(self.root)

    def test_internal_package_symlink_is_not_silently_unhashed(self):
        path = self.root / 'node_modules/beta/hidden.js'; path.symlink_to(self.root / 'package.json')
        with self.assertRaisesRegex(RuntimeError, 'ALIAS'):
            identity.dependency_identity(self.root)

    def test_docs_evidence_caches_and_unused_installs_do_not_enter_source(self):
        before = identity.source_identity(self.root)
        for name in ('docs/evidence/receipt.json', 'work/report.md', 'scripts/__pycache__/probe.pyc', 'scripts/.cache/temporary.txt'):
            put(self.root / name, 'excluded')
        self.package('unused')
        self.assertEqual(identity.source_identity(self.root), before)

    def test_source_script_lock_config_and_resource_changes_are_bound(self):
        for name in ('src/main.ts', 'scripts/build.mjs', 'test/behavior.test.mjs', 'pnpm-lock.yaml', 'package-lock.json',
                     'tsconfig.client.json', 'tsdown.config.ts', 'assets/client.css', 'domain-packs/zhijian-realestate/checks/check.mjs'):
            before = identity.source_identity(self.root)
            put(self.root / name, 'new relevant bytes')
            self.assertNotEqual(identity.source_identity(self.root), before, name)

    def test_source_alias_is_rejected(self):
        (self.root / 'src').symlink_to(self.root / 'node_modules', target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_PATH_ALIAS'):
            identity.source_identity(self.root)


class Qualification(unittest.TestCase):
    def setUp(self):
        # Use the same complete offline gate fixture, then install the exact
        # inert controller/helper so promotion.qualify exercises its real import.
        guard.Guards.setUp(self)
        for name in ('round9-real-rerun.py', 'round12-real-rerun.py', 'round12-payload-identity.py'):
            for root in (self.candidate, self.installed):
                shutil.copy2(ROOT / 'scripts/qa' / name, root / 'scripts/qa' / name) if (root / 'scripts/qa').exists() else self.copy_script(root, name)
        self.qualification['sourceIdentity'] = identity.source_identity(self.candidate)
        guard.m.save(guard.c.QUALIFICATION, self.qualification)

    def copy_script(self, root, name):
        (root / 'scripts/qa').mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / 'scripts/qa' / name, root / 'scripts/qa' / name)

    def test_current_qualification_accepted_by_actual_promotion_gate(self):
        _, result = promotion.qualify(self.candidate, self.evidence)
        self.assertEqual(result['sourceIdentity'], identity.source_identity(self.candidate))

    def test_old_pass_rejected_after_source_script_or_lock_changes(self):
        for name in ('src/example.ts', 'scripts/build-example.mjs', 'package-lock.json', 'pnpm-lock.yaml'):
            with self.subTest(name=name):
                path = self.candidate / name; raw = path.read_bytes(); path.write_text('changed after PASS')
                with self.assertRaisesRegex(RuntimeError, 'QUALIFIED_SOURCE_CHANGED'):
                    promotion.qualify(self.candidate, self.evidence)
                path.write_bytes(raw)

    def test_old_pass_rejected_after_installed_candidate_dependency_changes(self):
        put(self.candidate / 'node_modules/fixture-parser/index.js', 'new parser bytes')
        with self.assertRaisesRegex(RuntimeError, 'QUALIFIED_DEPENDENCIES_CHANGED'):
            promotion.qualify(self.candidate, self.evidence)

    def test_missing_new_identity_fields_cannot_reuse_legacy_pass(self):
        for field in ('sourceIdentity', 'dependencyIdentity'):
            value = copy.deepcopy(self.qualification); value.pop(field)
            guard.m.save(guard.c.QUALIFICATION, value)
            with self.assertRaisesRegex(RuntimeError, 'QUALIFIED_'):
                promotion.qualify(self.candidate, self.evidence)


if __name__ == '__main__':
    unittest.main(verbosity=2)
