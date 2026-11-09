"""Offline administration; never expose these operations through the team API."""
import argparse
import hashlib
import os
from pathlib import Path
import secrets
import uuid

import psycopg
from psycopg import sql


def issue_token(c, user_id, path, days=30):
    token = secrets.token_urlsafe(32)
    # Exclusive, owner-only creation: never overwrite an existing credential.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(token + '\n')
    c.execute("""INSERT INTO syncup.tokens(digest,user_id,expires_at)
        VALUES(%s,%s,now() + %s * interval '1 day')""",
        (hashlib.sha256(token.encode()).hexdigest(), user_id, days))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('init')
    p.add_argument('--api-password-file', type=Path, required=True)
    sub.add_parser('migrate-integration')
    for kind in ('user', 'team'):
        p = sub.add_parser(kind)
        p.add_argument('--name', required=True)
    p = sub.add_parser('member')
    p.add_argument('--team', type=uuid.UUID, required=True)
    p.add_argument('--user', type=uuid.UUID, required=True)
    p.add_argument('--revoke', action='store_true')
    p = sub.add_parser('token')
    p.add_argument('--user', type=uuid.UUID, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--days', type=int, default=30)
    p = sub.add_parser('revoke-tokens')
    p.add_argument('--user', type=uuid.UUID, required=True)
    args = parser.parse_args()
    dsn = os.environ.get('SYNCUP_ADMIN_DATABASE_URL')
    if not dsn:
        parser.error('SYNCUP_ADMIN_DATABASE_URL 환경 변수가 필요합니다.')
    try:
        with psycopg.connect(dsn, connect_timeout=5) as c:
            if args.command == 'init':
                password = args.api_password_file.read_text(encoding='utf-8').strip()
                if len(password) < 24:
                    raise ValueError('API DB password too short')
                c.execute(sql.SQL('CREATE ROLE syncup_api LOGIN PASSWORD {} NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION').format(sql.Literal(password)))
                c.execute(Path(__file__).with_name('team_schema.sql').read_text(encoding='utf-8'))
                c.execute(Path(__file__).with_name('team_integration.sql').read_text(encoding='utf-8'))
            elif args.command == 'migrate-integration':
                if not c.execute("SELECT to_regclass('syncup.conflict_checks')").fetchone()[0]:
                    c.execute(Path(__file__).with_name('team_integration.sql').read_text(encoding='utf-8'))
            elif args.command in ('user', 'team'):
                identifier = uuid.uuid4()
                table = 'users' if args.command == 'user' else 'teams'
                c.execute(sql.SQL('INSERT INTO syncup.{}(id,name) VALUES(%s,%s)').format(sql.Identifier(table)),
                          (identifier, args.name))
            elif args.command == 'member':
                c.execute('''INSERT INTO syncup.memberships(team_id,user_id,active) VALUES(%s,%s,%s)
                    ON CONFLICT(team_id,user_id) DO UPDATE SET active=excluded.active''',
                    (args.team, args.user, not args.revoke))
            elif args.command == 'token':
                if not 1 <= args.days <= 90:
                    raise ValueError('Token validity must be 1 to 90 days')
                issue_token(c, args.user, args.output, args.days)
            else:
                c.execute('UPDATE syncup.tokens SET revoked=true WHERE user_id=%s', (args.user,))
            if args.command in ('init', 'migrate-integration'):
                c.execute(Path(__file__).with_name('team_diagnostics.sql').read_text(encoding='utf-8'))
        print(str(identifier) if args.command in ('user', 'team') else '완료 (인증 값은 출력하지 않습니다.)')
    except (ValueError, OSError, psycopg.Error) as error:
        # 예외 메시지에는 접속 정보가 섞일 수 있어 종류만 알린다
        parser.exit(1, f'설정을 확인하세요 ({type(error).__name__}). 기존 키 파일은 덮어쓰지 않습니다. 실패 후 생성된 키 파일은 유효하지 않을 수 있습니다.\n')


if __name__ == '__main__':
    main()
