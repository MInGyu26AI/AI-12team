"""Secrets read from files that only the current user can read: the team connection key and connection.json."""
import os
import re
import stat

# secrets.token_urlsafe(32), the form of team connection keys and of the local RPC token.
SECRET_TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')


def read_private_file(path, limit, message):
    """Up to limit bytes of a regular file owned by the current user with no group or other permissions.

    ValueError(message) otherwise. A symbolic link is refused when opened (OSError), as O_NOFOLLOW makes it.
    The owner and mode are checked on POSIX only.
    """
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as f:
        info = os.fstat(f.fileno())
        private = os.name != 'posix' or (not info.st_mode & 0o077 and info.st_uid == os.getuid())
        if not stat.S_ISREG(info.st_mode) or not private:
            raise ValueError(message)
        return f.read(limit)
