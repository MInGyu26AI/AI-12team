// SYNCUP.md 를 보여 주는 작은 마크다운 표시기. 팀 서버가 만드는 형식(ai/syncup_ai/team_state.py render_markdown)만 다룬다:
// #·##·### 제목, > 인용, - 목록(두 칸 들여쓴 하위 목록), - [x] 체크, **굵게**, `코드`, ~~취소선~~.
// HTML 을 그대로 넣지 않고 React 요소로만 만든다 (공개 레포 파일이라 내용을 믿지 않는다)
import type { ReactNode } from "react";

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|~~[^~]+~~)/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return <code key={i} className="rounded bg-muted px-1 py-0.5 text-[0.9em]">{part.slice(1, -1)}</code>;
    if (part.startsWith("~~") && part.endsWith("~~") && part.length > 4) return <s key={i} className="text-muted-foreground">{part.slice(2, -2)}</s>;
    return part;
  });
}

function item(text: string): ReactNode {
  const check = /^\[( |x)\] (.*)$/.exec(text);
  if (!check) return inline(text);
  return (
    <>
      <span aria-hidden className="mr-1">{check[1] === "x" ? "☑" : "☐"}</span>
      <span className={check[1] === "x" ? "text-muted-foreground line-through" : undefined}>{inline(check[2]!)}</span>
    </>
  );
}

export function Markdown({ source }: { source: string }) {
  const out: ReactNode[] = [];
  let list: { text: string; sub: string[] }[] = [];
  const flush = () => {
    if (!list.length) return;
    out.push(
      <ul key={out.length} className="list-disc space-y-1 pl-5">
        {list.map((li, i) => (
          <li key={i}>
            {item(li.text)}
            {li.sub.length > 0 && (
              <ul className="list-[circle] pl-5 text-sm text-muted-foreground">
                {li.sub.map((s, j) => <li key={j}>{item(s)}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const line of source.split(/\r?\n/)) {
    const sub = /^ {2,}- (.*)$/.exec(line);
    if (sub && list.length) {
      list[list.length - 1]!.sub.push(sub[1]!);
      continue;
    }
    const li = /^- (.*)$/.exec(line);
    if (li) {
      list.push({ text: li[1]!, sub: [] });
      continue;
    }
    flush();
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) {
      const size = ["text-2xl", "text-xl", "text-lg"][heading[1]!.length - 1];
      out.push(<p key={out.length} role="heading" aria-level={heading[1]!.length} className={`${size} mt-4 font-bold first:mt-0`}>{inline(heading[2]!)}</p>);
    } else if (line.startsWith("> ")) {
      out.push(<blockquote key={out.length} className="border-l-4 pl-3 text-sm text-muted-foreground">{inline(line.slice(2))}</blockquote>);
    } else if (line.trim()) {
      out.push(<p key={out.length}>{inline(line)}</p>);
    }
  }
  flush();
  return <div className="space-y-2 break-keep">{out}</div>;
}
