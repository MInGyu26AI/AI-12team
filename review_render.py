"""HTML of the private review page and the team board it links to."""
from dataclasses import dataclass, field
import datetime as dt
import json
from pathlib import Path

from ai.syncup_ai.classify import SITE_LABEL
from batch_classification import failed_batches
from card_contract import MAX_TEXT, card_label
from collection_session import bound_team, config, session_state
from html_page import card_html, esc, page
from storage import connect
from team_client import NETWORK_ERRORS, TeamClient
from turn_intake import unresolved_issues

SOURCE_LABELS = SITE_LABEL | {'manual': '직접 입력', 'chatgpt-export': 'ChatGPT 내보내기'}
STATE_LABELS = {'ended': '종료', 'paused': '일시중지', 'collecting': '수집 중'}
CARDS = """SELECT cards.*,jobs.evidence,outbox.state AS delivery_state,outbox.detail AS delivery_detail,
    outbox.attempts,outbox_destinations.team_id AS approved_team
    FROM cards JOIN jobs ON jobs.id=cards.job LEFT JOIN outbox ON outbox.id=cards.id
    LEFT JOIN outbox_destinations ON outbox_destinations.id=cards.id
    ORDER BY cards.rowid DESC"""
LEGACY_FAILED_JOBS = "SELECT * FROM jobs WHERE state LIKE 'failed_%'"
LEGACY_NOTE = ('새 Codex·Claude Code 대화의 발췌를 OpenAI에서 분류하고 초안을 작성합니다. '
               '아래에서 승인한 문구와 근거만 팀 보드에 올라갑니다.')
PIPELINE_NOTE = ('확장 프로그램과 Codex·Claude Code 대화의 발췌를 이 기기의 개인정보 검사를 거친 뒤 설정한 AI로 분류합니다. '
                 '아래에서 승인한 문구와 근거만 팀 보드에 올라갑니다.')
LEGACY_EMPTY = '아직 후보가 없습니다. 선택한 프로젝트에서 새 Codex 또는 Claude Code 대화를 시작하면 완료된 발화를 확인합니다.'
PIPELINE_EMPTY = '아직 후보가 없습니다. 확장 프로그램이나 선택한 프로젝트의 Codex·Claude Code 대화에서 완료된 발화를 확인합니다.'


@dataclass
class TeamChoice:
    """The team picker's state: the user's teams and the bound team, if the team server answered."""
    teams: dict = field(default_factory=dict)
    target: str | None = None
    name: str | None = None


@dataclass
class ReviewView:
    token: str
    retry_token: str
    client: TeamClient | None
    team: TeamChoice


def _team_picker(client, binding, token):
    """(html, TeamChoice) of the team selection; a team server outage shows an alert instead."""
    try:
        profile = client.me()
    except NETWORK_ERRORS:
        return '<p role="alert">팀 연결을 확인할 수 없습니다. 팀 승인은 잠시 차단됩니다.</p>', TeamChoice()
    teams = {t['id']: t['name'] for t in profile['teams']}
    choice = TeamChoice(teams, binding['team_id'], teams.get(binding['team_id']))
    options = '<option value="">공유할 팀 선택</option>' + ''.join(
        f'<option value="{esc(t)}" {"selected" if t == choice.target else ""}>{esc(name)}</option>' for t, name in teams.items())
    html = (f'<p>연결 사용자 · {esc(profile["name"])}</p><form method="post" action="/switch-team">{token}'
            f'<label>새로 승인할 카드의 대상 팀<select name="team_id" required>{options}</select></label>'
            '<button>대상 팀 변경</button></form><p class="note">팀을 바꿔도 이미 승인한 카드의 대상 팀은 바뀌지 않습니다.</p>')
    if not choice.name:
        html += '<p role="alert">공유할 팀을 선택하세요. 권한이 없어진 팀에는 공유할 수 없습니다.</p>'
    return html, choice


def _session_controls(cfg, state, token, pipeline):
    end = dt.datetime.fromtimestamp(cfg["end"]).strftime("%m/%d %H:%M")
    note = PIPELINE_NOTE if pipeline else LEGACY_NOTE
    html = f'<p><strong>{esc(Path(cfg["project"]).name)}</strong> · {end}까지</p><p class="note">{note}</p>'
    if state != "ended":
        action, label = ("resume", "재개") if cfg["paused"] else ("pause", "일시중지")
        html += f'<form method="post" action="/{action}">{token}<button>{label}</button></form>'
    return html


def _issues_html(issues):
    if not issues:
        return ''
    html = f'<p role="alert">자동 처리에서 제외하여 보관한 입력 {len(issues)}개가 있습니다. 원래 입력은 덮어쓰지 않았습니다.</p>'
    return html + ''.join(f'<details><summary>{esc(i["reason"])}</summary><pre>{esc(json.loads(i["message"]))}</pre></details>'
                          for i in issues)


def _source_label(evidence):
    if not evidence:
        return "Codex"
    label = SOURCE_LABELS.get(evidence[0].get("source", "codex"), "Codex")
    return label + " · 추가 답변" if evidence[0].get("continuation_of") else label


def _queued_state(r, view):
    html = f'<p>{esc(r["draft"])}</p><blockquote>{esc(r["quote"])}</blockquote>'
    if r["delivery_state"] != "blocked":
        return html + f'<p role="status">승인 저장됨 · 전송 대기 · 시도 {r["attempts"]}회</p>'
    return html + (f'<p role="alert">전송 확인 필요 · {esc(r["delivery_detail"])}</p><form method="post" action="/retry-delivery">'
                   f'{view.retry_token}<input type="hidden" name="id" value="{esc(r["id"])}">'
                   '<button>승인한 내용 그대로 재시도</button></form>')


def _approve_form(r, evidence, view):
    html = (f'<form method="post" action="/approve">{view.token}<input type="hidden" name="id" value="{esc(r["id"])}">'
            f'<label>팀에 공유할 문구<textarea name="text" maxlength="{MAX_TEXT}" required>{esc(r["draft"] or "")}</textarea></label>')
    if r["status"] == "manual":
        options = "".join(f'<option value="{x["n"]}">{esc(x["role"])} · {esc(x["text"])}</option>' for x in evidence)
        html += f'<label>수동 작성 · 공유할 근거 선택<select name="source" required><option value="">근거 선택</option>{options}</select></label>'
    else:
        speaker = "사용자" if r["role"] == "user" else "AI"
        html += (f'<label>{speaker} 근거 · 공유할 범위<textarea name="quote" maxlength="{MAX_TEXT}" required>'
                 f'{esc(r["quote"])}</textarea></label>')
    if not view.client:
        return html + '<button>이 카드 한 장 승인</button></form>'
    team = view.team
    return html + (f'<input type="hidden" name="target_team" value="{esc(team.target or "")}">'
                   f'<button {"disabled" if not team.name else ""}>{esc(team.name or "팀 선택 필요")} · 이 카드 한 장 승인</button></form>')


def _card_state(r, evidence, view):
    if r["status"] == "drafting":
        excerpts = "".join(f'<blockquote>{esc(x["role"])} · {esc(x["text"])}</blockquote>' for x in evidence)
        return ('<p role="status">Terra가 근거와 초안을 정리하고 있습니다.</p>'
                f'<details><summary>분류에 사용한 발췌</summary>{excerpts}</details>')
    if r["status"] == "shared":
        return f'<p>{esc(r["draft"])}</p><small>공유 완료</small>'
    if r["status"] == "queued":
        return _queued_state(r, view)
    return _approve_form(r, evidence, view)


def _card_article(r, view):
    html = f'<article><h2>{card_label(r["kind"], r["adopted"])}</h2>'
    if r['approved_team']:
        team = view.team.teams.get(r["approved_team"], "접근 불가 또는 이전 팀")
        html += f'<p>승인 대상 · {esc(team)} <small>{esc(r["approved_team"])}</small></p>'
    elif view.client and r['status'] in ('queued', 'shared'):
        html += '<p class="note">이전 로컬 시연 승인 · 팀 서버로 자동 공유하지 않음</p>'
    evidence = json.loads(r["evidence"])
    return html + f'<small>출처 · {_source_label(evidence)}</small>' + _card_state(r, evidence, view) + "</article>"


def render_review_page(server, client, pipeline):
    """The whole review page for one GET."""
    cfg = config(server.db)
    token = f'<input type="hidden" name="csrf" value="{server.csrf}">'
    with connect(server.db) as c:
        binding = c.execute('SELECT * FROM sharing WHERE id=1').fetchone()
    retry_team = binding['team_id'] if binding else ''
    state = session_state(cfg)
    body = (f'<nav><b>싱크업</b><a href="{server.board_url}">팀 보드 열기 ↗</a></nav>'
            f'<header><h1>개인 검토함</h1><span class="state">{STATE_LABELS[state]}</span></header>')
    team = TeamChoice()
    if client:
        picker, team = _team_picker(client, binding, token)
        body += picker
    body += _session_controls(cfg, state, token, pipeline)
    with connect(server.db) as c:
        rows = c.execute(CARDS).fetchall()
        if pipeline:
            errors = failed_batches(c, retry_team)
            body += _issues_html(unresolved_issues(c, retry_team))
        else:
            errors = c.execute(LEGACY_FAILED_JOBS).fetchall()
    if cfg["status"]:
        body += f'<p role="alert">{esc(cfg["status"])}</p>'
    view = ReviewView(token, token + f'<input type="hidden" name="teamId" value="{esc(retry_team)}">', client, team)
    for j in errors:
        body += (f'<form method="post" action="/retry">{view.retry_token}<input type="hidden" name="id" value="{esc(j["id"])}">'
                 f'처리 실패 · {esc(j["detail"])} <button>다시 시도</button></form>')
    if not rows:
        body += f'<article>{PIPELINE_EMPTY if pipeline else LEGACY_EMPTY}</article>'
    body += ''.join(_card_article(r, view) for r in rows)
    return page("개인 검토함", body, True)


def render_team_board(db, client):
    """(status, html) of the bound team's board as the team server returns it."""
    try:
        profile = client.me()
        with connect(db) as c:
            team_id = bound_team(c)
        name = next((t['name'] for t in profile['teams'] if t['id'] == team_id), None)
        if name is None:
            return 403, page('팀 선택 필요', '<a href="/">개인 검토함에서 접근 가능한 팀을 선택하세요.</a>')
        rows = client.items(team_id)
        body = (f'<nav><b>싱크업</b><a href="/">개인 검토함</a></nav><header><h1>{esc(name)} · 팀 보드</h1></header>'
                f'<p>최근 승인 카드 {len(rows)}장</p>' + ''.join(card_html(row['packet']) for row in rows))
        return 200, page('팀 보드', body, True)
    except (*NETWORK_ERRORS, KeyError, TypeError):
        return 503, page('팀 연결 확인', '<p role="alert">팀 권한이나 연결을 확인할 수 없습니다.</p><a href="/">개인 검토함</a>')
