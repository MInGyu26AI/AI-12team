# Desktop trust and Mac lifecycle

Install `collector/desktop-requirements.txt` in the Python 3.12 build environment before running
`collector/desktop_bundle.py`. The pinned certifi CA file is copied into `certs/cacert.pem`. Update
the certifi pin when maintaining release dependencies. Frozen desktop entry sets `SSL_CERT_FILE`
to this bundled file before dispatching GUI, native-host or collector commands. Source runs keep
their interpreter's trust configuration. Missing or invalid bundled roots fail closed; hostname
and certificate verification are never disabled. No end-user Python installation is required.

The Mac GUI runs Cocoa on the main thread and the loopback setup server on a worker. Finder/Dock
reopen and the app's “PC 연결 화면 열기” menu action mint a fresh one-use bootstrap URL. Existing
authenticated tabs remain valid; concurrent consumption succeeds once. Native-host commands
do not import or start Cocoa. Both the web Quit button and the app Quit action stop the server
and collector.

Mac Developer ID signing must retain `collector/desktop-macos-entitlements.plist` on the main
executable and app bundle. Its sole exception is `com.apple.security.cs.allow-jit`, needed for
PyObjC's Cocoa-to-Python callback stubs. Keep hardened runtime, timestamp and library validation;
do not add `disable-library-validation` or `allow-unsigned-executable-memory`. Sign all bundled
Mach-O files and nested frameworks from inside out, then sign the outer app with these
entitlements. Validate the signed app, submit it to Apple notarization, staple the accepted
ticket and test the downloaded copy. An unsigned CI artifact is not a signed release.

Checks:

```sh
python checks/check_bundled_tls.py
python checks/check_desktop_setup.py
python checks/check_desktop_bundle.py
# Opt-in public invalid-invite lookup; creates no login, key or real invite.
python checks/check_desktop_https.py --api https://your-team-api.example
```

On a real Mac, launch the signed download, close its browser tab, reopen the same app, and
verify the page is authenticated and the same server is reused. Verify web Quit exits the app,
then launch again and verify app Quit exits it. Finally verify GitHub PC connection with the
actual Chrome extension. Source tests alone cannot establish these distribution behaviors.

References: [certifi](https://github.com/certifi/python-certifi),
[Apple NSApplication](https://developer.apple.com/documentation/appkit/nsapplication),
[PyInstaller macOS events](https://www.pyinstaller.org/en/stable/feature-notes.html),
[PyObjC signing requirements](https://pyobjc.readthedocs.io/en/latest/notes/codesigning.html).
