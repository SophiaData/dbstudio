# Run only on an ephemeral GitHub-hosted runner with a synthetic loopback database.
param([string]$CandidateDirectory)

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
if (-not $CandidateDirectory -and -not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'The Windows test binary is missing.' }

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
    'Isolated MySQL is ready.'
    $values = (1..405 | ForEach-Object { '({0},{1},''row-{0}'',''note-{0}'')' -f $_, ($_ % 3) }) -join ','
    $null = Invoke-FixtureSql @"
CREATE DATABASE dbstudio_acceptance;
CREATE DATABASE dbstudio_restore;
CREATE TABLE dbstudio_acceptance.items (
    id INT PRIMARY KEY,
    group_id INT NOT NULL,
    payload VARCHAR(64) NOT NULL,
    note VARCHAR(64) NULL,
    generated_value VARCHAR(64) GENERATED ALWAYS AS (upper(payload)) STORED
);
CREATE TABLE dbstudio_acceptance.items_secondary (
    id INT PRIMARY KEY,
    payload VARCHAR(64) NOT NULL
);
CREATE TABLE dbstudio_restore.items LIKE dbstudio_acceptance.items;
CREATE USER 'acceptance'@'127.0.0.1';
GRANT SELECT, UPDATE ON dbstudio_acceptance.* TO 'acceptance'@'127.0.0.1';
GRANT SELECT ON dbstudio_restore.* TO 'acceptance'@'127.0.0.1';
INSERT INTO dbstudio_acceptance.items (id, group_id, payload, note) VALUES $values;
INSERT INTO dbstudio_acceptance.items_secondary (id, payload) VALUES (1, 'secondary-row-1'), (2, 'secondary-row-2');
"@
    if ($CandidateDirectory) {
        & (Join-Path $PSScriptRoot 'windows-installed-candidate.ps1') -CandidateDirectory $CandidateDirectory -Port $port -ReadFixtureSql ${function:Invoke-FixtureSql}
        return
    }
    $launch = [Diagnostics.ProcessStartInfo]::new($binary)
    $launch.UseShellExecute = $false
    $launch.CreateNoWindow = $true
    $launch.RedirectStandardOutput = $true
    $launch.RedirectStandardError = $true
    $app = [Diagnostics.Process]::Start($launch)
    $stdout = $app.StandardOutput.ReadToEndAsync()
    $stderr = $app.StandardError.ReadToEndAsync()
    $exited = $app.WaitForExit(150000)
    if (-not $exited) {
        $app.Kill()
        $app.WaitForExit()
    }
    ($stdout.Result + [char]10 + $stderr.Result) -split '\r?\n' | Where-Object {
        $_ -match '^\[windows-acceptance\] (host-start|page-finished|smokeFixture|smokeReport|[A-Za-z]{1,32}:(enter|ok|error))$'
    } | Write-Output
    $reportPath = Join-Path $env:DBSTUDIO_NATIVE_SMOKE_ROOT 'report.json'
    if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
        throw "The native WebView produced no acceptance report (exited=$exited, exitCode=$($app.ExitCode))."
    }
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    $required = @('isolated_fixture', 'mysql_connection', 'mysql_alias_completion', 'mysql_codemirror_execution', 'mysql_editor_daily_tools', 'mysql_editor_error_navigation', 'mysql_editor_large_drafts', 'mysql_multi_sort_pages', 'mysql_cancel_then_query', 'mysql_transaction', 'mysql_update_preview', 'mysql_grid_batch_paste', 'mysql_guard_local_apply_preview', 'mysql_connection_draft_aggregate', 'mysql_generated_column_export', 'mysql_execution_context')
    if ($report.editorPerformance) {
        @{ sha = $env:GITHUB_SHA; runId = $env:GITHUB_RUN_ID; metrics = $report.editorPerformance } | ConvertTo-Json -Depth 8 |
            Set-Content -LiteralPath (Join-Path $PWD 'editor-performance.json') -Encoding utf8NoBOM
    }
    foreach ($name in $required) {
        $passed = $report.checks.$name -eq $true
        Write-Output "$name=$passed"
    }
    foreach ($name in @('mysql_editor_ime_guard', 'mysql_editor_single_statement', 'mysql_editor_text_result', 'mysql_editor_sql_source', 'mysql_editor_text_kind')) {
        Write-Output "$name=$($report.checks.$name -eq $true)"
    }
    if (-not $exited -or $app.ExitCode -ne 0 -or $report.ok -ne $true -or @($required | Where-Object { $report.checks.$_ -ne $true }).Count) {
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
    AND BINARY a.note <=> BINARY b.note
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
