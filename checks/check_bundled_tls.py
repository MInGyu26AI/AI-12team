"""The standalone app supplies trust roots without weakening TLS or changing source runs."""
import repo_paths  # noqa: F401
import os
from pathlib import Path
import shutil
import ssl
import sys
import tempfile
import unittest
from unittest.mock import patch

import certifi
from bundled_tls import configure


class BundledTrust(unittest.TestCase):
    def test_source_run_keeps_its_existing_trust_configuration(self):
        with patch.object(sys, 'frozen', False, create=True), patch.dict(os.environ, {'SSL_CERT_FILE': '/custom/ca.pem'}):
            configure()
            self.assertEqual(os.environ['SSL_CERT_FILE'], '/custom/ca.pem')

    def test_frozen_app_uses_packaged_roots_and_still_verifies_hostnames(self):
        with tempfile.TemporaryDirectory() as folder:
            ca = Path(folder) / 'certs/cacert.pem'
            ca.parent.mkdir()
            shutil.copyfile(certifi.where(), ca)
            with patch.object(sys, 'frozen', True, create=True), patch.object(sys, '_MEIPASS', folder, create=True), \
                    patch.dict(os.environ, {'SSL_CERT_FILE': '/missing/build-machine/cert.pem'}):
                configure()
                context = ssl.create_default_context()
                self.assertEqual(os.environ['SSL_CERT_FILE'], str(ca))
                self.assertGreater(context.cert_store_stats()['x509_ca'], 50)
                self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
                self.assertTrue(context.check_hostname)

    def test_missing_or_invalid_bundle_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            ca = Path(folder) / 'certs/cacert.pem'
            ca.parent.mkdir()
            with patch.object(sys, 'frozen', True, create=True), patch.object(sys, '_MEIPASS', folder, create=True):
                with self.assertRaises(FileNotFoundError):
                    configure()
                ca.write_text('not a certificate')
                with self.assertRaises(ssl.SSLError):
                    configure()


if __name__ == '__main__':
    unittest.main(verbosity=2)
