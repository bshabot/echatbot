# Windows Task Scheduler wrapper. Create the task (every 30 min) once, after one supervised live run:
#   schtasks /Create /TN "OrderStream runner" /SC MINUTE /MO 30 /TR "powershell -File C:\path\orderstream-bridge\run-task.ps1"
Set-Location $PSScriptRoot
Get-Content .env | ForEach-Object { if ($_ -match '^\s*([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim()) } }
node src/sync.js --write
node src/run.js --live --limit 5
