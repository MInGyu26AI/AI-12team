"""One local owner for collection, private candidates and the existing durable approval outbox."""
from datetime import datetime, timezone
import hashlib
import json
import math
import threading
import time
from urllib.parse import quote

from ai.syncup_ai.batch import take_ready_batches, group_turns, context_tail
from ai.syncup_ai.classify import handle_request as classify
from ai.syncup_ai.config import load_env
from ai.syncup_ai.llm import from_env, decider_from_env
from ai.syncup_ai.mask import mask, has_mask_token
from ai.syncup_ai.evidence import render_evidence, locate_evidence
from card_contract import PUBLIC_FIELDS, validate_card
from collector import active, config
from delivery import approve, deliver
from diagnostics import failure
from integration_store import initialize_integration
import local_privacy
from local_privacy import ALLOW, EXCLUDE, HOLD, OutboundGuard
from storage import connect
from team_client import bind_sharing


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def clean_message(message):
    if not isinstance(message, dict):
        raise ValueError('발화 형식 오류')
    for key in ('id','text','conversationId','site','role','collectedAt'):
        if not isinstance(message.get(key), str) or not message[key].strip() or len(message[key]) > (20000 if key == 'text' else 1200):
            raise ValueError('발화 필드 오류')
    if message['role'] not in ('user','assistant') or message['site'] not in ('chatgpt','manual','chatgpt-export'):
        raise ValueError('허용되지 않은 발화 출처입니다.')
    if datetime.fromisoformat(message['collectedAt'].replace('Z','+00:00')).tzinfo is None:
        raise ValueError('발화 시각에 시간대가 필요합니다.')
    if type(message.get('roleGuessed',False)) is not bool:
        raise ValueError('화자 상태 오류')
    return {k:message[k] for k in ('id','text','conversationId','site','role','collectedAt')} | {'roleGuessed':message.get('roleGuessed',False)}


class Pipeline:
    def __init__(self, db, client, profile=None):
        self.db, self.client = db, client
        self.lock = threading.RLock()
        self.process_lock = threading.Lock()
        self.llm_factory = from_env
        self.decider_factory = decider_from_env
        initialize_integration(db)
        if profile is not None:
            with connect(db) as c:
                options = json.loads(c.execute('SELECT config FROM integration_settings').fetchone()[0])
                options['profile'] = profile
                c.execute('UPDATE integration_settings SET config=?', (json.dumps(options),))
        load_env()
        # Every external AI request passes this on-device gate first; tests replace the classifier.
        self.privacy = local_privacy.Gate(local_privacy.classifier_from_env())

    def local_profile(self, c):
        options = json.loads(c.execute('SELECT config FROM integration_settings').fetchone()[0])
        binding = c.execute('SELECT * FROM sharing').fetchone()
        # Cached names are display/classification context only; sharing always reauthenticates.
        return options.get('profile') or dict(user_id=binding['user_id'], name=binding['user_id'],
            teams=[dict(id=binding['team_id'], name=binding['team_id'])])

    def require_active(self, team=None, start=None):
        with connect(self.db) as c:
            s = c.execute('SELECT * FROM settings').fetchone()
            binding = c.execute('SELECT * FROM sharing').fetchone()
            if not active(s):
                raise ValueError('수집이 일시중지되었거나 종료되었습니다.')
            if not binding or not binding['team_id'] or (team and binding['team_id'] != team) or (start is not None and start != s['start']):
                raise ValueError('수집 세션이나 대상 팀이 변경되었습니다.')
            return dict(s), dict(binding)

    def context(self, c, team_id, profile):
        s = c.execute('SELECT * FROM settings').fetchone()
        options = json.loads(c.execute('SELECT config FROM integration_settings').fetchone()[0])
        team = next((t for t in profile['teams'] if t['id'] == team_id), None)
        if not team:
            raise ValueError('현재 팀의 구성원이 아닙니다.')
        keys = [json.loads(r[0]).get('topic_key') for r in c.execute('SELECT body FROM candidate_details WHERE team_id=?', (team_id,))]
        return dict(teamName=team['name'], userName=profile['name'], projectTopic=options['projectTopic'],
                    enabledSubtopics=options['enabledSubtopics'], existingTopicKeys=list(set(k for k in keys if k)),
                    collectionStart=s['start'])

    def quarantine(self, c, message, team_id, start, reason):
        saved = mask(json.dumps(message, ensure_ascii=False))[0]
        identifier = digest([team_id, start, reason, saved])
        c.execute('INSERT OR IGNORE INTO intake_issues VALUES(?,?,?,?,?)',
                  (identifier, team_id, reason, json.dumps(saved), time.time()))
        return dict(id=identifier, reason=reason,
                    messageId=message.get('id') if isinstance(message,dict) and isinstance(message.get('id'),str) else None)

    def insert_messages(self, c, messages, team_id, start, issues=None):
        count = 0
        for m in messages:
            identifier = digest([team_id, start, m['site'], m['conversationId'], m['id']])
            m = dict(m, session=start)
            m['text'], m['masked'] = mask(m['text'])
            existing = c.execute('SELECT message FROM intake WHERE id=?', (identifier,)).fetchone()
            if existing:
                previous = json.loads(existing[0])
                # Text cleared by retention: the message was already processed, so a re-send is not a change.
                if previous.get('purged'):
                    continue
                if any(previous[k] != m[k] for k in ('text','role','roleGuessed')):
                    issue = self.quarantine(c,m,team_id,start,'message_changed')
                    if issues is not None:
                        issues.append(issue)
                continue
            c.execute('INSERT INTO intake VALUES(?,?,?,?,NULL,?)',
                      (identifier,team_id,m['site']+':'+m['conversationId'],json.dumps(m,ensure_ascii=False),time.time()))
            count += 1
        return count

    def batches(self, c, team_id, context, flush=False):
        options = json.loads(c.execute('SELECT config FROM integration_settings').fetchone()[0])
        rows = c.execute('''SELECT rowid,* FROM intake WHERE team_id=? AND job IS NULL
                            AND json_extract(message,'$.session')=? ORDER BY rowid''', (team_id,context['collectionStart'])).fetchall()
        groups = {}
        for r in rows:
            groups.setdefault(r['conversation'], []).append(dict(json.loads(r['message']), intakeId=r['id']))
        for messages in groups.values():
            ready, _ = take_ready_batches(messages, options['turnsPerBatch'], flush)
            for batch in ready:
                self.queue_batch(c,batch,team_id,dict(context,trigger='flush' if flush else 'auto'))

    def queue_batch(self, c, batch, team_id, context):
        identifier = 'batch-' + digest([m['intakeId'] for m in batch])
        evidence = [dict(n=i,role=m['role'],text=m['text'],source=m['site']) for i,m in enumerate(batch,1)]
        c.execute("INSERT INTO jobs VALUES(?,?,'new','')", (identifier,json.dumps(evidence,ensure_ascii=False)))
        c.execute('INSERT INTO job_context VALUES(?,?,?,?)', (identifier,team_id,json.dumps(context,ensure_ascii=False),json.dumps(batch,ensure_ascii=False)))
        c.executemany('UPDATE intake SET job=? WHERE id=?', [(identifier,m['intakeId']) for m in batch])

    def append(self, messages, flush=False):
        if not isinstance(messages, list) or not 0 < len(messages) <= 200:
            raise ValueError('발화는 한 번에 1~200개를 보내세요.')
        clean, rejected = [], []
        for m in messages:
            try:
                clean.append(clean_message(m))
            except ValueError:
                rejected.append(m)
        with self.lock, connect(self.db) as c:
            c.execute('BEGIN IMMEDIATE')
            s, binding = self.require_active()
            ctx = self.context(c,binding['team_id'],self.local_profile(c))
            issues = [self.quarantine(c,m,binding['team_id'],s['start'],'invalid_message') for m in rejected]
            count = self.insert_messages(c,clean,binding['team_id'],s['start'],issues)
            self.batches(c,binding['team_id'],ctx,flush)
        return dict(newMessages=count, queued=bool(clean), intakeIssues=issues)

    def resolve_intake(self, params, action):
        if not isinstance(params.get('id'),str) or not isinstance(params.get('teamId'),str):
            raise ValueError('입력과 대상 팀을 확인하세요.')
        with self.lock, connect(self.db) as c:
            c.execute('BEGIN IMMEDIATE')
            binding = c.execute('SELECT * FROM sharing').fetchone()
            issue = c.execute('SELECT id FROM intake_issues WHERE id=? AND team_id=?',
                              (params['id'],binding['team_id'])).fetchone()
            if not issue or params['teamId'] != binding['team_id']:
                raise ValueError('현재 팀의 입력이 아닙니다.')
            previous = c.execute('SELECT action,replacement_id FROM intake_resolutions WHERE issue_id=?',(params['id'],)).fetchone()
            if previous:
                if previous['action'] != action:
                    raise ValueError('이미 다른 방식으로 처리한 입력입니다.')
                return dict(ok=True,alreadyResolved=True,replacementId=previous['replacement_id'])
            replacement = None
            if action == 'retry':
                s,_ = self.require_active(binding['team_id'])
                message = clean_message(params.get('message'))
                # Corrections are new private input, never an edit of collected evidence.
                message.update(id='intake-retry-'+params['id'],site='manual')
                ctx = self.context(c,binding['team_id'],self.local_profile(c))
                if self.insert_messages(c,[message],binding['team_id'],s['start']) != 1:
                    raise ValueError('복구 입력이 이미 존재합니다.')
                intake_id = digest([binding['team_id'],s['start'],message['site'],message['conversationId'],message['id']])
                saved = json.loads(c.execute('SELECT message FROM intake WHERE id=?',(intake_id,)).fetchone()[0])
                self.queue_batch(c,[dict(saved,intakeId=intake_id)],binding['team_id'],dict(ctx,trigger='manual'))
                replacement = message['id']
            c.execute('INSERT INTO intake_resolutions VALUES(?,?,?,?)',
                      (params['id'],action,replacement,time.time()))
        return dict(ok=True,alreadyResolved=False,replacementId=replacement)

    def capture_local_jobs(self):
        with self.lock, connect(self.db) as c:
            c.execute('BEGIN IMMEDIATE')
            s, binding = self.require_active()
            ctx = self.context(c,binding['team_id'],self.local_profile(c))
            jobs = c.execute("SELECT * FROM jobs WHERE state='new' AND id NOT LIKE 'batch-%' AND id NOT IN (SELECT job FROM job_context)").fetchall()
            for job in jobs:
                messages=[]
                for e in json.loads(job['evidence']):
                    stamp = e.get('at',e.get('timestamp',time.time()))
                    messages.append(dict(id=job['id']+':'+str(e['n']),site=e.get('source','codex'),role=e['role'],
                        roleGuessed=False,text=e['text'],conversationId=e.get('conversationId',e.get('session_id',job['id'])),
                        collectedAt=datetime.fromtimestamp(stamp,timezone.utc).isoformat(),turnId=e.get('turnId',job['id']),complete=True))
                self.insert_messages(c,messages,binding['team_id'],s['start'])
                c.execute("UPDATE jobs SET state='done',detail='통합 분류 대기함에 저장됨' WHERE id=?", (job['id'],))
            self.batches(c,binding['team_id'],ctx)

    def process(self):
        if not self.process_lock.acquire(blocking=False):
            return
        try:
            with connect(self.db) as c:
                jobs = c.execute("SELECT j.id,x.team_id,x.context,x.messages FROM jobs j JOIN job_context x ON x.job=j.id WHERE j.state='new' ORDER BY j.rowid").fetchall()
            for job in jobs:
                ctx = json.loads(job['context'])
                try:
                    self.require_active(job['team_id'],ctx['collectionStart'])
                except ValueError:
                    continue
                with connect(self.db) as c:
                    if self.privacy.waiting(c, job['id']):
                        continue
                try:
                    messages = json.loads(job['messages'])
                    with connect(self.db) as c:
                        previous = c.execute('''SELECT x.messages FROM job_context x JOIN jobs j ON j.id=x.job
                            WHERE x.team_id=? AND j.rowid<(SELECT rowid FROM jobs WHERE id=?)
                            AND json_extract(x.context,'$.collectionStart')=?
                            AND json_extract(x.messages,'$[0].conversationId')=?
                            AND json_extract(x.messages,'$[0].site')=? ORDER BY j.rowid DESC LIMIT 1''',
                            (job['team_id'],job['id'],ctx['collectionStart'],messages[0]['conversationId'],messages[0]['site'])).fetchone()
                    # Batch, earlier context and metadata all pass the on-device gate before any AI client exists.
                    review = self.privacy.review_job(self.db, job['id'], messages,
                                                     context_tail(json.loads(previous[0])) if previous else [], ctx)
                    if review.decision == HOLD:
                        continue
                    if review.decision == EXCLUDE:
                        with connect(self.db) as c:
                            c.execute('BEGIN IMMEDIATE')
                            self.require_active(job['team_id'],ctx['collectionStart'])
                            c.execute("UPDATE jobs SET state='done',detail='개인 내용 · 로컬에서 제외, 외부 전송 없음' WHERE id=? AND state='new'", (job['id'],))
                        continue
                    llm, decider = self.llm_factory(), self.decider_factory()
                    guard = lambda: self.require_active(job['team_id'],ctx['collectionStart'])
                    llm.before_request = guard
                    if decider:
                        decider.before_request = guard
                    llm = OutboundGuard(llm, review.fragments)
                    decider = OutboundGuard(decider, review.fragments) if decider else None
                    result = classify(dict(context=review.context,messages=review.messages,contextMessages=review.context_messages),llm,decider)
                    blocked = llm.blocked or (decider.blocked if decider else None)
                    if blocked:
                        self.privacy.record(self.db, job['id'], HOLD, blocked, review.model, review.detail)
                        continue
                    if not result['ok']:
                        raise ValueError(result['error'])
                    self.require_active(job['team_id'],ctx['collectionStart'])
                    with connect(self.db) as c:
                        c.execute('BEGIN IMMEDIATE')
                        self.require_active(job['team_id'],ctx['collectionStart'])
                        for index, card in enumerate(result['cards']):
                            if card['relevance'] != 'related' or card['tag'] == 'none':
                                continue
                            validate_card({k:card[k] for k in PUBLIC_FIELDS})
                            identifier = digest([job['id'],index])
                            kind = 'task' if card['tag']=='todo' else card['tag']
                            c.execute("INSERT INTO cards VALUES(?,?,?,?,?,?,?,'ready') ON CONFLICT(id) DO NOTHING",
                                      (identifier,job['id'],kind,1,card['content'],card['sentence'],card['evidence']['role']))
                            c.execute('INSERT INTO candidate_details VALUES(?,?,?,0) ON CONFLICT(id) DO NOTHING',
                                      (identifier,job['team_id'],json.dumps(card,ensure_ascii=False)))
                        c.execute("UPDATE jobs SET state='done',detail='' WHERE id=?", (job['id'],))
                except Exception as error:
                    failure('classification', error, job['id'])
                    try:
                        self.require_active(job['team_id'],ctx['collectionStart'])
                    except ValueError:
                        continue
                    with connect(self.db) as c:
                        c.execute("UPDATE jobs SET state='failed_new',detail=? WHERE id=?",
                                  ('분류 실패 · '+type(error).__name__+' · 원문 보존, 재시도 가능',job['id']))
        finally:
            self.process_lock.release()

    def status(self):
        with connect(self.db) as c:
            profile = self.local_profile(c)
            s = dict(c.execute('SELECT * FROM settings').fetchone())
            binding = dict(c.execute('SELECT * FROM sharing').fetchone())
            options = json.loads(c.execute('SELECT config FROM integration_settings').fetchone()[0])
            buffered = {}
            for row in c.execute("SELECT conversation,message FROM intake WHERE team_id=? AND job IS NULL AND json_extract(message,'$.session')=? ORDER BY rowid",(binding['team_id'],s['start'])):
                buffered.setdefault(row['conversation'],[]).append(json.loads(row['message']))
            last_collected = c.execute("SELECT MAX(received) FROM intake WHERE team_id=? AND json_extract(message,'$.session')=?",(binding['team_id'],s['start'])).fetchone()[0]
            failures = [dict(r) for r in c.execute("SELECT j.id,j.detail FROM jobs j JOIN job_context x ON x.job=j.id WHERE x.team_id=? AND j.state='failed_new'", (binding['team_id'],))]
            held_sql = "SELECT p.job FROM privacy_jobs p WHERE p.decision='hold'"
            pending_jobs = c.execute(f"SELECT count(*) FROM jobs j JOIN job_context x ON x.job=j.id WHERE x.team_id=? AND j.state='new' AND json_extract(x.context,'$.collectionStart')=? AND j.id NOT IN ({held_sql})",(binding['team_id'],s['start'])).fetchone()[0]
            privacy_held = c.execute(f"SELECT count(*) FROM jobs j JOIN job_context x ON x.job=j.id WHERE x.team_id=? AND j.state='new' AND j.id IN ({held_sql})",(binding['team_id'],)).fetchone()[0]
            privacy_excluded = c.execute("SELECT count(*) FROM privacy_jobs p JOIN job_context x ON x.job=p.job WHERE x.team_id=? AND p.decision='exclude'",(binding['team_id'],)).fetchone()[0]
            counts = dict(reviewPending=0,deliveryPending=0,deliveryBlocked=0)
            for row in c.execute('''SELECT c.status,o.state,count(*) AS n FROM candidate_details d JOIN cards c ON c.id=d.id
                LEFT JOIN outbox o ON o.id=c.id WHERE d.team_id=? AND NOT d.dismissed GROUP BY c.status,o.state''',(binding['team_id'],)):
                key = 'reviewPending' if row['status']=='ready' else 'deliveryPending' if row['state']=='pending' else 'deliveryBlocked' if row['state']=='blocked' else None
                if key: counts[key] += row['n']
            issues = [dict(r) for r in c.execute('''SELECT id,reason,received FROM intake_issues WHERE team_id=?
                AND id NOT IN (SELECT issue_id FROM intake_resolutions) ORDER BY received''',(binding['team_id'],))]
            legacy = c.execute("SELECT count(*) FROM cards WHERE status IN ('manual','ready') AND id NOT IN (SELECT id FROM candidate_details)").fetchone()[0]
            team = next((t for t in profile['teams'] if t['id']==binding['team_id']),None)
            recent=[]
            for row in c.execute("""SELECT x.job,x.context,x.messages,MAX(i.received) AS received FROM job_context x
                JOIN jobs j ON j.id=x.job JOIN intake i ON i.job=x.job
                WHERE x.team_id=? AND j.state='done' GROUP BY x.job ORDER BY received DESC LIMIT 20""",(binding['team_id'],)):
                messages=json.loads(row['messages'])
                recent.append(dict(id=row['job'],at=datetime.fromtimestamp(row['received'],timezone.utc).isoformat(),
                    site=messages[0]['site'],turns=len(group_turns(messages)),trigger=json.loads(row['context']).get('trigger','auto'),
                    cardIds=[r[0] for r in c.execute('SELECT id FROM cards WHERE job=?',(row['job'],))]))
            return dict(version='1',configured=bool(team),autoCollect=active(s),state='ended' if time.time()>=s['end'] else 'paused' if s['paused'] else 'collecting',
                turnsPerBatch=options['turnsPerBatch'],bufferedTurns=sum(len(group_turns(messages)) for messages in buffered.values()),endsAt=datetime.fromtimestamp(s['end'],timezone.utc).isoformat(),lastCollectedAt=datetime.fromtimestamp(last_collected,timezone.utc).isoformat() if last_collected is not None else None,
                teamId=binding['team_id'],teamName=team['name'] if team else '접근 불가',userName=profile['name'],teams=profile['teams'],
                projectTopic=options['projectTopic'],project=s['project'],failedJobs=failures,legacyCandidates=legacy,lastClassifier='native' if recent else None,recent=recent,
                profileStatus='cached',intakeIssues=issues,
                privacy=dict(policy=local_privacy.POLICY_VERSION,model=self.privacy.last_state['model'],
                             available=self.privacy.last_state['available'],reason=self.privacy.last_state['reason']),
                counts=dict(counts,classificationPending=pending_jobs,classificationFailed=len(failures),intakeIssues=len(issues),
                            privacyHeld=privacy_held,privacyExcluded=privacy_excluded))

    def candidates(self):
        with connect(self.db) as c:
            binding=c.execute('SELECT * FROM sharing').fetchone()
            rows=c.execute('''SELECT d.body,c.id,c.status,o.state AS delivery,o.detail,o.attempts,o.next_attempt FROM candidate_details d JOIN cards c ON c.id=d.id
                LEFT JOIN outbox o ON o.id=c.id WHERE d.team_id=? AND NOT d.dismissed AND c.status!='shared' ORDER BY c.rowid''', (binding['team_id'],)).fetchall()
        return [dict(json.loads(r['body']),id=r['id'],status='candidate',deliveryState=r['delivery'],
                     reviewState='review' if r['status']=='ready' else 'delivery',deliveryDetail=r['detail'],
                     deliveryAttempts=r['attempts'],nextDeliveryAttemptAt=r['next_attempt']) for r in rows]

    def update(self, identifier, patch):
        if not isinstance(patch,dict) or set(patch)-{'content','sentence','owner','due','reason','topic_key','subtopic','confirmedRole'}:
            raise ValueError('수정 필드 오류')
        with self.lock, connect(self.db) as c:
            c.execute('BEGIN IMMEDIATE')
            row=c.execute('''SELECT d.*,c.job,c.status FROM candidate_details d JOIN cards c ON c.id=d.id
                JOIN sharing s ON s.team_id=d.team_id WHERE d.id=? AND NOT d.dismissed''', (identifier,)).fetchone()
            if not row or row['status']!='ready':
                raise ValueError('수정 가능한 후보가 아닙니다.')
            card=json.loads(row['body'])
            card.update({k:mask(v)[0] if isinstance(v,str) else v for k,v in patch.items() if k!='confirmedRole'})
            messages=json.loads(c.execute('SELECT messages FROM job_context WHERE job=?',(row['job'],)).fetchone()[0])
            source=next((m for m in messages if m['id']==card['evidence']['messageId']),None)
            if not source or not isinstance(card['sentence'],str) or not card['sentence'].strip():
                raise ValueError('입력 발화에 있는 근거를 선택하세요.')
            # 근거 좌표는 외부 AI가 실제로 본 로컬 보호 정리본을 기준으로 검증한다.
            source_text = self.sanitized_text(c,row['job'],card['evidence']['messageId']) or mask(source['text'])[0]
            if card['sentence'] in source_text:
                card['evidence'].update(locate_evidence(card['sentence'], source_text, {}))
            elif render_evidence(source_text, card['evidence']) != card['sentence']:
                raise ValueError('입력 발화에 있는 근거를 선택하세요.')
            if 'confirmedRole' in patch:
                if patch['confirmedRole'] not in ('user','assistant'):
                    raise ValueError('화자를 확인하세요.')
                card['evidence'].update(role=patch['confirmedRole'],roleGuessed=False)
            if card['tag'] in ('decision','todo') and card['evidence']['role']=='assistant':
                raise ValueError('AI 제안은 결정·할 일로 승인할 수 없습니다. 후보를 제외하세요.')
            card['evidence']['quote']=card['sentence']
            card['masked'] = card['masked'] or any(has_mask_token(v) for k,v in card.items() if k in PUBLIC_FIELDS and isinstance(v,str))
            validate_card({k:card[k] for k in PUBLIC_FIELDS})
            c.execute('UPDATE candidate_details SET body=? WHERE id=?',(json.dumps(card,ensure_ascii=False),identifier))
            c.execute('UPDATE cards SET draft=?,quote=?,role=? WHERE id=?',(card['content'],card['sentence'],card['evidence']['role'],identifier))
        return dict(ok=True)

    def sanitized_text(self, c, job, message_id):
        row = c.execute("SELECT detail FROM privacy_jobs WHERE job=? AND decision='allow'", (job,)).fetchone()
        item = next((d for d in json.loads(row[0]) if d['id']==message_id), None) if row else None
        return item['sanitized'] if item and isinstance(item.get('sanitized'),str) else ''

    def privacy_items(self):
        """Held batches for local review. Text is shown with format rules applied and never leaves the device."""
        with connect(self.db) as c:
            rows = c.execute('''SELECT p.job,p.reason,p.decided,p.detail,x.messages FROM privacy_jobs p
                JOIN job_context x ON x.job=p.job JOIN jobs j ON j.id=p.job
                WHERE x.team_id=(SELECT team_id FROM sharing) AND j.state='new' AND p.decision='hold' ORDER BY j.rowid''').fetchall()
        items = []
        for row in rows:
            decided = {d['id']: d for d in json.loads(row['detail'])}
            items.append(dict(id=row['job'], reason=row['reason'], decidedAt=row['decided'], messages=[
                dict(id=m['id'], role=m['role'], text=local_privacy.apply_rules(m['text'])[0],
                     decision=decided.get(m['id'],{}).get('decision'), reason=decided.get(m['id'],{}).get('reason'),
                     categories=decided.get(m['id'],{}).get('categories',[]))
                for m in json.loads(row['messages'])]))
        return items

    def privacy_list(self, limit=200):
        """Held batches (unchanged `items`) plus every message the gate or the user excluded, for the current team only.

        Excluded entries are per message, including the excluded part of a batch that was otherwise allowed.
        mixed_redacted messages are allowed, so they are not listed. Previews use format rules only and stay local.
        """
        with connect(self.db) as c:
            team = c.execute('SELECT team_id FROM sharing').fetchone()[0]
            rows = c.execute('''SELECT p.job,p.decided,p.detail,x.messages FROM privacy_jobs p JOIN job_context x ON x.job=p.job
                WHERE x.team_id=? ORDER BY p.decided DESC, p.job''', (team,)).fetchall()
        excluded = []
        for row in rows:
            messages = {m['id']: m for m in json.loads(row['messages'])}
            for d in json.loads(row['detail']):
                if d.get('decision') != EXCLUDE:
                    continue
                m = messages.get(d['id'], {})
                excluded.append(dict(jobId=row['job'], messageId=d['id'], reason=d.get('reason'), decidedAt=row['decided'],
                                     role=m.get('role'), site=m.get('site'), collectedAt=m.get('collectedAt'),
                                     text=local_privacy.apply_rules(str(m.get('text', '')))[0]))
        return dict(teamId=team, items=self.privacy_items(), excluded=excluded[:limit], excludedCount=len(excluded))

    def privacy_action(self, method, params):
        if not isinstance(params.get('id'),str) or not isinstance(params.get('teamId'),str):
            raise ValueError('보류된 작업과 대상 팀을 확인하세요.')
        if 'messageId' in params and not isinstance(params['messageId'],str):
            raise ValueError('제외할 발화를 확인하세요.')
        with self.lock, connect(self.db) as c:
            c.execute('BEGIN IMMEDIATE')
            binding = c.execute('SELECT * FROM sharing').fetchone()
            row = c.execute('''SELECT p.detail,x.messages FROM privacy_jobs p JOIN job_context x ON x.job=p.job JOIN jobs j ON j.id=p.job
                WHERE p.job=? AND x.team_id=? AND j.state='new' AND p.decision='hold' ''',(params['id'],binding['team_id'])).fetchone()
            if not row or params['teamId'] != binding['team_id']:
                raise ValueError('현재 팀에 보류된 작업이 아닙니다.')
            detail = json.loads(row['detail'])
            if method == 'privacy.exclude':
                targets = [params['messageId']] if 'messageId' in params else [d['id'] for d in detail if d['decision'] != ALLOW]
                if not targets or any(t not in {d['id'] for d in detail} for t in targets):
                    raise ValueError('제외할 발화를 확인하세요.')
                c.executemany('INSERT OR IGNORE INTO privacy_overrides VALUES(?,?,?,?)',
                              [(params['id'],t,'exclude',time.time()) for t in targets])
            else:
                self.privacy.forget_holds(c, json.loads(row['messages']))
            # Still held (nothing is sent from here) until the next run writes a new decision; the screen shows it as pending.
            c.execute('UPDATE privacy_jobs SET reason=?,decided=? WHERE job=?',
                      ('exclude_requested' if method == 'privacy.exclude' else 'recheck_requested', time.time(), params['id']))
        return dict(queued=True)

    def configure(self, patch):
        if not isinstance(patch,dict) or set(patch)-{'teamId','projectTopic','enabledSubtopics','turnsPerBatch','endsAt','autoCollect'}:
            raise ValueError('수집 설정 필드 오류')
        from ai.syncup_ai.schema import SUBTOPICS
        profile = self.client.me() if 'teamId' in patch else None
        with self.lock, connect(self.db) as c:
            c.execute('BEGIN IMMEDIATE')
            options=json.loads(c.execute('SELECT config FROM integration_settings').fetchone()[0])
            s=dict(c.execute('SELECT * FROM settings').fetchone())
            if 'teamId' in patch:
                bind_sharing(c,self.client,patch['teamId'],profile)
                options['profile'] = profile
            if 'projectTopic' in patch:
                if not isinstance(patch['projectTopic'],str) or len(patch['projectTopic'])>1200: raise ValueError('프로젝트 주제 오류')
                options['projectTopic']=patch['projectTopic']
            if 'turnsPerBatch' in patch:
                if type(patch['turnsPerBatch']) is not int or not 1<=patch['turnsPerBatch']<=50: raise ValueError('묶음 크기 오류')
                options['turnsPerBatch']=patch['turnsPerBatch']
            if 'enabledSubtopics' in patch:
                if not isinstance(patch['enabledSubtopics'],list) or any(k not in SUBTOPICS for k in patch['enabledSubtopics']): raise ValueError('소주제 오류')
                options['enabledSubtopics']=patch['enabledSubtopics']
            if 'endsAt' in patch:
                end=datetime.fromisoformat(str(patch['endsAt']).replace('Z','+00:00')).timestamp()
                if not math.isfinite(end) or not time.time()<end<=time.time()+86400: raise ValueError('종료는 현재부터 24시간 이내로 설정하세요.')
                if s['end'] <= time.time():
                    c.execute('INSERT INTO pauses(start,end) VALUES(?,?)',(s['end'],time.time()))
                c.execute('UPDATE settings SET end=?',(end,))
            if 'autoCollect' in patch:
                if type(patch['autoCollect']) is not bool: raise ValueError('수집 상태 오류')
                paused=not patch['autoCollect']
                if paused and not s['paused']:
                    c.execute('INSERT INTO pauses(start) VALUES(?)',(time.time(),))
                if not paused:
                    end=c.execute('SELECT end FROM settings').fetchone()[0]
                    if end<=time.time(): raise ValueError('수집 종료 시각을 먼저 갱신하세요.')
                    c.execute('UPDATE pauses SET end=? WHERE end IS NULL',(time.time(),))
                c.execute('UPDATE settings SET paused=?',(int(paused),))
            c.execute('UPDATE integration_settings SET config=?',(json.dumps(options,ensure_ascii=False),))
        return self.status()

    def rpc(self, method, params):
        if not isinstance(params,dict): raise ValueError('요청 형식 오류')
        if method in ('jobs.retry','delivery.retry'):
            if not isinstance(params.get('id'),str) or not params['id']:
                raise ValueError('재시도할 항목을 확인하세요.')
            if 'teamId' in params and (not isinstance(params['teamId'],str) or not params['teamId']):
                raise ValueError('대상 팀을 확인하세요.')
        if method=='collection.status': return self.status()
        if method=='collection.configure': return self.configure(params)
        if method=='collection.pause': return self.configure(dict(autoCollect=False))
        if method=='turns.append': return self.append(params.get('messages'),params.get('flush') is True)
        if method=='collection.flush':
            with self.lock,connect(self.db) as c:
                c.execute('BEGIN IMMEDIATE')
                _,binding=self.require_active()
                self.batches(c,binding['team_id'],self.context(c,binding['team_id'],self.local_profile(c)),True)
            return dict(queued=True)
        if method=='intake.issues':
            with connect(self.db) as c:
                return dict(items=[dict(r) for r in c.execute('''SELECT * FROM intake_issues WHERE team_id=(SELECT team_id FROM sharing)
                    AND id NOT IN (SELECT issue_id FROM intake_resolutions) ORDER BY received''')])
        if method=='intake.retry': return self.resolve_intake(params,'retry')
        if method=='intake.dismiss': return self.resolve_intake(params,'dismiss')
        if method=='privacy.list': return self.privacy_list()
        if method in ('privacy.exclude','privacy.recheck'): return self.privacy_action(method,params)
        if method=='candidates.list': return dict(cards=self.candidates(),status=self.status())
        if method=='candidates.update': return self.update(params.get('id'),params.get('patch'))
        if method=='candidates.dismiss':
            with connect(self.db) as c:
                c.execute('''UPDATE candidate_details SET dismissed=1 WHERE id=? AND team_id=(SELECT team_id FROM sharing)
                    AND id IN (SELECT id FROM cards WHERE status='ready')''',(params.get('id'),))
            return dict(ok=True)
        if method=='jobs.retry':
            with self.lock, connect(self.db) as c:
                c.execute('BEGIN IMMEDIATE')
                s,binding=self.require_active(params.get('teamId'))
                row=c.execute("SELECT x.context FROM job_context x JOIN jobs j ON j.id=x.job WHERE x.job=? AND x.team_id=? AND j.state='failed_new'",(params.get('id'),binding['team_id'])).fetchone()
                if not row: raise ValueError('재시도할 작업이 없습니다.')
                ctx=json.loads(row[0]);ctx['collectionStart']=s['start']
                c.execute('UPDATE job_context SET context=? WHERE job=?',(json.dumps(ctx),params['id']))
                c.execute("UPDATE jobs SET state='new',detail='' WHERE id=? AND state='failed_new'",(params['id'],))
            return dict(queued=True)
        if method=='delivery.retry':
            with self.lock, connect(self.db) as c:
                c.execute('BEGIN IMMEDIATE')
                if 'teamId' in params and params['teamId'] != c.execute('SELECT team_id FROM sharing').fetchone()[0]:
                    raise ValueError('대상 팀이 변경되었습니다.')
                updated = c.execute("""UPDATE outbox SET state='pending',attempts=0,next_attempt=0,detail='' WHERE id=? AND state='blocked'
                    AND id IN (SELECT d.id FROM outbox_destinations d JOIN sharing s ON s.team_id=d.team_id AND s.user_id=d.user_id AND s.api_url=d.api_url)""",(params.get('id'),))
                if updated.rowcount != 1: raise ValueError('현재 팀에 재시도할 전송이 없습니다.')
            return dict(queued=True)
        if method=='candidates.approve':
            identifiers=params.get('ids')
            if not isinstance(identifiers,list) or not 1<=len(identifiers)<=100 or any(not isinstance(i,str) for i in identifiers): raise ValueError('승인 후보를 확인하세요.')
            profile=self.client.me()
            with self.lock,connect(self.db) as c:
                c.execute('BEGIN IMMEDIATE')
                binding=dict(c.execute('SELECT * FROM sharing').fetchone())
                if params.get('teamId')!=binding['team_id'] or binding['team_id'] not in {t['id'] for t in profile['teams']}:
                    raise ValueError('대상 팀이 변경되었습니다. 다시 확인하세요.')
                for identifier in identifiers:
                    row=c.execute('SELECT c.* FROM cards c JOIN candidate_details d ON d.id=c.id WHERE c.id=? AND d.team_id=? AND NOT d.dismissed',(identifier,binding['team_id'])).fetchone()
                    if not row: raise ValueError('승인 가능한 후보가 없습니다.')
                    approve(c,dict(id=identifier,text=row['draft'],quote=row['quote']).__getitem__,binding)
            return dict(items=[dict(clientItemId=i,status='queued') for i in identifiers])
        if method.startswith('team.'):
            with connect(self.db) as c: binding=dict(c.execute('SELECT * FROM sharing').fetchone())
            path={'team.board':'board','team.history':'history','team.conflicts':'conflicts','team.conflictHistory':'conflicts/history','team.done':'todos/done'}.get(method)
            data=None
            if method=='team.resolve': path='conflicts/'+quote(str(params.get('id')),safe='')+'/resolve';data=dict(resolution=params.get('resolution'),resolutionNote=params.get('resolutionNote',''))
            if method=='team.setDone': path='items/'+quote(str(params.get('id')),safe='')+'/done';data=dict(done=params.get('done'))
            if method=='team.retryCheck': path='items/'+quote(str(params.get('id')),safe='')+'/retry-check';data={}
            if not path: raise ValueError('지원하지 않는 팀 요청입니다.')
            result=self.client.request('teams/'+binding['team_id']+'/'+path,data)
            if result.get('team_id')!=binding['team_id']: raise ValueError('대상 팀 응답 불일치')
            return result
        raise ValueError('지원하지 않는 로컬 요청입니다.')
