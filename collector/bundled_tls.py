"""Use the release's CA bundle in every mode of the standalone desktop executable."""
import os
from pathlib import Path
import ssl
import sys


def configure():
    if not getattr(sys, 'frozen', False):
        return
    ca_file = Path(sys._MEIPASS) / 'certs' / 'cacert.pem'
    # Fail closed if packaging omitted or damaged the trust store. Do not depend on a Python
    # installation at the build machine's OpenSSL path, or disable certificate/hostname checks.
    ssl.create_default_context(cafile=str(ca_file))
    os.environ['SSL_CERT_FILE'] = str(ca_file)
