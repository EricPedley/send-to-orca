@echo off
rem Orca Bridge - start the local helper without a console window.
rem Requires Python 3 from python.org (pythonw on PATH).
start "" pythonw "%~dp0..\bridge\orca_bridge.py"
