"""Desktop bundle entry; CLI/native-host commands keep the existing packaged-app protocol."""
import sys
from bundled_tls import configure

configure()

import syncup_entry
import desktop

if __name__ == '__main__':
    if len(sys.argv) == 1 or sys.argv[1] == 'desktop':
        desktop.main()
    else:
        syncup_entry.main()
