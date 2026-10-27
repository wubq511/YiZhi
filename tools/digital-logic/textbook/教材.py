#!/usr/bin/env python3
"""离线教材检索。标准库即可使用；原页渲染需要 pdftoppm。"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import unicodedata
from pathlib import Path

ROOT = (Path(__file__).resolve().parents[3]
        / 'courses/digital-logic/教材/数字设计和计算机体系结构-检索版')


def norm(s):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', s)).casefold()


def search_pattern(query):
    text = norm(query)
    # Avoid matching exercise 5.5 inside 5.55, 15.5 or section 5.5.1.
    if re.fullmatch(r'\d+(?:\.\d+)+', text):
        return re.compile(r'(?<![\d.])' + r'\s*\.\s*'.join(map(re.escape, text.split('.'))) + r'(?!\d|\s*\.\s*\d)')
    return re.compile(re.escape(text))


def fold_text(raw, keep_spaces=False):
    folded, positions = [], []
    for i, char in enumerate(raw):
        normalized = ' ' if keep_spaces and char.isspace() else norm(char)
        for c in normalized:
            folded.append(c)
            positions.append(i)
    return ''.join(folded), positions


def exercise_excerpt(record, query):
    """Locate a likely exercise label spatially; never certify its boundaries."""
    query = norm(query)
    if not re.fullmatch(r'[1-8]\.\d+', query):
        return None
    chapter, number = query.split('.')
    labels = []
    for line in record['lines']:
        match = re.match(r'([1-8]\.\d+)(?![\d.])', norm(line['text']))
        x, y, width, height = line['bbox']
        if match and x < .18 and y < .94:
            labels.append((match.group(1), line))
    candidates = [line for key, line in labels if key == query]
    if len(candidates) != 1:
        return None
    start = candidates[0]
    top = start['bbox'][1] + start['bbox'][3]
    next_id = f'{chapter}.{int(number)+1}'
    below = [(key, line) for key, line in labels
             if line['bbox'][1] + line['bbox'][3] < start['bbox'][1]]
    following = max(below, key=lambda pair: pair[1]['bbox'][1], default=None)
    # A missing intermediate label must not make adjacent exercises look complete.
    if following and following[0] != next_id:
        return None
    bottom = following[1]['bbox'][1] + following[1]['bbox'][3] if following else 0
    lines = [line for line in record['lines'] if line is not start
             and bottom < line['bbox'][1] + line['bbox'][3]/2 <= top + .004]
    lines.sort(key=lambda line: (-line['bbox'][1], line['bbox'][0]))
    text = '\n'.join([start['text']] + [line['text'] for line in lines])
    note = (f'检测到同页下一题号 {next_id}；摘录按坐标推定，仍需原页确认边界。'
            if following else '未检测到同页下一题号；必须读取并查看下一页，确认是否续题。')
    return text, note


def page_range(value):
    try:
        ns = [int(n) for n in value.split('-')]
        if len(ns) not in (1, 2) or ns[0] < 1 or ns[-1] < ns[0]:
            raise ValueError
        return ns[0], ns[-1]
    except ValueError:
        raise argparse.ArgumentTypeError('页码格式：56 或 56-58')


class Book:
    def __init__(self, root=ROOT):
        self.root = root
        self.manifest = json.loads((root / 'manifest.json').read_text())
        if self.manifest.get('schema_version') != 2:
            raise ValueError('检索版格式过旧，请先运行 tools/digital-logic/textbook/构建索引.py')
        self.source = (root / self.manifest['source_file']).resolve()
        if self.digest(self.source) != self.manifest['source_sha256']:
            raise ValueError('原 PDF 已变更，与检索版不匹配；请恢复对应原件或在新目录重新 OCR。')
        self.toc = self.load('目录.json')
        self.mapping = self.load('页码映射.json')
        if [m['pdf_page'] for m in self.mapping] != list(range(1, self.manifest['pdf_pages'] + 1)):
            raise ValueError('页码映射不完整或乱序')

    @staticmethod
    def digest(path):
        h = hashlib.sha256()
        with path.open('rb') as f:
            for block in iter(lambda: f.read(1024 * 1024), b''):
                h.update(block)
        return h.hexdigest()

    def checked(self, name):
        expected = self.manifest['artifacts_sha256'].get(name)
        if expected is None or self.digest(self.root / name) != expected:
            raise ValueError(f'文件缺少校验记录或内容已变化：{name}；检查修改原因后重建索引。')
        return self.root / name

    def load(self, name):
        return json.loads(self.checked(name).read_text())

    def record(self, n):
        r = self.load(f'OCR/{n:04}.json')
        if r['pdf_page'] != n:
            raise ValueError(f'OCR 页号与文件名不符：{n}')
        return r

    def label(self, n):
        m = self.mapping[n-1]
        page = f"中文书页 {m['book_page']}" if m['book_page'] is not None else '无中文正文页码'
        return f"{page} | PDF {n} | {m['chapter_title']}"

    def verify(self):
        for name in self.manifest['artifacts_sha256']:
            self.checked(name)
        for m in self.mapping:
            self.record(m['pdf_page'])
            if f'<a id="{m["anchor"]}"></a>' not in (self.root / m['file']).read_text():
                raise ValueError(f'章节缺少页锚点：{m["pdf_page"]}')
        for e in self.toc:
            if not 1 <= e['pdf_page'] <= e['pdf_end'] <= len(self.mapping):
                raise ValueError(f'目录范围错误：{e["id"]}')
            if self.mapping[e['pdf_page']-1]['chapter'] != self.mapping[e['pdf_end']-1]['chapter']:
                raise ValueError(f'目录范围跨章：{e["id"]}')
            if e['level'] == 1:
                pages = [m['pdf_page'] for m in self.mapping if m['chapter'] == e['id']]
                if (e['pdf_page'], e['pdf_end']) != (min(pages), max(pages)):
                    raise ValueError(f'整章范围不完整：{e["id"]}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('verify', help='核对原件、全部检索文件、页号及整章范围')
    p = sub.add_parser('toc', help='校准目录，可按编号或标题过滤')
    p.add_argument('query', nargs='?', default='')
    p = sub.add_parser('search', help='同时检索校准目录和 OCR；忽略空白及英文大小写')
    p.add_argument('query'); p.add_argument('--chapter'); p.add_argument('--limit', type=int, default=10)
    p.add_argument('--scope', choices=['all', 'exercises'], default='all',
                   help='exercises 限定章末习题区，减少同号例题/小节干扰；边界页仍可能混入其他内容')
    p = sub.add_parser('read', help='读取中文书页或 PDF 页序')
    p.add_argument('pages', type=page_range); p.add_argument('--pdf', action='store_true')
    p = sub.add_parser('section', help='按章节编号读整页，如 2.7 或 5-exercises')
    p.add_argument('id')
    p = sub.add_parser('render', help='渲染原页用于公式、电路图、代码核对')
    p.add_argument('pages', type=page_range); p.add_argument('--pdf', action='store_true')
    p.add_argument('--out', type=Path, required=True); p.add_argument('--dpi', type=int, default=180)
    args = parser.parse_args()
    try:
        book = Book()
        if args.command == 'verify':
            book.verify()
            print(f'通过：原件 SHA-256、{len(book.manifest["artifacts_sha256"])} 个检索文件、'
                  f'{len(book.mapping)} 页及 {len(book.toc)} 个目录范围。此检查不代表 OCR 文字准确。')
            return
        if args.command == 'toc':
            numeric = re.fullmatch(r'[1-8](?:\.\d+)*', args.query)
            for e in book.toc:
                hit = (e['id'] == args.query or e['id'].startswith(args.query+'.') or e['id'].startswith(args.query+'-')) if numeric else norm(args.query) in norm(e['id']+' '+e['title'])
                if hit:
                    print(f"{e['id']} {e['title']} | 中文书页 {e['book_page']} | PDF {e['pdf_page']}-{e['pdf_end']}")
            return
        if args.command == 'search':
            if not norm(args.query) or args.limit < 1:
                parser.error('关键词不能为空，limit 必须为正数')
            if args.chapter and args.chapter not in {m['chapter'] for m in book.mapping}:
                parser.error('未知章节编号')
            pattern = search_pattern(args.query)
            matches = []
            exercise_ranges = [e for e in book.toc if e['id'].endswith('-exercises')]
            for m in book.mapping:
                if args.chapter and m['chapter'] != args.chapter:
                    continue
                n = m['pdf_page']
                in_exercises = any(e['pdf_page'] <= n <= e['pdf_end'] for e in exercise_ranges)
                if args.scope == 'exercises' and not in_exercises:
                    continue
                headings = [e for e in book.toc if e['pdf_page'] == n and pattern.search(norm(e['id']+' '+e['title']))]
                record = book.record(n)
                raw = record['text']
                # Keep original case, spacing, and line breaks in displayed evidence.
                numeric = bool(re.fullmatch(r'\d+(?:\.\d+)+', norm(args.query)))
                folded, positions = fold_text(raw, keep_spaces=numeric)
                hit = pattern.search(folded)
                if headings or hit:
                    description = '；'.join(e['id']+' '+e['title'] for e in headings)
                    snippet = raw[max(0, positions[hit.start()]-70):positions[hit.end()-1]+151] if hit else ''
                    spatial = exercise_excerpt(record, args.query) if args.scope == 'exercises' else None
                    matches.append((n, description, snippet, spatial))
            if args.scope == 'exercises':
                matches.sort(key=lambda result: (result[3] is None, result[0]))
                print('范围：章末习题区（含共享边界页）。题号候选优先；正文引用仍可能命中。')
            print(f'命中 {len(matches)} 页，显示前 {args.limit} 页。目录命中与 OCR 命中分开标注。')
            for n, heading, snippet, spatial in matches[:args.limit]:
                print(f'\n[{book.label(n)}]')
                if heading: print(f'校准目录：{heading}')
                if spatial:
                    print(f'OCR 摘录（习题题号候选，按坐标重排，未校对）：\n{spatial[0]}\n{spatial[1]}')
                elif snippet:
                    print(f'OCR 摘录（未校对）：\n{snippet}')
            if not matches:
                print('请改用 --scope all、同义词、短词或 toc 定位相关章节，再 render 核对原页；无命中不能证明原书没有。')
            return
        if args.command == 'section':
            e = next((e for e in book.toc if e['id'] == args.id), None)
            if not e: parser.error('未知章节编号；先使用 toc')
            lo, hi = e['pdf_page'], e['pdf_end']
            print(f"{e['id']} {e['title']}：按整页读取，可能包含相邻节内容。")
        else:
            lo, hi = args.pages
            if args.pdf:
                if hi > len(book.mapping): parser.error('PDF 页序超出范围')
            else:
                lookup = {m['book_page']: m['pdf_page'] for m in book.mapping if m['book_page'] is not None}
                if lo not in lookup or hi not in lookup: parser.error('中文书页超出范围')
                lo, hi = lookup[lo], lookup[hi]
        if args.command == 'render':
            executable = shutil.which('pdftoppm')
            if not executable: parser.error('渲染需要 Poppler 的 pdftoppm')
            if not 50 <= args.dpi <= 600: parser.error('dpi 范围为 50-600')
            args.out.mkdir(parents=True, exist_ok=True)
            subprocess.run([executable, '-f', str(lo), '-l', str(hi), '-r', str(args.dpi), '-png', str(book.source), str(args.out/'page')], check=True)
            print(f'已渲染 PDF {lo}-{hi} 至 {args.out.resolve()}')
        else:
            print('以下为未校对 OCR；公式、电路图、代码、精确引文及可疑内容请 render 原页核对。')
            for n in range(lo, hi+1):
                print(f"\n## {book.label(n)}\n\n{book.record(n)['text']}")
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(2, f'教材读取失败：{exc}\n')


if __name__ == '__main__':
    main()
