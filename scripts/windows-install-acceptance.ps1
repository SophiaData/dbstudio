#Requires -Version 7.4
param(
    [Parameter(Mandatory)][string]$CandidateInstaller,
    [Parameter(Mandatory)][string]$ReportPath,
    [string]$BaselineInstaller,
    [switch]$FirstUse,
    [switch]$CsvOnly,
    [switch]$EditorTabsOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:stage = 'runner'
$script:action = $null
$script:failure = 'CHECK_FAILED'
$script:children = [Collections.Generic.List[Diagnostics.Process]]::new()
$report = [ordered]@{
    schemaVersion = 1
    status = 'failed'
    runId = $env:GITHUB_RUN_ID
    runAttempt = $env:GITHUB_RUN_ATTEMPT
    candidateSha = $env:GITHUB_SHA
    scenario = if ($EditorTabsOnly) { 'mysql_editor_tabs' } elseif ($CsvOnly) { 'clean_install_csv_roundtrip' } elseif ($FirstUse) { 'clean_install_grid_copy' } else { 'replacement' }
    checks = [ordered]@{}
}

function Stop-Acceptance([string]$Code) {
    $script:failure = $Code
    throw [InvalidOperationException]::new($Code)
}

function Start-OwnedProcess([Diagnostics.ProcessStartInfo]$Info) {
    $Info.UseShellExecute = $false
    $process = [Diagnostics.Process]::Start($Info)
    $script:children.Add($process)
    return $process
}

function New-ProcessInfo([string]$File, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($File)
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    return $info
}

function Invoke-PrivateProcess($Info, [int]$Timeout, [string]$InputText = '') {
    $Info.CreateNoWindow = $true
    $Info.RedirectStandardInput = $true
    $Info.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    $process = Start-OwnedProcess $Info
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    try {
        if ($InputText) { $process.StandardInput.WriteLine($InputText) }
    } catch [IO.IOException] {
        if (-not $process.HasExited) { throw }
    } finally {
        $process.StandardInput.Dispose()
    }
    if (-not $process.WaitForExit($Timeout * 1000)) { Stop-Acceptance 'PROCESS_TIMEOUT' }
    return @{ ExitCode = $process.ExitCode; Out = $stdout.GetAwaiter().GetResult().Trim(); Err = $stderr.GetAwaiter().GetResult().Trim() }
}

# Use a separate option-free MySQL instance and never log its SQL or output.
function Invoke-FixtureSql([string]$User, [string]$Sql, [string]$SecretValue = '') {
    $info = New-ProcessInfo $mysql @('--no-defaults', '--no-login-paths', '--protocol=TCP',
        '--host=127.0.0.1', "--port=$port", '--connect-timeout=2', "--user=$User", '--batch', '--raw', '--skip-column-names')
    $null = $info.Environment.Remove('MYSQL_PWD')
    if ($SecretValue) { $info.Environment['MYSQL_PWD'] = $SecretValue }
    return Invoke-PrivateProcess $info 15 $Sql
}

function Install-App([string]$Installer, [switch]$Update) {
    $info = [Diagnostics.ProcessStartInfo]::new($Installer)
    $mode = if ($Update) { '/S /UPDATE' } else { '/S' }
    # NSIS expects an unquoted /D switch as the final argument.
    $info.Arguments = "$mode /D=$installDir"
    $installerProcess = Start-OwnedProcess $info
    if (-not $installerProcess.WaitForExit(180000)) { Stop-Acceptance 'INSTALLER_TIMEOUT' }
    if ($installerProcess.ExitCode -ne 0) { Stop-Acceptance 'INSTALLER_NONZERO' }
    $binaries = @(Get-ChildItem -LiteralPath $installDir -File -Filter '*.exe' | Where-Object Name -ne 'uninstall.exe')
    if ($binaries.Count -ne 1 -or ($binaries[0].Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Stop-Acceptance 'INSTALLED_BINARY_NOT_FOUND'
    }
    return $binaries[0].FullName
}

function Open-App([string]$Binary) {
    $info = New-ProcessInfo $Binary @()
    # Enable Chromium's native accessibility provider for this CI-launched app.
    $info.Environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = '--force-renderer-accessibility --enable-features=UiaProvider'
    $process = Start-OwnedProcess $info
    $deadline = [datetime]::UtcNow.AddSeconds(45)
    do {
        $process.Refresh()
        if ($process.HasExited) { Stop-Acceptance 'APP_EXITED' }
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
            $window = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
            return @{ Process = $process; Window = $window }
        }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $deadline)
    Stop-Acceptance 'APP_WINDOW_TIMEOUT'
}

function Close-App($App) {
    if (-not $App.Process.CloseMainWindow() -or -not $App.Process.WaitForExit(30000)) {
        Stop-Acceptance 'APP_DID_NOT_CLOSE'
    }
    if ($App.Process.ExitCode -ne 0) { Stop-Acceptance 'APP_EXIT_NONZERO' }
}

function Find-Control($Scope, $Type, [string]$Name, [switch]$ContainsName, [switch]$FieldLabel, [switch]$AllowOffscreen) {
    $typeConditions = [Windows.Automation.Condition[]]@(
        foreach ($controlType in @($Type)) {
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType)
        }
    )
    $condition = if ($typeConditions.Count -eq 1) { $typeConditions[0] }
        else { [Windows.Automation.OrCondition]::new($typeConditions) }
    if ($Name -and -not $ContainsName -and -not $FieldLabel) {
        $condition = [Windows.Automation.AndCondition]::new($condition,
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name))
    }
    $deadline = [datetime]::UtcNow.AddSeconds(25)
    do {
        try {
            foreach ($control in $Scope.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
                if ($control.Current.IsEnabled -and ($AllowOffscreen -or -not $control.Current.IsOffscreen) -and
                    (-not $ContainsName -or $control.Current.Name.Contains($Name, [StringComparison]::Ordinal)) -and
                    (-not $FieldLabel -or $control.Current.Name.TrimEnd([char[]]' *') -ceq $Name)) {
                    return $control
                }
            }
        } catch [Windows.Automation.ElementNotAvailableException] {
            # WebView2 may replace an element during a Vue render.
        }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $deadline)
    if ($script:action -eq 'open_connection_form') {
        $controls = $Scope.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        $summary = [ordered]@{
            descendants = $controls.Count; buttons = 0; documents = 0; matching = 0; enabled = 0; visible = 0
            appDocument = $false; workbenchText = $false; browserError = $false
            browserCode = $null; tauriOrigin = $false; developmentOrigin = $false
            windowWidth = [int]$Scope.Current.BoundingRectangle.Width
            windowHeight = [int]$Scope.Current.BoundingRectangle.Height
        }
        foreach ($control in $controls) {
            try {
                $controlName = $control.Current.Name
                if ($control.Current.ControlType -eq [Windows.Automation.ControlType]::Document) {
                    $summary.documents++
                    if ($controlName -eq 'dbstudio') { $summary.appDocument = $true }
                }
                if ($controlName -like '*数据库工作台*') { $summary.workbenchText = $true }
                if ($controlName -match '\b(ERR_[A-Z_]+)\b') { $summary.browserCode = $Matches[1] }
                if ($controlName -match 'ERR_[A-Z_]+|can.t reach this page|无法访问此页面|应用启动预检失败') {
                    $summary.browserError = $true
                }
                if ($controlName -like '*tauri.localhost*') { $summary.tauriOrigin = $true }
                if ($controlName -like '*127.0.0.1:1420*') { $summary.developmentOrigin = $true }
                if ($control.Current.ControlType -ne [Windows.Automation.ControlType]::Button) { continue }
                $summary.buttons++
                if ($control.Current.Name -notlike '*新建连接*') { continue }
                $summary.matching++
                if ($control.Current.IsEnabled) { $summary.enabled++ }
                if (-not $control.Current.IsOffscreen) { $summary.visible++ }
            } catch [Windows.Automation.ElementNotAvailableException] {
                # The probe reports only controls still present in the window.
            }
        }
        $report.uiProbe = $summary
    }
    Stop-Acceptance 'UI_CONTROL_TIMEOUT'
}

function Invoke-Button($Window, [string]$Name, [switch]$ContainsName) {
    $button = Find-Control $Window ([Windows.Automation.ControlType]::Button) $Name -ContainsName:$ContainsName -AllowOffscreen
    $scroll = $null
    if ($button.Current.IsOffscreen -and $button.TryGetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scroll)) {
        $scroll.ScrollIntoView()
    }
    $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
}

function Send-ControlKeys($Control, [string]$Keys) {
    $Control.SetFocus()
    $focused = [Windows.Automation.AutomationElement]::FocusedElement
    if (-not $focused -or -not $focused.Equals($Control)) { Stop-Acceptance 'UI_CONTROL_NOT_FOCUSED' }
    [Windows.Forms.SendKeys]::SendWait($Keys)
}

function Set-EditText($Edit, [string]$Value) {
    $pattern = $null
    if ($Edit.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -and -not $pattern.Current.IsReadOnly) {
        $pattern.SetValue($Value)
        return
    }
    if ($Value -match '^\d+$' -and
        $Edit.TryGetCurrentPattern([Windows.Automation.RangeValuePattern]::Pattern, [ref]$pattern) -and -not $pattern.Current.IsReadOnly) {
        $pattern.SetValue([double]$Value)
        return
    }
    Stop-Acceptance 'UI_EDIT_PATTERN_UNAVAILABLE'
}

function Select-MySql($Window) {
    $combo = Find-Control $Window ([Windows.Automation.ControlType]::ComboBox) '数据库类型'
    $expand = $null
    if (-not $combo.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expand)) {
        Stop-Acceptance 'UI_DIALECT_EXPAND_UNAVAILABLE'
    }
    $expand.Expand()
    $choice = Find-Control $Window @([Windows.Automation.ControlType]::ListItem, [Windows.Automation.ControlType]::DataItem) 'MySQL / MariaDB'
    $selection = $null
    if (-not $choice.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
        Stop-Acceptance 'UI_DIALECT_SELECTION_UNAVAILABLE'
    }
    $selection.Select()
    if ($expand.Current.ExpandCollapseState -eq [Windows.Automation.ExpandCollapseState]::Expanded) { $expand.Collapse() }
}

function Connect-Saved($App, [string]$ConnectionName = $profile) {
    $script:action = 'find_saved_connection'
    $tree = Find-Control $App.Window ([Windows.Automation.ControlType]::Tree) '数据库对象'
    $row = Find-Control $tree ([Windows.Automation.ControlType]::TreeItem) $ConnectionName -ContainsName
    $invoke = $null
    if ($row.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        $invoke.Invoke()
    } else {
        Send-ControlKeys $row ' '
    }
    $script:action = 'connect_saved_profile'
    Invoke-Button $App.Window '连接'
}

function Save-FixtureConnection($App, [string]$Name, [string]$Database, [string]$Secret) {
    $script:action = 'open_connection_form'
    Invoke-Button $App.Window '新建连接' -ContainsName
    $script:action = 'select_mysql'
    Select-MySql $App.Window
    $fields = [ordered]@{
        connection_name = @('连接名', $Name)
        host = @('主机', '127.0.0.1')
        port = @('端口', [string]$port)
        database = @('数据库', $Database)
        username = @('用户名', 'dbstudio_ci')
    }
    foreach ($field in $fields.GetEnumerator()) {
        $script:action = 'fill_' + $field.Key
        $types = @([Windows.Automation.ControlType]::Edit)
        if ($field.Key -eq 'port') { $types += [Windows.Automation.ControlType]::Spinner }
        Set-EditText (Find-Control $App.Window $types $field.Value[0] -FieldLabel) $field.Value[1]
    }
    $script:action = 'fill_credential'
    $secretEdit = Find-Control $App.Window ([Windows.Automation.ControlType]::Edit) '密码'
    if (-not $secretEdit.Current.IsPassword) { Stop-Acceptance 'UI_CREDENTIAL_FIELD_NOT_PROTECTED' }
    Set-EditText $secretEdit $Secret
    $script:action = 'save_and_connect'
    Invoke-Button $App.Window '保存并连接'
    $null = Find-Control $App.Window ([Windows.Automation.ControlType]::Button) '执行 SQL'
}

function Assert-EditorDraft($App, [string]$ExpectedSql) {
    $editor = Find-Control $App.Window ([Windows.Automation.ControlType]::Edit) 'SQL 编辑器'
    $value = $editor.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    if ($value.Current.Value.TrimEnd() -cne $ExpectedSql) { Stop-Acceptance 'SQL_EDITOR_DRAFT_MISMATCH' }
}

function Assert-EditorTabs($App, [string]$Binary, [string]$Secret) {
    $draftA = 'SELECT CONCAT(DATABASE(), '':'' , marker) AS proof FROM probe;'
    $draftA2 = 'SELECT CONCAT(DATABASE(), '':'' , marker, '':'' , ?) AS proof FROM probe;'
    $draftB = 'SELECT CONCAT(DATABASE(), '':'' , marker, '':window'') AS proof FROM probe;'
    $profileB = "${profile}-other"
    $firstLabel = "SQL 1 · $profile · 默认库 dbstudio_ci"
    $secondLabel = "SQL 2 · $profile · 默认库 dbstudio_ci"
    $thirdLabel = "SQL 3 · $profileB · 默认库 dbstudio_other"
    $types = @([Windows.Automation.ControlType]::Text, [Windows.Automation.ControlType]::DataItem)
    $script:action = 'observe_two_databases'
    $observedA = Invoke-FixtureSql 'dbstudio_observer' 'SELECT marker FROM dbstudio_ci.probe;' $observerSecret
    $observedB = Invoke-FixtureSql 'dbstudio_observer' 'SELECT marker FROM dbstudio_other.probe;' $observerSecret
    if ($observedA.ExitCode -ne 0 -or $observedB.ExitCode -ne 0 -or $observedA.Out -eq $observedB.Out -or
        $observedA.Out -cne $marker -or $observedB.Out -cne $otherMarker) { Stop-Acceptance 'EDITOR_OBSERVER_MISMATCH' }

    $script:action = 'first_sql_editor'
    $probe = $draftA
    $expected = "dbstudio_ci:$($observedA.Out)"
    Assert-AppProbe $App
    $report.checks.firstEditorQueried = $true
    $script:action = 'create_second_editor'
    Invoke-Button $App.Window '新建 SQL 标签' -ContainsName
    $script:action = 'activate_second_editor'
    Invoke-Button $App.Window $secondLabel
    $script:action = 'second_sql_editor_with_parameter'
    $input = Find-Control $App.Window ([Windows.Automation.ControlType]::Edit) 'SQL 编辑器'
    Set-EditText $input $draftA2
    Invoke-Button $App.Window '执行 SQL'
    $null = Find-Control $App.Window $types "执行目标 · $profile · 默认库 dbstudio_ci" -AllowOffscreen
    $slot = Find-Control $App.Window ([Windows.Automation.ControlType]::Edit) '第 1 条语句参数 ?1'
    Set-EditText $slot 'parameter-ok'
    Invoke-Button $App.Window '执行'
    $null = Find-Control $App.Window $types "dbstudio_ci:$($observedA.Out):parameter-ok" -AllowOffscreen

    Save-FixtureConnection $App $profileB 'dbstudio_other' $Secret
    $script:action = 'third_sql_editor_other_database'
    Invoke-Button $App.Window $thirdLabel
    $probe = $draftB
    $expected = "dbstudio_other:$($observedB.Out):window"
    Assert-AppProbe $App
    Invoke-Button $App.Window $firstLabel
    Assert-EditorDraft $App $draftA
    Invoke-Button $App.Window $secondLabel
    Assert-EditorDraft $App $draftA2
    Invoke-Button $App.Window $thirdLabel
    Assert-EditorDraft $App $draftB
    $report.checks.independentEditorTargets = $true
    Close-App $App

    $script:action = 'restore_editor_tabs_after_restart'
    $restarted = Open-App $Binary
    Invoke-Button $restarted.Window $firstLabel
    Assert-EditorDraft $restarted $draftA
    Invoke-Button $restarted.Window $secondLabel
    Assert-EditorDraft $restarted $draftA2
    Invoke-Button $restarted.Window $thirdLabel
    Assert-EditorDraft $restarted $draftB
    Connect-Saved $restarted $profileB
    $probe = 'SELECT CONCAT(DATABASE(), '':'' , marker, '':restarted'') AS proof FROM probe;'
    $expected = "dbstudio_other:$($observedB.Out):restarted"
    Assert-AppProbe $restarted
    Close-App $restarted
    $report.checks.restoredEditorDrafts = $true
}

function Assert-AppProbe($App) {
    $script:action = 'edit_probe_sql'
    $editor = Find-Control $App.Window ([Windows.Automation.ControlType]::Edit) 'SQL 编辑器'
    Set-EditText $editor $probe
    $script:action = 'execute_probe_sql'
    Invoke-Button $App.Window '执行 SQL'
    $script:action = 'read_probe_result'
    $null = Find-Control $App.Window @([Windows.Automation.ControlType]::Text, [Windows.Automation.ControlType]::DataItem) $expected
}

function Assert-GridClipboard($App, [string]$Expected) {
    $script:action = 'query_clipboard_fixture'
    $editor = Find-Control $App.Window ([Windows.Automation.ControlType]::Edit) 'SQL 编辑器'
    Set-EditText $editor 'SELECT id, body FROM dbstudio_ci.copy_rows ORDER BY id;'
    Invoke-Button $App.Window '执行 SQL'
    $script:action = 'select_result_rows'
    foreach ($position in @(3, 1)) {
        $label = "选择第 $position 行"
        $row = Find-Control $App.Window ([Windows.Automation.ControlType]::CheckBox) $label
        $toggle = $row.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
        if ($toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::Off) { Stop-Acceptance 'RESULT_ROW_ALREADY_SELECTED' }
        $toggle.Toggle()
        $deadline = [datetime]::UtcNow.AddSeconds(5)
        do {
            $row = Find-Control $App.Window ([Windows.Automation.ControlType]::CheckBox) $label
            $state = $row.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Current.ToggleState
            if ($state -eq [Windows.Automation.ToggleState]::On) { break }
            Start-Sleep -Milliseconds 100
        } while ([datetime]::UtcNow -lt $deadline)
        if ($state -ne [Windows.Automation.ToggleState]::On) { Stop-Acceptance 'RESULT_ROW_NOT_SELECTED' }
    }
    if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') { Stop-Acceptance 'BLOCKED_CLIPBOARD_STA' }
    $script:action = 'copy_result_rows'
    [Windows.Forms.Clipboard]::SetText('dbstudio-fixture-before-copy')
    Invoke-Button $App.Window '复制选中行'
    $deadline = [datetime]::UtcNow.AddSeconds(25)
    do {
        try {
            $clipboard = [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText)
            if ($clipboard -ceq $Expected) { return }
        } catch [Runtime.InteropServices.ExternalException] {
            # Another process can briefly hold the runner clipboard open.
        }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $deadline)
    Stop-Acceptance 'CLIPBOARD_CONTENT_MISMATCH'
}

function Assert-GridPage($App, [string[]]$Expected, [string]$MarkerPrefix) {
    $types = @([Windows.Automation.ControlType]::Text, [Windows.Automation.ControlType]::DataItem)
    $null = Find-Control $App.Window $types $Expected[-1] -AllowOffscreen
    $condition = [Windows.Automation.OrCondition]::new([Windows.Automation.Condition[]]@(
        foreach ($type in $types) {
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
        }
    ))
    $pattern = '^' + [regex]::Escape($MarkerPrefix) + '[0-9]{4}$'
    $text = [Collections.Generic.List[string]]::new()
    $cells = [Collections.Generic.List[string]]::new()
    foreach ($control in $App.Window.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
        $value = $control.Current.Name
        if ($value -cnotmatch $pattern) { continue }
        if ($control.Current.ControlType -eq [Windows.Automation.ControlType]::Text) { $text.Add($value) }
        else { $cells.Add($value) }
    }
    # The provider may expose the same value as a cell and as its child text.
    $actual = if ($text.Count) { @($text.ToArray()) } else { @($cells.ToArray()) }
    if (($actual -join '|') -cne ($Expected -join '|')) {
        $report.pageMismatch = @{ expectedRows = $Expected.Count; renderedRows = @($actual).Count }
        Stop-Acceptance 'PAGE_CONTENT_MISMATCH'
    }
}

function Assert-GridPaging($App, [string[]]$Expected, [string]$MarkerPrefix) {
    $script:action = 'query_paging_fixture'
    $editor = Find-Control $App.Window ([Windows.Automation.ControlType]::Edit) 'SQL 编辑器'
    Set-EditText $editor 'SELECT marker FROM dbstudio_ci.paging_rows ORDER BY id;'
    Invoke-Button $App.Window '执行 SQL'
    $script:action = 'first_page'
    Assert-GridPage $App $Expected[0..199] $MarkerPrefix
    $script:action = 'second_page'
    Invoke-Button $App.Window '下一页'
    Assert-GridPage $App $Expected[200..399] $MarkerPrefix
    $script:action = 'last_page'
    Invoke-Button $App.Window '下一页'
    Assert-GridPage $App $Expected[400..404] $MarkerPrefix
    $script:action = 'back_to_second_page'
    Invoke-Button $App.Window '上一页'
    Assert-GridPage $App $Expected[200..399] $MarkerPrefix
    $script:action = 'back_to_first_page'
    Invoke-Button $App.Window '上一页'
    Assert-GridPage $App $Expected[0..199] $MarkerPrefix
}

function Open-FixtureTable($App, [string]$TableName) {
    $tree = Find-Control $App.Window ([Windows.Automation.ControlType]::Tree) '数据库对象'
    foreach ($groupName in @($profile, 'Schemas', 'dbstudio_ci', 'Tables')) {
        $script:action = "expand_$groupName"
        $node = Find-Control $tree ([Windows.Automation.ControlType]::TreeItem) $groupName -ContainsName
        $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, '展开')
        $expand = $node.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
        if ($expand) { $expand.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
    }
    $script:action = "open_$TableName"
    $table = Find-Control $tree ([Windows.Automation.ControlType]::TreeItem) $TableName -ContainsName
    Invoke-ControlDoubleClick $App $table
}

function Invoke-ControlDoubleClick($App, $Control) {
    $deadline = [datetime]::UtcNow.AddSeconds(3)
    do {
        $point = [Windows.Point]::new(0, 0)
        if ($Control.TryGetClickablePoint([ref]$point) -and
            [AcceptanceDesktop]::DoubleClickInWindow($App.Process.MainWindowHandle, [int]$point.X, [int]$point.Y)) { return }
        $scroll = $null
        $target = $Control
        if ($Control.Current.ControlType -eq [Windows.Automation.ControlType]::Text) {
            $parent = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($Control)
            if ($parent -and $parent.Current.ControlType -eq [Windows.Automation.ControlType]::DataItem) { $target = $parent }
        }
        if ($target.TryGetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scroll)) { $scroll.ScrollIntoView() }
        Start-Sleep -Milliseconds 100
    } while ([datetime]::UtcNow -lt $deadline)
    Stop-Acceptance 'UI_CONTROL_NOT_CLICKABLE'
}

function Edit-GridValue($App, [string]$Old, [string]$Value, [switch]$NullValue) {
    $types = @([Windows.Automation.ControlType]::DataItem, [Windows.Automation.ControlType]::Text)
    $cell = Find-Control $App.Window $types $Old -AllowOffscreen
    Invoke-ControlDoubleClick $App $cell
    $editor = Find-Control $App.Window ([Windows.Automation.ControlType]::Edit) '单元格值'
    if ($NullValue) {
        $checkbox = Find-Control $App.Window ([Windows.Automation.ControlType]::CheckBox) 'NULL'
        $toggle = $checkbox.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
        if ($toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::Off) { Stop-Acceptance 'NULL_EDITOR_UNEXPECTED_STATE' }
        $toggle.Toggle()
        $deadline = [datetime]::UtcNow.AddSeconds(5)
        do {
            if ($toggle.Current.ToggleState -eq [Windows.Automation.ToggleState]::On) { break }
            Start-Sleep -Milliseconds 100
        } while ([datetime]::UtcNow -lt $deadline)
        if ($toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::On) { Stop-Acceptance 'NULL_EDITOR_NOT_SELECTED' }
    } else {
        Set-EditText $editor $Value
    }
    Invoke-Button $App.Window '保存到本地修改'
}

function Assert-TransactionObserver([string]$Expected, [string]$FailureCode) {
    $observed = Invoke-FixtureSql 'dbstudio_observer' @'
SELECT CONCAT_WS('|', id, big_value, amount, IFNULL(HEX(optional_text), 'NULL'), HEX(empty_text), HEX(body))
FROM dbstudio_ci.grid_transaction ORDER BY id;
'@ $observerSecret
    if ($observed.ExitCode -ne 0 -or $observed.Out -cne $Expected) { Stop-Acceptance $FailureCode }
}

function Assert-GridTransaction($App) {
    $start = '1|9007199254740993|12.123456789012345678|6F7074696F6E616C2D73656564|656D7074792D73656564|626F64792D73656564'
    $end = '1|9007199254740995|1234567890.123456789012345678|NULL||E68F90E4BAA4'
    $types = @([Windows.Automation.ControlType]::Text, [Windows.Automation.ControlType]::DataItem)
    Open-FixtureTable $App 'grid_transaction'
    $script:action = 'stage_rollback_edit'
    Edit-GridValue $App 'body-seed' 'rollback-pending'
    $script:action = 'apply_rollback_edit'
    Invoke-Button $App.Window '应用修改 (1)'
    $null = Find-Control $App.Window $types '未提交 · 1 行'
    Assert-TransactionObserver $start 'UNCOMMITTED_EDIT_VISIBLE'
    $script:action = 'rollback_edit'
    Invoke-Button $App.Window '回滚'
    Invoke-Button $App.Window '确认'
    $null = Find-Control $App.Window $types 'body-seed'
    Assert-TransactionObserver $start 'ROLLBACK_OBSERVER_MISMATCH'
    $report.checks.rollbackRestored = $true

    $script:action = 'stage_unicode_edit'
    Edit-GridValue $App 'body-seed' '提交'
    $script:action = 'stage_bigint_edit'
    Edit-GridValue $App '9007199254740993' '9007199254740995'
    $script:action = 'stage_decimal_edit'
    Edit-GridValue $App '12.123456789012345678' '1234567890.123456789012345678'
    $script:action = 'stage_null_edit'
    Edit-GridValue $App 'optional-seed' -NullValue
    $script:action = 'stage_empty_text_edit'
    Edit-GridValue $App 'empty-seed' ''
    $script:action = 'apply_precise_edits'
    Invoke-Button $App.Window '应用修改 (1)'
    $null = Find-Control $App.Window $types '未提交 · 1 行'
    Assert-TransactionObserver $start 'UNCOMMITTED_PRECISE_EDITS_VISIBLE'
    $script:action = 'commit_precise_edits'
    Invoke-Button $App.Window '提交'
    $null = Find-Control $App.Window $types '已提交当前连接事务'
    Assert-TransactionObserver $end 'COMMIT_OBSERVER_MISMATCH'
    $report.checks.preciseCommit = $true
}

function Select-TransferFile($App, [string]$Title, [string]$CsvPath, [bool]$Save) {
    $idCondition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ProcessIdProperty, $App.Process.Id)
    $titleCondition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::NameProperty, $Title)
    $condition = [Windows.Automation.AndCondition]::new($idCondition, $titleCondition)
    $desktop = [Windows.Automation.AutomationElement]::RootElement
    $scope = [Windows.Automation.TreeScope]::Children
    $deadline = [datetime]::UtcNow.AddSeconds(25)
    do {
        $dialog = $desktop.FindFirst($scope, $condition)
        if (-not $dialog) {
            $owner = [IntPtr]$App.Window.Current.NativeWindowHandle
            $handle = [AcceptanceDesktop]::FindOwnedDialog($owner, $App.Process.Id)
            if ($handle -ne [IntPtr]::Zero) { $dialog = [Windows.Automation.AutomationElement]::FromHandle($handle) }
        }
        if ($dialog) { break }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $deadline)
    if (-not $dialog) { Stop-Acceptance 'TRANSFER_FILE_DIALOG_NOT_FOUND' }

    $fileControls = [Windows.Automation.OrCondition]::new([Windows.Automation.Condition[]]@(
        foreach ($type in @([Windows.Automation.ControlType]::Edit, [Windows.Automation.ControlType]::ComboBox)) {
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
        }
    ))
    $descendants = [Windows.Automation.TreeScope]::Descendants
    $handle = [IntPtr]$dialog.Current.NativeWindowHandle
    $deadline = [datetime]::UtcNow.AddSeconds(15)
    $highestControlCount = 0
    $fileName = $null
    do {
        $controls = $dialog.FindAll($descendants, $fileControls)
        $highestControlCount = [Math]::Max($highestControlCount, $controls.Count)
        foreach ($control in $controls) {
            if (-not $control.Current.IsEnabled -or
                ($control.Current.AutomationId -notin @('1148','1152') -and
                 $control.Current.Name -notmatch '^(File\s*&?name|文件名)(?:\s*\([A-Z]\))?\s*[:：]?\s*$')) { continue }
            $value = $null
            if ($control.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$value) -and -not $value.Current.IsReadOnly) {
                $fileName = $control
                break
            }
        }
        if (-not $fileName) {
            $editHandle = [AcceptanceDesktop]::FindFileNameEdit($handle)
            if ($editHandle -ne [IntPtr]::Zero) {
                $edit = [Windows.Automation.AutomationElement]::FromHandle($editHandle)
                $value = $null
                if ($edit.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$value) -and -not $value.Current.IsReadOnly) {
                    $fileName = $edit
                }
            }
        }
        if ($fileName) { break }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $deadline)
    if (-not $fileName) {
        if (-not [AcceptanceDesktop]::FocusDialog($handle)) {
            $report.fileDialogProbe = @{ controlsSeen = $highestControlCount; hasNativeHandle = ($handle -ne [IntPtr]::Zero) }
            Stop-Acceptance 'TRANSFER_FILE_DIALOG_NOT_FOCUSED'
        }
        [Windows.Forms.SendKeys]::SendWait('%n')
        $deadline = [datetime]::UtcNow.AddSeconds(3)
        do {
            $focusedEdit = [AcceptanceDesktop]::GetFocusedDialogEdit($handle)
            if ($focusedEdit -ne [IntPtr]::Zero) { break }
            Start-Sleep -Milliseconds 100
        } while ([datetime]::UtcNow -lt $deadline)
        if ($focusedEdit -eq [IntPtr]::Zero) {
            $report.fileDialogProbe = @{ controlsSeen = $highestControlCount; hasNativeHandle = $true }
            Stop-Acceptance 'TRANSFER_FILE_NAME_CONTROL_NOT_FOUND'
        }
        if ([AcceptanceDesktop]::GetFocusedDialogEdit($handle) -ne $focusedEdit) {
            Stop-Acceptance 'TRANSFER_FILE_NAME_FOCUS_LOST'
        }
        $keys = [regex]::Replace($CsvPath, '[+^%~(){}\[\]]', { param($match) '{' + $match.Value + '}' })
        [Windows.Forms.SendKeys]::SendWait('^a' + $keys)
        if (-not [AcceptanceDesktop]::FocusedEditHasText($handle, $focusedEdit, $CsvPath)) {
            Stop-Acceptance 'TRANSFER_FILE_NAME_VALUE_MISMATCH'
        }
        [Windows.Forms.SendKeys]::SendWait('{ENTER}')
        return
    }
    Set-EditText $fileName $CsvPath

    $buttons = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,
        [Windows.Automation.ControlType]::Button)
    $caption = if ($Save) { '^(Save|保存)(?:\([A-Z]\))?$' } else { '^(Open|打开)(?:\([A-Z]\))?$' }
    $chosen = @($dialog.FindAll($descendants, $buttons) | Where-Object {
        $_.Current.IsEnabled -and $_.Current.Name -match $caption
    })
    if ($chosen.Count -ne 1) { Stop-Acceptance 'TRANSFER_FILE_CONFIRM_CONTROL_NOT_FOUND' }
    $chosen[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
}

function Read-TransferRows([string]$Table) {
    if ($Table -notin @('csv_source', 'csv_target')) { Stop-Acceptance 'TRANSFER_OBSERVER_TARGET_INVALID' }
    $observed = Invoke-FixtureSql 'dbstudio_observer' @"
SELECT CONCAT_WS('|', id, IFNULL(HEX(optional_text), 'NULL'), HEX(empty_text), HEX(body))
FROM dbstudio_ci.$Table ORDER BY id;
"@ $observerSecret
    if ($observed.ExitCode -ne 0) { Stop-Acceptance 'TRANSFER_OBSERVER_QUERY_FAILED' }
    return $observed.Out
}

function Assert-CsvRoundTrip($App) {
    $python = Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $python) { Stop-Acceptance 'BLOCKED_CSV_OBSERVER_PYTHON' }
    $csvPath = Join-Path $root 'roundtrip.csv'
    if (Test-Path -LiteralPath $csvPath) { Stop-Acceptance 'TRANSFER_EXPORT_PATH_EXISTS' }
    $expectedRows = Read-TransferRows 'csv_source'
    if (@($expectedRows -split '\r?\n').Count -ne 2 -or (Read-TransferRows 'csv_target') -ne '') {
        Stop-Acceptance 'TRANSFER_OBSERVER_START_MISMATCH'
    }

    $types = @([Windows.Automation.ControlType]::Text, [Windows.Automation.ControlType]::DataItem)
    $script:action = 'query_csv_source'
    $editor = Find-Control $App.Window ([Windows.Automation.ControlType]::Edit) 'SQL 编辑器'
    Set-EditText $editor 'SELECT id, optional_text, empty_text, body FROM dbstudio_ci.csv_source ORDER BY id;'
    Invoke-Button $App.Window '执行 SQL'
    $null = Find-Control $App.Window $types $marker -AllowOffscreen
    $script:action = 'choose_csv_export_path'
    Invoke-Button $App.Window '导出完整来源…'
    Invoke-Button $App.Window '选择…'
    Select-TransferFile $App '保存导出文件' $csvPath $true
    $script:action = 'export_csv'
    Invoke-Button $App.Window '开始导出'
    $null = Find-Control $App.Window $types '任务 completed · 2 行' -ContainsName -AllowOffscreen
    Invoke-Button $App.Window '关闭'

    $script:action = 'verify_independent_csv'
    $fileCheck = Invoke-PrivateProcess (New-ProcessInfo $python.Source @('-I', '-', $csvPath, $marker)) 15 @'
import csv
import sys

path, marker = sys.argv[1:]
with open(path, encoding='utf-8-sig', newline='') as source:
    rows = list(csv.reader(source, strict=True))
expected = [
    ['id', 'optional_text', 'empty_text', 'body'],
    ['9007199254740993', '', '', '中文,"csv"\r\nline'],
    ['9007199254740995', 'present', 'value', marker],
]
sys.exit(0 if rows == expected else 1)
'@
    if ($fileCheck.ExitCode -ne 0) { Stop-Acceptance 'TRANSFER_EXPORTED_CSV_MISMATCH' }
    $report.checks.csvFileVerified = $true

    $script:action = 'open_csv_target'
    Open-FixtureTable $App 'csv_target'
    $null = Find-Control $App.Window $types '结果为空' -AllowOffscreen
    $script:action = 'choose_csv_import_path'
    Invoke-Button $App.Window '导入 CSV…'
    Invoke-Button $App.Window '选择…'
    Select-TransferFile $App '选择导入文件' $csvPath $false
    $script:action = 'preview_csv_import'
    $nullField = Find-Control $App.Window ([Windows.Automation.ControlType]::Edit) 'NULL 标记' -AllowOffscreen
    Set-EditText $nullField ''
    Invoke-Button $App.Window '读取有界预览'
    $null = Find-Control $App.Window $types '2 行 · 0 个解析错误' -AllowOffscreen
    $script:action = 'import_csv'
    Invoke-Button $App.Window '开始导入'
    $null = Find-Control $App.Window $types '任务 completed · 2 行' -AllowOffscreen
    $script:action = 'verify_independent_csv_import'
    if ((Read-TransferRows 'csv_target') -cne $expectedRows) { Stop-Acceptance 'TRANSFER_IMPORTED_ROWS_MISMATCH' }
    Invoke-Button $App.Window '关闭'
    $report.checks.csvRoundTrip = $true
}

try {
    if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
        -not [Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) {
        Stop-Acceptance 'BLOCKED_INTERACTIVE_WINDOWS_RUNNER'
    }
    foreach ($folder in @([Environment]::GetFolderPath('ApplicationData'), [Environment]::GetFolderPath('LocalApplicationData'))) {
        foreach ($profileName in @('io.dbstudio.desktop', 'dbstudio')) {
            if (Test-Path -LiteralPath (Join-Path $folder $profileName)) { Stop-Acceptance 'BLOCKED_NONEMPTY_PROFILE' }
        }
    }
    Add-Type -AssemblyName WindowsBase,UIAutomationClient,UIAutomationTypes,System.Windows.Forms
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AcceptanceDesktop {
    [DllImport("user32.dll")]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);

    [DllImport("user32.dll")]
    private static extern bool CloseDesktop(IntPtr desktop);

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(Point point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);

    private delegate bool EnumWindowCallback(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out int processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder className, int capacity);

    public static IntPtr FindOwnedDialog(IntPtr owner, int processId) {
        IntPtr found = IntPtr.Zero;
        int count = 0;
        EnumWindows((window, _) => {
            if (window == owner || !IsWindowVisible(window)) return true;
            GetWindowThreadProcessId(window, out int candidateProcess);
            if (candidateProcess != processId && (owner == IntPtr.Zero || GetAncestor(window, 3) != owner)) return true;
            var className = new StringBuilder(24);
            GetClassName(window, className, className.Capacity);
            if (className.ToString() == "#32770") { found = window; count++; }
            return true;
        }, IntPtr.Zero);
        return count == 1 ? found : IntPtr.Zero;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern int GetDlgCtrlID(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsChild(IntPtr parent, IntPtr child);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [StructLayout(LayoutKind.Sequential)]
    private struct GuiThreadInfo {
        public uint Size, Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);

    public static bool FocusDialog(IntPtr dialog) {
        if (dialog == IntPtr.Zero) return false;
        if (GetForegroundWindow() == dialog) return true;
        return SetForegroundWindow(dialog) && GetForegroundWindow() == dialog;
    }

    public static IntPtr GetFocusedDialogEdit(IntPtr dialog) {
        var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        if (GetForegroundWindow() != dialog || !GetGUIThreadInfo(0, ref info) || !IsChild(dialog, info.Focus)) return IntPtr.Zero;
        var className = new StringBuilder(24);
        GetClassName(info.Focus, className, className.Capacity);
        return className.ToString() == "Edit" ? info.Focus : IntPtr.Zero;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
        StringBuilder text, uint flags, uint timeout, out UIntPtr result);

    public static bool FocusedEditHasText(IntPtr dialog, IntPtr edit, string expected) {
        if (edit == IntPtr.Zero || GetFocusedDialogEdit(dialog) != edit) return false;
        var text = new StringBuilder(expected.Length + 2);
        const uint WM_GETTEXT = 0x000D;
        const uint SMTO_ABORTIFHUNG = 0x0002;
        var sent = SendMessageTimeout(edit, WM_GETTEXT, (UIntPtr)text.Capacity, text, SMTO_ABORTIFHUNG, 1000, out _);
        return sent != IntPtr.Zero && text.ToString() == expected && GetFocusedDialogEdit(dialog) == edit;
    }

    public static IntPtr FindFileNameEdit(IntPtr dialog) {
        if (dialog == IntPtr.Zero) return IntPtr.Zero;
        IntPtr found = IntPtr.Zero;
        int count = 0;
        EnumChildWindows(dialog, (window, _) => {
            if (!IsWindowVisible(window)) return true;
            var className = new StringBuilder(24);
            GetClassName(window, className, className.Capacity);
            if (className.ToString() != "Edit") return true;
            bool isFileName = GetDlgCtrlID(window) == 1152; // edt1
            for (var parent = GetParent(window); !isFileName && parent != IntPtr.Zero && parent != dialog; parent = GetParent(parent)) {
                isFileName = GetDlgCtrlID(parent) == 1148; // cmb13, the file-name combo box
            }
            if (isFileName) { found = window; count++; }
            return true;
        }, IntPtr.Zero);
        return count == 1 ? found : IntPtr.Zero;
    }

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);

    public static bool DoubleClickInWindow(IntPtr window, int x, int y) {
        var target = WindowFromPoint(new Point { X = x, Y = y });
        if (window == IntPtr.Zero || GetAncestor(target, 2) != window || !SetCursorPos(x, y)) return false;
        for (var i = 0; i < 2; i++) {
            mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
            mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
        }
        return true;
    }

    public static bool InputDesktopAvailable() {
        var desktop = OpenInputDesktop(0, false, 1); // DESKTOP_READOBJECTS
        return desktop != IntPtr.Zero && CloseDesktop(desktop);
    }
}
'@
    if (-not [AcceptanceDesktop]::InputDesktopAvailable()) { Stop-Acceptance 'BLOCKED_INPUT_DESKTOP_UNAVAILABLE' }
    $webViewRoot = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\EdgeWebView\Application'
    if (-not (Test-Path -LiteralPath $webViewRoot -PathType Container)) { Stop-Acceptance 'BLOCKED_WEBVIEW2_MISSING' }
    $mysqlCommand = Get-Command mysql.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $mysqlCommand) { Stop-Acceptance 'BLOCKED_MYSQL_CLIENT_MISSING' }
    $mysql = $mysqlCommand.Source
    $mysqlBin = Split-Path -Parent $mysql
    $mysqlBase = Split-Path -Parent $mysqlBin
    $server = Join-Path $mysqlBin 'mysqld.exe'
    if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { Stop-Acceptance 'BLOCKED_MYSQL_SERVER_MISSING' }
    $report.checks.runnerPreflight = $true

    $script:stage = 'installer_integrity'
    if (($CsvOnly -or $EditorTabsOnly) -and -not $FirstUse) { Stop-Acceptance 'SCENARIO_REQUIRES_FRESH_INSTALL' }
    $report.candidateInstallerSha256 = (Get-FileHash -LiteralPath $CandidateInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $FirstUse) {
        $report.baselineInstallerSha256 = (Get-FileHash -LiteralPath $BaselineInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($report.baselineInstallerSha256 -ne '41403e3117aaade4dd8c9b9eb433684cb2bc925da8a489e89d726e1c6e9da292') {
            Stop-Acceptance 'BASELINE_HASH_MISMATCH'
        }
        if ($report.candidateInstallerSha256 -eq $report.baselineInstallerSha256) { Stop-Acceptance 'INSTALLERS_IDENTICAL' }
    }

    $script:stage = 'fixture'
    $run = [guid]::NewGuid().ToString('N')
    $root = Join-Path $env:RUNNER_TEMP "dbstudio-install-$run"
    $null = New-Item -ItemType Directory -Path $root
    $dataDir = Join-Path $root 'mysql-data'
    $installDir = Join-Path $root 'app'
    $profile = "dbstudio-ci-$run"
    $marker = $run.Substring(0, 16)
    $otherMarker = 'b-' + $marker.Substring(0, 14)
    $pagingMarkerPrefix = "pg-$marker-"
    $initialization = Invoke-PrivateProcess (New-ProcessInfo $server @('--no-defaults', '--initialize-insecure', "--basedir=$mysqlBase", "--datadir=$dataDir", '--console')) 90
    if ($initialization.ExitCode -ne 0) { Stop-Acceptance 'FIXTURE_INIT_FAILED' }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { $port = $listener.LocalEndpoint.Port } finally { $listener.Stop() }
    $serverInfo = New-ProcessInfo $server @('--no-defaults', "--basedir=$mysqlBase", "--datadir=$dataDir", '--bind-address=127.0.0.1',
        "--port=$port", '--mysqlx=OFF', '--skip-log-bin', '--general-log=OFF', '--slow-query-log=OFF')
    $serverInfo.CreateNoWindow = $true
    $mysqld = Start-OwnedProcess $serverInfo
    $deadline = [datetime]::UtcNow.AddSeconds(45)
    do {
        if ($mysqld.HasExited) { Stop-Acceptance 'FIXTURE_SERVER_EXITED' }
        $ready = Invoke-FixtureSql 'root' 'SELECT @@datadir;'
        if ($ready.ExitCode -eq 0) { break }
        Start-Sleep -Milliseconds 300
    } while ([datetime]::UtcNow -lt $deadline)
    if ($ready.ExitCode -ne 0) { Stop-Acceptance 'FIXTURE_NOT_READY' }
    if ($ready.Out.Replace('/', '\').TrimEnd('\') -ne $dataDir) { Stop-Acceptance 'FIXTURE_IDENTITY_MISMATCH' }

    $syntheticSecret = 'Aa9' + [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
    $observerSecret = 'Aa9' + [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
    $setup = Invoke-FixtureSql 'root' @"
CREATE DATABASE dbstudio_ci;
CREATE DATABASE dbstudio_other;
CREATE TABLE dbstudio_ci.probe (marker VARCHAR(16) NOT NULL);
CREATE TABLE dbstudio_other.probe LIKE dbstudio_ci.probe;
INSERT INTO dbstudio_ci.probe VALUES ('$marker');
INSERT INTO dbstudio_other.probe VALUES ('$otherMarker');
CREATE TABLE dbstudio_ci.copy_rows (id BIGINT NOT NULL PRIMARY KEY, body TEXT NOT NULL);
INSERT INTO dbstudio_ci.copy_rows VALUES
(9007199254740993, CONCAT('$marker', CHAR(9), CHAR(34), 'quoted', CHAR(34), CHAR(13,10), REPEAT('x', 1400))),
(9007199254740994, 'not-selected'),
(9007199254740995, 'third-row');
CREATE TABLE dbstudio_ci.paging_rows (id INT NOT NULL PRIMARY KEY, marker VARCHAR(32) NOT NULL);
INSERT INTO dbstudio_ci.paging_rows (id, marker)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 405)
SELECT n, CONCAT('$pagingMarkerPrefix', LPAD(n, 4, '0')) FROM seq;
CREATE TABLE dbstudio_ci.grid_transaction (
    id INT NOT NULL PRIMARY KEY, big_value BIGINT NOT NULL, amount DECIMAL(38,18) NOT NULL,
    optional_text VARCHAR(32), empty_text VARCHAR(32) NOT NULL, body VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO dbstudio_ci.grid_transaction VALUES
(1, 9007199254740993, 12.123456789012345678, 'optional-seed', 'empty-seed', 'body-seed');
CREATE TABLE dbstudio_ci.csv_source (
    id BIGINT NOT NULL PRIMARY KEY, optional_text VARCHAR(32), empty_text VARCHAR(32) NOT NULL, body TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE dbstudio_ci.csv_target LIKE dbstudio_ci.csv_source;
INSERT INTO dbstudio_ci.csv_source VALUES
(9007199254740993, NULL, '', CONCAT(CONVERT(0xE4B8ADE69687 USING utf8mb4), CHAR(44,34), 'csv', CHAR(34,13,10), 'line')),
(9007199254740995, 'present', 'value', '$marker');
CREATE USER 'dbstudio_ci'@'127.0.0.1' IDENTIFIED BY '$syntheticSecret';
GRANT SELECT ON dbstudio_ci.* TO 'dbstudio_ci'@'127.0.0.1';
GRANT SELECT ON dbstudio_other.probe TO 'dbstudio_ci'@'127.0.0.1';
GRANT UPDATE ON dbstudio_ci.grid_transaction TO 'dbstudio_ci'@'127.0.0.1';
GRANT INSERT ON dbstudio_ci.csv_target TO 'dbstudio_ci'@'127.0.0.1';
CREATE USER 'dbstudio_observer'@'127.0.0.1' IDENTIFIED BY '$observerSecret';
GRANT SELECT ON dbstudio_ci.grid_transaction TO 'dbstudio_observer'@'127.0.0.1';
GRANT SELECT ON dbstudio_ci.probe TO 'dbstudio_observer'@'127.0.0.1';
GRANT SELECT ON dbstudio_other.probe TO 'dbstudio_observer'@'127.0.0.1';
GRANT SELECT ON dbstudio_ci.csv_source TO 'dbstudio_observer'@'127.0.0.1';
GRANT SELECT ON dbstudio_ci.csv_target TO 'dbstudio_observer'@'127.0.0.1';
"@
    if ($setup.ExitCode -ne 0) { Stop-Acceptance 'FIXTURE_SETUP_FAILED' }
    $probe = "SELECT CONCAT(marker, ':', CURRENT_USER()) AS proof FROM dbstudio_ci.probe;"
    $expected = "${marker}:dbstudio_ci@127.0.0.1"
    $denied = Invoke-FixtureSql 'dbstudio_ci' $probe
    if ($denied.ExitCode -eq 0 -or $denied.Err -notmatch '\b1045\b') { Stop-Acceptance 'FIXTURE_EMPTY_PASSWORD_NOT_DENIED' }
    $observed = Invoke-FixtureSql 'dbstudio_ci' $probe $syntheticSecret
    if ($observed.ExitCode -ne 0 -or $observed.Out -cne $expected) { Stop-Acceptance 'FIXTURE_OBSERVER_MISMATCH' }
    $report.checks.fixtureAuthentication = $true
    if ($FirstUse) {
        $copyRows = Invoke-FixtureSql 'dbstudio_ci' 'SELECT id, HEX(body) FROM dbstudio_ci.copy_rows WHERE id IN (9007199254740993, 9007199254740995) ORDER BY id;' $syntheticSecret
        $expectedLines = @("id`tbody")
        if ($copyRows.ExitCode -ne 0) { Stop-Acceptance 'CLIPBOARD_OBSERVER_QUERY_FAILED' }
        foreach ($line in ($copyRows.Out -split '\r?\n')) {
            if ($line -cnotmatch '^(9007199254740993|9007199254740995)\t([0-9A-F]+)$') { Stop-Acceptance 'CLIPBOARD_OBSERVER_ROW_INVALID' }
            $id = $Matches[1]
            $body = [Text.Encoding]::UTF8.GetString([Convert]::FromHexString($Matches[2]))
            if ($body -match '["\t\r\n]') { $body = '"' + $body.Replace('"', '""') + '"' }
            $expectedLines += "$id`t$body"
        }
        if ($expectedLines.Count -ne 3) { Stop-Acceptance 'CLIPBOARD_OBSERVER_COUNT' }
        $expectedClipboard = $expectedLines -join "`r`n"
        $pagingRows = Invoke-FixtureSql 'dbstudio_ci' 'SELECT marker FROM dbstudio_ci.paging_rows ORDER BY id;' $syntheticSecret
        $expectedPaging = @($pagingRows.Out -split '\r?\n')
        if ($pagingRows.ExitCode -ne 0 -or $expectedPaging.Count -ne 405 -or
            ($expectedPaging -join '|') -cne ((1..405 | ForEach-Object { '{0}{1:D4}' -f $pagingMarkerPrefix, $_ }) -join '|')) {
            Stop-Acceptance 'PAGING_OBSERVER_MISMATCH'
        }
    }

    if ($env:DBSTUDIO_PROBE_CANDIDATE_STARTUP -eq '1') {
        $script:stage = 'candidate_clean_install'
        $installed = Install-App $CandidateInstaller
        $report.checks.candidateInstalled = $true
        $script:stage = 'candidate_clean_startup'
        $app = Open-App $installed
        $script:action = 'open_connection_form'
        Invoke-Button $app.Window '新建连接' -ContainsName
        $null = Find-Control $app.Window ([Windows.Automation.ControlType]::Edit) '连接名'
        Close-App $app
        $report.checks.candidateConnectionFormOpened = $true
        $report.status = 'passed'
        return
    }

    if ($FirstUse) {
        $script:stage = 'candidate_clean_install'
        $binary = Install-App $CandidateInstaller
        $report.checks.candidateInstalled = $true
        $script:stage = 'candidate_connect_and_copy'
    } else {
        $script:stage = 'baseline_install'
        $baseline = Install-App $BaselineInstaller
        $report.baselineBinarySha256 = (Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash.ToLowerInvariant()
        $report.checks.baselineInstalled = $true
        $script:stage = 'baseline_save_and_query'
        $binary = $baseline
    }
    $script:action = 'launch_application'
    $app = Open-App $binary
    Save-FixtureConnection $app $profile 'dbstudio_ci' $syntheticSecret
    if ($EditorTabsOnly) {
        $script:stage = 'candidate_editor_tabs'
        Assert-EditorTabs $app $binary $syntheticSecret
        $syntheticSecret = $null
        $report.status = 'passed'
        return
    }
    $syntheticSecret = $null
    Assert-AppProbe $app
    if ($FirstUse) {
        $report.checks.mysqlConnectedAndQueried = $true
        if ($CsvOnly) {
            $script:stage = 'candidate_csv_roundtrip'
            Assert-CsvRoundTrip $app
            $script:action = 'close_candidate'
            Close-App $app
            $report.status = 'passed'
            return
        }
        Assert-GridClipboard $app $expectedClipboard
        Close-App $app
        $report.checks.selectedRowsClipboard = $true

        $script:stage = 'candidate_same_version_restart'
        $script:action = 'relaunch_candidate'
        $firstProcessId = $app.Process.Id
        $app = Open-App $binary
        if ($app.Process.Id -eq $firstProcessId) { Stop-Acceptance 'APP_PROCESS_NOT_REPLACED' }
        Connect-Saved $app
        $probe = "SELECT CONCAT(marker, ':restart:', CURRENT_USER()) AS proof FROM dbstudio_ci.probe;"
        $expected = "${marker}:restart:dbstudio_ci@127.0.0.1"
        Assert-AppProbe $app
        $report.checks.sameVersionReconnect = $true
        $script:stage = 'candidate_paging'
        Assert-GridPaging $app $expectedPaging $pagingMarkerPrefix
        $report.checks.paging = $true
        $script:stage = 'candidate_grid_transaction'
        Assert-GridTransaction $app
        $script:action = 'close_restarted_candidate'
        Close-App $app
        $report.status = 'passed'
        return
    }
    Close-App $app
    $report.checks.baselineSavedAndQueried = $true

    $script:stage = 'baseline_relaunch'
    $app = Open-App $baseline
    Connect-Saved $app
    Assert-AppProbe $app
    Close-App $app
    $report.checks.baselineReconnected = $true

    $script:stage = 'candidate_install'
    $candidate = Install-App $CandidateInstaller -Update
    $report.candidateBinarySha256 = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($candidate -ne $baseline -or $report.candidateBinarySha256 -eq $report.baselineBinarySha256) {
        Stop-Acceptance 'INSTALL_DID_NOT_REPLACE_BINARY'
    }
    $report.checks.candidateInstalled = $true

    $script:stage = 'candidate_reconnect'
    $app = Open-App $candidate
    Connect-Saved $app
    Assert-AppProbe $app
    Close-App $app
    $report.checks.candidateReconnected = $true
    $report.status = 'passed'
} catch {
    $report.status = if ($script:failure.StartsWith('BLOCKED_')) { 'blocked' } else { 'failed' }
    $report.stage = $script:stage
    if ($script:action) { $report.action = $script:action }
    $report.code = $script:failure
    if ($script:failure -eq 'CHECK_FAILED') {
        $cause = $_.Exception.GetBaseException()
        $report.diagnostic = @{ exception = $cause.GetType().Name; hresult = $cause.HResult; line = $_.InvocationInfo.ScriptLineNumber }
    }
} finally {
    foreach ($process in $script:children) {
        try {
            if (-not $process.HasExited) {
                $process.Kill($true)
                if (-not $process.WaitForExit(10000)) { throw 'PROCESS_CLEANUP_TIMEOUT' }
            }
        } catch {
            $report.cleanup = 'failed'
            if ($report.status -eq 'passed') { $report.status = 'failed'; $report.code = 'PROCESS_CLEANUP_FAILED' }
        } finally { $process.Dispose() }
    }
    $json = $report | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($ReportPath, $json + [Environment]::NewLine)
    Write-Output $json
}
if ($report.status -ne 'passed') { exit 1 }
