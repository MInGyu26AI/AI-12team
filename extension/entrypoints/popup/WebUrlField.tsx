import { LOCAL_WEB_URL, PRODUCTION_WEB_URL, bridgeSupported } from '@/lib/web-url';
import { TextField } from './TextField';

interface WebUrlFieldProps {
  value: string;
  normalized: string | null; // value 를 origin 으로 바꾼 값. null = 잘못된 주소
  onChange: (value: string) => void;
}

function hintFor(normalized: string | null) {
  if (!normalized) return { color: 'text-sensitive', text: 'http:// 또는 https:// 로 시작하는 주소를 넣어 주세요.' };
  if (!bridgeSupported(normalized)) {
    const text = '이 주소에서는 “확장에서 가져온 카드” 넘기기가 동작하지 않아요. localhost:3000 또는 *.vercel.app 주소를 써 주세요.';
    return { color: 'text-warn', text };
  }
  return { color: 'text-gray-500', text: 'Vercel 배포 주소를 붙여넣으면 “개인 검토함 열기”가 그 주소로 열려요.' };
}

// 개인 검토함 주소 입력. 확장 카드 넘기기는 web-bridge 가 붙는 주소(WEB_BRIDGE_MATCHES)에서만 된다
export function WebUrlField({ value, normalized, onChange }: WebUrlFieldProps) {
  const hint = hintFor(normalized);
  return (
    <div className="space-y-1">
      <TextField label="개인 검토함 주소" value={value} onChange={onChange} placeholder="https://syncup-xxxx.vercel.app" />
      <div className="flex gap-3 text-xs">
        <button type="button" className="text-gray-500 underline" onClick={() => onChange(PRODUCTION_WEB_URL)}>
          배포 주소 쓰기
        </button>
        <button type="button" className="text-gray-500 underline" onClick={() => onChange(LOCAL_WEB_URL)}>
          로컬 개발 주소 쓰기
        </button>
      </div>
      <p className={`text-xs ${hint.color}`}>{hint.text}</p>
    </div>
  );
}
