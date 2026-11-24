# Run only on an ephemeral GitHub-hosted runner with a synthetic loopback database.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'This fixture requires a GitHub-hosted Windows runner.'
}

$serverCommand = Get-Command mysqld.exe -ErrorAction SilentlyContinue
if ($serverCommand) {
    $server = $serverCommand.Source
} else {
    $mysqlInstall = Join-Path $env:ProgramFiles 'MySQL'
    $server = Get-ChildItem -LiteralPath $mysqlInstall -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'bin\mysqld.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
}
if (-not $server) {
    $portableServer = 'C:\tools\mysql\current\bin\mysqld.exe'
    if (Test-Path -LiteralPath $portableServer -PathType Leaf) { $server = $portableServer }
}
if (-not $server) { throw 'The runner image does not expose mysqld.exe.' }
$mysql = Join-Path (Split-Path -Parent $server) 'mysql.exe'
if (-not (Test-Path -LiteralPath $mysql -PathType Leaf)) { throw 'MySQL CLI is missing.' }
$binary = Join-Path $PWD 'target\debug\dbstudio-desktop.exe'
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'The Windows test binary is missing.' }

$runKey = [Guid]::NewGuid().ToString('N')
$data = Join-Path $env:RUNNER_TEMP "dbstudio-mysql-$runKey"
$env:TMP = $env:RUNNER_TEMP
$env:TEMP = $env:RUNNER_TEMP
$env:DBSTUDIO_NATIVE_SMOKE_ROOT = Join-Path $env:RUNNER_TEMP "dbstudio-smoke-$runKey"
$port = 13306
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw 'The fixture port is already occupied.'
}
$common = @('--no-defaults', ('--datadir="{0}"' -f $data))
function Invoke-FixtureSql([string] $Sql) {
    $result = $Sql | & $mysql --no-defaults --protocol=TCP --host=127.0.0.1 --port=$port --user=root --skip-password --connect-timeout=3 --batch --skip-column-names
    if ($LASTEXITCODE -ne 0) { throw 'Fixture SQL failed.' }
    return $result
}

$init = Start-Process -FilePath $server -ArgumentList ($common + '--initialize-insecure') -Wait -PassThru -WindowStyle Hidden
if ($init.ExitCode -ne 0) { throw 'MySQL fixture initialization failed.' }
$daemon = Start-Process -FilePath $server -ArgumentList ($common + @("--port=$port", '--bind-address=127.0.0.1', '--mysqlx=OFF')) -PassThru -WindowStyle Hidden
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($daemon.HasExited) { throw "Fixture server exited with code $($daemon.ExitCode)." }
        $ping = & $mysql --no-defaults --protocol=TCP --host=127.0.0.1 --port=$port --user=root --skip-password --connect-timeout=2 --batch --skip-column-names --execute='SELECT 1' 2>$null
        if ($LASTEXITCODE -eq 0 -and $ping -eq '1') { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw 'Isolated MySQL did not become reachable.' }
    $values = (1..405 | ForEach-Object { '({0},{1},''row-{0}'')' -f $_, ($_ % 3) }) -join ','
    $null = Invoke-FixtureSql @"
CREATE DATABASE dbstudio_acceptance;
CREATE DATABASE dbstudio_restore;
CREATE TABLE dbstudio_acceptance.items (
    id INT PRIMARY KEY,
    group_id INT NOT NULL,
    payload VARCHAR(64) NOT NULL,
    generated_value VARCHAR(64) GENERATED ALWAYS AS (upper(payload)) STORED
);
CREATE TABLE dbstudio_restore.items LIKE dbstudio_acceptance.items;
CREATE USER 'acceptance'@'127.0.0.1';
GRANT SELECT, UPDATE ON dbstudio_acceptance.* TO 'acceptance'@'127.0.0.1';
INSERT INTO dbstudio_acceptance.items (id, group_id, payload) VALUES $values;
"@
    $app = Start-Process -FilePath $binary -PassThru -WindowStyle Hidden
    if (-not $app.WaitForExit(150000)) {
        $app.Kill()
        throw 'The native WebView did not finish its acceptance checks.'
    }
    $report = Get-Content -LiteralPath (Join-Path $env:DBSTUDIO_NATIVE_SMOKE_ROOT 'report.json') -Raw | ConvertFrom-Json
    $required = @('isolated_fixture', 'mysql_connection', 'mysql_alias_completion', 'mysql_multi_sort_pages', 'mysql_cancel_then_query', 'mysql_transaction', 'mysql_generated_column_export')
    foreach ($name in $required) {
        $passed = $report.checks.$name -eq $true
        Write-Output "$name=$passed"
    }
    if ($app.ExitCode -ne 0 -or $report.ok -ne $true -or @($required | Where-Object { $report.checks.$_ -ne $true }).Count) {
        throw 'Windows native MySQL acceptance failed.'
    }
    $export = Get-Content -LiteralPath (Join-Path $env:DBSTUDIO_NATIVE_SMOKE_ROOT 'acceptance.sql') -Encoding utf8
    $prefix = 'INSERT INTO `dbstudio_acceptance`.`items` '
    $restorePrefix = 'INSERT INTO `dbstudio_restore`.`items` '
    if ($export.Count -ne 405 -or @($export | Where-Object { -not $_.StartsWith($prefix) -or $_ -match '`generated_value`' }).Count) {
        throw 'Unexpected export target, column list, or row count.'
    }
    $replay = ($export | ForEach-Object { $restorePrefix + $_.Substring($prefix.Length) }) -join "`n"
    $null = Invoke-FixtureSql $replay
    $match = Invoke-FixtureSql @'
SELECT COUNT(*) = 405 AND SUM(
    BINARY a.payload = BINARY b.payload
    AND a.group_id = b.group_id
    AND BINARY a.generated_value = BINARY b.generated_value
) = 405
AND (SELECT COUNT(*) FROM dbstudio_restore.items) = 405
FROM dbstudio_acceptance.items a JOIN dbstudio_restore.items b ON a.id = b.id;
'@
    if ($match -ne '1') { throw 'Independent readback does not match the MySQL source.' }
    'Verified: Windows WebView and isolated MySQL, including 405 restored rows.' | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8
} finally {
    if (-not $daemon.HasExited) {
        $daemon.Kill()
        $daemon.WaitForExit()
    }
}
