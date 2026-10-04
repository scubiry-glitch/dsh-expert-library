#!/usr/bin/env python3
"""Compatibility entry: static chapter text precheck, never full semantic quality."""
import pathlib
import runpy
runpy.run_path(str(pathlib.Path(__file__).resolve().parent / "scripts" / "html_preflight.py"), run_name="__main__")
