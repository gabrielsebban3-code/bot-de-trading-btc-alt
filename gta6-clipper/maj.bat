@echo off
rem Met a jour gta6-clipper depuis GitHub. Garde .venv, data, config.yaml et .env.
cd /d "%~dp0"
set DOSSIER=maj\bot-de-trading-btc-alt-claude-sweet-ramanujan-kNRqe\gta6-clipper
echo Mise a jour de gta6-clipper.
echo Ferme d'abord le site s'il tourne (Ctrl+C dans sa fenetre), puis appuie sur une touche.
pause >nul
echo Telechargement de la derniere version...
curl -L -s -f -o maj.zip https://codeload.github.com/gabrielsebban3-code/bot-de-trading-btc-alt/zip/refs/heads/claude/sweet-ramanujan-kNRqe || goto erreur
if exist maj rmdir /S /Q maj
mkdir maj
tar -xf maj.zip -C maj || goto erreur
if not exist "%DOSSIER%\src" goto erreur
xcopy /E /Y /I /Q "%DOSSIER%\src" src >nul || goto erreur
for %%F in (pyproject.toml requirements.txt README.md planifier.bat lancer_run.bat) do if exist "%DOSSIER%\%%F" copy /Y "%DOSSIER%\%%F" . >nul
echo Mise a jour des dependances...
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -e . || goto erreur
echo Mise a jour de yt-dlp (YouTube change souvent, les vieilles versions cassent)...
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -U yt-dlp || goto erreur
copy /Y "%DOSSIER%\maj.bat" maj_nouveau.bat >nul
rmdir /S /Q maj
del maj.zip
echo.
echo Mise a jour terminee. Relance le site avec : gta6-clipper serve
pause
rem Remplace ce fichier par sa nouvelle version (le bloc entre parentheses est lu en entier avant d'etre execute).
(if exist maj_nouveau.bat move /Y maj_nouveau.bat "%~f0" >nul) & exit /b 0

:erreur
echo.
echo ECHEC de la mise a jour. Envoie une capture de cette fenetre.
if exist maj rmdir /S /Q maj
if exist maj.zip del maj.zip
pause
exit /b 1
