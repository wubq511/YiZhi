#!/usr/bin/env python3
"""Run the common independent cube enumerator on TH-08 candidates only; no writes."""
import importlib.util
import json
from pathlib import Path
import sys
sys.dont_write_bytecode=True
path=Path(__file__).resolve().parents[1]/'TH-07/verify_candidate.py'
spec=importlib.util.spec_from_file_location('second_batch_verifier',path)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
if __name__=='__main__':print(json.dumps(module.run('TH-08'),ensure_ascii=False,indent=2))
