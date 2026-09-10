param([Parameter(Mandatory=$true)][string]$ApplicationDirectory)
$ErrorActionPreference = 'Stop'
$applicationRoot = (Resolve-Path -LiteralPath $ApplicationDirectory).Path
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CodexConsoleProbe {
  delegate bool EnumCallback(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  public static string[] Find(string root) {
    var found = new List<string>();
    EnumWindows((window, data) => {
      if (!IsWindowVisible(window)) return true;
      var title = new StringBuilder(32768);
      GetWindowText(window, title, title.Capacity);
      var value = title.ToString();
      if (value.StartsWith(root, StringComparison.OrdinalIgnoreCase) && value.IndexOf("codex", StringComparison.OrdinalIgnoreCase) >= 0) found.Add(value);
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
}
'@
$titles = @([CodexConsoleProbe]::Find($applicationRoot))
ConvertTo-Json -InputObject $titles -Compress
