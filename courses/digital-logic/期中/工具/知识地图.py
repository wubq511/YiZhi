#!/usr/bin/env python3
import argparse
import copy
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import 地图生成
import 复习内容

BASE = Path(__file__).resolve().parents[1]
ROOT = BASE.parent
DATA_PATH = BASE / '数据/知识地图.json'
LAYOUT_PATH = BASE / '数据/视图布局.json'


class MapError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


def require(condition, code, message, details=None):
    if not condition:
        raise MapError(code, message, details)


def load_data(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        raise MapError('missing_data', f'权威数据不存在：{path}')
    except json.JSONDecodeError as exc:
        raise MapError('invalid_json', f'权威数据不是合法 JSON：{exc}')


def unique(records, key, label, errors):
    seen = set()
    for item in records:
        value = item.get(key)
        if not value:
            errors.append(f'{label}缺少 {key}')
        elif value in seen:
            errors.append(f'{label}重复：{value}')
        seen.add(value)


def valid_ref(ref, sources, label, errors):
    sid = ref.get('sourceId')
    if sid not in sources:
        errors.append(f'{label}来源悬空：{sid}')
        return
    source = sources[sid]
    version_id = ref.get('versionId')
    version = next((item for item in source.get('versions', []) if item['id'] == version_id), None)
    if version_id and version is None:
        errors.append(f'{label}版本不匹配：{sid}:{version_id}')
    if ref.get('visualStatus') == 'unverified':
        errors.append(f'{label}存在未核实来源')
    if source['type'] == 'course-note':
        if not ref.get('section'):
            errors.append(f'{label}课程笔记缺少真实小节')
        return
    pages = ref.get('pdfPages')
    if not isinstance(pages, list) or not pages:
        errors.append(f'{label}缺少 PDF 页码')
        return
    page_count = version.get('totalPages', source['totalPages']) if version else source['totalPages']
    for page in pages:
        if not isinstance(page, int) or not 1 <= page <= page_count:
            errors.append(f'{label}页码越界：{sid}:{page}')
    if source['type'] == 'textbook' and 'bookPages' in ref:
        book = ref['bookPages']
        if not isinstance(book, list) or len(book) != len(pages):
            errors.append(f'{label}教材书页与 PDF 页数量不一致')


class Store:
    def __init__(self, data, root=None):
        self.data = data
        self.root = Path(root) if root is not None else ROOT
        self.sources = {x['id']: x for x in data['sources']}
        self.themes = {x['id']: x for x in data['themes']}
        self.units = {x['id']: x for x in data['units']}
        self.questions = {x['id']: x for x in data['questions']}
        self.relations = {x['id']: x for x in data['relations']}
        self.reference_items = {x['id']: x for x in data['referenceItems']}
        self.groups = {x['id']: x for x in data['requirementGroups']}
        self.mappings = data['mappings']
        self.coverage = {x['questionId']: x for x in data['questionCoverage']}
        self.by_unit = defaultdict(list)
        self.by_question = defaultdict(list)
        for mapping in self.mappings:
            self.by_unit[mapping['unitId']].append(mapping)
            self.by_question[mapping['questionId']].append(mapping)

    @property
    def hash(self):
        return 地图生成.source_hash(self.data)

    def unit_summary(self, uid):
        unit = self.units[uid]
        return {
            'id': uid,
            'name': unit['name'],
            'kind': unit['kind'],
            'themeId': unit['themeId'],
            'themeName': self.themes[unit['themeId']]['name'],
            'stars': unit['rating']['stars'],
            'questionTypes': unit['questionTypes'],
        }

    def mapping_detail(self, mapping):
        question = self.questions[mapping['questionId']]
        return {
            **copy.deepcopy(mapping),
            'question': copy.deepcopy(question),
            'unit': self.unit_summary(mapping['unitId']),
        }

    def unit_detail(self, uid):
        unit = copy.deepcopy(self.units[uid])
        unit['theme'] = copy.deepcopy(self.themes[unit['themeId']])
        mappings = sorted(self.by_unit[uid], key=lambda x: (x['role'] != 'direct', x['id']))
        unit['questions'] = [self.mapping_detail(x) for x in mappings]
        unit['relations'] = [
            copy.deepcopy(x) for x in self.data['relations']
            if uid in (x['fromUnitId'], x['toUnitId'])
        ]
        return unit

    def theme_detail(self, tid):
        theme = copy.deepcopy(self.themes[tid])
        members = [self.unit_summary(x['id']) for x in self.data['units'] if x['themeId'] == tid]
        dist = Counter(x['stars'] for x in members)
        theme['units'] = members
        theme['unitPeak'] = max(dist) if dist else None
        theme['unitDistribution'] = {str(i): dist.get(i, 0) for i in range(1, 6)}
        return theme

    def question_detail(self, qid):
        question = copy.deepcopy(self.questions[qid])
        question['coverage'] = copy.deepcopy(self.coverage.get(qid))
        question['mappings'] = [self.mapping_detail(x) for x in self.by_question[qid]]
        return question

    def relation_detail(self, rid):
        relation = copy.deepcopy(self.relations[rid])
        relation['fromUnit'] = self.unit_summary(relation['fromUnitId'])
        relation['toUnit'] = self.unit_summary(relation['toUnitId'])
        if relation.get('requirementGroupId'):
            relation['requirementGroup'] = copy.deepcopy(self.groups[relation['requirementGroupId']])
        return relation

    def get(self, ident):
        if ident in self.themes:
            return self.theme_detail(ident)
        if ident in self.units:
            return self.unit_detail(ident)
        if ident in self.questions:
            return self.question_detail(ident)
        if ident in self.relations:
            return self.relation_detail(ident)
        if ident in self.reference_items:
            item = copy.deepcopy(self.reference_items[ident])
            item['relatedUnits'] = [self.unit_summary(x) for x in item['relatedUnitIds']]
            return item
        if ident in self.sources:
            return copy.deepcopy(self.sources[ident])
        if ident in self.groups:
            return copy.deepcopy(self.groups[ident])
        raise MapError('not_found', f'找不到实体：{ident}', {'id': ident})

    def search(self, text='', entity='unit', lesson=None, theme=None, question_type=None,
               kind=None, stars=None, min_stars=None, limit=20):
        require(entity in {'unit', 'theme', 'question', 'relation', 'all'}, 'invalid_parameter', f'未知搜索类型：{entity}')
        require(isinstance(limit, int) and limit >= 0, 'invalid_parameter', 'limit 必须是不小于 0 的整数')
        if stars is not None:
            require(1 <= stars <= 5, 'invalid_parameter', 'stars 必须在 1–5 之间')
        if min_stars is not None:
            require(1 <= min_stars <= 5, 'invalid_parameter', 'min-stars 必须在 1–5 之间')
        needle = text.strip().casefold()
        records = []
        if entity in {'unit', 'all'}:
            records.extend(('unit', x) for x in self.data['units'])
        if entity in {'theme', 'all'}:
            records.extend(('theme', x) for x in self.data['themes'])
        if entity in {'question', 'all'}:
            records.extend(('question', x) for x in self.data['questions'])
        if entity in {'relation', 'all'}:
            records.extend(('relation', x) for x in self.data['relations'])
        results = []
        for entity_type, item in records:
            if entity_type == 'unit':
                if lesson and item['themeId'] and self.themes[item['themeId']]['lessonId'] != lesson:
                    continue
                if theme and item['themeId'] != theme and self.themes[item['themeId']]['name'] != theme:
                    continue
                if question_type and question_type not in item['questionTypes']:
                    continue
                if kind and item['kind'] != kind:
                    continue
                if stars is not None and item['rating']['stars'] != stars:
                    continue
                if min_stars is not None and item['rating']['stars'] < min_stars:
                    continue
                name = item['name']
                aliases = item.get('aliases', [])
                outcome = item.get('outcome', '')
                rating = item['rating']['stars']
                extra = {'themeId': item['themeId'], 'kind': item['kind'], 'stars': rating,
                         'questionTypes': item['questionTypes'], 'sourceRefs': item['sourceRefs']}
            elif entity_type == 'theme':
                if lesson and item['lessonId'] != lesson:
                    continue
                if theme and item['id'] != theme and item['name'] != theme:
                    continue
                if stars is not None and item['rating']['stars'] != stars:
                    continue
                if min_stars is not None and item['rating']['stars'] < min_stars:
                    continue
                name, aliases, outcome = item['name'], [], item.get('coreOutcome', '')
                extra = {'lessonId': item['lessonId'], 'stars': item['rating']['stars'],
                         'coreOutcome': item['coreOutcome']}
            elif entity_type == 'question':
                if question_type and question_type not in item['questionTypes']:
                    continue
                name, aliases, outcome = item['label'], [], item.get('taskSummary', '')
                extra = {'sourceId': item['sourceId'], 'questionTypes': item['questionTypes'],
                         'sourceRefs': item['sourceRefs']}
            else:
                if kind and item['type'] != kind:
                    continue
                name = f"{self.units[item['fromUnitId']]['name']} → {self.units[item['toUnitId']]['name']}"
                aliases, outcome = [], item.get('value', '')
                extra = {'relationType': item['type'], 'view': item['view'],
                         'fromUnitId': item['fromUnitId'], 'toUnitId': item['toUnitId']}
            candidates = [('id', item['id']), ('name', name), * [('alias', x) for x in aliases],
                          ('outcome', outcome)]
            match = None
            for field, value in candidates:
                if needle and needle in str(value).casefold():
                    match = (field, value)
                    break
            if needle and not match:
                continue
            if match:
                field, value = match
                rank = 0 if field == 'id' and needle == str(value).casefold() else 1 if field == 'name' and needle == str(value).casefold() else 2 if field == 'name' else 3 if field == 'alias' else 4
            else:
                field, value, rank = 'all', '', 5
            results.append({'id': item['id'], 'type': entity_type, 'name': name,
                            'matchField': field, 'matchText': value, **extra,
                            '_rank': rank})
        results.sort(key=lambda x: (x['_rank'], x['type'], x['id']))
        if limit:
            results = results[:limit]
        for item in results:
            item.pop('_rank', None)
        return {'query': text, 'count': len(results), 'items': results}

    def filtered_relations(self, relation_type, view):
        require(relation_type in {'requires', 'constructs', 'improves', 'inverse', 'all'},
                'invalid_parameter', f'未知关系类型：{relation_type}', {'relationType': relation_type})
        require(view in {'main', 'auxiliary', 'all'}, 'invalid_parameter', f'未知视图：{view}')
        relations = [x for x in self.data['relations'] if x['status'] == 'approved']
        if view != 'all':
            relations = [x for x in relations if x['view'] == view]
        if relation_type != 'all':
            relations = [x for x in relations if x['type'] == relation_type]
        return relations

    def related(self, uid, relation_type='requires', direction='upstream', depth=1, view='all'):
        require(uid in self.units, 'not_found', f'找不到知识单元：{uid}')
        require(direction in {'upstream', 'downstream'}, 'invalid_parameter', 'direction 只能是 upstream 或 downstream')
        require(isinstance(depth, int) and depth >= -1, 'invalid_parameter', 'depth 必须是 -1 或不小于 0 的整数')
        if relation_type != 'requires':
            require(depth == 1, 'invalid_parameter', '非 requires 关系只支持 depth=1，避免把结构关联误当前置闭包')
        relations = self.filtered_relations(relation_type, view)
        outgoing = defaultdict(list)
        incoming = defaultdict(list)
        for relation in relations:
            outgoing[relation['fromUnitId']].append(relation)
            incoming[relation['toUnitId']].append(relation)
        adjacency = outgoing if direction == 'downstream' else incoming
        nodes = {uid: 0}
        edges = {}
        queue = [uid]
        while queue:
            current = queue.pop(0)
            if depth != -1 and nodes[current] >= depth:
                continue
            for relation in adjacency.get(current, []):
                other = relation['toUnitId'] if direction == 'downstream' else relation['fromUnitId']
                edges[relation['id']] = relation
                if other not in nodes:
                    nodes[other] = nodes[current] + 1
                    queue.append(other)
        prerequisites = [x for x in edges.values() if x['type'] == 'requires']
        group_ids = {x['requirementGroupId'] for x in prerequisites if x.get('requirementGroupId')}
        conditions = {}
        for target in sorted({x['toUnitId'] for x in prerequisites}):
            incoming_edges = [x for x in prerequisites if x['toUnitId'] == target]
            conditions[target] = {
                'required': sorted({x['fromUnitId'] for x in incoming_edges if not x.get('requirementGroupId')}),
                'groups': sorted({x['requirementGroupId'] for x in incoming_edges if x.get('requirementGroupId')}),
            }
        items = [self.unit_summary(x) | {'depth': d} for x, d in sorted(nodes.items(), key=lambda p: (p[1], p[0]))]
        return {
            'root': self.unit_summary(uid), 'relationType': relation_type,
            'direction': direction, 'depth': depth, 'view': view,
            'nodes': items,
            'edges': [copy.deepcopy(edges[x]) for x in sorted(edges)],
            'conditions': conditions,
            'requirementGroups': [copy.deepcopy(self.groups[x]) for x in sorted(group_ids)],
        }

    def path(self, start, target, relation_type='requires', view='all', limit=5):
        require(start in self.units, 'not_found', f'找不到起点：{start}')
        require(target in self.units, 'not_found', f'找不到终点：{target}')
        require(1 <= limit <= 20, 'invalid_parameter', 'path limit 必须在 1–20 之间')
        relations = self.filtered_relations(relation_type, view)
        adjacency = defaultdict(list)
        for relation in relations:
            adjacency[relation['fromUnitId']].append((relation['toUnitId'], relation['id']))
        paths = []
        queue = [(start, [start], [])]
        while queue and len(paths) < limit:
            node, nodes, edge_ids = queue.pop(0)
            if node == target:
                paths.append({'nodes': nodes, 'edges': edge_ids})
                continue
            for nxt, rid in adjacency.get(node, []):
                if nxt in nodes:
                    continue
                queue.append((nxt, nodes + [nxt], edge_ids + [rid]))
        return {
            'from': self.unit_summary(start), 'to': self.unit_summary(target),
            'relationType': relation_type, 'view': view,
            'paths': [
                {'nodes': [self.unit_summary(x) for x in path['nodes']],
                 'edges': [copy.deepcopy(self.relations[x]) for x in path['edges']]}
                for path in paths
            ],
        }

    def question_mappings(self, uid, role='all', source=None):
        require(uid in self.units, 'not_found', f'找不到知识单元：{uid}')
        require(role in {'all', 'direct', 'support'}, 'invalid_parameter', 'role 只能是 all、direct 或 support')
        mappings = [x for x in self.by_unit[uid] if role == 'all' or x['role'] == role]
        if source:
            mappings = [x for x in mappings if self.questions[x['questionId']]['sourceId'] == source]
        items = [self.mapping_detail(x) for x in sorted(mappings, key=lambda x: x['id'])]
        return {
            'unit': self.unit_summary(uid), 'role': role,
            'counts': dict(Counter(x['role'] for x in items)),
            'items': items,
        }

    def graph(self, view='main'):
        relations = self.filtered_relations('all', view)
        nodes = [self.unit_summary(x['id']) for x in self.data['units']]
        groups = []
        for theme in self.data['themes']:
            detail = self.theme_detail(theme['id'])
            groups.append({
                'id': theme['id'], 'name': theme['name'], 'lessonId': theme['lessonId'],
                'coreOutcome': theme['coreOutcome'], 'rating': theme['rating'],
                'unitPeak': detail['unitPeak'], 'unitDistribution': detail['unitDistribution'],
            })
        theme_edges = defaultdict(list)
        for relation in relations:
            source_theme = self.units[relation['fromUnitId']]['themeId']
            target_theme = self.units[relation['toUnitId']]['themeId']
            if source_theme != target_theme:
                theme_edges[(source_theme, target_theme, relation['type'])].append(relation['id'])
        aggregated = [
            {'fromThemeId': key[0], 'toThemeId': key[1], 'type': key[2],
             'relationIds': sorted(ids), 'count': len(ids)}
            for key, ids in sorted(theme_edges.items())
        ]
        layout_path = Path(os.environ.get('MIDTERM_LAYOUT_FILE', str(LAYOUT_PATH)))
        layout = (json.loads(layout_path.read_text(encoding='utf-8')) if layout_path.exists()
                  else 地图生成.default_layout(self.data))
        return {
            'sourceHash': self.hash, 'view': view,
            'nodes': nodes, 'groups': groups,
            'edges': [copy.deepcopy(x) for x in relations],
            'themeEdges': aggregated, 'layout': layout,
            'counts': {'units': len(nodes), 'themes': len(groups), 'relations': len(relations)},
        }

    def validate(self):
        errors = []
        required = ['sources', 'themes', 'units', 'questions', 'referenceItems', 'mappings',
                    'questionCoverage', 'relations', 'requirementGroups', 'retiredUnits']
        for key in required:
            if key not in self.data:
                errors.append(f'缺少顶层字段：{key}')
        require(not errors, 'invalid_schema', '权威数据结构不完整', {'errors': errors})
        if self.data.get('schemaVersion') != 'midterm-map-1':
            errors.append('schemaVersion 必须为 midterm-map-1')
        if self.data.get('status') != 'active':
            errors.append('权威数据 status 必须为 active')
        unique(self.data['sources'], 'id', '来源', errors)
        version_ids = set()
        for source in self.data['sources']:
            path = self.root / source['path']
            if not path.exists():
                errors.append(f"来源文件不存在：{source['id']} {source['path']}")
            for version in source.get('versions', []):
                identifier = version.get('id')
                if not identifier or not identifier.startswith('VER-'):
                    errors.append(f"资料版本 ID 非法：{source['id']}:{identifier}")
                elif identifier in version_ids:
                    errors.append(f"资料版本 ID 重复：{identifier}")
                version_ids.add(identifier)
                if not isinstance(version.get('sha256'), str) or len(version['sha256']) != 64:
                    errors.append(f"资料版本摘要非法：{identifier}")
                if not isinstance(version.get('displayName'), str) or not version['displayName']:
                    errors.append(f"资料版本显示名为空：{identifier}")
                if type(version.get('totalPages')) is not int or version['totalPages'] < 0:
                    errors.append(f"资料版本页数非法：{identifier}")
                version_path = self.root / version.get('path', '')
                if not version.get('path') or not version_path.exists():
                    errors.append(f"资料版本资源缺失：{identifier} {version.get('path')}")
        unique(self.data['themes'], 'id', '主题', errors)
        unique(self.data['units'], 'id', '知识单元', errors)
        unique(self.data['questions'], 'id', '题目', errors)
        unique(self.data['referenceItems'], 'id', '参考条目', errors)
        unique(self.data['mappings'], 'id', '题目映射', errors)
        unique(self.data['relations'], 'id', '知识关系', errors)
        for theme in self.data['themes']:
            if not theme.get('coreOutcome'):
                errors.append(f"主题缺少核心学习表现：{theme['id']}")
            rating = theme.get('rating', {})
            if not isinstance(rating.get('stars'), int) or not 1 <= rating['stars'] <= 5:
                errors.append(f"主题星级非法：{theme['id']}")
            if not rating.get('rationale'):
                errors.append(f"主题缺少评级理由：{theme['id']}")
        for unit in self.data['units']:
            if unit['themeId'] not in self.themes:
                errors.append(f"单元主题悬空：{unit['id']}")
            if unit['kind'] not in {'concept', 'method', 'module'}:
                errors.append(f"单元类型非法：{unit['id']}")
            for field in ['name', 'outcome', 'summary', 'questionTypes', 'sourceRefs']:
                if not unit.get(field):
                    errors.append(f"单元 {unit['id']} 缺少 {field}")
            rating = unit.get('rating', {})
            if not isinstance(rating.get('stars'), int) or not 1 <= rating['stars'] <= 5:
                errors.append(f"单元星级非法：{unit['id']}")
            if not rating.get('rationale'):
                errors.append(f"单元缺少评级理由：{unit['id']}")
            for ref in unit['sourceRefs']:
                valid_ref(ref, self.sources, f"单元 {unit['id']}", errors)
        for question in self.data['questions']:
            if question.get('parentId') and question['parentId'] not in self.questions:
                errors.append(f"父题悬空：{question['id']}")
            for ref in question.get('sourceRefs', []):
                valid_ref(ref, self.sources, f"题目 {question['id']}", errors)
            if question['kind'] == 'homework' and question.get('hasOfficialAnswer'):
                errors.append(f"普通作业官方答案标记错误：{question['id']}")
        for item in self.data['referenceItems']:
            related = item.get('relatedUnitIds', [])
            if len(related) != len(set(related)):
                errors.append(f"参考条目重复关联：{item['id']}")
            for uid in related:
                if uid not in self.units:
                    errors.append(f"参考条目单元悬空：{item['id']} {uid}")
        seen = set()
        for mapping in self.mappings:
            if mapping['questionId'] not in self.questions:
                errors.append(f"映射题目悬空：{mapping['id']}")
            if mapping['unitId'] not in self.units:
                errors.append(f"映射单元悬空：{mapping['id']}")
            if mapping['role'] not in {'direct', 'support'}:
                errors.append(f"映射角色非法：{mapping['id']}")
            if mapping['basis'] not in {'stem', 'official-solution', 'agent-analysis'}:
                errors.append(f"映射依据非法：{mapping['id']}")
            key = (mapping['questionId'], mapping['unitId'], mapping['role'])
            if key in seen:
                errors.append(f"重复映射：{key}")
            seen.add(key)
            question = self.questions[mapping['questionId']]
            if question['kind'] == 'homework' and mapping['basis'] == 'official-solution':
                errors.append(f"普通作业冒充官方答案：{mapping['id']}")
        for row in self.data['questionCoverage']:
            actual = Counter(x['role'] for x in self.by_question[row['questionId']])
            if row['directCount'] != actual['direct'] or row['supportCount'] != actual['support']:
                errors.append(f"题目覆盖计数不符：{row['questionId']}")
            if row['mappingStatus'] == 'mapped' and not actual['direct']:
                errors.append(f"可作答题目无直接映射：{row['questionId']}")
        coverage_by_source = defaultdict(list)
        for row in self.data['pageCoverage']:
            coverage_by_source[row['sourceId']].append(row)
            if row['disposition'] not in {'mapped', 'background', 'excluded', 'nonContent', 'mixed'}:
                errors.append(f"覆盖状态非法：{row}")
            if row.get('visualStatus') == 'unverified':
                errors.append(f"覆盖页未核实：{row['sourceId']}:{row['page']}")
            for uid in row['unitIds']:
                if uid not in self.units:
                    errors.append(f"覆盖单元悬空：{uid}")
        for source in self.data['sources']:
            if source['type'] != 'courseware':
                continue
            pages = [x['page'] for x in coverage_by_source[source['id']]]
            if sorted(pages) != list(range(1, source['totalPages'] + 1)) or len(pages) != len(set(pages)):
                errors.append(f"课件覆盖不连续或重复：{source['id']}")
        unit_refs = {(u['id'], ref['sourceId'], page) for u in self.data['units']
                     for ref in u['sourceRefs'] if self.sources[ref['sourceId']]['type'] == 'courseware'
                     for page in ref['pdfPages']}
        coverage_refs = {(uid, row['sourceId'], row['page']) for row in self.data['pageCoverage']
                         for uid in row['unitIds']}
        if unit_refs != coverage_refs:
            errors.append('单元来源页与逐页覆盖不一致')
        adjacency = defaultdict(list)
        seen_relations = set()
        for relation in self.data['relations']:
            if relation['fromUnitId'] not in self.units or relation['toUnitId'] not in self.units:
                errors.append(f"关系端点悬空：{relation['id']}")
            if relation['fromUnitId'] == relation['toUnitId']:
                errors.append(f"关系自环：{relation['id']}")
            if relation['type'] not in {'requires', 'constructs', 'improves', 'inverse'}:
                errors.append(f"关系类型非法：{relation['id']}")
            if relation['status'] != 'approved':
                errors.append(f"关系未经审核：{relation['id']}")
            if relation['view'] not in {'main', 'auxiliary'}:
                errors.append(f"关系视图非法：{relation['id']}")
            if not relation.get('value'):
                errors.append(f"关系缺少 value：{relation['id']}")
            if relation['type'] == 'inverse' and relation['directed']:
                errors.append(f"inverse 不应有单向含义：{relation['id']}")
            for ref in relation['sourceRefs']:
                valid_ref(ref, self.sources, f"关系 {relation['id']}", errors)
            key = (relation['fromUnitId'], relation['toUnitId'], relation['type'],
                   relation.get('requirementGroupId'), relation.get('route'))
            if key in seen_relations:
                errors.append(f"重复关系：{key}")
            seen_relations.add(key)
            if relation['type'] == 'requires':
                adjacency[relation['fromUnitId']].append(relation['toUnitId'])
        for group in self.data['requirementGroups']:
            if group['targetUnitId'] not in self.units:
                errors.append(f"路线组目标悬空：{group['id']}")
            if group['mode'] not in {'all', 'any'}:
                errors.append(f"路线组模式非法：{group['id']}")
            if not group['unitIds']:
                errors.append(f"路线组为空：{group['id']}")
            for uid in group['unitIds']:
                if uid not in self.units:
                    errors.append(f"路线组单元悬空：{group['id']} {uid}")
            for rid in group['relationIds']:
                if rid not in self.relations:
                    errors.append(f"路线组关系悬空：{group['id']} {rid}")
                elif self.relations[rid].get('requirementGroupId') != group['id']:
                    errors.append(f"路线组关系未回指：{group['id']} {rid}")
        state = {}
        def visit(node, path):
            if state.get(node) == 1:
                errors.append('前置循环：' + ' -> '.join([*path, node]))
                return
            if state.get(node) == 2:
                return
            state[node] = 1
            for nxt in adjacency[node]:
                visit(nxt, [*path, node])
            state[node] = 2
        for uid in self.units:
            if not state.get(uid):
                visit(uid, [uid])
        def reachable(start, target):
            stack, seen_nodes = [start], set()
            while stack:
                node = stack.pop()
                for nxt in adjacency[node]:
                    if nxt == target:
                        return True
                    if nxt not in seen_nodes:
                        seen_nodes.add(nxt)
                        stack.append(nxt)
            return False
        for relation in self.data['relations']:
            if relation['type'] != 'requires':
                continue
            adjacency[relation['fromUnitId']].remove(relation['toUnitId'])
            if reachable(relation['fromUnitId'], relation['toUnitId']):
                errors.append(f"传递重复边：{relation['id']}")
            adjacency[relation['fromUnitId']].append(relation['toUnitId'])
        retired = {x['id'] for x in self.data['retiredUnits']}
        for uid in retired:
            if uid in self.units:
                errors.append(f"退休 ID 仍活跃：{uid}")
            if any(x['unitId'] == uid for x in self.mappings):
                errors.append(f"退休 ID 仍有映射：{uid}")
            if any(uid in (x['fromUnitId'], x['toUnitId']) for x in self.data['relations']):
                errors.append(f"退休 ID 仍有关系统：{uid}")
        for issue in self.data['issues']:
            if issue.get('status') != 'resolved':
                errors.append(f"存在未关闭问题：{issue.get('id')}")
        复习内容.validate_reading(self.data, errors)
        require(not errors, 'validation_failed', '权威数据校验失败', {'errors': errors})
        return ['sources', 'identity', 'ratings', 'mappings', 'coverage', 'relations', 'requirementGroups', 'retirement', 'reading']

    def validate_layout(self, layout_path):
        require(layout_path.exists(), 'missing_layout', f'布局文件不存在：{layout_path}')
        layout = json.loads(layout_path.read_text(encoding='utf-8'))
        errors = []
        views = layout.get('views') or [layout]
        for view in views:
            visual_ids = set()
            for node in view.get('nodes', []):
                eid = node.get('elementId')
                if not eid or eid in visual_ids:
                    errors.append(f"视觉元素 ID 缺失或重复：{eid}")
                visual_ids.add(eid)
                if node.get('unitId') not in self.units:
                    errors.append(f"布局单元悬空：{node.get('unitId')}")
                for field in ['x', 'y', 'width', 'height']:
                    value = node.get(field)
                    if not isinstance(value, (int, float)):
                        errors.append(f"布局坐标非法：{eid}.{field}")
                if node.get('width', 0) <= 0 or node.get('height', 0) <= 0:
                    errors.append(f"布局尺寸非法：{eid}")
            for group in view.get('groups', []):
                if group.get('themeId') not in self.themes:
                    errors.append(f"布局主题悬空：{group.get('themeId')}")
                if not group.get('elementId'):
                    errors.append('布局组缺少视觉 ID')
            for edge in view.get('edgeElements', []):
                if edge.get('relationId') not in self.relations:
                    errors.append(f"布局关系悬空：{edge.get('relationId')}")
            for unit in self.data['units']:
                if sum(node.get('unitId') == unit['id'] for node in view.get('nodes', [])) != 1:
                    errors.append(f"单元在视图中不是恰好一次：{unit['id']}")
        require(not errors, 'layout_failed', '布局校验失败', {'errors': errors})
        return ['layout']

    def build(self, output_dir, layout_path):
        self.validate()
        return 地图生成.build(self.data, output_dir, layout_path)

    def check(self, output_dir, layout_path, source_only=False):
        checks = self.validate()
        if source_only:
            return {'status': 'ok', 'sourceHash': self.hash, 'checks': checks}
        checks.extend(self.validate_layout(layout_path))
        expected = 地图生成.render_expected(self.data, layout_path)
        differences = []
        for relative, content in expected.items():
            path = output_dir / relative
            if not path.exists():
                differences.append({'path': relative, 'reason': 'missing'})
            elif path.read_text(encoding='utf-8') != content:
                differences.append({'path': relative, 'reason': 'stale_or_modified'})
        require(not differences, 'stale_output', '派生产物与权威数据不一致', {'differences': differences})
        checks.append('derived_outputs')
        return {'status': 'ok', 'sourceHash': self.hash, 'checks': checks}


def emit(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def main(argv=None):
    parser = argparse.ArgumentParser(description='数字逻辑期中知识地图查询、校验与构建')
    sub = parser.add_subparsers(dest='command', required=True)
    get_p = sub.add_parser('get')
    get_p.add_argument('id')
    search_p = sub.add_parser('search')
    search_p.add_argument('text', nargs='?', default='')
    search_p.add_argument('--type', default='unit', choices=['unit', 'theme', 'question', 'relation', 'all'])
    search_p.add_argument('--lesson')
    search_p.add_argument('--theme')
    search_p.add_argument('--question-type')
    search_p.add_argument('--kind')
    search_p.add_argument('--stars', type=int)
    search_p.add_argument('--min-stars', type=int)
    search_p.add_argument('--limit', type=int, default=20)
    related_p = sub.add_parser('related')
    related_p.add_argument('id')
    related_p.add_argument('--relation', default='requires')
    related_p.add_argument('--direction', default='upstream', choices=['upstream', 'downstream'])
    related_p.add_argument('--depth', type=int, default=1)
    related_p.add_argument('--view', default='all', choices=['main', 'auxiliary', 'all'])
    path_p = sub.add_parser('path')
    path_p.add_argument('from_id')
    path_p.add_argument('to_id')
    path_p.add_argument('--relation', default='requires')
    path_p.add_argument('--view', default='all', choices=['main', 'auxiliary', 'all'])
    path_p.add_argument('--limit', type=int, default=5)
    questions_p = sub.add_parser('questions')
    questions_p.add_argument('id')
    questions_p.add_argument('--role', default='all', choices=['all', 'direct', 'support'])
    questions_p.add_argument('--source')
    graph_p = sub.add_parser('graph')
    graph_p.add_argument('--view', default='main', choices=['main', 'auxiliary', 'all'])
    for name in ['check', 'build']:
        cmd = sub.add_parser(name)
        cmd.add_argument('--source-only', action='store_true')
    args = parser.parse_args(argv)
    data_path = Path(os.environ.get('MIDTERM_MAP_FILE', str(DATA_PATH)))
    output_dir = Path(os.environ.get('MIDTERM_OUTPUT_DIR', str(BASE)))
    layout_path = Path(os.environ.get('MIDTERM_LAYOUT_FILE', str(LAYOUT_PATH)))
    try:
        store = Store(load_data(data_path))
        if args.command == 'get':
            result = store.get(args.id)
        elif args.command == 'search':
            result = store.search(args.text, args.type, args.lesson, args.theme,
                                  args.question_type, args.kind, args.stars, args.min_stars, args.limit)
        elif args.command == 'related':
            result = store.related(args.id, args.relation, args.direction, args.depth, args.view)
        elif args.command == 'path':
            result = store.path(args.from_id, args.to_id, args.relation, args.view, args.limit)
        elif args.command == 'questions':
            result = store.question_mappings(args.id, args.role, args.source)
        elif args.command == 'graph':
            result = store.graph(args.view)
        elif args.command == 'build':
            result = store.build(output_dir, layout_path)
        else:
            result = store.check(output_dir, layout_path, args.source_only)
        emit(result)
        return 0
    except MapError as exc:
        emit({'error': {'code': exc.code, 'message': exc.message, 'details': exc.details}})
        return 1


if __name__ == '__main__':
    sys.exit(main())
