#!/usr/bin/env python3
"""Compatibility entry point; reads candidate content through the independent verifier."""
import runpy
import sys
from pathlib import Path
sys.dont_write_bytecode = True
script = Path(__file__).with_name("verify_independent.py")
sys.argv = [str(script), "--unit", "KU-072"]
runpy.run_path(str(script), run_name="__main__")
