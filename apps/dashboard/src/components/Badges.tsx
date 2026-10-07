import { ruleLabel } from '@pos/rules/src/labels';
import { LEVEL_LABEL, STATUS_LABEL } from '@/lib/format';

export function LevelBadge({ level }: { level: 'LOW' | 'MEDIUM' | 'CRITICAL' }) {
  return <span className={`badge badge-${level}`}>{LEVEL_LABEL[level]}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status === 'OPEN' ? 'badge-MEDIUM' : 'badge-ok'}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function RuleChips({ rules }: { rules: string[] }) {
  return (
    <div className="chips">
      {[...new Set(rules)].map((r) => (
        <span className="chip" key={r} title={r}>{ruleLabel(r)}</span>
      ))}
    </div>
  );
}
