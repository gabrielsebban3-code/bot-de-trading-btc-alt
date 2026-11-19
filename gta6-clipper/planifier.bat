@echo off
rem Programme un traitement automatique chaque jour (Planificateur de taches Windows).
cd /d "%~dp0"
set HEURE=18:00
set /p HEURE=Heure du traitement quotidien (HH:MM, Entree = 18:00) : 
schtasks /Create /F /SC DAILY /ST %HEURE% /TN "gta6-clipper" /TR "\"%~dp0lancer_run.bat\"" >nul || goto erreur
echo.
echo C'est programme : chaque jour a %HEURE%, si le PC est allume et ta session ouverte.
echo Les nouveaux clips apparaitront sur le site. Journal : data\run.log
echo Pour arreter : schtasks /Delete /TN gta6-clipper /F
pause
exit /b 0

:erreur
echo.
echo ECHEC de la programmation (heure au format HH:MM, par exemple 18:00). Envoie une capture de cette fenetre.
pause
exit /b 1
