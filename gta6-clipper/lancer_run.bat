@echo off
rem Lance une recherche + decoupe (appele chaque jour par le Planificateur de taches).
cd /d "%~dp0"
if not exist data mkdir data
echo ===== %date% %time% >> data\run.log
".venv\Scripts\gta6-clipper.exe" run >> data\run.log 2>&1
