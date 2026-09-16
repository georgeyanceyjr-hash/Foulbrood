/* Portable Windows entry point; no system Python or console window required. */
#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#include <windows.h>
#include <wchar.h>

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR args, int show) {
    wchar_t folder[32768], python[32768], command[32768];
    DWORD n = GetModuleFileNameW(NULL, folder, 32768);
    if (!n || n >= 32768) return 1;
    wchar_t *end = wcsrchr(folder, L'\\');
    if (!end) return 1;
    *end = 0;
    if (swprintf(python, 32768, L"%ls\\Resources\\python\\pythonw.exe", folder) < 0 ||
        swprintf(command, 32768, L"\"%ls\" -X utf8 -E -s -B \"%ls\\Resources\\launcher_windows.py\"", python, folder) < 0) return 1;
    STARTUPINFOW startup = {sizeof(startup)};
    PROCESS_INFORMATION process = {0};
    if (!CreateProcessW(python, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, folder, &startup, &process)) {
        MessageBoxW(NULL, L"Extract the entire ZIP before opening FoulBrood GUI. Keep the Resources folder beside this program.", L"FoulBrood GUI", MB_OK | MB_ICONERROR);
        return 1;
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 0;
}
