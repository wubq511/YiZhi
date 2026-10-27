#!/usr/bin/env python3
"""Measurement-only libSystem helper; never executes a database/product workload."""
import ctypes
import json
import os
import sys


class Usage(ctypes.Structure):
    # Same RUSAGE_INFO_V2 layout as desktop-resource-spike/run.py.
    _fields_ = [('ri_uuid', ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64) for name in [
            'ri_user_time', 'ri_system_time', 'ri_pkg_idle_wkups',
            'ri_interrupt_wkups', 'ri_pageins', 'ri_wired_size',
            'ri_resident_size', 'ri_phys_footprint', 'ri_proc_start_abstime',
            'ri_proc_exit_abstime', 'ri_child_user_time', 'ri_child_system_time',
            'ri_child_pkg_idle_wkups', 'ri_child_interrupt_wkups',
            'ri_child_pageins', 'ri_child_elapsed_abstime',
            'ri_diskio_bytesread', 'ri_diskio_byteswritten',
        ]
    ]


def collect(pids):
    try:
        if sys.platform != 'darwin':
            raise RuntimeError('proc_pid_rusage physical footprint requires macOS')
        lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        lib.proc_pid_rusage.restype = ctypes.c_int
    except Exception as error:
        return [{'pid': pid, 'physFootprintBytes': None,
                 'error': {'message': str(error), 'type': type(error).__name__}}
                for pid in pids]
    rows = []
    for pid in pids:
        try:
            usage = Usage()
            ctypes.set_errno(0)
            rc = lib.proc_pid_rusage(pid, 2, ctypes.byref(usage))
            err = ctypes.get_errno()
            if rc:
                rows.append({'pid': pid, 'physFootprintBytes': None,
                             'error': {'returnCode': rc, 'errno': err,
                                       'message': os.strerror(err)}})
            else:
                rows.append({'pid': pid, 'physFootprintBytes': usage.ri_phys_footprint})
        except Exception as error:
            rows.append({'pid': pid, 'physFootprintBytes': None,
                         'error': {'message': str(error), 'type': type(error).__name__}})
    return rows


if __name__ == '__main__':
    # PID selection/ownership is exclusively determined by the Electron sampler.
    pids = list(dict.fromkeys(int(arg) for arg in sys.argv[1:]))
    print(json.dumps({'method': 'proc_pid_rusage(RUSAGE_INFO_V2).ri_phys_footprint',
                      'processes': collect(pids)}))
