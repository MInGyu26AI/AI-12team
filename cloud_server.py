"""Existing team API behind the hosting provider's HTTPS ingress."""
import json
import os
import re

import psycopg
from psycopg.conninfo import conninfo_to_dict

from team_server import TeamHandler, TeamServer, verify_database


class CloudHandler(TeamHandler):
    def valid_host(self):
        return self.headers.get_all('Host', []) == [self.server.public_host]

    def handle_api(self):
        if self.path != '/healthz':
            return super().handle_api()
        # Health checks reveal only readiness, never identities or DB error text.
        # Railway probes use a dedicated host; it is allowed only on this read-only route.
        probe = self.headers.get_all('Host', []) == ['healthcheck.railway.app']
        if self.command != 'GET' or not (self.valid_host() or probe):
            return self.reply(400, '{}', 'application/json')
        try:
            with psycopg.connect(self.server.dsn, connect_timeout=3) as c:
                c.execute("SET LOCAL statement_timeout = '3s'")
                c.execute('SELECT 1')
            status = 200
        except psycopg.Error:
            status = 503
        self.reply(status, json.dumps({'ready': status == 200}), 'application/json')


def settings():
    if os.environ.get('SYNCUP_ADMIN_DATABASE_URL'):
        raise ValueError('Administrator credentials are forbidden in this service.')
    dsn = os.environ['SYNCUP_DATABASE_URL']
    if conninfo_to_dict(dsn).get('sslmode') != 'verify-full':
        raise ValueError('Database TLS hostname verification is required.')
    host = os.environ.get('SYNCUP_PUBLIC_HOST') or os.environ.get('RENDER_EXTERNAL_HOSTNAME', '')
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?', host) or '.' not in host:
        raise ValueError('An exact public hostname is required.')
    port = int(os.environ.get('PORT', '10000'))
    if not 1 <= port <= 65535:
        raise ValueError('Invalid port.')
    return dsn, host, port


def main():
    try:
        dsn, host, port = settings()
        verify_database(dsn)
    except (KeyError, ValueError, psycopg.Error):
        raise SystemExit('Cloud configuration or restricted DB connection failed; credentials are not logged.') from None
    # The provider terminates TLS; only this authenticated API is bound publicly.
    with TeamServer(('0.0.0.0', port), CloudHandler) as server:
        server.dsn, server.public_host = dsn, host
        print('SyncUp team API ready behind managed HTTPS ingress.', flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
