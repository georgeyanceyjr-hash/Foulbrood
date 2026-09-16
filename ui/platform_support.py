"""Small OS boundary for the local viewer and its subprocesses."""
import base64
import os
from pathlib import Path
import subprocess


def executable(root, name):
    return str(Path(root)/'target'/'release'/(name + ('.exe' if os.name == 'nt' else '')))


def process_options():
    return {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}


def choose_engine():
    if os.name == 'nt':
        script = """[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$picker = New-Object System.Windows.Forms.OpenFileDialog
$picker.Title = 'Choose a UHP engine program'
$picker.Filter = 'Engine programs (*.exe)|*.exe'
try { if ($picker.ShowDialog() -eq 'OK') { [Console]::Write($picker.FileName) } }
finally { $picker.Dispose() }
"""
        encoded = base64.b64encode(script.encode('utf-16le')).decode('ascii')
        powershell = Path(os.environ.get('SystemRoot', r'C:\Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
        command = [str(powershell), '-NoProfile', '-STA', '-EncodedCommand', encoded]
    else:
        command = ['/usr/bin/osascript', '-e', 'POSIX path of (choose file with prompt "Choose a UHP engine program")']
    result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=120, **process_options())
    if result.returncode:
        if os.name != 'nt' and '(-128)' in result.stderr:
            return None
        raise ValueError('Could not open the file chooser. Paste the engine path instead.')
    return result.stdout.strip() or None
