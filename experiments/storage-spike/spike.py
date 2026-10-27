#!/usr/bin/env python3
"""Isolated contract experiment. Standard library only; never imports the application."""
import argparse
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
FIXTURE = HERE.parent / 'architecture-spike' / 'fixture.json'
PROJECT = HERE.parents[1]
STORAGE_DESIGN = PROJECT / 'docs/research/architecture/后端存储方案调研.md'
CONTENT_PROTOCOL = PROJECT / 'docs/architecture/内容演进与实时修改协议.md'
CHILDREN = set()
CONNECTIONS = set()
CHECKS = []
SCHEMA = '''
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE operations(id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
 request TEXT NOT NULL, receipt TEXT NOT NULL);
CREATE TABLE units(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
CREATE TABLE revisions(unit TEXT NOT NULL REFERENCES units(id), revision INTEGER NOT NULL,
 body TEXT NOT NULL, operation TEXT REFERENCES operations(id) DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY(unit,revision));
CREATE TABLE drafts(session TEXT NOT NULL, unit TEXT NOT NULL REFERENCES units(id),
 block TEXT NOT NULL, seq INTEGER NOT NULL, epoch INTEGER NOT NULL, base_hash TEXT NOT NULL,
 body TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(session,unit,block));
CREATE TABLE notes(id TEXT PRIMARY KEY, unit TEXT NOT NULL, revision INTEGER NOT NULL,
 block TEXT NOT NULL, body TEXT NOT NULL, original_context TEXT NOT NULL,
 FOREIGN KEY(unit,revision) REFERENCES revisions(unit,revision));
CREATE TABLE layouts(unit TEXT PRIMARY KEY REFERENCES units(id), body TEXT NOT NULL);
CREATE TABLE messages(conversation TEXT NOT NULL, offset INTEGER NOT NULL,
 body TEXT NOT NULL, PRIMARY KEY(conversation,offset));
CREATE TABLE tasks(id TEXT PRIMARY KEY, current_attempt TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE attempts(id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id),
 eligible INTEGER NOT NULL, state TEXT NOT NULL, commits INTEGER NOT NULL DEFAULT 0);
CREATE TABLE read_sets(token TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id),
 attempt TEXT NOT NULL REFERENCES attempts(id), observations TEXT NOT NULL,
 used_by TEXT REFERENCES operations(id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE resources(digest TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, size INTEGER NOT NULL);
CREATE TABLE resource_uses(unit TEXT NOT NULL, revision INTEGER NOT NULL,
 digest TEXT NOT NULL REFERENCES resources(digest), PRIMARY KEY(unit,revision,digest),
 FOREIGN KEY(unit,revision) REFERENCES revisions(unit,revision));
CREATE TABLE history(cursor INTEGER PRIMARY KEY AUTOINCREMENT,
 operation TEXT NOT NULL UNIQUE REFERENCES operations(id) DEFERRABLE INITIALLY DEFERRED,
 kind TEXT NOT NULL, changes TEXT NOT NULL);
'''
TABLES = ['meta', 'operations', 'units', 'revisions', 'drafts', 'notes', 'layouts',
          'messages', 'tasks', 'attempts', 'read_sets', 'resources', 'resource_uses', 'history']


def canonical(x):
    return json.dumps(x, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def digest(x):
    return sha(canonical(x).encode())


def check(name, ok, detail=None):
    item = {'assertion': name, 'passed': bool(ok)}
    if detail is not None:
        item['detail'] = detail
    CHECKS.append(item)
    if not ok:
        raise AssertionError(canonical(item))


def connect(root):
    c = sqlite3.connect(root / 'course.sqlite3', isolation_level=None, timeout=5)
    CONNECTIONS.add(c)
    c.execute('PRAGMA foreign_keys=ON')
    c.execute('PRAGMA journal_mode=WAL')
    c.execute('PRAGMA synchronous=FULL')
    c.execute('PRAGMA busy_timeout=5000')
    c.execute('PRAGMA wal_autocheckpoint=1000')
    return c


def blocks(unit):
    def walk(xs):
        for b in xs:
            yield b
            yield from walk(b.get('children', []))
    return list(walk(unit['reading']['blocks']))


def block(c, unit, bid):
    body = json.loads(c.execute('SELECT body FROM units WHERE id=?', (unit,)).fetchone()[0])
    return next(b for b in blocks(body) if b['id'] == bid)


def observation(c, unit, bid):
    # Include inactive epochs too: discard/reopen cannot accidentally revive an old read.
    ds = c.execute('SELECT session,seq,epoch,active FROM drafts WHERE unit=? AND block=? ORDER BY session',
                   (unit, bid)).fetchall()
    return {'unit': unit, 'block': bid, 'hash': digest(block(c, unit, bid)), 'drafts': ds}


def seed(root, fixture, count):
    root.mkdir(parents=True)
    c = connect(root)
    c.executescript(SCHEMA)
    # Exact-string ID remapping keeps the tree/relations/coverage shapes, not only block text.
    def remap(x, mapping):
        if isinstance(x, dict):
            return {k: remap(v, mapping) for k, v in x.items()}
        if isinstance(x, list):
            return [remap(v, mapping) for v in x]
        return mapping.get(x, x) if isinstance(x, str) else x
    c.execute('BEGIN IMMEDIATE')
    c.executemany('INSERT INTO meta VALUES (?,?)', [('course_id', 'COURSE-storage-spike'),
                                                    ('generation', '1'), ('schema', 'storage-spike-1')])
    original = fixture['units']
    for i in range(count):
        batch = i // len(original)
        u = original[i % len(original)]
        present = original[:min(len(original), count - batch * len(original))]
        # Final partial batch references absent peers in the original 84-unit set.
        ids = [z['id'] for z in present] + [b['id'] for z in present for b in blocks(z)]
        ids += [r['id'] for z in present for r in z.get('relations', [])]
        mapping = {s: f'{s}~copy{batch}' for s in ids} if batch else {}
        body = remap(u, mapping)
        # Preserve the fixture's embedded reading revision; SQL revision is this spike's ledger.
        c.execute('INSERT INTO units VALUES (?,1,?)', (body['id'], canonical(body)))
        c.execute('INSERT INTO revisions VALUES (?,1,?,NULL)', (body['id'], canonical(body)))
    c.execute("INSERT INTO tasks VALUES ('T','attempt-1','running')")
    c.execute("INSERT INTO attempts VALUES ('attempt-1','T',1,'running',0)")
    c.execute('COMMIT')
    c.close()


def capture(root, targets, token, attempt='attempt-1'):
    c = connect(root)
    try:
        c.execute('BEGIN IMMEDIATE')
        obs = [observation(c, u, b) for u, b in targets]
        c.execute('INSERT INTO read_sets VALUES (?,?,?,?,NULL)', (token, 'T', attempt, canonical(obs)))
        c.execute('COMMIT')
    finally:
        c.close()
    return token


def fsync_dir(path):
    if os.name != 'nt':
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def publish_resource(root, text):
    data = text.encode()
    h = sha(data)
    folder = root / 'resources'
    if not folder.exists():
        folder.mkdir()
        fsync_dir(root)
    target = folder / h
    if not target.exists():
        # Exclusive creation: no overwrite of an existing content-addressed object.
        tmp = folder / (h + f'.{os.getpid()}.part')
        with tmp.open('xb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.link(tmp, target)
        except FileExistsError:
            pass
        finally:
            tmp.unlink()
        fsync_dir(folder)
    if target.read_bytes() != data:
        raise ValueError('resource_digest_mismatch')
    return {'digest': h, 'relative_path': 'resources/' + h, 'size': len(data)}


def inject(req, point):
    spec = req.get('_inject')
    if not spec or spec['point'] != point:
        return
    Path(spec['ready']).write_text(point, encoding='utf-8')
    if spec['mode'] == 'exit':
        os._exit(73)
    if sys.stdin.readline().strip() != 'release':
        os._exit(74)


class Rejected(Exception):
    pass


def apply(root, req, c=None):
    """Only contract-shaped commands. No SQL transaction spans synthetic generation."""
    owned = c is None
    c = c or connect(root)
    semantic = {k: v for k, v in req.items() if not k.startswith('_')}
    ph = digest(semantic)
    started = time.monotonic_ns()
    acquired = None
    committed = None
    try:
        inject(req, 'before_begin')
        c.execute('BEGIN IMMEDIATE')
        acquired = time.monotonic_ns()
        inject(req, 'after_begin')
        prior = c.execute('SELECT payload_hash,receipt FROM operations WHERE id=?', (req['id'],)).fetchone()
        if prior:
            if prior[0] != ph:
                raise Rejected('operation_payload_mismatch')
            c.execute('ROLLBACK')
            return {'receipt': json.loads(prior[1]), 'replayed': True,
                    'timing_ns': {'started': started, 'acquired': acquired}}
        generation = int(c.execute("SELECT value FROM meta WHERE key='generation'").fetchone()[0])
        if req.get('generation', 1) != generation:
            raise Rejected('generation_mismatch')
        kind = req['kind']
        changes = []
        if kind == 'group':
            token = None
            if req.get('actor') == 'agent':
                a = c.execute('SELECT t.current_attempt,t.state,a.eligible,a.state FROM tasks t '
                              'JOIN attempts a ON a.task=t.id WHERE t.id=? AND a.id=?',
                              ('T', req['attempt'])).fetchone()
                if not a or a != (req['attempt'], 'running', 1, 'running'):
                    raise Rejected('attempt_ineligible')
                row = c.execute('SELECT task,attempt,observations,used_by FROM read_sets WHERE token=?',
                                (req['read_token'],)).fetchone()
                if not row or row[:2] != ('T', req['attempt']) or row[3] is not None:
                    raise Rejected('read_token_invalid')
                observations = json.loads(row[2])
                covered = {(o['unit'], o['block']) for o in observations}
                if any((w['unit'], w['block']) not in covered for w in req['writes']):
                    raise Rejected('write_not_observed')
                for o in observations:
                    now = observation(c, o['unit'], o['block'])
                    if digest(now) != digest(o):
                        raise Rejected('read_set_changed')
                    if any(d[3] for d in now['drafts']):
                        raise Rejected('active_student_draft')
                token = req['read_token']
            resources = []
            for text in req.get('resource_texts', []):
                resources.append(publish_resource(root, text))
            inject(req, 'after_resource_publish_before_register')
            for r in resources:
                c.execute('INSERT OR IGNORE INTO resources VALUES (:digest,:relative_path,:size)', r)
            by_unit = {}
            for w in req['writes']:
                if w['unit'] not in by_unit:
                    rev, text = c.execute('SELECT revision,body FROM units WHERE id=?', (w['unit'],)).fetchone()
                    by_unit[w['unit']] = [rev, text, json.loads(text)]
                rev, before, body = by_unit[w['unit']]
                b = next(b for b in blocks(body) if b['id'] == w['block'])
                b['payload'] = w['payload']
            for uid, (rev, before, body) in by_unit.items():
                after = canonical(body)
                c.execute('UPDATE units SET revision=?,body=? WHERE id=?', (rev + 1, after, uid))
                c.execute('INSERT INTO revisions VALUES (?,?,?,?)', (uid, rev + 1, after, req['id']))
                for r in resources:
                    c.execute('INSERT INTO resource_uses VALUES (?,?,?)', (uid, rev + 1, r['digest']))
                changes.append({'unit': uid, 'before_revision': rev, 'after_revision': rev + 1,
                                'before_hash': sha(before.encode()), 'after_hash': sha(after.encode())})
            for d in req.get('drafts', []):
                save_draft(c, d)
            for n in req.get('notes', []):
                c.execute('INSERT INTO notes VALUES (:id,:unit,:revision,:block,:body,:original_context)', n)
            if token:
                c.execute('UPDATE read_sets SET used_by=? WHERE token=?', (req['id'], token))
                c.execute('UPDATE attempts SET commits=commits+1 WHERE id=?', (req['attempt'],))
                if req.get('finish'):
                    c.execute("UPDATE attempts SET eligible=0,state='completed' WHERE id=?", (req['attempt'],))
                    c.execute("UPDATE tasks SET state='completed' WHERE id='T'")
        elif kind == 'draft':
            save_draft(c, req['draft'])
        elif kind == 'layout':
            c.execute('INSERT INTO layouts VALUES (?,?) ON CONFLICT(unit) DO UPDATE SET body=excluded.body',
                      (req['unit'], canonical(req['layout'])))
        elif kind == 'message':
            offset = c.execute('SELECT COALESCE(MAX(offset),0) FROM messages WHERE conversation=?',
                               (req['conversation'],)).fetchone()[0]
            if offset != req['expected_offset']:
                raise Rejected('message_offset_mismatch')
            c.execute('INSERT INTO messages VALUES (?,?,?)',
                      (req['conversation'], offset + len(req['text'].encode()), req['text']))
        elif kind == 'stop':
            c.execute("UPDATE attempts SET eligible=0,state='stopped' WHERE task='T' AND eligible=1")
            c.execute("UPDATE tasks SET state='stopped' WHERE id='T'")
        elif kind == 'continue':
            if c.execute("SELECT state FROM tasks WHERE id='T'").fetchone()[0] != 'stopped':
                raise Rejected('task_not_stopped')
            c.execute("INSERT INTO attempts VALUES (?,'T',1,'running',0)", (req['new_attempt'],))
            c.execute("UPDATE tasks SET current_attempt=?,state='running' WHERE id='T'", (req['new_attempt'],))
        else:
            raise Rejected('unknown_command')
        cur = c.execute('INSERT INTO history(operation,kind,changes) VALUES (?,?,?)',
                        (req['id'], kind, canonical(changes)))
        receipt = {'operationId': req['id'], 'saved': True, 'kind': kind,
                   'generation': generation, 'cursor': cur.lastrowid, 'changes': changes}
        c.execute('INSERT INTO operations VALUES (?,?,?,?)', (req['id'], ph, canonical(semantic), canonical(receipt)))
        inject(req, 'before_commit')
        c.execute('COMMIT')
        committed = time.monotonic_ns()
        inject(req, 'after_commit')
        return {'receipt': receipt, 'replayed': False,
                'timing_ns': {'started': started, 'acquired': acquired, 'committed': committed}}
    except Rejected as e:
        if c.in_transaction:
            c.execute('ROLLBACK')
        return {'saved': False, 'rejected': str(e),
                'timing_ns': {'started': started, 'acquired': acquired}}
    except BaseException:
        if c.in_transaction:
            c.execute('ROLLBACK')
        raise
    finally:
        if owned:
            c.close()


def save_draft(c, d):
    old = c.execute('SELECT seq,epoch FROM drafts WHERE session=? AND unit=? AND block=?',
                    (d['session'], d['unit'], d['block'])).fetchone()
    if old and d['seq'] <= old[0]:
        raise Rejected('draft_sequence_stale')
    c.execute('INSERT INTO drafts VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(session,unit,block) '
              'DO UPDATE SET seq=excluded.seq,epoch=excluded.epoch,base_hash=excluded.base_hash,'
              'body=excluded.body,active=excluded.active',
              (d['session'], d['unit'], d['block'], d['seq'], 1 if not old else old[1] + 1,
               d['base_hash'], d['body'], int(d.get('active', True))))


def dump(root):
    c = connect(root)
    try:
        c.execute('BEGIN')
        out = {}
        for table in TABLES:
            columns = [r[1] for r in c.execute('PRAGMA table_info(' + table + ')')]
            rows = [dict(zip(columns, r)) for r in c.execute('SELECT * FROM ' + table)]
            out[table] = sorted(rows, key=canonical)
        c.execute('COMMIT')
        return out
    finally:
        c.close()


def audit(root, name):
    c = connect(root)
    try:
        integrity = c.execute('PRAGMA integrity_check').fetchall()
        fk = c.execute('PRAGMA foreign_key_check').fetchall()
        check(name + ': SQLite integrity and foreign keys', integrity == [('ok',)] and not fk,
              {'integrity_check': integrity, 'foreign_key_check': fk})
        for h, rel, size in c.execute('SELECT * FROM resources'):
            path = root / rel
            check(name + ': registered resource exists and hashes ' + h[:12],
                  path.is_file() and path.stat().st_size == size and sha(path.read_bytes()) == h)
        history = c.execute('SELECT operation FROM history ORDER BY cursor').fetchall()
        ops = c.execute('SELECT id FROM operations').fetchall()
        check(name + ': every history has exactly one receipt', sorted(history) == sorted(ops))
        check(name + ': revision head matches immutable history', not c.execute(
            'SELECT u.id FROM units u LEFT JOIN revisions r ON r.unit=u.id AND r.revision=u.revision '
            'WHERE r.body IS NULL OR r.body != u.body').fetchall())
    finally:
        c.close()


def spawn(root, req, marker=None, point=None, mode='hold'):
    request = copy.deepcopy(req)
    if marker:
        request['_inject'] = {'ready': str(marker), 'point': point, 'mode': mode}
    file = root / ('.request-' + req['id'] + '-' + str(time.monotonic_ns()) + '.json')
    file.write_text(canonical(request), encoding='utf-8')
    p = subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()), '--worker', str(root), str(file)],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    CHILDREN.add(p)
    return p


def wait_marker(path, p):
    deadline = time.monotonic() + 15
    while not path.exists():
        if p.poll() is not None:
            out, err = p.communicate()
            raise RuntimeError(f'worker exited before injection: {p.returncode} {out} {err}')
        if time.monotonic() > deadline:
            raise TimeoutError(str(path))
        time.sleep(.005)


def collect(p, release=False):
    try:
        out, err = p.communicate('release\n' if release else None, timeout=15)
    finally:
        if p.poll() is not None:
            CHILDREN.discard(p)
    return {'exit_code': p.returncode, 'stdout': out, 'stderr': err,
            'result': json.loads(out) if out.strip() else None}


def command(root, req, label):
    r = apply(root, req)
    check(label, r.get('receipt', {}).get('saved') is True, r)
    return r


def rejected(root, req, reason, label):
    before = dump(root)
    r = apply(root, req)
    check(label, r.get('rejected') == reason and not r.get('saved'), r)
    check(label + ': rejection changes no persistent facts', before == dump(root))
    return r


def group(op, targets, token, **kw):
    return {'id': op, 'kind': 'group', 'actor': 'agent', 'attempt': 'attempt-1',
            'read_token': token, 'writes': [{'unit': u, 'block': b, 'payload': {'text': op + ' 合成提交'}}
                                          for u, b in targets], **kw}


def draft(target, seq=1, session='student', text='学生有效草稿，正文尚未提交'):
    return {'session': session, 'unit': target[0], 'block': target[1], 'seq': seq,
            'base_hash': 'fixture-baseline-recorded-by-caller', 'body': text, 'active': True}


def fault_matrix(base, targets):
    cases = []
    for point in ['before_commit', 'after_commit', 'after_resource_publish_before_register']:
        for mode in ['exit', 'kill']:
            root = base / (point + '-' + mode)
            seed(root, FIXTURE_DATA, 84)
            capture(root, targets, 'read-fault')
            c = connect(root)
            d = draft(targets[0], session='new-unrelated-session')
            d['active'] = False
            d['base_hash'] = digest(block(c, *targets[0]))
            n = {'id': 'N', 'unit': targets[0][0], 'revision': 1, 'block': targets[0][1],
                 'body': '合成个人笔记', 'original_context': canonical(block(c, *targets[0]))}
            c.close()
            req = group('fault-group', targets, 'read-fault', resource_texts=['synthetic immutable output'],
                        notes=[n], drafts=[d], finish=True)
            before = dump(root)
            ready = root / '.ready'
            p = spawn(root, req, ready, point, 'exit' if mode == 'exit' else 'hold')
            wait_marker(ready, p)
            if mode == 'kill':
                p.kill()
            death = collect(p)
            check(f'{point}/{mode}: actual abnormal child exit without saved reply',
                  death['exit_code'] != 0 and death['result'] is None and death['stderr'] == '', death)
            # Retain the source untouched after death: copy WAL+DB+resources before reopening it.
            copied = base / (root.name + '-moved')
            shutil.copytree(root, copied)
            wal_at_death = (root / 'course.sqlite3-wal').stat().st_size
            after = dump(root)
            audit(root, point + '/' + mode)
            if point == 'after_commit':
                check(point + '/' + mode + ': content/draft/note/history/receipt/attempt/readSet all committed',
                      len(after['operations']) == 1 and len(after['history']) == 1
                      and len(after['notes']) == 1 and len(after['drafts']) == 1
                      and all(u['revision'] == 2 for u in after['units'] if u['id'] in {t[0] for t in targets})
                      and after['attempts'][0]['state'] == 'completed'
                      and after['attempts'][0]['eligible'] == 0
                      and after['attempts'][0]['commits'] == 1
                      and after['read_sets'][0]['used_by'] == req['id']
                      and len(after['resource_uses']) == len({t[0] for t in targets}))
                replay = apply(root, req)
                check(point + '/' + mode + ': lost receipt recovered by original operation',
                      replay.get('replayed') and replay['receipt'] == json.loads(after['operations'][0]['receipt'])
                      and dump(root) == after)
            else:
                check(point + '/' + mode + ': all SQL facts rollback, no false saved', after == before)
            files = sorted(x.name for x in (root / 'resources').glob('*'))
            registered = {r['digest'] for r in after['resources']}
            orphans = [f for f in files if f not in registered]
            check(point + '/' + mode + ': immutable completed output survives; orphans are explicit',
                  len(files) == 1 and len(orphans) == (0 if point == 'after_commit' else 1), orphans)
            shutil.rmtree(root)
            audit(copied, point + '/' + mode + '/moved')
            check(point + '/' + mode + ': abnormal whole-directory copy recovers without original path',
                  dump(copied) == after)
            cases.append({'injection': point, 'mode': mode, 'process': death,
                          'wal_bytes_at_death': wal_at_death, 'orphan_digests': orphans,
                          'recovered_snapshot_hash': digest(after), 'copied_with_wal': True})
    return cases


def conflicts(root, targets):
    seed(root, FIXTURE_DATA, 84)
    a, b = targets
    capture(root, [a, b], 'reads-a-b')
    command(root, {'id': 'student-B', 'kind': 'group', 'actor': 'student',
                   'writes': [{'unit': b[0], 'block': b[1], 'payload': {'text': '学生已改依赖B'}}]},
            'student change B committed')
    rejected(root, group('stale-A', [a], 'reads-a-b'), 'read_set_changed', 'read B/write A rejects stale dependency')
    capture(root, [a], 'before-draft')
    c = connect(root)
    a_hash = digest(block(c, *a))
    c.close()
    d = draft(a)
    d['base_hash'] = a_hash
    saved = command(root, {'id': 'draft-save', 'kind': 'draft', 'draft': d}, 'valid student draft saved separately')
    c = connect(root)
    check('draft.saved does not claim content.committed', digest(block(c, *a)) == a_hash
          and saved['receipt']['kind'] == 'draft' and not saved['receipt']['changes'])
    c.close()
    rejected(root, group('draft-old-token', [a], 'before-draft'), 'read_set_changed', 'draft invalidates earlier read token')
    capture(root, [a], 'after-draft')
    rejected(root, group('draft-new-token', [a], 'after-draft'), 'active_student_draft', 'fresh token cannot overwrite active student input')
    # B and A are separate blocks of one real unit: no unit-wide conflict for independent content.
    capture(root, [b], 'only-B')
    independent = group('independent-B', [b], 'only-B')
    command(root, independent, 'unrelated active draft A allows independent B')
    before = dump(root)
    replay = apply(root, independent)
    check('same operation same payload returns identical receipt without side effects', replay['replayed'] and dump(root) == before)
    changed = copy.deepcopy(independent)
    changed['writes'][0]['payload']['text'] += ' changed'
    rejected(root, changed, 'operation_payload_mismatch', 'same operation different payload rejected')
    older = copy.deepcopy(d)
    older['body'] = '迟到旧输入'
    rejected(root, {'id': 'draft-stale-seq', 'kind': 'draft', 'draft': older}, 'draft_sequence_stale', 'draft sequence cannot go backwards')
    command(root, {'id': 'stop', 'kind': 'stop'}, 'stop invalidates attempt')
    command(root, {'id': 'continue', 'kind': 'continue', 'new_attempt': 'attempt-2'}, 'continue creates new attempt')
    capture(root, [b], 'old-late-read')
    rejected(root, group('old-late', [b], 'old-late-read'), 'attempt_ineligible', 'continue does not revive late old attempt')
    capture(root, [b], 'new-read', 'attempt-2')
    new = group('new-commit', [b], 'new-read')
    new['attempt'] = 'attempt-2'
    command(root, new, 'new continued attempt may commit')
    capture(root, [b], 'old-generation', 'attempt-2')
    stale = group('stale-generation', [b], 'old-generation', generation=0)
    stale['attempt'] = 'attempt-2'
    rejected(root, stale, 'generation_mismatch', 'wrong course generation rejected')
    # Incomplete/unparseable editor text is still a valid saved draft value.
    command(root, {'id': 'incomplete-input', 'kind': 'draft',
                   'draft': {**draft(a, 2, text='\\frac{未完成'), 'base_hash': a_hash}}, 'incomplete editor input retained')
    c = connect(root)
    check('independent commits and rejected stale writes preserve latest active input and original A',
          c.execute('SELECT body,seq,active FROM drafts WHERE session=? AND unit=? AND block=?',
                    ('student', *a)).fetchone() == ('\\frac{未完成', 2, 1) and digest(block(c, *a)) == a_hash)
    c.close()
    audit(root, 'conflicts')
    return {'snapshot_hash': digest(dump(root)), 'rejections': [c['detail'].get('rejected') for c in CHECKS
            if isinstance(c.get('detail'), dict) and c['detail'].get('rejected')]}


def races(base, targets):
    evidence = []
    for first in ['stop', 'commit']:
        root = base / first
        seed(root, FIXTURE_DATA, 84)
        capture(root, targets, 'read-race')
        commit = group('race-group', targets, 'read-race')
        stop = {'id': 'race-stop', 'kind': 'stop'}
        first_req, second_req = (stop, commit) if first == 'stop' else (commit, stop)
        marker1, marker2 = root / '.first-locked', root / '.second-entered'
        p1 = spawn(root, first_req, marker1, 'before_commit')
        wait_marker(marker1, p1)
        p2 = spawn(root, second_req, marker2, 'before_begin')
        wait_marker(marker2, p2)
        # Release second into a real SQLite write-lock wait while the first still owns it.
        p2.stdin.write('release\n')
        p2.stdin.flush()
        time.sleep(.05)
        check(first + ': both real workers alive while first transaction holds writer lock',
              p1.poll() is None and p2.poll() is None)
        r1 = collect(p1, release=True)
        r2 = collect(p2)
        check(first + ': worker protocol clean exits', r1['exit_code'] == r2['exit_code'] == 0
              and not r1['stderr'] and not r2['stderr'])
        t1, t2 = r1['result']['timing_ns'], r2['result']['timing_ns']
        check(first + ': second request overlaps first transaction and acquires after its commit',
              t2['started'] < t1['committed'] <= t2['acquired'], {'first': t1, 'second': t2})
        snapshot = dump(root)
        if first == 'stop':
            check('stop wins: new commit rejected, content/history receipt not fabricated',
                  r2['result'].get('rejected') == 'attempt_ineligible'
                  and len(snapshot['operations']) == 1 and all(u['revision'] == 1 for u in snapshot['units']))
        else:
            check('commit wins: committed group retained after stop',
                  r1['result']['receipt']['saved'] and len(snapshot['operations']) == 2
                  and all(u['revision'] == 2 for u in snapshot['units'] if u['id'] in {t[0] for t in targets}))
            before = dump(root)
            retry = apply(root, commit)
            check('late saved receipt after stop is a replay, not another commit',
                  retry.get('replayed') and dump(root) == before)
            capture(root, targets, 'after-stop')
            rejected(root, group('new-after-stop', targets, 'after-stop'), 'attempt_ineligible', 'new group after stopped rejected')
        audit(root, first + '/race')
        evidence.append({'first_lock_holder': first, 'first_process': r1, 'second_process': r2,
                         'second_lock_wait_ms': (t2['acquired'] - t2['started']) / 1e6})
    return evidence


def exchange(source, base, targets):
    # A stopped/quiescent course is copied whole. No online snapshot/GC claim.
    command(source, {'id': 'exchange-stop', 'kind': 'stop'}, 'quiesce task before directory copy')
    c = connect(source)
    checkpoint = c.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
    c.close()
    check('quiescent checkpoint completed', checkpoint[0] == 0, checkpoint)
    expected = dump(source)
    moved = base / 'course-moved'
    shutil.copytree(source, moved)
    shutil.rmtree(source)
    audit(moved, 'directory-move')
    check('stopped directory copy preserves all stable IDs/content/personal/history without source', dump(moved) == expected)
    # Human-readable versioned JSON rows + relative immutable resource bytes, no SQL dump/pickle.
    package = base / 'open-exchange'
    package.mkdir()
    manifest = {'format': 'storage-spike-exchange-1', 'tables': expected,
                'resource_policy': 'relative-sha256-immutable'}
    (package / 'course.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    for r in expected['resources']:
        dest = package / r['relative_path']
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(moved / r['relative_path'], dest)
    imported = base / 'course-imported'
    imported.mkdir()
    incoming = json.loads((package / 'course.json').read_text(encoding='utf-8'))
    check('exchange declares supported explicit format', incoming['format'] == 'storage-spike-exchange-1')
    c = connect(imported)
    try:
        c.executescript(SCHEMA)
        c.execute('BEGIN IMMEDIATE')
        c.execute('PRAGMA defer_foreign_keys=ON')
        for table in TABLES:
            for row in incoming['tables'][table]:
                if table == 'resources':
                    path = Path(row['relative_path'])
                    if path.is_absolute() or '..' in path.parts or path.parts[0] != 'resources':
                        raise ValueError('invalid_resource_path')
                    data = (package / path).read_bytes()
                    if sha(data) != row['digest'] or len(data) != row['size']:
                        raise ValueError('bad_exchange_resource')
                    (imported / 'resources').mkdir(exist_ok=True)
                    (imported / path).write_bytes(data)
                cols = list(row)
                c.execute('INSERT INTO ' + table + '(' + ','.join(cols) + ') VALUES (' + ','.join('?' for _ in cols) + ')',
                          tuple(row[k] for k in cols))
        c.execute('COMMIT')
    finally:
        c.close()
    audit(imported, 'open-exchange-import')
    check('open roundtrip preserves stable IDs/full content/drafts/personal/history/task/readSet/receipts',
          dump(imported) == expected)
    c = connect(imported)
    try:
        note = c.execute('SELECT unit,revision,block,original_context FROM notes').fetchone()
        original = json.loads(c.execute('SELECT body FROM revisions WHERE unit=? AND revision=?', note[:2]).fetchone()[0])
        anchored = next(b for b in blocks(original) if b['id'] == note[2])
        check('personal note still resolves original immutable context after import', canonical(anchored) == note[3])
    finally:
        c.close()
    return {'format': incoming['format'], 'snapshot_sha256': digest(expected),
            'json_bytes': (package / 'course.json').stat().st_size,
            'table_counts': {k: len(v) for k, v in expected.items()},
            'manifest_sha256': sha((package / 'course.json').read_bytes()), 'checkpoint': checkpoint}


def sizes(root):
    return {name: (root / ('course.sqlite3' + ext)).stat().st_size
            if (root / ('course.sqlite3' + ext)).exists() else 0
            for name, ext in [('db', ''), ('wal', '-wal'), ('shm', '-shm')]}


def distribution(xs):
    s = sorted(xs)
    return {'count': len(s), 'p50_ms': statistics.median(s),
            'p95_ms': s[max(0, math.ceil(.95 * len(s)) - 1)], 'max_ms': max(s)}


def mixed(root):
    seed(root, FIXTURE_DATA, 500)
    c = connect(root)
    # Keep the writer connection open so WAL measurements represent the active workload.
    units = [(u, json.loads(b)) for u, b in c.execute('SELECT id,body FROM units ORDER BY id')]
    ids = {u for u, _ in units}
    missing_relation_endpoints = sorted({r[k] for _, u in units for r in u.get('relations', [])
                                         for k in ['fromUnitId', 'toUnitId'] if r[k] not in ids})
    check('500-unit expansion preserves all embedded relation endpoints', not missing_relation_endpoints,
          missing_relation_endpoints)
    targets = [(uid, blocks(u)[0]['id']) for uid, u in units]
    before = sizes(root)
    records, errors, samples = [], [], []
    offset = 0
    cpu_start = time.process_time()
    wall_start = time.monotonic()
    for i in range(240):
        kind = ['draft', 'layout', 'message', 'group'][i % 4]
        uid, bid = targets[i % len(targets)]
        req = {'id': f'mixed-{i:03d}', 'kind': kind}
        if kind == 'draft':
            d = draft((uid, bid), 1, f'mixed-editor-{i}', text=('合成输入 ' * 50) + str(i))
            d['base_hash'] = digest(block(c, uid, bid))
            req['draft'] = d
        elif kind == 'layout':
            req.update(unit=uid, layout={'x': i * 3, 'y': i * 2, 'width': 384})
        elif kind == 'message':
            text = ('合成对话片段，非真实对话。' * 48) + str(i)
            req.update(conversation='synthetic-conversation', expected_offset=offset, text=text)
            offset += len(text.encode())
        else:
            other = targets[(i + 1) % len(targets)]
            req.update(actor='student', writes=[{'unit': u, 'block': b, 'payload': {'text': '完整合成正文 ' * 32 + str(i)}}
                                               for u, b in [(uid, bid), other]])
        start = time.perf_counter_ns()
        try:
            result = apply(root, req, c)
            elapsed = (time.perf_counter_ns() - start) / 1e6
            if not result.get('receipt', {}).get('saved'):
                errors.append({'operation': req['id'], 'result': result})
            records.append({'id': req['id'], 'kind': kind, 'ack_ms': elapsed,
                            'request_utf8_bytes': len(canonical(req).encode()),
                            'lock_wait_ms': (result['timing_ns']['acquired'] - result['timing_ns']['started']) / 1e6})
        except Exception as e:
            errors.append({'operation': req['id'], 'error': repr(e)})
        if (i + 1) % 24 == 0:
            samples.append({'after_operations': i + 1, **sizes(root)})
    wall = time.monotonic() - wall_start
    cpu = time.process_time() - cpu_start
    active = sizes(root)
    check('bounded mixed load: all 240 saves acknowledged with zero errors', len(records) == 240 and not errors, errors)
    check('mixed load: append offsets match durable byte stream',
          c.execute('SELECT MAX(offset),COUNT(*) FROM messages').fetchone() == (offset, 60))
    check('mixed load: 60 ordered drafts,60 layouts,120 new unit revisions,240 receipts',
          c.execute('SELECT COUNT(*) FROM drafts').fetchone()[0] == 60
          and c.execute('SELECT COUNT(*) FROM layouts').fetchone()[0] == 60
          and c.execute('SELECT COUNT(*) FROM revisions').fetchone()[0] == 620
          and c.execute('SELECT COUNT(*) FROM operations').fetchone()[0] == 240)
    checkpoint = c.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
    check('mixed load: final checkpoint returns nonbusy', checkpoint[0] == 0, checkpoint)
    post_checkpoint = sizes(root)
    c.close()
    audit(root, 'mixed')
    return {'unit_count': 500, 'operations': 240, 'concurrency': 1, 'pacing': 'bounded sequential without think-time',
            'ack_scope': 'Python command entry through FULL commit and receipt construction; excludes UI/IPC/fsync of resources',
            'percentile_method': 'median P50; nearest-rank ceil(0.95*n) P95',
            'overall': distribution([r['ack_ms'] for r in records]),
            'by_kind': {k: distribution([r['ack_ms'] for r in records if r['kind'] == k])
                        for k in ['draft', 'layout', 'message', 'group']},
            'before_bytes': before, 'active_end_bytes': active, 'after_checkpoint_bytes': post_checkpoint,
            'after_checkpoint_growth_bytes': {k: post_checkpoint[k] - before[k] for k in post_checkpoint},
            'active_growth_bytes': {k: active[k] - before[k] for k in active},
            'peak_observed_bytes': {k: max(s[k] for s in samples) for k in active},
            'samples': samples, 'records': records, 'errors': errors, 'wall_seconds': wall,
            'process_cpu_seconds': cpu, 'request_utf8_bytes': sum(r['request_utf8_bytes'] for r in records),
            'synthetic_conversation_bytes': offset, 'wal_checkpoint': checkpoint,
            'note': 'No A comparator, no latency threshold, no long-history/continuous-contention claim.'}


def main():
    global FIXTURE_DATA
    FIXTURE_DATA = json.loads(FIXTURE.read_text(encoding='utf-8'))
    out = {'experiment': 'sqlite-authority-immutable-resource-spike', 'format_version': 1,
           'started_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'status': 'running',
           'environment': {'python': sys.version, 'executable': sys.executable, 'sqlite': sqlite3.sqlite_version,
                           'platform': platform.platform(), 'machine': platform.machine(), 'os_name': os.name,
                           'cpu_count': os.cpu_count(), 'cwd': str(Path.cwd()), 'filesystem_probe_path': str(HERE)},
           'file_hashes': {}, 'checks': CHECKS, 'failures': []}
    for path in [Path(__file__).resolve(), FIXTURE, STORAGE_DESIGN, CONTENT_PROTOCOL]:
        data = path.read_bytes()
        out['file_hashes'][str(path.relative_to(PROJECT))] = {'sha256': sha(data), 'bytes': len(data)}
    prior_path = HERE / 'results.json'
    if prior_path.exists():
        prior = json.loads(prior_path.read_text(encoding='utf-8'))
        out['prior_runs'] = prior.get('prior_runs', []) + [{k: prior.get(k) for k in
                            ['started_at', 'status', 'failures', 'file_hashes', 'cleanup']}]
    temp = None
    temp_path = None
    try:
        temp = tempfile.TemporaryDirectory(prefix='.tmp-storage-spike-', dir=HERE)
        temp_path = Path(temp.name)
        setting_root = temp_path / 'settings'
        seed(setting_root, FIXTURE_DATA, 84)
        c = connect(setting_root)
        out['sqlite_settings'] = {k: c.execute('PRAGMA ' + k).fetchone()[0] for k in
                                  ['journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout',
                                   'wal_autocheckpoint', 'page_size', 'auto_vacuum']}
        out['sqlite_settings'].update({k: c.execute('PRAGMA ' + k).fetchone()[0]
                                       for k in ['fullfsync', 'checkpoint_fullfsync', 'locking_mode']})
        out['sqlite_compile_options'] = [r[0] for r in c.execute('PRAGMA compile_options')]
        c.close()
        first = FIXTURE_DATA['units'][0]
        targets = [(first['id'], b['id']) for b in blocks(first)[:2]]
        out['fixture'] = {'original_units': len(FIXTURE_DATA['units']), 'expanded_units': 500,
                          'targets': targets, 'source_assets': 'paths retained as fixture data; bytes never read',
                          'resource_bytes': 'synthetic UTF-8 only', 'nested_blocks': sum(len(blocks(u)) for u in FIXTURE_DATA['units'])}
        out['faults'] = fault_matrix(temp_path / 'faults', targets)
        out['conflicts'] = conflicts(temp_path / 'conflicts', targets)
        out['races'] = races(temp_path / 'races', targets)
        # Copy/exchange needs nonempty personal/history/resource links. Add one real contract group.
        portable = temp_path / 'portable'
        seed(portable, FIXTURE_DATA, 84)
        capture(portable, targets, 'portable-read')
        c = connect(portable)
        n = {'id': 'portable-note', 'unit': targets[0][0], 'revision': 1, 'block': targets[0][1],
             'body': '合成笔记保留旧语境', 'original_context': canonical(block(c, *targets[0]))}
        d = draft(targets[0], session='retained-draft')
        d['active'] = False
        d['base_hash'] = digest(block(c, *targets[0]))
        c.close()
        command(portable, group('portable-group', targets, 'portable-read', notes=[n], drafts=[d],
                                resource_texts=['portable synthetic artifact']), 'portable group saved')
        c = connect(portable)
        active = draft(targets[0], session='active-student-input', text='迁移时保留的有效输入')
        active['base_hash'] = digest(block(c, *targets[0]))
        c.close()
        command(portable, {'id': 'portable-active-draft', 'kind': 'draft', 'draft': active},
                'portable active student draft saved without publishing body')
        command(portable, {'id': 'portable-layout', 'kind': 'layout', 'unit': targets[0][0],
                           'layout': {'x': 20, 'y': 40}}, 'portable layout saved')
        command(portable, {'id': 'portable-message', 'kind': 'message', 'conversation': 'synthetic',
                           'expected_offset': 0, 'text': '合成追加消息'}, 'portable message saved')
        out['portability'] = exchange(portable, temp_path, targets)
        out['mixed_load'] = mixed(temp_path / 'mixed-500')
        out['status'] = 'passed'
    except BaseException as e:
        out['status'] = 'failed'
        out['failures'].append({'error': repr(e), 'traceback': traceback.format_exc()})
    finally:
        cleanup_errors = []
        for p in list(CHILDREN):
            try:
                if p.poll() is None:
                    p.kill()
                p.communicate(timeout=10)
                CHILDREN.discard(p)
            except Exception as e:
                cleanup_errors.append(repr(e))
        for connection in CONNECTIONS:
            try:
                connection.close()
            except Exception as e:
                cleanup_errors.append(repr(e))
        try:
            if temp:
                temp.cleanup()
        except Exception as e:
            cleanup_errors.append(repr(e))
        out['cleanup'] = {'temporary_course_removed': temp_path is not None and not temp_path.exists(),
                          'tracked_children_remaining': len(CHILDREN), 'errors': cleanup_errors}
        if cleanup_errors or CHILDREN or (temp_path and temp_path.exists()):
            out['status'] = 'failed'
            out['failures'].append({'error': 'cleanup_incomplete', 'details': out['cleanup']})
        out['check_count'] = len(CHECKS)
        out['finished_at'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
        prior_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(canonical({'status': out['status'], 'checks': len(CHECKS), 'failures': out['failures'],
                     'results': str(prior_path), 'cleanup': out['cleanup']}))
    return 0 if out['status'] == 'passed' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', nargs=2, metavar=('COURSE', 'REQUEST'))
    args = parser.parse_args()
    if args.worker:
        root, path = map(Path, args.worker)
        print(canonical(apply(root, json.loads(path.read_text(encoding='utf-8')))), flush=True)
    else:
        sys.exit(main())
