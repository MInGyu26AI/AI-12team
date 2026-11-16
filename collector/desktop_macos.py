"""Keep the Cocoa event loop alive while the setup HTTP server runs in a worker.

Imported only by the macOS GUI entry, never by Chrome's native messaging process.
"""
import threading

from AppKit import NSApplication, NSApplicationActivationPolicyRegular, NSMenu, NSMenuItem, NSWorkspace
from Foundation import NSObject, NSURL
from PyObjCTools import AppHelper


class SetupAppDelegate(NSObject):
    def applicationDidFinishLaunching_(self, _notification):
        self.openSettings_(None)

    def applicationShouldHandleReopen_hasVisibleWindows_(self, _application, _visible):
        self.openSettings_(None)
        return False

    def openSettings_(self, _sender):
        # Each open gets a new one-use bootstrap. Existing authenticated tabs stay valid.
        url = NSURL.URLWithString_(self.server.browser_url())
        NSWorkspace.sharedWorkspace().openURL_(url)

    def applicationWillTerminate_(self, _notification):
        self.server.shutdown()
        self.worker.join(timeout=5)
        with self.server.state.lock:
            self.server.state.stop()
        self.server.server_close()


def run(server):
    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyRegular)
    delegate = SetupAppDelegate.alloc().init()
    delegate.server = server
    app.setDelegate_(delegate)

    menu = NSMenu.alloc().init()
    root = NSMenuItem.alloc().init()
    menu.addItem_(root)
    actions = NSMenu.alloc().initWithTitle_('SyncUp')
    root.setSubmenu_(actions)
    reopen = actions.addItemWithTitle_action_keyEquivalent_('PC 연결 화면 열기', 'openSettings:', 'o')
    reopen.setTarget_(delegate)
    actions.addItem_(NSMenuItem.separatorItem())
    quit_item = actions.addItemWithTitle_action_keyEquivalent_('SyncUp 종료', 'terminate:', 'q')
    quit_item.setTarget_(app)
    app.setMainMenu_(menu)

    def serve():
        try:
            server.serve_forever()
        finally:
            # The web UI's Quit action shuts down HTTP first. End the Cocoa loop as well.
            AppHelper.callAfter(app.terminate_, None)

    delegate.worker = threading.Thread(target=serve, name='syncup-setup-http', daemon=True)
    delegate.worker.start()
    app.run()
