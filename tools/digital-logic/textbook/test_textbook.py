"""Regression checks for omissions, wrong matches, and stale source/index failures."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('教材.py')
spec = importlib.util.spec_from_file_location('textbook', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RetrievalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.book = module.Book()

    def run_cli(self, *args):
        return subprocess.check_output([sys.executable, str(SCRIPT), *args], text=True)

    def test_every_whole_chapter_includes_exercises_and_last_page(self):
        for key in map(str, range(1, 9)):
            e = next(e for e in self.book.toc if e['id'] == key)
            pages = [m['pdf_page'] for m in self.book.mapping if m['chapter'] == key]
            self.assertEqual((e['pdf_page'], e['pdf_end']), (min(pages), max(pages)))
            self.assertIn(f'{key}-exercises', self.run_cli('toc', key))
            result = self.run_cli('section', key)
            self.assertEqual(result.count('\n## '), len(pages))
            self.assertIn(f'| PDF {max(pages)} |', result)

    def test_small_section_keeps_shared_boundary_page(self):
        e = next(e for e in self.book.toc if e['id'] == '2.7')
        self.assertEqual((e['pdf_page'], e['pdf_end']), (56, 61))

    def test_pdf_and_printed_pages_are_equivalent(self):
        self.assertEqual(self.run_cli('read', '42-43'), self.run_cli('read', '56-57', '--pdf'))

    def test_exercise_numbers_do_not_match_other_numbers(self):
        p = module.search_pattern('5.5')
        for text in ['5.55', '15.5', '5.5.1', '5.5 . 1']:
            self.assertIsNone(p.search(text), text)
        self.assertIsNotNone(p.search(module.norm('习题 ５．５：问题')))
        self.assertIsNotNone(p.search('5.5.'))

    def test_adjacent_exercise_lines_remain_separate(self):
        raw = '5.55\n5.56\n5.57\n题目内容'
        folded, positions = module.fold_text(raw, keep_spaces=True)
        hit = module.search_pattern('5.55').search(folded)
        self.assertIsNotNone(hit)
        self.assertEqual(raw[positions[hit.start()]:positions[hit.end()-1]+1], '5.55')
        self.assertIsNotNone(module.search_pattern('5.55').search('5 . 55 题目'))

    def test_search_uses_verified_contents_and_preserves_case(self):
        result = self.run_cli('search', 'SystemVerilog', '--chapter', '4', '--limit', '100')
        self.assertIn('校准目录：4.7.1 SystemVerilog', result)
        self.assertIn('OCR 摘录', result)
        self.assertIn('中文书页 130 | PDF 144', result)

    def test_real_exercise_location(self):
        self.assertIn('中文书页 179 | PDF 193', self.run_cli('search', '5.55', '--chapter', '5'))

    def test_exercise_scope_excludes_same_number_example(self):
        result = self.run_cli('search', '2.13', '--chapter', '2', '--scope', 'exercises')
        self.assertNotIn('中文书页 49 | PDF 63', result)
        self.assertIn('中文书页 56 | PDF 70', result)
        first = self.run_cli('search', '2.13', '--chapter', '2', '--scope', 'exercises', '--limit', '1')
        self.assertIn('中文书页 56 | PDF 70', first)

    def test_spatial_excerpt_separates_555_from_556(self):
        text, note = module.exercise_excerpt(self.book.record(193), '5.55')
        for number in ['2.13', '2.17', '2.24', '2.35', '2.36']:
            self.assertIn(number, text)
        self.assertNotIn('5.56', text)
        self.assertNotIn('5.57', text)
        self.assertNotIn('3.22', text)
        self.assertIn('5.56', note)
        result = self.run_cli('search', '5.55', '--chapter', '5', '--scope', 'exercises')
        self.assertIn('习题2.35', result)
        self.assertIn('习题2.36', result)

    def test_cross_page_exercises_require_continuation(self):
        for n, query in [(70, '2.13'), (72, '2.35')]:
            text, note = module.exercise_excerpt(self.book.record(n), query)
            self.assertIn(query, text)
            self.assertIn('下一页', note)

    def test_missing_neighbor_does_not_merge_exercises(self):
        record = self.book.record(193)
        record['lines'] = [line for line in record['lines'] if line['text'] != '5.56']
        self.assertIsNone(module.exercise_excerpt(record, '5.55'))

    def test_bad_inputs_fail(self):
        for args in [('read', '0'), ('read', '481'), ('read', '4-2'), ('read', '496', '--pdf'), ('search', '   '), ('search', 'x', '--chapter', '99')]:
            p = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True)
            self.assertNotEqual(p.returncode, 0, args)

    def test_all_artifacts_and_ranges(self):
        self.book.verify()

    def test_modified_source_and_ocr_are_rejected(self):
        # Synthetic fixture only. Never mutate the real source or stored OCR.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'OCR').mkdir()
            files = {'source.pdf': b'fixture-source', '目录.json': b'[]',
                     '页码映射.json': b'[{"pdf_page":1}]',
                     'OCR/0001.json': b'{"pdf_page":1,"text":"original"}'}
            for name, data in files.items(): (root/name).write_bytes(data)
            manifest = {'schema_version': 2, 'source_file': 'source.pdf',
                        'source_sha256': hashlib.sha256(files['source.pdf']).hexdigest(),
                        'pdf_pages': 1, 'artifacts_sha256': {
                            name: hashlib.sha256(data).hexdigest() for name, data in files.items() if name != 'source.pdf'}}
            (root/'manifest.json').write_text(json.dumps(manifest))
            b = module.Book(root)
            self.assertEqual(b.record(1)['text'], 'original')
            (root/'OCR/0001.json').write_text('{"pdf_page":1,"text":"changed"}')
            with self.assertRaisesRegex(ValueError, '内容已变化'): b.record(1)
            (root/'source.pdf').write_bytes(b'replaced-source')
            with self.assertRaisesRegex(ValueError, '原 PDF 已变更'): module.Book(root)


if __name__ == '__main__':
    unittest.main(verbosity=2)
