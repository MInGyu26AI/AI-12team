import { PRE_ALERT_HINT, preAlertText, type PreAlertSummary } from '@shared/pre-alert';

const SHOWN = 2;

// 승인 전 미리 알림: 검토 중 후보가 어긋나는 팀 결정 (본인에게만 보임). 없으면 그리지 않는다
export function PreAlertList({ alerts }: { alerts: PreAlertSummary[] }) {
  if (!alerts.length) return null;
  return (
    <section role="note" className="space-y-1 rounded-lg border border-alert-conflict/30 bg-alert-conflict-soft p-3 text-alert-conflict">
      <p className="font-semibold">팀 결정과 어긋나는 후보 {alerts.length}건</p>
      <ul className="space-y-0.5 text-xs">
        {alerts.slice(0, SHOWN).map((a) => (
          <li key={a.key}>
            {preAlertText(a)}
            {a.candidates > 1 && ` · 같은 후보 ${a.candidates}개`}
          </li>
        ))}
      </ul>
      {alerts.length > SHOWN && <p className="text-xs">나머지 {alerts.length - SHOWN}건은 개인 검토함에서 확인해 주세요.</p>}
      <p className="text-xs opacity-80">{PRE_ALERT_HINT}</p>
    </section>
  );
}
