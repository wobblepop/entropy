@echo off
rem Starts the local PDF service behind the EntropyEditor's "Generate PDF" picker.
rem Keep this window open while you work; close it (or press Ctrl+C) to stop.
rem Extra arguments are passed through, e.g.:  start_pdf_service.bat --port 9000
cd /d "%~dp0"
py pdf_service.py %*
echo.
echo The PDF service has stopped.
pause
