import type { ReactNode } from 'react';

const TONE_COLOR = {
  info: 'bg-surface-soft text-muted-foreground',
  ok: 'bg-tag-todo-soft text-tag-todo',
  error: 'bg-sensitive-soft text-sensitive',
};

export function Notice({ tone, children }: { tone: keyof typeof TONE_COLOR; children: ReactNode }) {
  return <p className={`rounded-lg px-3 py-2 text-xs ${TONE_COLOR[tone]}`}>{children}</p>;
}
