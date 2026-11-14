"""Windows file ACLs for SyncUp's private files, the counterpart of the POSIX modes in private_files.py.

Only `private_acl` runs on other systems (it is plain data); the rest calls the Windows API through ctypes.
"""
import ctypes
from ctypes import wintypes
import functools

SE_FILE_OBJECT = 1
OWNER_SECURITY_INFORMATION = 0x1
DACL_SECURITY_INFORMATION = 0x4
PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
TOKEN_QUERY = 0x8
TOKEN_USER = 1
SDDL_REVISION_1 = 1
ACCESS_ALLOWED_ACE_TYPE = 0
# ACCESS_DENIED, ACCESS_DENIED_OBJECT, ACCESS_DENIED_CALLBACK and ACCESS_DENIED_CALLBACK_OBJECT entries.
DENIED_ACE_TYPES = {1, 6, 10, 12}
INHERIT_ONLY_ACE = 0x8
# Besides the user, the accounts a default Windows user profile admits; on POSIX root can read every file too.
LOCAL_SYSTEM = 'S-1-5-18'
ADMINISTRATORS = 'S-1-5-32-544'
# OWNER RIGHTS stands for the file's owner, which private_acl checks first. Python's os.mkdir(path, 0o700) and so
# tempfile.mkdtemp grant it on Windows.
OWNER_RIGHTS = 'S-1-3-4'
TRUSTED = (LOCAL_SYSTEM, ADMINISTRATORS, OWNER_RIGHTS)


def private_acl(owner, entries, user):
    """Whether a file with this owner and DACL is private to user. SIDs are S-1-... strings.

    entries: (ACE type, ACE flags, SID or None) for each DACL entry, or None for a NULL DACL, which admits everyone.
    The owner must be the user, or Administrators when the user ran elevated. Every entry that lets someone in must
    name the user or a TRUSTED account; deny entries and inherit-only ones, which do not apply to the file itself,
    are skipped, and an entry of any other type is refused.
    """
    if entries is None or owner not in (user, ADMINISTRATORS):
        return False
    for kind, flags, sid in entries:
        if flags & INHERIT_ONLY_ACE or kind in DENIED_ACE_TYPES:
            continue
        if kind != ACCESS_ALLOWED_ACE_TYPE or sid not in (user, *TRUSTED):
            return False
    return True


class _ACL(ctypes.Structure):
    _fields_ = [('AclRevision', ctypes.c_ubyte), ('Sbz1', ctypes.c_ubyte), ('AclSize', wintypes.WORD),
                ('AceCount', wintypes.WORD), ('Sbz2', wintypes.WORD)]


class _ACE_HEADER(ctypes.Structure):
    _fields_ = [('AceType', ctypes.c_ubyte), ('AceFlags', ctypes.c_ubyte), ('AceSize', wintypes.WORD)]


# An allow or deny entry is its header, a 4-byte access mask, then the SID.
_ACE_SID_OFFSET = ctypes.sizeof(_ACE_HEADER) + 4


@functools.cache
def _api():
    advapi32 = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    out = ctypes.POINTER(ctypes.c_void_p)
    signatures = {
        (kernel32, 'GetCurrentProcess'): (wintypes.HANDLE, []),
        (kernel32, 'CloseHandle'): (wintypes.BOOL, [wintypes.HANDLE]),
        (kernel32, 'LocalFree'): (ctypes.c_void_p, [ctypes.c_void_p]),
        (advapi32, 'OpenProcessToken'): (wintypes.BOOL, [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]),
        (advapi32, 'GetTokenInformation'): (wintypes.BOOL, [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                                             wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]),
        (advapi32, 'ConvertSidToStringSidW'): (wintypes.BOOL, [ctypes.c_void_p, out]),
        (advapi32, 'GetSecurityInfo'): (wintypes.DWORD, [wintypes.HANDLE, ctypes.c_int, wintypes.DWORD,
                                                         out, out, out, out, out]),
        (advapi32, 'GetNamedSecurityInfoW'): (wintypes.DWORD, [wintypes.LPCWSTR, ctypes.c_int, wintypes.DWORD,
                                                               out, out, out, out, out]),
        (advapi32, 'GetAce'): (wintypes.BOOL, [ctypes.c_void_p, wintypes.DWORD, out]),
        (advapi32, 'ConvertStringSecurityDescriptorToSecurityDescriptorW'):
            (wintypes.BOOL, [wintypes.LPCWSTR, wintypes.DWORD, out, ctypes.POINTER(wintypes.ULONG)]),
        (advapi32, 'GetSecurityDescriptorDacl'): (wintypes.BOOL, [ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL),
                                                                   out, ctypes.POINTER(wintypes.BOOL)]),
        (advapi32, 'SetNamedSecurityInfoW'): (wintypes.DWORD, [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                                                               ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                                               ctypes.c_void_p]),
    }
    for (dll, name), (restype, argtypes) in signatures.items():
        function = getattr(dll, name)
        function.restype, function.argtypes = restype, argtypes
    return advapi32, kernel32


def _check(succeeded):
    if not succeeded:
        raise ctypes.WinError(ctypes.get_last_error())


def _sid_text(sid):
    advapi32, kernel32 = _api()
    text = ctypes.c_void_p()
    _check(advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text)))
    try:
        return ctypes.wstring_at(text.value)
    finally:
        kernel32.LocalFree(text)


@functools.cache
def current_user_sid():
    """The SID of the user this process runs as (the same when elevated)."""
    advapi32, kernel32 = _api()
    token = wintypes.HANDLE()
    _check(advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), TOKEN_QUERY, ctypes.byref(token)))
    try:
        size = wintypes.DWORD()
        advapi32.GetTokenInformation(token, TOKEN_USER, None, 0, ctypes.byref(size))  # fails, reporting the size
        if not size.value:
            raise ctypes.WinError(ctypes.get_last_error())
        buffer = ctypes.create_string_buffer(size.value)
        _check(advapi32.GetTokenInformation(token, TOKEN_USER, buffer, size, ctypes.byref(size)))
        # TOKEN_USER starts with the user's SID pointer, which points into buffer.
        return _sid_text(ctypes.c_void_p.from_buffer(buffer).value)
    finally:
        kernel32.CloseHandle(token)


def _entries(acl):
    advapi32, _ = _api()
    for index in range(_ACL.from_address(acl).AceCount):
        ace = ctypes.c_void_p()
        _check(advapi32.GetAce(acl, index, ctypes.byref(ace)))
        header = _ACE_HEADER.from_address(ace.value)
        sid = _sid_text(ace.value + _ACE_SID_OFFSET) if header.AceType == ACCESS_ALLOWED_ACE_TYPE else None
        yield header.AceType, header.AceFlags, sid


def is_private(fd):
    """Whether the open file fd is private to the current user (private_acl)."""
    import msvcrt
    advapi32, _ = _api()
    handle = msvcrt.get_osfhandle(fd)
    return _private_security(lambda owner, dacl, descriptor: advapi32.GetSecurityInfo(
        handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        owner, None, dacl, None, descriptor))


def is_private_path(path):
    """Whether the file or folder at path is private to the current user (private_acl)."""
    advapi32, _ = _api()
    return _private_security(lambda owner, dacl, descriptor: advapi32.GetNamedSecurityInfoW(
        str(path), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        owner, None, dacl, None, descriptor))


def _private_security(get):
    """private_acl for the owner and DACL that get(owner, dacl, descriptor) reads, returning a Win32 error code."""
    _, kernel32 = _api()
    owner, dacl, descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
    error = get(ctypes.byref(owner), ctypes.byref(dacl), ctypes.byref(descriptor))
    if error:
        raise ctypes.WinError(error)
    try:
        if not owner.value:  # a file system without security, such as FAT
            return False
        entries = list(_entries(dacl.value)) if dacl.value else None
        return private_acl(_sid_text(owner.value), entries, current_user_sid())
    finally:
        kernel32.LocalFree(descriptor)


def restrict_to_current_user(path):
    """Give the folder path an ACL of its own that admits only the current user and LocalSystem, inherited by every
    file and folder in it, existing ones included: the Windows counterpart of a 0700 folder under umask 077."""
    advapi32, kernel32 = _api()
    descriptor = ctypes.c_void_p()
    sddl = f'D:P(A;OICI;FA;;;{current_user_sid()})(A;OICI;FA;;;SY)'
    _check(advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1,
                                                                         ctypes.byref(descriptor), None))
    try:
        present, defaulted, dacl = wintypes.BOOL(), wintypes.BOOL(), ctypes.c_void_p()
        _check(advapi32.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl),
                                                  ctypes.byref(defaulted)))
        error = advapi32.SetNamedSecurityInfoW(str(path), SE_FILE_OBJECT,
                                               DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                                               None, None, dacl, None)
        if error:
            raise ctypes.WinError(error)
    finally:
        kernel32.LocalFree(descriptor)
