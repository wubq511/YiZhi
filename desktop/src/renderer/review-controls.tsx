import type { ReviewSnapshot, ReviewStatus } from '../shared';

const labels: Record<ReviewStatus, string> = { pending: '待复习', weak: '薄弱', mastered: '已掌握' };

export function ReviewControls({ unitId, snapshot, change, confirm }: {
  unitId: string; snapshot: ReviewSnapshot; change(status: ReviewStatus): void;
  confirm(promptId: string, adjust: boolean): void;
}) {
  const current = snapshot.units[unitId];
  if (!current) return null;
  const prompts = snapshot.prompts.filter(prompt => prompt.unitId === unitId);
  return <section className="review-controls" aria-label="复习状态">
    <div className="review-choice" role="group" aria-label="设置复习状态">
      {(Object.keys(labels) as ReviewStatus[]).map(status => <button key={status} aria-pressed={current.status === status}
        className={`review-${status}`} onClick={() => change(status)}>{labels[status]}</button>)}
    </div>
    {prompts.map(prompt => <div className="review-prompt" key={prompt.id} role="status">
      重要结论或方法已变化。要将此单元改为待复习吗？
      <button onClick={() => confirm(prompt.id, true)}>改为待复习</button>
      <button onClick={() => confirm(prompt.id, false)}>保留已掌握</button>
    </div>)}
  </section>;
}
