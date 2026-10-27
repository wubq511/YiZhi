#!/usr/bin/env python3
"""Bounded history contract/cost experiment; no production service or user data."""
import copy
import hashlib
import json
import math
import os
import platform
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parent / 'architecture-spike/fixture.json'
CHECKS = []


def enc(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(enc(value).encode()).hexdigest()


def check(name, condition, evidence=None):
    record = {'name': name, 'passed': bool(condition)}
    if evidence is not None:
        record['evidence'] = evidence
    CHECKS.append(record)
    if not condition:
        raise AssertionError(enc(record))


def connect(path):
    c = sqlite3.connect(path, isolation_level=None, timeout=5)
    c.row_factory = sqlite3.Row
    c.executescript('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; '
                    'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; '
                    'PRAGMA wal_autocheckpoint=1000;')
    return c


def dist(values):
    ordered = sorted(values)
    return {'count': len(values), 'p50_ms': statistics.median(ordered),
            'p95_ms': ordered[math.ceil(len(ordered) * .95) - 1], 'max_ms': max(ordered)}


def walk(blocks):
    for block in blocks:
        yield block
        yield from walk(block.get('children', []))


def normalize(units):
    objects = {}
    for original in units:
        uid = original['id']
        unit = copy.deepcopy(original)
        for block in walk(original['reading']['blocks']):
            value = copy.deepcopy(block)
            if 'children' in value:
                value['children'] = [b['id'] for b in value['children']]
            objects[f'{uid}/block/{block["id"]}'] = value
        unit['reading']['blocks'] = [b['id'] for b in original['reading']['blocks']]
        objects[f'{uid}/unit'] = unit
    return objects


def rebuild(objects, uid):
    unit = copy.deepcopy(objects[f'{uid}/unit'])
    seen = set()

    def build(bid):
        if bid in seen:
            raise ValueError('duplicate_or_cyclic_block')
        seen.add(bid)
        block = copy.deepcopy(objects[f'{uid}/block/{bid}'])
        if not block or block['id'] != bid:
            raise ValueError('missing_or_wrong_block')
        if 'children' in block:
            block['children'] = [build(child) for child in block['children']]
        return block

    unit['reading']['blocks'] = [build(bid) for bid in unit['reading']['blocks']]
    return unit


class Conflict(Exception):
    pass


class Ledger:
    """Current objects + one before/after ledger + latest drafts, not an app API."""
    def __init__(self, path, initial=None):
        self.c = connect(path)
        self.c.executescript('''
        CREATE TABLE IF NOT EXISTS commits(
          seq INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT UNIQUE NOT NULL,
          hash TEXT NOT NULL, actor TEXT NOT NULL, activity TEXT NOT NULL,
          kind TEXT NOT NULL, metadata TEXT NOT NULL, receipt TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS current(
          key TEXT PRIMARY KEY, value TEXT NOT NULL, head INTEGER NOT NULL REFERENCES commits(seq));
        CREATE TABLE IF NOT EXISTS changes(
          seq INTEGER NOT NULL REFERENCES commits(seq), key TEXT NOT NULL,
          before TEXT NOT NULL, after TEXT NOT NULL, prior_head INTEGER NOT NULL,
          PRIMARY KEY(seq,key));
        CREATE INDEX IF NOT EXISTS changes_by_object ON changes(key,seq);
        CREATE TABLE IF NOT EXISTS drafts(
          session TEXT NOT NULL, key TEXT NOT NULL, input_seq INTEGER NOT NULL,
          base_head INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(session,key));
        ''')
        if initial is not None:
            self.commit('baseline', 'system', 'initial', initial, {}, 'baseline')

    def values(self):
        return {r['key']: json.loads(r['value']) for r in self.c.execute('SELECT * FROM current')}

    def heads(self):
        return {r['key']: r['head'] for r in self.c.execute('SELECT key,head FROM current')}

    def snapshot(self, seq):
        rows = self.c.execute('''SELECT x.key,x.after FROM changes x JOIN
          (SELECT key,MAX(seq) AS latest FROM changes WHERE seq<=? GROUP BY key) p
          ON x.key=p.key AND x.seq=p.latest''', (seq,))
        return {r['key']: json.loads(r['after']) for r in rows}

    def validate(self, values):
        # Structural existence/order only: not a course semantic or evidence validator.
        for key, value in values.items():
            if key.endswith('/unit') and value is not None:
                rebuild(values, key[:-5])

    def commit(self, operation, actor, activity, changes, expected, kind='edit', metadata=None):
        request_hash = digest([actor, activity, changes, expected, kind, metadata])
        self.c.execute('BEGIN IMMEDIATE')
        try:
            receipt = self._commit(operation, request_hash, actor, activity, changes, expected, kind, metadata)
            self.c.execute('COMMIT')
            return receipt
        except BaseException:
            self.c.execute('ROLLBACK')
            raise

    def _commit(self, operation, request_hash, actor, activity, changes, expected, kind, metadata):
        old = self.c.execute('SELECT hash,receipt FROM commits WHERE operation=?', (operation,)).fetchone()
        if old:
            if old['hash'] != request_hash:
                raise Conflict('operation_payload_changed')
            return json.loads(old['receipt'])
        values, heads = self.values(), self.heads()
        if any(heads.get(key, 0) != revision for key, revision in expected.items()):
            raise Conflict('stale_revision')
        next_values = {**values, **changes}
        self.validate(next_values)
        cur = self.c.execute('INSERT INTO commits(operation,hash,actor,activity,kind,metadata,receipt) '
                             'VALUES(?,?,?,?,?,?,?)',
                             (operation, request_hash, actor, activity, kind, enc(metadata or {}), '{}'))
        seq = cur.lastrowid
        for key, value in changes.items():
            self.c.execute('INSERT INTO changes VALUES(?,?,?,?,?)',
                           (seq, key, enc(values.get(key)), enc(value), heads.get(key, 0)))
            self.c.execute('INSERT INTO current VALUES(?,?,?) ON CONFLICT(key) '
                           'DO UPDATE SET value=excluded.value,head=excluded.head', (key, enc(value), seq))
        receipt = {'operation': operation, 'seq': seq, 'changed': sorted(changes), 'metadata': metadata or {}}
        self.c.execute('UPDATE commits SET receipt=? WHERE seq=?', (enc(receipt), seq))
        return receipt

    def edit(self, operation, actor, activity, changes):
        heads = self.heads()
        return self.commit(operation, actor, activity, changes, {k: heads.get(k, 0) for k in changes})

    def inverse(self, operation, target_sequences):
        # One current transaction plans reverse-order groups and saves only their net effect.
        target_sequences = sorted(set(target_sequences), reverse=True)
        request_hash = digest(['inverse', target_sequences])
        self.c.execute('BEGIN IMMEDIATE')
        try:
            old = self.c.execute('SELECT hash,receipt FROM commits WHERE operation=?', (operation,)).fetchone()
            if old:
                if old['hash'] != request_hash:
                    raise Conflict('operation_payload_changed')
                result = json.loads(old['receipt'])
            else:
                before, heads = self.values(), self.heads()
                values, effective = copy.deepcopy(before), heads.copy()
                accepted, conflicts = [], []
                touched = set()
                for seq in target_sequences:
                    rows = list(self.c.execute('SELECT * FROM changes WHERE seq=?', (seq,)))
                    if not rows:
                        raise ValueError('unknown_target')
                    mismatches = [r['key'] for r in rows if effective.get(r['key'], 0) != seq]
                    if mismatches:
                        conflicts.append({'seq': seq, 'keys': mismatches})
                        continue
                    candidate = {**values, **{r['key']: json.loads(r['before']) for r in rows}}
                    try:
                        self.validate(candidate)
                    except (ValueError, KeyError, TypeError):
                        conflicts.append({'seq': seq, 'reason': 'dependent_structure'})
                        continue
                    values = candidate
                    for r in rows:
                        effective[r['key']] = r['prior_head']
                        touched.add(r['key'])
                    accepted.append(seq)
                metadata = {'target_sequences': target_sequences, 'reverted': accepted, 'conflicts': conflicts}
                result = self._commit(operation, request_hash, 'student', operation,
                                      {k: values[k] for k in touched}, {k: heads.get(k, 0) for k in touched},
                                      'inverse', metadata)
            self.c.execute('COMMIT')
            return result
        except BaseException:
            self.c.execute('ROLLBACK')
            raise

    def save_draft(self, session, key, seq, base, text):
        self.c.execute('BEGIN IMMEDIATE')
        try:
            old = self.c.execute('SELECT * FROM drafts WHERE session=? AND key=?', (session, key)).fetchone()
            if old and (seq < old['input_seq'] or
                        (seq == old['input_seq'] and (text != old['text'] or base != old['base_head']))):
                raise Conflict('stale_or_reused_input_sequence')
            self.c.execute('INSERT INTO drafts VALUES(?,?,?,?,?) ON CONFLICT(session,key) DO UPDATE SET '
                           'input_seq=excluded.input_seq,base_head=excluded.base_head,text=excluded.text',
                           (session, key, seq, base, text))
            self.c.execute('COMMIT')
        except BaseException:
            self.c.execute('ROLLBACK')
            raise

    def plan_restore(self, uid, historical_seq, layout=False):
        current, past, heads = self.values(), self.snapshot(historical_seq), self.heads()
        keys = {k for k in current.keys() | past.keys()
                if k.startswith(uid + '/') or (layout and k == 'layout/' + uid)}
        return {'uid': uid, 'historical_seq': historical_seq, 'layout': layout,
                'heads': {k: heads.get(k, 0) for k in keys},
                'drafts': [tuple(r) for r in self.c.execute('SELECT * FROM drafts ORDER BY session,key')
                           if r['key'].startswith(uid + '/')],
                'changes': {k: past.get(k) for k in keys if current.get(k) != past.get(k)}}

    def restore(self, operation, plan):
        # Scope membership as well as existing revisions is checked inside the write transaction.
        self.c.execute('BEGIN IMMEDIATE')
        try:
            request_hash = digest(plan)
            prior = self.c.execute('SELECT hash,receipt FROM commits WHERE operation=?', (operation,)).fetchone()
            if prior:
                if prior['hash'] != request_hash:
                    raise Conflict('operation_payload_changed')
                self.c.execute('COMMIT')
                return json.loads(prior['receipt'])
            current_plan = self.plan_restore(plan['uid'], plan['historical_seq'], plan['layout'])
            if current_plan['heads'] != plan['heads'] or current_plan['drafts'] != plan['drafts']:
                raise Conflict('restore_preview_stale')
            result = self._commit(operation, request_hash, 'student', operation, plan['changes'], plan['heads'],
                                  'restore', {'from_seq': plan['historical_seq'], 'layout': plan['layout']})
            self.c.execute('COMMIT')
            return result
        except BaseException:
            self.c.execute('ROLLBACK')
            raise


def paragraph_keys(initial, uid):
    return [key for key, value in initial.items() if key.startswith(uid + '/block/')
            and value.get('kind') == 'paragraph']


def changed(value, suffix):
    result = copy.deepcopy(value)
    result['payload']['text'] += suffix
    return result


def contracts(root, units):
    initial = normalize(units[:3])
    uid = units[0]['id']
    p, q = paragraph_keys(initial, uid)[:2]
    initial['layout/' + uid] = {'x': 0, 'y': 0}
    initial['mastery/' + uid] = '薄弱'
    store = Ledger(root / 'contracts.sqlite3', initial)
    try:
        check('initial nested structure round-trips exactly', rebuild(store.snapshot(1), uid) == units[0])
        a = store.edit('agent-1', 'agent', 'task-1', {p: changed(initial[p], ' 合成解释A')})
        b = store.edit('agent-2', 'agent', 'task-1', {p: changed(store.values()[p], ' 合成解释B')})
        note = {'text': '合成个人笔记', 'target': p, 'original_seq': b['seq'],
                'original_quote': store.values()[p]['payload']['text'][-20:]}
        store.edit('student-later', 'student', 'editing',
                   {q: changed(initial[q], ' 学生后来补充'), 'note/N': note,
                    'layout/' + uid: {'x': 77, 'y': 33}, 'mastery/' + uid: '已掌握'})
        later = store.values()
        inverse = store.inverse('undo-task-1', [a['seq'], b['seq']])
        check('task reverse order undoes its own successive edits without false conflict',
              store.values()[p] == initial[p] and inverse['metadata']['reverted'] == [b['seq'], a['seq']]
              and not inverse['metadata']['conflicts'])
        check('task undo preserves later independent text, note, layout and mastery',
              all(store.values()[key] == later[key] for key in (q, 'note/N', 'layout/' + uid, 'mastery/' + uid)))
        seq = store.c.execute('SELECT MAX(seq) FROM commits').fetchone()[0]
        check('same inverse request replays one durable receipt', store.inverse('undo-task-1', [a['seq'], b['seq']]) == inverse
              and store.c.execute('SELECT MAX(seq) FROM commits').fetchone()[0] == seq)

        own = store.edit('own-move', 'student', 'canvas', {'layout/' + uid: {'x': 99, 'y': 55}})
        store.edit('background-agent', 'agent', 'other-task', {p: changed(initial[p], ' 后台改动')})
        undo_own = store.inverse('keyboard-undo-simulation', [own['seq']])
        check('explicit student undo target ignores later unrelated agent operation',
              store.values()['layout/' + uid] == later['layout/' + uid] and store.values()[p] != initial[p])
        store.inverse('keyboard-redo-simulation', [undo_own['seq']])
        check('redo reuses inverse primitive and preserves agent content',
              store.values()['layout/' + uid] == {'x': 99, 'y': 55} and store.values()[p] != initial[p])

        one = store.edit('conflict-agent', 'agent', 'conflict-task', {p: changed(initial[p], ' Agent新值')})
        agent_value = store.values()[p]
        store.edit('student-overlap', 'student', 'editing', {p: changed(initial[p], ' 学生同块改写')})
        store.edit('student-return-value', 'student', 'editing', {p: agent_value})
        before = store.values()
        result = store.inverse('conflict-undo', [one['seq']])
        check('equal value after intervening student edits does not bypass revision guard',
              store.values() == before and len(result['metadata']['conflicts']) == 1)

        grouped = store.edit('atomic-group', 'agent', 'two-blocks',
                             {p: changed(store.values()[p], ' 组P'), q: changed(store.values()[q], ' 组Q')})
        store.edit('group-overlap', 'student', 'editing', {p: changed(store.values()[p], ' 学生介入')})
        before = store.values()
        result = store.inverse('undo-atomic-group', [grouped['seq']])
        check('a conflicting atomic group is not half undone', store.values() == before and not result['metadata']['reverted'])

        parent = copy.deepcopy(store.values()[uid + '/unit'])
        new_bid = uid + '-synthetic-added'
        new_key = uid + '/block/' + new_bid
        parent['reading']['blocks'].insert(1, new_bid)
        new_block = {'id': new_bid, 'kind': 'paragraph', 'payload': {'text': '新增合成段落'}, 'role': 'core'}
        add = store.edit('add-block', 'agent', 'add-task', {uid + '/unit': parent, new_key: new_block})
        store.edit('note-on-added', 'student', 'note', {'note/added': {'target': new_key, 'original_seq': add['seq'], 'text': '新增块上的笔记'}})
        store.inverse('undo-added', [add['seq']])
        values = store.values()
        check('undo creation restores parent order while retaining attached note and original version',
              new_bid not in values[uid + '/unit']['reading']['blocks'] and values[new_key] is None
              and values['note/added']['target'] == new_key and store.snapshot(add['seq'])[new_key] == new_block)

        stale = store.plan_restore(uid, 1)
        store.edit('late-scope-insert', 'student', 'structure', {uid + '/unreferenced-object': {'text': '预览后的新对象'}})
        try:
            store.restore('stale-restore', stale)
            rejected = False
        except Conflict:
            rejected = True
        check('restore preview guards later scope membership, not only old object revisions', rejected)

        store.save_draft('student', p, 1, store.heads()[p], '\\frac{未完成')
        plan = store.plan_restore(uid, 1)
        other_key = paragraph_keys(initial, units[1]['id'])[0]
        store.save_draft('other-unit', other_key, 1, store.heads()[other_key], '其他单元活动草稿')
        before = store.values()
        before_seq = store.c.execute('SELECT MAX(seq) FROM commits').fetchone()[0]
        restored = store.restore('restore-content-only', plan)
        after = store.values()
        check('default restore reconstructs original full unit and preserves personal state',
              rebuild(after, uid) == units[0] and all(after[k] == before[k] for k in before if k.startswith(('note/', 'layout/', 'mastery/'))))
        check('unrelated unit draft does not invalidate a content-only restore preview',
              store.c.execute("SELECT text FROM drafts WHERE session='other-unit'").fetchone()[0] == '其他单元活动草稿')
        check('restore keeps prior state and unfinished draft recoverable',
              store.snapshot(before_seq) == before and store.c.execute("SELECT text FROM drafts WHERE session='student'").fetchone()[0] == '\\frac{未完成')
        check('lost restore receipt can replay after restore changed current revisions',
              store.restore('restore-content-only', plan) == restored and store.values() == after)
        store.inverse('undo-restore', [restored['seq']])
        check('restore itself can be reversed through the same ledger', store.values() == before)
        layout_plan = store.plan_restore(uid, 1, layout=True)
        store.restore('restore-with-layout', layout_plan)
        check('optional layout restore is explicit and leaves mastery untouched',
              store.values()['layout/' + uid] == initial['layout/' + uid]
              and store.values()['mastery/' + uid] == before['mastery/' + uid])

        formal_head = store.c.execute('SELECT MAX(seq) FROM commits').fetchone()[0]
        for index in range(2, 102):
            store.save_draft('student', p, index, store.heads()[p], '\\frac{草稿' + str(index))
        check('100 draft updates replace one latest draft without formal history entries',
              store.c.execute("SELECT COUNT(*) FROM drafts WHERE session='student'").fetchone()[0] == 1
              and store.c.execute('SELECT MAX(seq) FROM commits').fetchone()[0] == formal_head)
        try:
            store.save_draft('student', p, 100, store.heads()[p], '迟到输入')
            rejected = False
        except Conflict:
            rejected = True
        check('late draft cannot replace newer recoverable input', rejected)
        result = {'current_hash': digest(store.values()), 'formal_groups': formal_head,
                  'draft_rows': store.c.execute('SELECT COUNT(*) FROM drafts').fetchone()[0]}
    finally:
        store.c.close()
    reopened = Ledger(root / 'contracts.sqlite3')
    try:
        check('reopen preserves formal state, history and latest incomplete draft',
              digest(reopened.values()) == result['current_hash']
              and reopened.c.execute("SELECT input_seq FROM drafts WHERE session='student'").fetchone()[0] == 101)
        check('ledger SQLite integrity and foreign keys', reopened.c.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
              and not list(reopened.c.execute('PRAGMA foreign_key_check')))
    finally:
        reopened.c.close()
    return result


def draft_crash(root):
    path = root / 'draft-crash.sqlite3'
    p = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve()), '--draft-crash', str(path)],
                       capture_output=True, text=True, timeout=20)
    check('draft child actually exits after acknowledged save and before later commit',
          p.returncode == 73 and json.loads(p.stdout)['saved_input_seq'] == 2 and not p.stderr)
    store = Ledger(path)
    try:
        row = dict(store.c.execute('SELECT * FROM drafts').fetchone())
        check('abnormal exit retains acknowledged draft, not uncommitted replacement',
              row['input_seq'] == 2 and row['text'] == '\\frac{仍未完成'
              and store.c.execute('SELECT COUNT(*) FROM commits').fetchone()[0] == 0)
        return {'exit_code': p.returncode, 'retained_input_seq': row['input_seq']}
    finally:
        store.c.close()


def replicas(units, count):
    result = []
    for index in range(count):
        unit = copy.deepcopy(units[index % len(units)])
        # Both comparison strategies consume this exact same fixture; references are not revalidated.
        unit['id'] = unit['id'] + '-copy-' + str(index)
        result.append(unit)
    return result


def sizes(path):
    return {suffix or 'db': Path(str(path) + suffix).stat().st_size if Path(str(path) + suffix).exists() else 0
            for suffix in ('', '-wal', '-shm')}


def benchmark(root, mode, units, round_index):
    path = root / f'{mode}-{round_index}.sqlite3'
    c = connect(path)
    try:
        c.executescript('''
        CREATE TABLE units(id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE baseline(id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE operations(seq INTEGER PRIMARY KEY,request_hash TEXT NOT NULL,kind TEXT NOT NULL);
        CREATE TABLE history(seq INTEGER NOT NULL REFERENCES operations(seq),unit TEXT NOT NULL,
          object TEXT NOT NULL,before TEXT NOT NULL,after TEXT NOT NULL,PRIMARY KEY(seq,unit,object));
        CREATE INDEX history_by_unit_object ON history(unit,object,seq);
        CREATE TABLE drafts(id TEXT PRIMARY KEY,input_seq INTEGER,text TEXT);
        CREATE TABLE layouts(id TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE message_chunks(id INTEGER PRIMARY KEY,body TEXT);
        ''')
        c.execute('BEGIN')
        payloads = [(u['id'], enc(u)) for u in units]
        c.executemany('INSERT INTO units VALUES(?,?)', payloads)
        c.executemany('INSERT INTO baseline VALUES(?,?)', payloads)
        c.execute('COMMIT')
        c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        start_sizes = sizes(path)
        series = {'formal': [], 'draft': [], 'layout': [], 'message': []}
        samples, initial_cpu = [], time.process_time()
        start_wall = time.perf_counter()
        seq = 0
        # 400 formal groups x 2 units, 800 latest-draft writes, 200 completed drags, 200 message chunks.
        for i in range(1600):
            slot = i % 8
            kind = 'formal' if slot in (0, 4) else 'draft' if slot in (1, 2, 5, 6) else 'layout' if slot == 3 else 'message'
            turn = i // 8
            ids = [units[(turn * 2 + (1 if slot == 4 else 0) + offset) % 40]['id'] for offset in (0, 1)]
            suffix = f' 合成修订{turn}-{slot}'
            t0 = time.perf_counter_ns()
            c.execute('BEGIN IMMEDIATE')
            if kind == 'formal':
                seq += 1
                c.execute('INSERT INTO operations VALUES(?,?,?)', (seq, digest([i, ids, suffix]), kind))
                for uid in ids:
                    raw = c.execute('SELECT body FROM units WHERE id=?', (uid,)).fetchone()[0]
                    value = json.loads(raw)
                    block = next(b for b in walk(value['reading']['blocks']) if b.get('kind') == 'paragraph')
                    old_block = enc(block)
                    block['payload']['text'] += suffix
                    after = enc(value)
                    c.execute('UPDATE units SET body=? WHERE id=?', (after, uid))
                    # Identical current-unit write and payload preparation in both modes.
                    block_after = enc(block)
                    c.execute('INSERT INTO history VALUES(?,?,?,?,?)',
                              (seq, uid, '*' if mode == 'unit' else block['id'],
                               raw if mode == 'unit' else old_block, after if mode == 'unit' else block_after))
            elif kind == 'draft':
                uid = ids[0]
                c.execute('INSERT INTO drafts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET '
                          'input_seq=excluded.input_seq,text=excluded.text', (uid, i, '\\frac{未完成输入' + str(i)))
            elif kind == 'layout':
                seq += 1
                value = enc({'x': turn * 3, 'y': turn * 2})
                uid = ids[0]
                old = c.execute('SELECT value FROM layouts WHERE id=?', (uid,)).fetchone()
                c.execute('INSERT INTO operations VALUES(?,?,?)', (seq, digest([i, uid, value]), kind))
                c.execute('INSERT INTO history VALUES(?,?,?,?,?)', (seq, 'layout', uid, old[0] if old else 'null', value))
                c.execute('INSERT INTO layouts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', (uid, value))
            else:
                c.execute('INSERT INTO message_chunks VALUES(?,?)', (i, '合成学习对话片段。' * 12 + str(i)))
            c.execute('COMMIT')
            series[kind].append((time.perf_counter_ns() - t0) / 1e6)
            if (i + 1) % 200 == 0:
                samples.append({'operation': i + 1, **sizes(path)})
        elapsed, cpu = time.perf_counter() - start_wall, time.process_time() - initial_cpu
        active_sizes = sizes(path)
        checkpoint = list(c.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone())
        check(f'{mode}/{round_index}: checkpoint completes', checkpoint[0] == 0)
        final_sizes = sizes(path)
        counts = {table: c.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0]
                  for table in ('units', 'operations', 'history', 'drafts', 'layouts', 'message_chunks')}
        check(f'{mode}/{round_index}: bounded workload counts', counts['units'] == 500 and counts['operations'] == 600
              and counts['history'] == 1000 and counts['message_chunks'] == 200 and counts['drafts'] <= 40)
        logical_history = c.execute('SELECT SUM(length(CAST(before AS BLOB))+length(CAST(after AS BLOB))) FROM history').fetchone()[0]
        formal_history = c.execute("SELECT SUM(length(CAST(before AS BLOB))+length(CAST(after AS BLOB))) FROM history WHERE unit!='layout'").fetchone()[0]
        results, preview_times = [], []
        for uid in [units[i]['id'] for i in range(0, 40, 4)]:
            t0 = time.perf_counter_ns()
            if mode == 'unit':
                row = c.execute("SELECT after FROM history WHERE unit=? AND object='*' AND seq<=300 ORDER BY seq DESC LIMIT 1", (uid,)).fetchone()
                value = json.loads(row[0] if row else c.execute('SELECT body FROM baseline WHERE id=?', (uid,)).fetchone()[0])
            else:
                value = json.loads(c.execute('SELECT body FROM baseline WHERE id=?', (uid,)).fetchone()[0])
                rows = c.execute('''SELECT h.object,h.after FROM history h JOIN
                  (SELECT object,MAX(seq) AS latest FROM history WHERE unit=? AND seq<=300 GROUP BY object) p
                  ON h.object=p.object AND h.seq=p.latest WHERE h.unit=?''', (uid, uid))
                replacements = {r['object']: json.loads(r['after']) for r in rows}
                for block in walk(value['reading']['blocks']):
                    if block['id'] in replacements:
                        block.update(replacements[block['id']])
            results.append(digest(value))
            preview_times.append((time.perf_counter_ns() - t0) / 1e6)
        head_hash = digest([tuple(r) for r in c.execute('SELECT * FROM units ORDER BY id')])
        settings = {key: c.execute('PRAGMA ' + key).fetchone()[0]
                    for key in ('journal_mode', 'synchronous', 'page_size', 'wal_autocheckpoint', 'fullfsync', 'checkpoint_fullfsync')}
        return {'mode': mode, 'round': round_index, 'wall_seconds': elapsed, 'cpu_seconds': cpu,
                'timings_ms': series, 'distributions': {k: dist(v) for k, v in series.items()},
                'initial': start_sizes, 'active': active_sizes, 'checkpointed': final_sizes,
                'database_growth_bytes': final_sizes['db'] - start_sizes['db'], 'samples': samples,
                'logical_history_bytes': logical_history, 'formal_before_after_bytes': formal_history,
                'counts': counts, 'head_hash': head_hash, 'historical_unit_hashes': results,
                'historical_preview_ms': preview_times, 'preview_distribution': dist(preview_times), 'settings': settings}
    finally:
        c.close()


def main():
    out = {'started_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'status': 'running',
           'environment': {'python': sys.version, 'sqlite': sqlite3.sqlite_version,
                           'platform': platform.platform(), 'machine': platform.machine()},
           'source_hash': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
           'fixture_hash': hashlib.sha256(FIXTURE.read_bytes()).hexdigest(), 'checks': CHECKS, 'failures': []}
    result_path = HERE / 'results.json'
    if result_path.exists():
        prior = json.loads(result_path.read_text())
        out['prior_runs'] = prior.get('prior_runs', []) + [{k: prior.get(k) for k in ('started_at', 'status', 'source_hash', 'failures', 'cleanup')}]
    with tempfile.TemporaryDirectory(prefix='.tmp-history-', dir=HERE) as temporary:
        root = Path(temporary)
        try:
            fixture = json.loads(FIXTURE.read_text())['units']
            out['contracts'] = contracts(root, fixture)
            out['draft_crash'] = draft_crash(root)
            units = replicas(fixture, 500)
            out['fixture'] = {'original_units': len(fixture), 'replicated_units': len(units),
                              'unit_payload_bytes': sum(len(enc(u).encode()) for u in units)}
            out['benchmarks'] = []
            for round_index, order in enumerate((('unit', 'block'), ('block', 'unit'), ('unit', 'block')), 1):
                pair = [benchmark(root, mode, units, round_index) for mode in order]
                check(f'paired round {round_index}: identical final contents and ten historical previews',
                      pair[0]['head_hash'] == pair[1]['head_hash'] and pair[0]['historical_unit_hashes'] == pair[1]['historical_unit_hashes'])
                out['benchmarks'].extend(pair)
            out['status'] = 'passed'
        except BaseException:
            out['status'] = 'failed'
            out['failures'].append(traceback.format_exc())
    out['cleanup'] = {'temporary_directory_removed': not root.exists()}
    out['check_count'] = len(CHECKS)
    out['finished_at'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    result_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
    print(enc({'status': out['status'], 'checks': len(CHECKS), 'failures': out['failures'], 'cleanup': out['cleanup']}))
    return 0 if out['status'] == 'passed' else 1


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--draft-crash':
        ledger = Ledger(Path(sys.argv[2]))
        ledger.save_draft('student', 'formula', 1, 0, '\\frac{')
        ledger.save_draft('student', 'formula', 2, 0, '\\frac{仍未完成')
        print(enc({'saved_input_seq': 2}), flush=True)
        ledger.c.execute('BEGIN IMMEDIATE')
        ledger.c.execute("UPDATE drafts SET input_seq=3,text='未提交替换'")
        os._exit(73)
    raise SystemExit(main())
