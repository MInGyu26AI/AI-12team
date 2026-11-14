"""Files only the current user can use: the state folder, and the secrets read from the team connection key and
connection.json. POSIX checks file modes; Windows checks ACLs (windows_security)."""
import errno
import os
import re
import stat
import sys

import windows_security

# secrets.token_urlsafe(32), the form of team connection keys and of the local RPC token.
SECRET_TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')


def make_private_directory(path):
    """Create the folder path (and its parents) for files no one else may read. On POSIX the process umask (0o077)
    keeps new files private. On Windows, where new files take their folder's ACL instead, an empty folder gets an ACL
    for the current user only; a folder that already holds files keeps its ACL, which must already be private.
    OSError when it is not or the ACL cannot be set."""
    path.mkdir(parents=True, exist_ok=True)
    if sys.platform != 'win32':
        return
    if not any(path.iterdir()):
        windows_security.restrict_to_current_user(path)
    elif not windows_security.is_private_path(path):
        raise PermissionError(errno.EACCES, '다른 계정도 접근할 수 있는 폴더입니다.', str(path))


def read_private_file(path, limit, message):
    """Up to limit bytes of a regular file only the current user can read: on POSIX owned by them with no group or
    other permissions, on Windows owned by them with an ACL that admits no other account (windows_security).

    ValueError(message) otherwise. A symbolic link is refused (OSError): POSIX opens with O_NOFOLLOW; Windows, which
    has no such flag, checks just before opening, and the ACL check still applies to whatever file was opened.
    """
    if sys.platform == 'win32' and os.path.islink(path):
        raise OSError(errno.ELOOP, '링크는 열지 않습니다.', str(path))
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
    with os.fdopen(fd, 'rb') as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or not _only_current_user(f.fileno(), info):
            raise ValueError(message)
        return f.read(limit)


def _only_current_user(fd, info):
    if sys.platform == 'win32':
        return windows_security.is_private(fd)
    return not info.st_mode & 0o077 and info.st_uid == os.getuid()
