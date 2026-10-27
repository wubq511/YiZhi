"""Rebuild Markdown and indexes from locally saved OCR and verified contents. Requires pypdf."""
import csv
import hashlib
import json
import re
from pathlib import Path
from pypdf import PdfReader

ROOT = (Path(__file__).resolve().parents[3]
        / 'courses/digital-logic/教材/数字设计和计算机体系结构-检索版')
SOURCE = ROOT.parent / '数字设计和计算机体系结构（原书第2版） ( etc.) (z-library.sk, 1lib.sk, z-lib.sk).pdf'
source_hash = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
manifest_path = ROOT / 'manifest.json'
if manifest_path.exists():
    previous = json.loads(manifest_path.read_text())
    if previous['source_sha256'] != source_hash:
        raise SystemExit('原 PDF 与现有 OCR 来源不一致；请在新目录重新 OCR，不能用旧 OCR 重建新原件索引。')
reader = PdfReader(SOURCE)
if len(reader.pages) != 495:
    raise SystemExit('页码映射仅适用于本版 495 页原件。')
count = len(reader.pages)
records = [json.loads((ROOT / 'OCR' / f'{n:04}.json').read_text()) for n in range(1, count + 1)]
assert [r['pdf_page'] for r in records] == list(range(1, count + 1))
entries = []
for line in (ROOT / '目录校准.tsv').read_text().splitlines():
    if not line or line.startswith('#'): continue
    key, title, page = line.split('|')
    entries.append(dict(id=key, title=title, book_page=int(page), pdf_page=int(page)+14,
                        level=2 if '-' in key else key.count('.')+1, source='printed_contents_pdf_11_14'))
assert len({e['id'] for e in entries}) == len(entries)
assert all(a['pdf_page'] <= b['pdf_page'] for a,b in zip(entries,entries[1:]))
chapters = [dict(id='front',title='封面、版权、前言与目录',pdf_page=1,book_page=None,level=1)] + [e.copy() for e in entries if e['level']==1 and '-' not in e['id']]
chapters.append(dict(id='back',title='封底',pdf_page=495,book_page=None,level=1))
for i,c in enumerate(chapters):
    c['pdf_end'] = chapters[i+1]['pdf_page']-1 if i+1<len(chapters) else count
    c['file'] = f"章节/{i:02}-{c['title'].replace('/', '／')}.md"
for i,e in enumerate(entries):
    c=next(c for c in chapters if c['pdf_page']<=e['pdf_page']<=c['pdf_end'])
    # Include the next heading's page: different sections can share a page.
    boundary=next((x['pdf_page'] for x in entries[i+1:] if x['level']<=e['level']),c['pdf_end'])
    e['pdf_end']=c['pdf_end'] if e['level']==1 else min(c['pdf_end'], max(e['pdf_page'],boundary))
    e['file']=c['file']
    e['anchor']=f"pdf-{e['pdf_page']:04}"
(ROOT/'章节').mkdir(exist_ok=True)
page_rows=[]
for c in chapters:
    text=[f"# {c['title']}", '', '> 本文是扫描件 OCR 检索文本，未逐字校对。公式、上划线、上下标、代码、图表及双栏顺序以原 PDF 为准。', '', f"PDF 页序 {c['pdf_page']}-{c['pdf_end']}（从 1 开始）。", '']
    for n in range(c['pdf_page'],c['pdf_end']+1):
        r=records[n-1]
        # Normal body/index page labels use the verified +14 offset.
        book=n-14 if 15<=n<=494 else None
        label=f'书上第 {book} 页' if book is not None else '前置资料或书后附页'
        text += [f'<a id="pdf-{n:04}"></a>',f'## {label} · PDF 第 {n} 页','']
        headings=[e for e in entries if e['pdf_page']==n]
        if headings: text += ['目录定位：'+'；'.join(e['id']+' '+e['title'] for e in headings),'']
        text += [r['text'], '']
        candidates=[x['text'] for x in r['lines'] if x['bbox'][1]>.93 and re.fullmatch(r'\d{1,3}',x['text'].strip())]
        page_rows.append(dict(pdf_page=n,book_page=book,chapter=c['id'],chapter_title=c['title'],file=c['file'],anchor=f'pdf-{n:04}',characters=len(r['text']),lines=len(r['lines']),header_number_candidates=candidates,header_matches_expected=str(book) in candidates if book else None))
    (ROOT/c['file']).write_text('\n'.join(text))
(ROOT/'目录.json').write_text(json.dumps(entries,ensure_ascii=False,indent=2)+'\n')
(ROOT/'页码映射.json').write_text(json.dumps(page_rows,ensure_ascii=False,indent=2)+'\n')
with (ROOT/'页码映射.csv').open('w') as f:
    w=csv.DictWriter(f,fieldnames=['pdf_page','book_page','chapter','chapter_title','file','anchor']);w.writeheader();w.writerows({k:r[k] for k in w.fieldnames} for r in page_rows)
md=['# 校准目录','','依据书内目录（PDF 第 11-14 页）转录，弃用原 PDF 的错误书签。PDF 页序从 1 开始；正文书页 +14。范围包含下一节所在页，以免漏掉同页结尾。','','| 编号 | 标题 | 书上起始页 | PDF 起始页 |','| --- | --- | ---: | ---: |']
for e in entries: md.append(f"| {e['id']} | [{e['title']}](<{e['file']}#{e['anchor']}>) | {e['book_page']} | {e['pdf_page']} |")
(ROOT/'目录.md').write_text('\n'.join(md)+'\n')
original=[]
def visit(items,depth=1):
    for item in items:
        if isinstance(item,list): visit(item,depth+1)
        else: original.append(dict(title=item.title,pdf_page=reader.get_destination_page_number(item)+1,level=depth,status='untrusted_original_bookmark'))
visit(reader.outline)
(ROOT/'原始书签-仅供审计.json').write_text(json.dumps(original,ensure_ascii=False,indent=2)+'\n')
manifest=dict(source_file='../'+SOURCE.name,source_sha256=source_hash,source_bytes=SOURCE.stat().st_size,pdf_pages=count,ocr_pages=len(records),toc_entries=len(entries),chapter_files=len(chapters),ocr_engine='Apple Vision VNRecognizeTextRequest (accurate, zh-Hans/en-US)',ocr_language_correction=True,ocr_text_status='uncorrected; not a faithful mathematical or layout transcription',bbox_coordinates='normalized [x,y,width,height], origin bottom-left',generated_date='2026-10-24',page_mapping='book 1-480 = PDF 15-494; PDF 495 back cover')
artifact_paths = sorted((ROOT/'OCR').glob('*.json')) + sorted((ROOT/'章节').glob('*.md'))
artifact_paths += [ROOT/name for name in ['目录.json','目录.md','页码映射.json','页码映射.csv','原始书签-仅供审计.json','目录校准.tsv']]
manifest['artifacts_sha256'] = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in artifact_paths}
manifest['schema_version'] = 2
(ROOT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(pages=count,entries=len(entries),chapters=len(chapters),characters=sum(r['characters'] for r in page_rows),short_pages=[r['pdf_page'] for r in page_rows if r['characters']<80],header_matches=sum(r['header_matches_expected'] is True for r in page_rows)),ensure_ascii=False))
