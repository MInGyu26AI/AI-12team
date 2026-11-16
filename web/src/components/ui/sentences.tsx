import type { ReactNode } from "react";

// 한 문단에 문장이 여럿이면 문장마다 줄을 바꾼다: 마침표·물음표·느낌표 뒤 공백에서 나눠 <span className="sentence"> 로 감싼다
// (globals.css .sentence = display:block). 글자는 그대로 두고(문장 사이 공백도 앞 문장 끝에 남긴다) 줄바꿈 구조만 바꾼다.
// 문장이 하나뿐이거나 글자가 아니면(JSX) 손대지 않는다
export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.?!]\s+)/);
}

export function Sentences({ children }: { children: ReactNode }) {
  if (typeof children !== "string") return children;
  const parts = splitSentences(children);
  if (parts.length < 2) return children;
  return parts.map((s, i) => (
    <span key={i} className="sentence">
      {s}
    </span>
  ));
}
