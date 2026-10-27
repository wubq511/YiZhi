"""Finite deterministic simulated work; deliberately no course or file writes."""
import json
import signal
import time

running = True
def stop(_signum, _frame):
    global running
    running = False
signal.signal(signal.SIGTERM, stop)
tick, checksum = 0, 0
while running and tick < 600:
    time.sleep(0.1)
    if not running:
        break
    tick += 1
    checksum = (checksum + tick * 17) % 1000000007
    print(json.dumps({"jobId": "host-spike-job-001", "tick": tick, "checksum": checksum,
                      "target": 600, "status": "running" if tick < 600 else "complete"}), flush=True)
