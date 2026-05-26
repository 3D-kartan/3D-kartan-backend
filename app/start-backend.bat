@echo off

REM Make sure we are on the correct drive
D:

REM Path to the folder
cd \3D-kartan-backend

REM Start Node with full path (most robust)
"C:\Program Files\nodejs\node.exe" server.js >> 3D-kartan-backen.log 2>&1
