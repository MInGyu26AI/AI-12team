import { SUBTOPICS, type Subtopic } from '@shared/types';

// 분류에 쓸 소주제 고르기. 꺼 둔 소주제는 로컬 수집기가 '기타'로 분류한다. 하나도 안 고르면(빈 목록) 모두 켬
export function SubtopicPicker({ value, onChange }: { value: Subtopic[]; onChange: (value: Subtopic[]) => void }) {
  const toggle = (t: Subtopic) => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t]);
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1 font-medium">켤 소주제</legend>
      <div className="grid grid-cols-2 gap-1.5">
        {SUBTOPICS.map((t) => (
          <label key={t} className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={value.includes(t)} onChange={() => toggle(t)} />
            {t}
          </label>
        ))}
      </div>
      <p className="text-xs text-gray-500">꺼 둔 소주제 내용은 ‘기타’로 분류돼요. 하나도 고르지 않으면 모든 소주제를 사용해요.</p>
    </fieldset>
  );
}
