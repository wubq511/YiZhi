#!/usr/bin/env python3
"""已修正的兼容入口：读取实际候选并执行独立校验，不再保留旧自证/错位读数。"""
from pathlib import Path
import runpy
import sys
sys.dont_write_bytecode = True
script = Path(__file__).with_name("verify_independent.py")
sys.argv = [str(script), "--unit", "KU-057"]
runpy.run_path(str(script), run_name="__main__")
