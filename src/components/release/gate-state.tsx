import {
  CircleHelp,
  CircleSlash,
  Clock3,
  Hourglass,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import type { GateState } from '../../models/release';
import { GATE_STATE_LABELS } from '../../models/release';
import { Badge } from '../ui/badge';

const STATE_TONE: Record<GateState, 'green' | 'amber' | 'red' | 'slate' | 'neutral'> = {
  released: 'green',
  pending: 'amber',
  verifying: 'red',
  voided: 'slate',
  conflict: 'neutral',
};

export function GateStateBadge({ state }: { state: GateState }) {
  return <Badge tone={STATE_TONE[state]}>{GATE_STATE_LABELS[state]}</Badge>;
}

export function GateStateIcon({
  state,
  className,
}: {
  state: GateState;
  className?: string;
}) {
  switch (state) {
    case 'released':
      return <ShieldCheck className={className} />;
    case 'pending':
      return <Hourglass className={className} />;
    case 'verifying':
      return <CircleHelp className={className} />;
    case 'voided':
      return <CircleSlash className={className} />;
    case 'conflict':
      return <TriangleAlert className={className} />;
  }
}

export function RevisionPill({
  revision,
  current,
}: {
  revision: number | null;
  current: number;
}) {
  if (revision === null) {
    return (
      <Badge tone="red">
        <Clock3 className="mr-1 h-3 w-3" />
        旧回执无修订号
      </Badge>
    );
  }
  return (
    <Badge tone={revision === current ? 'green' : 'red'}>
      修订 {revision}
      {revision === current ? '' : ` ≠ 当前 ${current}`}
    </Badge>
  );
}
