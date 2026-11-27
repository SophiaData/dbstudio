# UI Automation helpers adapted from the proven Windows probe at 0db1f8ed.
param(
    [Parameter(Mandatory)][string]$CandidateDirectory,
    [Parameter(Mandatory)][int]$Port,
    [Parameter(Mandatory)][scriptblock]$ReadFixtureSql
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:children = [Collections.Generic.List[Diagnostics.Process]]::new()
$script:action = 'preflight'
$script:failure = 'CHECK_FAILED'
$candidateIdentity = @{
    sha = $(if ($env:DBSTUDIO_CANDIDATE_SHA) { $env:DBSTUDIO_CANDIDATE_SHA } else { $env:GITHUB_SHA })
    runId = $(if ($env:DBSTUDIO_CANDIDATE_RUN_ID) { $env:DBSTUDIO_CANDIDATE_RUN_ID } else { $env:GITHUB_RUN_ID })
    runAttempt = $(if ($env:DBSTUDIO_CANDIDATE_RUN_ATTEMPT) { $env:DBSTUDIO_CANDIDATE_RUN_ATTEMPT } else { $env:GITHUB_RUN_ATTEMPT })
}
$report = [ordered]@{
    schemaVersion = 1
    status = 'failed'
    sha = $env:GITHUB_SHA
    runId = $env:GITHUB_RUN_ID
    runAttempt = $env:GITHUB_RUN_ATTEMPT
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

function Install-App([string]$Installer) {
    $info = [Diagnostics.ProcessStartInfo]::new($Installer)
    # NSIS expects an unquoted /D switch as the final argument.
    $info.Arguments = "/S /D=$installDir"
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

function Find-Control($Scope, $Type, [string]$Name, [switch]$ContainsName, [switch]$FieldLabel, [switch]$AllowOffscreen, [int]$TimeoutSeconds = 25) {
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
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
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
    Stop-Acceptance 'UI_CONTROL_TIMEOUT'
}

function Invoke-Button($Window, [string]$Name, [switch]$ContainsName) {
    $button = Find-Control $Window ([Windows.Automation.ControlType]::Button) $Name -ContainsName:$ContainsName -AllowOffscreen
    $scroll = $null
    if ($button.Current.IsOffscreen -and $button.TryGetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scroll)) {
        $scroll.ScrollIntoView()
    }
    $invoke = $null
    if ($button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        $invoke.Invoke()
        return
    }
    $toggle = $null
    if ($Name -notmatch '^SQL [0-9]+ · ' -or
        -not $button.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) {
        Stop-Acceptance 'UI_BUTTON_ACTION_UNAVAILABLE'
    }
    if ($toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
    $deadline = [datetime]::UtcNow.AddSeconds(5)
    do {
        if ($toggle.Current.ToggleState -eq [Windows.Automation.ToggleState]::On) { return }
        Start-Sleep -Milliseconds 100
    } while ([datetime]::UtcNow -lt $deadline)
    Stop-Acceptance 'EDITOR_TAB_NOT_SELECTED'
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

function Read-SqlEditorText($Editor) {
    $pattern = $null
    if ($Editor.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
        return $pattern.DocumentRange.GetText(-1).Replace("`r`n", "`n").TrimEnd([char[]]"`r`n")
    }
    if ($Editor.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        return $pattern.Current.Value.Replace("`r`n", "`n").TrimEnd([char[]]"`r`n")
    }
    Stop-Acceptance 'SQL_EDITOR_TEXT_PATTERN_UNAVAILABLE'
}

function Wait-SqlEditorText($Editor, [string]$Expected) {
    $deadline = [datetime]::UtcNow.AddSeconds(10)
    do {
        if ((Read-SqlEditorText $Editor) -ceq $Expected) { return }
        Start-Sleep -Milliseconds 100
    } while ([datetime]::UtcNow -lt $deadline)
    Stop-Acceptance 'SQL_EDITOR_TEXT_MISMATCH'
}

function Set-SqlEditorText($App, [string]$Value) {
    $types = @([Windows.Automation.ControlType]::Edit, [Windows.Automation.ControlType]::Document)
    $editor = Find-Control $App.Window $types 'SQL 编辑器'
    if (-not [AcceptanceDesktop]::FocusDialog($App.Process.MainWindowHandle)) { Stop-Acceptance 'SQL_EDITOR_WINDOW_NOT_FOCUSED' }
    $script:action = 'focus_sql_editor'
    $editor.SetFocus()
    $deadline = [datetime]::UtcNow.AddSeconds(10)
    $focused = $false
    do {
        $target = [Windows.Automation.AutomationElement]::FocusedElement
        for ($depth = 0; $target -and $depth -lt 8; $depth++) {
            if ([Windows.Automation.Automation]::Compare($target, $editor)) { $focused = $true; break }
            $target = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($target)
        }
        if ($focused) { break }
        Start-Sleep -Milliseconds 100
    } while ([datetime]::UtcNow -lt $deadline)
    if (-not $focused) { Stop-Acceptance 'SQL_EDITOR_NOT_FOCUSED' }
    # Exercise the real contenteditable input, including Unicode and native undo/redo.
    $before = Read-SqlEditorText $editor
    $script:action = 'paste_sql_editor'
    [Windows.Forms.Clipboard]::SetText($Value)
    [Windows.Forms.SendKeys]::SendWait('^a')
    [Windows.Forms.SendKeys]::SendWait('^v')
    Wait-SqlEditorText $editor $Value
    $script:action = 'undo_sql_editor'
    [Windows.Forms.SendKeys]::SendWait('^z')
    Wait-SqlEditorText $editor $before
    $script:action = 'redo_sql_editor'
    [Windows.Forms.SendKeys]::SendWait('^y')
    Wait-SqlEditorText $editor $Value
    return $editor
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

function Invoke-ControlDoubleClick($App, $Control) {
    if (-not [AcceptanceDesktop]::FocusDialog($App.Process.MainWindowHandle)) { Stop-Acceptance 'GRID_WINDOW_NOT_FOCUSED' }
    # Chromium may expose a text child; focus its keyboard-accessible cell so
    # the application's own focus handler scrolls it clear of sticky headers.
    $focusTarget = $Control
    for ($depth = 0; $focusTarget -and $depth -lt 6; $depth++) {
        if ($focusTarget.Current.IsKeyboardFocusable) { $focusTarget.SetFocus(); break }
        $focusTarget = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($focusTarget)
    }
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
    $bounds = $Control.Current.BoundingRectangle
    $report.controlClickProbe = @{ type = $Control.Current.ControlType.ProgrammaticName;
        offscreen = $Control.Current.IsOffscreen; x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
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

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

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
    $script:action = 'verify_candidate'
    $manifest = Get-Content -LiteralPath (Join-Path $CandidateDirectory 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.kind -ne 'tauri-native-candidate' -or $manifest.target -ne 'win-x64' -or
        $manifest.sha -cne $candidateIdentity.sha -or $manifest.runId -cne $candidateIdentity.runId -or
        $manifest.runAttempt -cne $candidateIdentity.runAttempt -or @($manifest.files).Count -ne 1) {
        Stop-Acceptance 'CANDIDATE_IDENTITY_MISMATCH'
    }
    $file = $manifest.files[0]
    if ($file.name -notmatch '^[A-Za-z0-9._+()-]+\.exe$') { Stop-Acceptance 'CANDIDATE_NAME_INVALID' }
    $candidate = Get-Item -LiteralPath (Join-Path $CandidateDirectory $file.name)
    if ($candidate.PSIsContainer -or ($candidate.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $candidate.Length -ne $file.size -or (Get-FileHash -LiteralPath $candidate.FullName).Hash -ine $file.sha256) {
        Stop-Acceptance 'CANDIDATE_HASH_MISMATCH'
    }
    $report.installerSha256 = $file.sha256
    $report.candidate = $candidateIdentity
    $report.checks.candidateIntegrity = $true

    $script:action = 'install_and_launch'
    $root = Join-Path $env:RUNNER_TEMP ('dbstudio-candidate-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $root
    $installDir = Join-Path $root 'app'
    $binary = Install-App $candidate.FullName
    $report.checks.installed = $true
    $report.binarySha256 = (Get-FileHash -LiteralPath $binary).Hash.ToLowerInvariant()
    $env:DBSTUDIO_NATIVE_SMOKE_ROOT = $null
    $app = Open-App $binary

    # Hosted desktops can be smaller than the app's default outer window.
    # Keep a normal window inside the work area; do not maximize or bypass UI clicks.
    $workArea = [Windows.Forms.Screen]::FromHandle($app.Process.MainWindowHandle).WorkingArea
    $windowBounds = $app.Window.Current.BoundingRectangle
    $windowWidth = [Math]::Min([int]$windowBounds.Width, $workArea.Width)
    $windowHeight = [Math]::Min([int]$windowBounds.Height, $workArea.Height)
    if (-not [AcceptanceDesktop]::SetWindowPos($app.Process.MainWindowHandle, [IntPtr]::Zero,
        $workArea.X, $workArea.Y, $windowWidth, $windowHeight, 0x0014)) { Stop-Acceptance 'WINDOW_FIT_FAILED' }
    $report.windowSize = @{ width = $windowWidth; height = $windowHeight }
    if (-not [AcceptanceDesktop]::FocusDialog($app.Process.MainWindowHandle)) { Stop-Acceptance 'APP_WINDOW_NOT_FOCUSED' }
    $script:action = 'wait_application_ready'
    $startup = [Diagnostics.Stopwatch]::StartNew()
    try {
        $null = Find-Control $app.Window ([Windows.Automation.ControlType]::Button) '新建连接' -ContainsName -AllowOffscreen -TimeoutSeconds 90
    } finally { $startup.Stop(); $report.readyWaitMs = $startup.ElapsedMilliseconds }
    $report.checks.applicationReady = $true
    $script:action = 'open_connection_form'
    Invoke-Button $app.Window '新建连接' -ContainsName
    $script:action = 'select_mysql'
    Select-MySql $app.Window
    $profile = 'DBStudio candidate MySQL'
    $fields = [ordered]@{
        '连接名' = $profile
        '主机' = '127.0.0.1'
        '端口' = [string]$Port
        '数据库' = 'dbstudio_acceptance'
        '用户名' = 'acceptance'
    }
    $edit = [Windows.Automation.ControlType]::Edit
    $button = [Windows.Automation.ControlType]::Button
    $cell = @([Windows.Automation.ControlType]::Text, [Windows.Automation.ControlType]::DataItem)
    foreach ($item in $fields.GetEnumerator()) {
        $script:action = 'fill_connection'
        $types = @($edit)
        if ($item.Key -eq '端口') { $types += [Windows.Automation.ControlType]::Spinner }
        Set-EditText (Find-Control $app.Window $types $item.Key -FieldLabel) $item.Value
    }
    $script:action = 'connect_and_query'
    Invoke-Button $app.Window '保存并连接'
    $sqlEditor = Set-SqlEditorText $app "-- 编辑器验收`nSELECT payload FROM dbstudio_acceptance.items WHERE id = 1;"
    $report.checks.editorClipboardAndHistory = $true
    $script:action = 'search_and_replace_sql'
    [Windows.Forms.SendKeys]::SendWait('^f')
    Set-EditText (Find-Control $app.Window $edit '查找') '编辑器验收'
    [Windows.Forms.SendKeys]::SendWait('{TAB}')
    [Windows.Forms.SendKeys]::SendWait('^h')
    Set-EditText (Find-Control $app.Window $edit '替换') '查找替换验收'
    [Windows.Forms.SendKeys]::SendWait('{TAB}')
    Invoke-Button $app.Window '全部替换'
    Wait-SqlEditorText $sqlEditor "-- 查找替换验收`nSELECT payload FROM dbstudio_acceptance.items WHERE id = 1;"
    Invoke-Button $app.Window '关闭查找'
    $sqlEditor.SetFocus()
    [Windows.Forms.SendKeys]::SendWait('^z')
    Wait-SqlEditorText $sqlEditor "-- 编辑器验收`nSELECT payload FROM dbstudio_acceptance.items WHERE id = 1;"
    $report.checks.editorSearchReplaceUndo = $true
    $script:action = 'execute_editor_shortcut'
    [Windows.Forms.SendKeys]::SendWait('^{ENTER}')
    $null = Find-Control $app.Window $cell 'row-1' -AllowOffscreen
    $report.checks.connectedAndQueried = $true

    $script:action = 'failed_sql_navigation'
    $failureSql = "SELECT 1;`nSELECT dbstudio_missing_column;`nSELECT 3;"
    $sqlEditor = Set-SqlEditorText $app $failureSql
    [Windows.Forms.SendKeys]::SendWait('+{ENTER}')
    $locate = Find-Control $app.Window $button '定位执行语句'
    Invoke-Button $app.Window '定位执行语句'
    $pattern = $sqlEditor.GetCurrentPattern([Windows.Automation.TextPattern]::Pattern)
    $deadline = [datetime]::UtcNow.AddSeconds(10)
    $located = $false
    do {
        $selection = @($pattern.GetSelection())
        if ($selection.Count -eq 1 -and $selection[0].GetText(-1) -ceq 'SELECT dbstudio_missing_column') { $located = $true; break }
        Start-Sleep -Milliseconds 100
    } while ([datetime]::UtcNow -lt $deadline)
    if (-not $located) { Stop-Acceptance 'SQL_EDITOR_FAILURE_SELECTION_MISMATCH' }
    $sqlEditor = Set-SqlEditorText $app 'SELECT 42 AS recovered;'
    $null = Find-Control $app.Window $cell '草稿已变化，请查看执行快照。' -AllowOffscreen
    [Windows.Forms.SendKeys]::SendWait('^{ENTER}')
    $null = Find-Control $app.Window $cell '42' -AllowOffscreen
    $report.checks.editorFailureNavigationAndRecovery = $true

    $script:action = 'open_fixture_table'
    $tree = Find-Control $app.Window ([Windows.Automation.ControlType]::Tree) '数据库对象'
    foreach ($group in @($profile, 'Schemas', 'dbstudio_acceptance', 'Tables')) {
        $node = Find-Control $tree ([Windows.Automation.ControlType]::TreeItem) $group -ContainsName
        $expand = $node.FindFirst([Windows.Automation.TreeScope]::Descendants,
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, '展开'))
        if ($expand) { $expand.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
    }
    $table = Find-Control $tree ([Windows.Automation.ControlType]::TreeItem) 'items' -ContainsName
    Invoke-ControlDoubleClick $app $table
    # A table result, unlike the earlier SQL query, exposes the import action.
    $null = Find-Control $app.Window $button '导入 CSV…'

    $script:action = 'edit_and_preview'
    Edit-GridValue $app 'row-1' 'candidate-committed'
    Invoke-Button $app.Window '应用修改 (1)'
    $null = Find-Control $app.Window $cell '更新 SQL 预览' -AllowOffscreen
    $null = Find-Control $app.Window $cell 'WHERE' -ContainsName -AllowOffscreen
    if ((& $ReadFixtureSql 'SELECT payload FROM dbstudio_acceptance.items WHERE id=1;') -cne 'row-1') {
        Stop-Acceptance 'PREVIEW_WROTE_DATA'
    }
    Invoke-Button $app.Window '应用修改'
    $null = Find-Control $app.Window $cell '未提交 · 1 行'
    if ((& $ReadFixtureSql 'SELECT payload FROM dbstudio_acceptance.items WHERE id=1;') -cne 'row-1') {
        Stop-Acceptance 'UNCOMMITTED_DATA_VISIBLE'
    }
    Invoke-Button $app.Window '提交'
    $null = Find-Control $app.Window $cell '提交当前连接' -AllowOffscreen
    if ((& $ReadFixtureSql 'SELECT payload FROM dbstudio_acceptance.items WHERE id=1;') -cne 'row-1') {
        Stop-Acceptance 'COMMIT_PREVIEW_WROTE_DATA'
    }
    Invoke-Button $app.Window '提交事务'
    $null = Find-Control $app.Window $cell '已提交当前连接事务' -AllowOffscreen
    if ((& $ReadFixtureSql 'SELECT payload FROM dbstudio_acceptance.items WHERE id=1;') -cne 'candidate-committed') {
        Stop-Acceptance 'COMMIT_READBACK_MISMATCH'
    }
    $report.checks.editPreviewAndCommit = $true

    $script:action = 'edit_and_rollback'
    Edit-GridValue $app 'candidate-committed' 'candidate-rolled-back'
    Invoke-Button $app.Window '应用修改 (1)'
    $null = Find-Control $app.Window $cell '更新 SQL 预览' -AllowOffscreen
    Invoke-Button $app.Window '应用修改'
    $null = Find-Control $app.Window $cell '未提交 · 1 行'
    $null = Find-Control $app.Window $cell 'candidate-rolled-back' -AllowOffscreen
    if ((& $ReadFixtureSql 'SELECT payload FROM dbstudio_acceptance.items WHERE id=1;') -cne 'candidate-committed') {
        Stop-Acceptance 'ROLLBACK_UNCOMMITTED_DATA_VISIBLE'
    }
    Invoke-Button $app.Window '回滚'
    $null = Find-Control $app.Window $cell '回滚当前连接' -AllowOffscreen
    Invoke-Button $app.Window '确认'
    $null = Find-Control $app.Window $cell '已回滚当前连接事务' -AllowOffscreen
    $null = Find-Control $app.Window $cell 'candidate-committed' -AllowOffscreen
    if ((& $ReadFixtureSql 'SELECT payload FROM dbstudio_acceptance.items WHERE id=1;') -cne 'candidate-committed') {
        Stop-Acceptance 'ROLLBACK_READBACK_MISMATCH'
    }
    $report.checks.editRollbackAndReadback = $true

    $script:action = 'export_csv'
    $csvPath = Join-Path $root 'candidate.csv'
    Invoke-Button $app.Window '导出完整来源…'
    Invoke-Button $app.Window '选择…'
    Select-TransferFile $app '保存导出文件' $csvPath $true
    Invoke-Button $app.Window '开始导出'
    $null = Find-Control $app.Window $cell '任务 completed · 405 行' -ContainsName -AllowOffscreen
    $script:action = 'verify_export_against_mysql'
    $csv = @(Import-Csv -LiteralPath $csvPath -Encoding utf8)
    $rows = @(& $ReadFixtureSql 'SELECT id, group_id, payload, note, generated_value FROM dbstudio_acceptance.items ORDER BY id;')
    if ($rows.Count -ne 405 -or $csv.Count -ne 405 -or
        ($csv[0].PSObject.Properties.Name -join ',') -cne 'id,group_id,payload,note,generated_value') {
        Stop-Acceptance 'CSV_SHAPE_MISMATCH'
    }
    $actual = @($csv | Sort-Object { [int]$_.id } | ForEach-Object {
        $_.id, $_.group_id, $_.payload, $_.note, $_.generated_value -join [char]9
    })
    if (($actual -join [char]10) -cne ($rows -join [char]10)) {
        Stop-Acceptance 'CSV_READBACK_MISMATCH'
    }
    $report.checks.csvMatchesMysql = $true
    $report.exportedRows = $csv.Count
    Invoke-Button $app.Window '关闭'
    $script:action = 'close_application'
    Close-App $app
    $report.checks.cleanExit = $true
    $report.status = 'passed'
    Write-Output 'Installed Windows candidate: MySQL query, update preview, commit and 405-row CSV verified.'
} finally {
    if ($report.status -ne 'passed') {
        try {
            $failedApp = Get-Variable -Name app -ValueOnly -ErrorAction SilentlyContinue
            if ($failedApp -and -not $failedApp.Process.HasExited) {
                Add-Type -AssemblyName System.Drawing
                $bounds = $failedApp.Window.Current.BoundingRectangle
                $screen = [Windows.Forms.SystemInformation]::VirtualScreen
                $region = [Drawing.Rectangle]::Intersect($screen, [Drawing.Rectangle]::new([int]$bounds.X, [int]$bounds.Y, [int]$bounds.Width, [int]$bounds.Height))
                $bitmap = [Drawing.Bitmap]::new($region.Width, $region.Height)
                $graphics = [Drawing.Graphics]::FromImage($bitmap)
                try {
                    $graphics.CopyFromScreen($region.Location, [Drawing.Point]::Empty, $region.Size)
                    $bitmap.Save((Join-Path $PWD 'candidate-window.png'), [Drawing.Imaging.ImageFormat]::Png)
                } finally { $graphics.Dispose(); $bitmap.Dispose() }
            }
        } catch { $report.screenshotUnavailable = $true }
    }
    foreach ($child in $script:children) {
        if (-not $child.HasExited) {
            $child.Kill()
            $child.WaitForExit()
        }
        $child.Dispose()
    }
    if ($report.status -ne 'passed') {
        $report.failure = $script:failure
        $report.stage = $script:action
    }
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $PWD 'candidate-acceptance.json') -Encoding utf8NoBOM
    Write-Output "Candidate acceptance stage: $script:action. Status: $($report.status)."
}
