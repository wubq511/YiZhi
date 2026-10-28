"""Shared source admission for the one-time, durable directory handoff.

The short shared lease covers each normal write; the migrator holds the same
lease exclusively through verification and the atomic publication decision.
A verified-but-unpublished intent never revokes the source after process death.
"""
from contextlib import contextmanager
import fcntl
import json
from pathlib import Path
import re

MARKER='directory-transition.json'
SCHEMA='yizhi-directory-transition-1'

def course_root(db_path):
    for parent in Path(db_path).resolve().parents:
        if (parent/'课程.json').is_file():
            m=json.loads((parent/'课程.json').read_text())
            if (parent/m.get('state','')).resolve()==Path(db_path).resolve():
                return parent
    return None

def decision(root):
    path=root/'.review-board'/MARKER
    if not path.exists():
        return None
    try:
        v=json.loads(path.read_text())
        manifest=json.loads((root/'课程.json').read_text())
        if v.get('schema')!=SCHEMA or v.get('sourceDirectory')!=str(root.resolve()) or v.get('courseId')!=manifest['courseId'] or v.get('phase') not in ('verified','published') or not isinstance(v.get('operationId'),str) or not isinstance(v.get('sourceVersion'),dict) or not isinstance(v.get('targetDirectory'),str):
            raise ValueError('身份或阶段无效')
        if v['phase']=='published' and (not v.get('publishedAt') or not re.fullmatch('[a-f0-9]{64}',v.get('proof',{}).get('databaseSha256',''))):
            raise ValueError('完成事实缺失')
        return v
    except Exception as exc:
        raise RuntimeError('迁移权威标记无法核对，拒绝写入：'+str(exc)) from exc

def check(root):
    v=decision(root)
    if v and v['phase']=='published':
        raise RuntimeError('课程已迁移，原目录仅为只读迁移前副本；当前权威：'+v['targetDirectory'])

@contextmanager
def writer_admission(root):
    if root is None:
        yield
        return
    root=Path(root).resolve();folder=root/'.review-board';folder.mkdir(exist_ok=True)
    with (folder/'directory-transition.lock').open('a+b') as h:
        fcntl.flock(h,fcntl.LOCK_SH)
        check(root)
        yield

def acquire_migration(root):
    root=Path(root).resolve();folder=root/'.review-board';folder.mkdir(exist_ok=True)
    h=(folder/'directory-transition.lock').open('a+b')
    try:
        fcntl.flock(h,fcntl.LOCK_EX|fcntl.LOCK_NB)
        check(root)
        return h
    except BaseException:
        h.close()
        raise RuntimeError('源课程仍在写入或已迁移，不能取得切换租约')
