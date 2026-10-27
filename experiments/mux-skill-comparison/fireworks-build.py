#!/usr/bin/env python3
"""Build the Fireworks comparison artifact from the unchanged shared brief.

Uses the upstream Fireworks 1.2.0 CLI for validation, rendering and both exports.
Only adds a local CJK font preference and visible source notes to the generated SVG.
All files written beside this script start with fireworks-.
"""
from __future__ import annotations

import hashlib
from html.parser import HTMLParser
import itertools
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

OUT = Path(__file__).resolve().parent
source = os.environ.get('FIREWORKS_SOURCE')
if not source:
    raise SystemExit('External Fireworks 1.2.0 source required: set FIREWORKS_SOURCE to its directory (scripts/fireworks.py and .venv/bin/python), optionally FIREWORKS_PYTHON.')
SKILL = Path(source).expanduser().resolve()
CLI = SKILL / 'scripts/fireworks.py'
PYTHON = Path(os.environ.get('FIREWORKS_PYTHON', str(SKILL / '.venv/bin/python'))).expanduser().resolve()
if not CLI.is_file() or not PYTHON.is_file():
    raise SystemExit(f'External Fireworks source/runtime missing: {CLI}, {PYTHON}. Set FIREWORKS_SOURCE and optionally FIREWORKS_PYTHON; nothing has been generated.')
BRIEF = OUT / 'brief.json'
brief_bytes = BRIEF.read_bytes()
b = json.loads(brief_bytes)
brief_sha = hashlib.sha256(brief_bytes).hexdigest()
env = dict(os.environ)
env['DYLD_FALLBACK_LIBRARY_PATH'] = '/opt/homebrew/opt/cairo/lib'
commands = []


def save_json(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def official(*args):
    argv = [str(PYTHON), str(CLI), *map(str, args)]
    result = subprocess.run(argv, capture_output=True, text=True, env=env)
    try:
        response = json.loads(result.stdout)
    except json.JSONDecodeError:
        response = result.stdout
    commands.append({'argv': argv, 'exit_code': result.returncode,
                     'result': response, 'stderr': result.stderr})
    save_json('fireworks-checks.json', {'brief_sha256': brief_sha, 'commands': commands})
    print(args[0], result.returncode, flush=True)
    if result.returncode:
        print(result.stdout, result.stderr, file=sys.stderr)
        raise SystemExit(result.returncode)
    return response


def node(identifier, x, y, width, height, label, **kwargs):
    return {'id': identifier, 'kind': 'rect', 'x': x, 'y': y,
            'width': width, 'height': height, 'label': label,
            'flat': True, **kwargs}


groups = []
for i, g in enumerate(b['groups']):
    groups.append(node(f'group-{g["xy"]}', 64 + 344 * i, 170, 280, 104,
                       g['input'], title_size=25, type_label=f'xy = {g["xy"]}',
                       sublabel=f'F(z=0) = {g["F_z0"]}  ·  F(z=1) = {g["F_z1"]}',
                       fill='#eff6ff', stroke='#93c5fd'))

concept_ids = dict(zip(b['concepts'], ['truth-table', 'grouping', 'mux-rule', 'realize']))
concept_positions = {
    'truth-table': (80, 645, 250, 70),
    'grouping': (510, 645, 300, 70),
    'mux-rule': (510, 760, 300, 70),
    'realize': (1110, 645, 250, 70),
}
concept_nodes = [node(concept_ids[label], *concept_positions[concept_ids[label]],
                      label, fill='#f8fafc', stroke='#cbd5e1', title_size=20)
                 for label in b['concepts']]
prerequisite_edges = []
for i, relation in enumerate(b['prerequisites']):
    src, dst = concept_ids[relation['from']], concept_ids[relation['to']]
    prerequisite_edges.append({
        'id': f'prerequisite-{i+1}', 'source': src, 'target': dst,
        'source_port': 'right', 'target_port': 'bottom' if src == 'mux-rule' else 'left',
        'label': relation['label'], 'flow': 'neutral', 'label_style': 'offset',
    })

selector_text = ' · '.join(f'{k} = {v}' for k, v in b['selectors'].items())
mapping_text = ' · '.join(f'{g["xy"]}→{g["input"].split(" = ")[0]}' for g in b['groups'])
ir = {
    'schema_version': 1, 'mode': 'architecture', 'template_type': 'architecture',
    'diagram_type': 'MUX explanation and concept prerequisites',
    'semantic_profile': 'generic', 'style': 1,
    'quality_profile': 'showcase', 'text_policy': 'strict',
    'width': 1440, 'height': 1040,
    'title': b['title'], 'subtitle': b['function'] + '  ·  变量顺序：' + ', '.join(b['variable_order']),
    'containers': [
        {'id': 'assignments', 'x': 40, 'y': 120, 'width': 1360, 'height': 185,
         'label': '01  四组赋值', 'sublabel': '固定 xy，分别代入 z = 0 与 z = 1'},
        {'id': 'selection', 'x': 40, 'y': 345, 'width': 1360, 'height': 200,
         'label': '02  MUX 选择机制'},
        {'id': 'concepts', 'x': 40, 'y': 590, 'width': 1360, 'height': 260,
         'label': '03  简洁概念依赖'},
    ],
    'nodes': groups + [
        node('selectors', 80, 405, 280, 100, selector_text,
             title_size=23, sublabel='xy 决定选中哪个数据端', fill='#faf5ff', stroke='#c4b5fd'),
        node('mux', 560, 405, 320, 100, '4 选 1 MUX',
             title_size=26, sublabel=mapping_text, fill='#eff6ff', stroke='#93c5fd'),
        node('output', 1080, 405, 280, 100, 'F(x,y,z)',
             title_size=26, sublabel='输出当前选中的数据端', fill='#f0fdf4', stroke='#86efac'),
    ] + concept_nodes,
    'arrows': [
        {'id': 'select-signal', 'source': 'selectors', 'target': 'mux',
         'source_port': 'right', 'target_port': 'left', 'flow': 'control',
         'label': '选择端', 'label_style': 'offset', 'dashed': True},
        {'id': 'selected-data', 'source': 'mux', 'target': 'output',
         'source_port': 'right', 'target_port': 'left', 'flow': 'read',
         'label': '所选数据', 'label_style': 'offset'},
    ] + prerequisite_edges,
    'legend_orientation': 'horizontal', 'legend_x': 64, 'legend_y': 884,
    'legend_locked': True,
    'legend': [{'flow': 'control', 'label': '选择信号'},
               {'flow': 'read', 'label': '输出数据'},
               {'flow': 'neutral', 'label': '概念依赖'}],
    'footer': b['takeaway'], 'footer_x': 64, 'footer_y': 934,
    'course_evidence': {'sources': b['sources'], 'source_note': b['source_note']},
    'source_brief_sha256': brief_sha,
    'source_brief': b,
}
save_json('fireworks-ir.json', ir)

version = official('version')
official('validate', 'architecture', OUT / 'fireworks-ir.json')
official('render', 'architecture', OUT / 'fireworks-ir.json', OUT / 'fireworks-mux.svg',
         '--report', OUT / 'fireworks-layout.json')

# Native SVG adaptation permitted by SKILL.md: prefer a verified local CJK font,
# retain upstream palette/topology/semantic roles, and add the exact brief sources.
svg_file = OUT / 'fireworks-mux.svg'
svg = svg_file.read_text()
svg = svg.replace("font-family: 'Helvetica Neue'", "font-family: 'Heiti SC', 'Helvetica Neue'")
NS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', NS)
root = ET.fromstring(svg)
description = ET.Element(f'{{{NS}}}desc')
description.text = b['source_note']
root.insert(0, description)
evidence = ET.SubElement(root, f'{{{NS}}}g', {
    'id': 'course-evidence', 'data-graph-role': 'reserved',
    'data-graph-bounds': '64,950,1376,1014',
})
for y, text in [(969, '来源：' + '；'.join(b['sources'])), (999, b['source_note'])]:
    el = ET.SubElement(evidence, f'{{{NS}}}text', {
        'x': '64', 'y': str(y), 'font-size': '13', 'fill': '#4b5563',
        'data-full-text': text, 'data-text-max-width': '1312',
    })
    el.text = text
svg_file.write_text(ET.tostring(root, encoding='unicode') + '\n')

official('check', svg_file)
official('export-png', svg_file, OUT / 'fireworks-mux.png', '--width', '2160')
official('export-html', svg_file, OUT / 'fireworks-mux.html', '--title', b['title'])

# This is a semantic check of the shared mathematics, separate from SVG geometry.
minterms = {int(n) for n in re.search(r'Σm\((.*?)\)', b['function']).group(1).split(',')}
truth_rows = []
for x, y, z in itertools.product((0, 1), repeat=3):
    expression = b['data_inputs'][f'I{2*x+y}']
    actual = {'z': z, '¬z': 1-z, '0': 0, '1': 1}[expression]
    expected = int(4*x+2*y+z in minterms)
    group = next(g for g in b['groups'] if g['xy'] == f'{x}{y}')
    grouped = group[f'F_z{z}']
    truth_rows.append({'x': x, 'y': y, 'z': z, 'selected': f'I{2*x+y}',
                       'expression': expression, 'function': expected,
                       'mux_output': actual, 'group_value': grouped,
                       'pass': actual == expected == grouped})
assert all(row['pass'] for row in truth_rows)
visible_text = '\n'.join(''.join(e.itertext()) for e in root.iter(f'{{{NS}}}text'))
required = [b['title'], b['function'], b['takeaway'], b['source_note'],
            *b['sources'], *b['concepts'], *[g['input'] for g in b['groups']],
            *[r['label'] for r in b['prerequisites']]]
missing = [text for text in required if text not in visible_text]
assert not missing, missing
assert BRIEF.read_bytes() == brief_bytes
from PIL import Image
with Image.open(OUT / 'fireworks-mux.png') as img:
    img.load()
    png_size = list(img.size)
html = (OUT / 'fireworks-mux.html').read_text()
assert '<svg' in html and '</html>' in html


class HtmlAudit(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_script = False
        self.scripts = []
        self.external = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script':
            self.in_script = True
        if tag in {'script', 'img', 'link', 'iframe'}:
            for key in ('src', 'href'):
                if key in attrs:
                    self.external.append(attrs[key])

    def handle_endtag(self, tag):
        if tag == 'script':
            self.in_script = False

    def handle_data(self, data):
        if self.in_script:
            self.scripts.append(data)


audit = HtmlAudit()
audit.feed(html)
assert not audit.external, audit.external
syntax = subprocess.run(['node', '--check', '--input-type=module'],
                        input='\n'.join(audit.scripts), capture_output=True, text=True)
assert syntax.returncode == 0, syntax.stderr
from fontTools.ttLib import TTCollection
with TTCollection('/System/Library/Fonts/STHeiti Medium.ttc') as fonts:
    cmap = fonts.fonts[1].getBestCmap()
    missing_glyphs = sorted({ch for ch in visible_text if not ch.isspace() and ord(ch) not in cmap})
assert not missing_glyphs, missing_glyphs
save_json('fireworks-verification.json', {
    'brief_sha256': brief_sha, 'brief_unchanged': True, 'truth_table': truth_rows,
    'all_eight_inputs_pass': True, 'missing_visible_brief_text': missing,
    'svg_size': [1440, 1040], 'png_size': png_size,
    'upstream': version,
    'font_preference': 'Heiti SC; system STHeiti Medium.ttc, face 1',
    'missing_glyphs_in_selected_font': missing_glyphs,
    'html_static_checks': {'external_resource_elements': audit.external,
                           'inline_script_syntax_exit_code': syntax.returncode},
    'post_generation_adaptations': ['CJK font preference', 'exact visible source notes'],
    'source_preservation': 'unchanged brief embedded in fireworks-ir.json',
    'browser_automation': 'not used; HTML interaction delegated to main thread CUA',
    'visual_review': 'pending PNG inspection',
})
print('Completed: SVG, PNG, offline HTML, IR, layout and verification reports.')
