"""Offline administration; never expose these operations through the team API."""
import sys
from pathlib import Path

# 폴더별로 실행해도 contract/ 의 공용 모듈과 저장소 루트의 ai/ 를 찾는다
_REPO = Path(__file__).resolve().parents[1]
sys.path[1:1] = [str(_REPO / 'contract'), str(_REPO)]

import argparse
import hashlib
import os
from pathlib import Path
import re
import secrets
import uuid

import psycopg
from psycopg import sql

TOKEN_DAYS_DEFAULT, TOKEN_DAYS_MAX = 30, 90
API_PASSWORD_MIN_CHARS = 24


class AdminInputError(ValueError):
    """An operator input problem with a fixed message; safe to print."""


def apply_sql(c, name):
    c.execute(Path(__file__).with_name(name).read_text(encoding='utf-8'))


def init(c, password_file):
    password = password_file.read_text(encoding='utf-8').strip()
    if len(password) < API_PASSWORD_MIN_CHARS:
        raise AdminInputError('API DB password too short')
    c.execute(sql.SQL('CREATE ROLE syncup_api LOGIN PASSWORD {} '
                      'NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION').format(sql.Literal(password)))
    apply_sql(c, 'team_schema.sql')
    apply_sql(c, 'team_decisions.sql')
    apply_sql(c, 'team_upgrades.sql')


def migrate_integration(c):
    # team_decisions.sql creates its tables once, so it runs only where they are missing. Every later
    # change goes into team_upgrades.sql, which must stay safe to apply again on any database.
    if not c.execute("SELECT to_regclass('syncup.conflict_checks')").fetchone()[0]:
        apply_sql(c, 'team_decisions.sql')
    apply_sql(c, 'team_upgrades.sql')


def issue_token(c, user_id, path, days):
    """Write the key only after its digest is committed, so a failed issue leaves no key file behind."""
    if not 1 <= days <= TOKEN_DAYS_MAX:
        raise AdminInputError(f'Token validity must be 1 to {TOKEN_DAYS_MAX} days')
    token = secrets.token_urlsafe(32)
    # Exclusive, owner-only creation: never overwrite an existing credential.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            c.execute("""INSERT INTO syncup.tokens(digest,user_id,expires_at)
                VALUES(%s,%s,now() + %s * interval '1 day')""",
                (hashlib.sha256(token.encode()).hexdigest(), user_id, days))
            c.commit()
            f.write(token + '\n')
    except BaseException:
        os.unlink(path)  # only the empty file created above
        raise


def run(c, args):
    """Apply one subcommand; returns the new id for `user` and `team`."""
    if args.command == 'init':
        init(c, args.api_password_file)
    elif args.command == 'migrate-integration':
        migrate_integration(c)
    elif args.command in ('user', 'team'):
        identifier = uuid.uuid4()
        table = 'users' if args.command == 'user' else 'teams'
        c.execute(sql.SQL('INSERT INTO syncup.{}(id,name) VALUES(%s,%s)').format(sql.Identifier(table)),
                  (identifier, args.name))
        return identifier
    elif args.command == 'member':
        c.execute('''INSERT INTO syncup.memberships(team_id,user_id,active) VALUES(%s,%s,%s)
            ON CONFLICT(team_id,user_id) DO UPDATE SET active=excluded.active''',
            (args.team, args.user, not args.revoke))
    elif args.command == 'token':
        issue_token(c, args.user, args.output, args.days)
    elif args.command == 'revoke-tokens':
        if args.user is None and args.via is None:
            raise AdminInputError('--user나 --via를 지정하세요')
        c.execute('''UPDATE syncup.tokens SET revoked=true
            WHERE (%(user)s::uuid IS NULL OR user_id=%(user)s) AND (%(via)s::text IS NULL OR issued_via=%(via)s)''',
            dict(user=args.user, via=args.via))
    elif args.command == 'identity':
        link_identity(c, args)
    return None


# A GitHub login name can change and can be taken over; its numeric user ID cannot (docs/team-server.md).
SUBJECT_FORMS = {'github': (re.compile(r'[1-9][0-9]{0,19}'), 'GitHub는 숫자 ID를 넣으세요: gh api users/<아이디> --jq .id'),
                 'kakao': (re.compile(r'[1-9][0-9]{0,19}'), '카카오는 회원 번호(숫자)를 넣으세요'),
                 'google': (re.compile(r'[0-9]{1,64}'), 'Google은 사용자 ID(숫자)를 넣으세요')}


def link_identity(c, args):
    """Link a login provider's user ID to a SyncUp user, or with --remove unlink it. Unlinking stops new web keys
    only; keys already issued keep working until revoke-tokens."""
    form, hint = SUBJECT_FORMS[args.provider]
    if not form.fullmatch(args.subject):
        raise AdminInputError(hint)
    if args.remove:
        c.execute('DELETE FROM syncup.identities WHERE provider=%s AND subject=%s', (args.provider, args.subject))
        return
    if args.user is None:
        raise AdminInputError('--user를 지정하세요')
    c.execute('''INSERT INTO syncup.identities(provider,subject,user_id,note) VALUES(%s,%s,%s,%s)
        ON CONFLICT(provider,subject) DO UPDATE SET user_id=excluded.user_id, note=excluded.note''',
        (args.provider, args.subject, args.user, args.note))


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('init').add_argument('--api-password-file', type=Path, required=True)
    sub.add_parser('migrate-integration')
    for kind in ('user', 'team'):
        sub.add_parser(kind).add_argument('--name', required=True)
    member = sub.add_parser('member')
    member.add_argument('--team', type=uuid.UUID, required=True)
    member.add_argument('--user', type=uuid.UUID, required=True)
    member.add_argument('--revoke', action='store_true')
    token = sub.add_parser('token')
    token.add_argument('--user', type=uuid.UUID, required=True)
    token.add_argument('--output', type=Path, required=True)
    token.add_argument('--days', type=int, default=TOKEN_DAYS_DEFAULT)
    revoke = sub.add_parser('revoke-tokens')
    revoke.add_argument('--user', type=uuid.UUID)
    revoke.add_argument('--via', choices=('admin', 'web'), help='관리자 발급 키나 웹 발급 키만 (사용자 없이 쓰면 모든 사용자)')
    identity = sub.add_parser('identity')
    identity.add_argument('--provider', choices=tuple(SUBJECT_FORMS), required=True)
    identity.add_argument('--subject', required=True, help='공급자의 사용자 ID (GitHub는 숫자 ID)')
    identity.add_argument('--user', type=uuid.UUID)
    identity.add_argument('--note', default='', help='관리자용 메모 (예: GitHub 아이디)')
    identity.add_argument('--remove', action='store_true')
    return p


def main():
    cli = parser()
    args = cli.parse_args()
    dsn = os.environ.get('SYNCUP_ADMIN_DATABASE_URL')
    if not dsn:
        cli.error('SYNCUP_ADMIN_DATABASE_URL 환경 변수가 필요합니다.')
    try:
        with psycopg.connect(dsn, connect_timeout=5) as c:
            identifier = run(c, args)
        print(identifier or '완료 (인증 값은 출력하지 않습니다.)')
    except AdminInputError as error:
        cli.exit(1, f'설정을 확인하세요: {error}\n')
    except (ValueError, OSError, psycopg.Error) as error:
        # 예외 메시지에는 접속 정보가 섞일 수 있어 종류만 알린다
        key_note = ' 기존 키 파일은 덮어쓰지 않습니다.' if args.command == 'token' else ''
        cli.exit(1, f'설정을 확인하세요 ({type(error).__name__}).{key_note}\n')


if __name__ == '__main__':
    main()
