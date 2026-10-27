import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name('知识地图.py')
CANONICAL = SCRIPT.parents[1] / '数据/知识地图.json'


class MapCliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.data_path = root / 'map.json'
        self.data_path.write_bytes(CANONICAL.read_bytes())
        self.output_dir = root / 'outputs'
        self.layout_path = root / 'layout.json'
        self.env = os.environ.copy()
        self.env.update({
            'MIDTERM_MAP_FILE': str(self.data_path),
            'MIDTERM_OUTPUT_DIR': str(self.output_dir),
            'MIDTERM_LAYOUT_FILE': str(self.layout_path),
        })
        result = self.run_cli('build')
        if result.returncode != 0:
            raise AssertionError(result.stdout + result.stderr)

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], env=self.env,
                              text=True, capture_output=True)

    def run_json(self, *args):
        result = self.run_cli(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_build_and_check(self):
        result = self.run_json('check')
        self.assertEqual(result['status'], 'ok')
        for name in ['01-课件知识点.md', '02-题目知识点映射.md', '03-知识点地图.md',
                     '知识地图.html', '数据/画板图.json']:
            self.assertTrue((self.output_dir / name).exists(), name)

    def test_get_exact_unit(self):
        result = self.run_json('get', 'KU-064')
        self.assertEqual(result['id'], 'KU-064')
        self.assertEqual(result['name'], '用译码器实现逻辑函数')
        self.assertTrue(result['sourceRefs'])
        self.assertTrue(result['questions'])

    def test_unknown_id_has_structured_error(self):
        result = self.run_cli('get', 'KU-999')
        self.assertNotEqual(result.returncode, 0)
        error = json.loads(result.stdout)['error']
        self.assertEqual(error['code'], 'not_found')

    def test_search_disambiguates_aliases(self):
        result = self.run_json('search', 'LE', '--limit', '0')
        ids = {item['id'] for item in result['items']}
        self.assertTrue({'KU-066', 'KU-083', 'KU-086'} <= ids)
        self.assertGreaterEqual(len(ids), 3)
        for item in result['items']:
            self.assertIn('name', item)
            self.assertIn('themeId', item)

    def test_related_preserves_any_group(self):
        result = self.run_json('related', 'KU-044', '--depth', '1')
        groups = result['requirementGroups']
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]['mode'], 'any')
        self.assertEqual(set(groups[0]['unitIds']), {'KU-033', 'KU-035'})
        self.assertEqual(result['conditions']['KU-044'], {'required': ['KU-029'], 'groups': ['G1']})
        edge_ids = {edge['id'] for edge in result['edges']}
        self.assertTrue({'REL-010', 'REL-011', 'REL-043'} <= edge_ids)

    def test_invalid_relation_type_is_not_an_empty_result(self):
        for args in [('related', 'KU-044'), ('path', 'KU-033', 'KU-044')]:
            with self.subTest(command=args[0]):
                result = self.run_cli(*args, '--relation', 'requieres')
                self.assertNotEqual(result.returncode, 0)
                error = json.loads(result.stdout)['error']
                self.assertEqual(error['code'], 'invalid_parameter')
                self.assertEqual(error['details']['relationType'], 'requieres')
        self.assertEqual(self.run_json('path', 'KU-033', 'KU-035')['paths'], [])

    def test_non_prerequisite_relations_do_not_create_conditions(self):
        result = self.run_json('related', 'KU-044', '--relation', 'inverse')
        self.assertTrue(result['edges'])
        self.assertTrue(all(edge['type'] == 'inverse' for edge in result['edges']))
        self.assertEqual(result['conditions'], {})
        self.assertEqual(result['requirementGroups'], [])

    def test_full_prerequisites_exclude_inverse(self):
        result = self.run_json('related', 'KU-044', '--depth', '-1')
        ids = {node['id'] for node in result['nodes']}
        self.assertIn('KU-029', ids)
        self.assertIn('KU-033', ids)
        self.assertIn('KU-035', ids)
        for edge in result['edges']:
            self.assertEqual(edge['type'], 'requires')

    def test_path_filters_relation_type(self):
        result = self.run_json('path', 'KU-028', 'KU-044')
        self.assertTrue(result['paths'])
        for path in result['paths']:
            for edge in path['edges']:
                self.assertEqual(edge['type'], 'requires')

    def test_questions_roles(self):
        direct = self.run_json('questions', 'KU-083', '--role', 'direct')
        self.assertEqual(len(direct['items']), 3)
        self.assertEqual(direct['counts'].get('direct'), 3)
        self.assertNotIn('support', direct['counts'])
        support = self.run_json('questions', 'KU-033', '--role', 'support')
        self.assertEqual(len(support['items']), 1)
        self.assertEqual(support['items'][0]['questionId'], 'Q-096')
        self.assertIn('分解', support['items'][0]['note'])

    def test_layout_is_preserved(self):
        layout = json.loads(self.layout_path.read_text(encoding='utf-8'))
        views = layout.get('views') or [layout]
        views[0]['nodes'][0]['x'] = 12345
        self.layout_path.write_text(json.dumps(layout, ensure_ascii=False, indent=2), encoding='utf-8')
        self.run_json('build')
        rebuilt = json.loads(self.layout_path.read_text(encoding='utf-8'))
        rebuilt_views = rebuilt.get('views') or [rebuilt]
        self.assertEqual(rebuilt_views[0]['nodes'][0]['x'], 12345)

    def test_stale_output_is_detected(self):
        target = self.output_dir / '01-课件知识点.md'
        with target.open('a', encoding='utf-8') as handle:
            handle.write('\n手工改动\n')
        result = self.run_cli('check')
        self.assertNotEqual(result.returncode, 0)
        error = json.loads(result.stdout)['error']
        self.assertEqual(error['code'], 'stale_output')

    def test_invalid_relation_is_rejected(self):
        data = json.loads(self.data_path.read_text(encoding='utf-8'))
        data['relations'].append({
            'id': 'REL-999', 'fromUnitId': 'KU-001', 'toUnitId': 'KU-002',
            'type': 'requires', 'directed': True, 'value': '',
            'sourceRefs': [], 'view': 'main', 'status': 'approved',
        })
        self.data_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
        result = self.run_cli('check', '--source-only')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('REL-999', result.stdout)

    def test_retired_units_are_not_in_graph(self):
        result = self.run_json('graph', '--view', 'all')
        ids = {node['id'] for node in result['nodes']}
        self.assertNotIn('KU-049', ids)
        self.assertNotIn('KU-073', ids)
        for edge in result['edges']:
            self.assertNotIn('KU-049', (edge['fromUnitId'], edge['toUnitId']))
            self.assertNotIn('KU-073', (edge['fromUnitId'], edge['toUnitId']))

    def test_html_is_offline_and_js_syntax_is_valid(self):
        from html.parser import HTMLParser
        class Audit(HTMLParser):
            def __init__(self):
                super().__init__()
                self.external = []
                self.in_script = False
                self.scripts = []
                self.script_type = ''
            def handle_starttag(self, tag, attrs):
                attrs = dict(attrs)
                if tag in {'script', 'img', 'link', 'iframe'}:
                    for key in ['src', 'href']:
                        if key in attrs:
                            self.external.append((tag, key, attrs[key]))
                if tag == 'script':
                    self.in_script = True
                    self.script_type = attrs.get('type', '')
            def handle_endtag(self, tag):
                if tag == 'script':
                    self.in_script = False
                    self.script_type = ''
            def handle_data(self, data):
                if self.in_script and self.script_type != 'application/json':
                    self.scripts.append(data)
        html = (self.output_dir / '知识地图.html').read_text(encoding='utf-8')
        audit = Audit()
        audit.feed(html)
        self.assertEqual(audit.external, [])
        syntax = subprocess.run(['node', '--check', '--input-type=module'],
                                input='\n'.join(audit.scripts), text=True, capture_output=True)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)
        self.assertNotIn('NaN', html)


if __name__ == '__main__':
    unittest.main()
