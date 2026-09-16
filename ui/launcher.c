/* Native entry point so Finder recognizes the local app bundle. */
#include <mach-o/dyld.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
int main(void) {
    char path[PATH_MAX], resolved[PATH_MAX], script[PATH_MAX], python[PATH_MAX];
    uint32_t size=sizeof(path);
    if (_NSGetExecutablePath(path,&size) || !realpath(path,resolved)) return 1;
    char *last=strrchr(resolved,'/'); if(!last)return 1; *last=0;
    last=strrchr(resolved,'/'); if(!last)return 1; *last=0;
    if(snprintf(script,sizeof(script),"%s/Resources/launcher.py",resolved)>=(int)sizeof(script))return 1;
    if(snprintf(python,sizeof(python),"%s/Resources/python/bin/python3",resolved)>=(int)sizeof(python))return 1;
    if(access(python,X_OK)==0)execl(python,"python3","-E","-s","-B",script,(char*)NULL);
    else execl("/usr/bin/python3","python3","-E","-s","-B",script,(char*)NULL);
    return 1;
}
