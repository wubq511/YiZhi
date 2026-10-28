"""One-shot legacy adapter. No legacy service instantiation or source writes.

Only macOS/POSIX migration is implemented. Hold the same service/content flocks
as the old host, plus SQLite writer byte locks; a missing lock is not evidence
of quiescence. stdin lifetime is the lease. The caller never receives a lock
receipt that could be reused after locks were released.
"""
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
from directory_authority import acquire_migration


def inside(root, name):
    if not isinstance(name, str) or not name or Path(name).is_absolute() or '..' in Path(name).parts or '\\' in name:
        raise ValueError('课程相对路径无效')
    path = root / name
    if any(p.is_symlink() for p in [path, *path.parents] if p != root.parent):
        raise ValueError('课程不接受软链')
    if not path.resolve().is_relative_to(root):
        raise ValueError('课程路径越界')
    return path


def main():
    root = Path(sys.argv[1]).resolve(strict=True)
    manifest = json.loads((root / '课程.json').read_text())
    handles = [acquire_migration(root)]
    for path in [root / '.review-board/service.lock', inside(root, manifest['knowledge'] + '.content.lock')]:
        handle = path.open('rb')  # Never creates lock files on the original course.
        handles.append(handle)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('源课程仍有活动写入者，须正常停止旧服务并释放写入锁')
    state = inside(root, manifest['state'])
    # SQLite POSIX byte locks detect writers even outside the normal host. WAL
    # readers do not protect WAL_WRITE_LOCK; reserve it explicitly until release.
    for path, offset, length in [(state, 1073741825, 1), (Path(str(state) + '-shm'), 120, 1)]:
        if path.exists():
            handle = path.open('r+b')  # No data is written, and no missing file is created.
            handles.append(handle)
            try:
                fcntl.lockf(handle, fcntl.LOCK_EX | fcntl.LOCK_NB, length, offset)
            except BlockingIOError:
                raise ValueError('源 SQLite 仍有活动写入事务')
    print(json.dumps({'locked': True}), flush=True)
    command = json.loads(sys.stdin.readline())
    if command['action'] == 'snapshot':
        target = Path(command['directory'])
        target.mkdir(exist_ok=False)
        try:
            files = {}
            for path in sorted(root.rglob('*')):
                rel = path.relative_to(root).as_posix()
                if path.is_symlink():
                    raise ValueError('课程副本不接受软链：' + rel)
                if not path.is_file() or rel.startswith('.review-board/') or rel.endswith('.content.lock'):
                    continue
                out = target / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                before = hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
                shutil.copyfile(path, out)
                if hashlib.file_digest(out.open('rb'), 'sha256').hexdigest() != before or hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() != before:
                    raise ValueError('复制期间源课程发生变化：' + rel)
                files[rel] = before
            if state.exists():
                output = inside(target.resolve(), manifest['state'])
                output.parent.mkdir(parents=True, exist_ok=True)
                with sqlite3.connect(state.as_uri() + '?mode=ro', uri=True) as src, sqlite3.connect(output) as dst:
                    src.backup(dst)
                    if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise ValueError('旧状态数据库副本校验失败')
                files[manifest['state']] = hashlib.file_digest(output.open('rb'), 'sha256').hexdigest()
            for rel, expected in files.items():
                if rel != manifest['state'] and hashlib.file_digest(inside(root, rel).open('rb'), 'sha256').hexdigest() != expected:
                    raise ValueError('复制完成前源课程发生变化：' + rel)
            (target / '.review-board').mkdir(exist_ok=True)
            (target / '.review-board/service.lock').touch()
            inside(target.resolve(), manifest['knowledge'] + '.content.lock').touch()
            (target / 'stopped-copy.json').write_text(json.dumps({'schema': 'yizhi-stopped-copy-1', 'originalDirectory': str(root), 'files': files}, ensure_ascii=False, indent=2))
            print(json.dumps({'directory': str(target), 'files': files}), flush=True)
        except BaseException:
            shutil.rmtree(target)
            raise
    elif command['action'] == 'hold':
        # The parent completes verification/publication before closing stdin.
        for line in sys.stdin:
            request = json.loads(line)
            if request['action'] != 'publish' or sys.platform != 'darwin':
                raise ValueError('独占目录发布当前仅支持 macOS')
            # macOS SDK sys/stdio.h: RENAME_EXCL = 0x00000004.
            # A plain rename may replace a concurrently created empty target.
            native = ctypes.CDLL(None, use_errno=True)
            native.renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
            native.renamex_np.restype = ctypes.c_int
            result = native.renamex_np(os.fsencode(request['from']), os.fsencode(request['to']), 4)
            code = ctypes.get_errno()
            print(json.dumps({'published': result == 0, 'error': os.strerror(code) if result else None}), flush=True)
    else:
        raise ValueError('未知锁请求')
    for handle in reversed(handles):
        handle.close()


try:
    main()
except BaseException as error:
    print(str(error), file=sys.stderr, flush=True)
    sys.exit(1)
