"use client";

import { useId, useState } from "react";
import "./stages-motion.css";

// 첫 화면 4단계 애니메이션 (확정본 syncup-stages-animation.html 의 <section class="sv-stage">). 11초 동안
// APPROVE(흩어진 점 중 고른 것만 진해짐) → ALERT(부딪혀 반짝) → RESOLVE(둘이 하나로) → RECORD(별이 궤도를 따라 올라가 터짐) → 글씨 로고로 멈춘다.
// 시간표·좌표는 stages-motion.css 의 sv* keyframes 그대로. ↻ REPLAY 는 key 를 바꿔 장면을 다시 붙여 처음부터 재생한다.
// mask id 는 useId 로 만들어 같은 페이지의 다른 로고(Wordmark)와 겹치지 않는다

const mono: React.CSSProperties = { margin: 0, fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: "0.22em" };
const display: React.CSSProperties = { margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 30, letterSpacing: "-0.04em" };
const body: React.CSSProperties = { margin: 0, fontSize: 15, color: "#3a342b" };

const CAPTIONS = [
  { cls: "sv-c1", label: "01 / 04 · APPROVE", line: "Only what you pick.", ko: "흩어진 대화 중 고른 것만 진해져요" },
  { cls: "sv-c2", label: "02 / 04 · ALERT", line: "Clash, then a flash.", ko: "다른 결정이 부딪히면 반짝, 알려줘요" },
  { cls: "sv-c3", label: "03 / 04 · RESOLVE", line: "Two become one.", ko: "엇갈린 결정을 하나로 정해요" },
  { cls: "sv-c4", label: "04 / 04 · RECORD", line: "Up it goes.", ko: "별이 되어 팀 기록으로 올라가요" },
];

function Scene() {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const m1 = `svm1-${id}`;
  const m2 = `svm2-${id}`;
  const cut = `svCut-${id}`;
  return (
    <div className="sv-run">
      <svg className="sv-scene" viewBox="0 0 1200 520" aria-hidden preserveAspectRatio="xMidYMid meet">
      <circle className="sv-a sv-faint" cx="450" cy="120" r="9" fill="#c9bfb3"/>
      <circle className="sv-a sv-faint" cx="520" cy="410" r="9" fill="#c9bfb3"/>
      <circle className="sv-a sv-faint" cx="690" cy="105" r="9" fill="#c9bfb3"/>
      <circle className="sv-a sv-faint" cx="770" cy="420" r="9" fill="#c9bfb3"/>
      <circle className="sv-a sv-faint" cx="1010" cy="250" r="9" fill="#c9bfb3"/>
      <circle className="sv-a sv-faint" cx="200" cy="270" r="9" fill="#c9bfb3"/>
      <defs>
      <mask id={m1} maskUnits="userSpaceOnUse" x="0" y="0" width="1200" height="520"><path className="sv-a sv-eat" d="M 470 260 Q 520 200 600 252" pathLength="100" fill="none" stroke="#ffffff" strokeWidth="14"/></mask>
      <mask id={m2} maskUnits="userSpaceOnUse" x="0" y="0" width="1200" height="520"><path className="sv-a sv-eat" d="M 730 260 Q 680 200 600 252" pathLength="100" fill="none" stroke="#ffffff" strokeWidth="14"/></mask>
      </defs>
      <g className="sv-a sv-trails">
      <path d="M 470 260 Q 520 200 600 252" fill="none" stroke="#1d1a14" strokeWidth="3" strokeLinecap="round" strokeDasharray="2 8" mask={`url(#${m1})`}/>
      <path d="M 730 260 Q 680 200 600 252" fill="none" stroke="#1d1a14" strokeWidth="3" strokeLinecap="round" strokeDasharray="2 8" mask={`url(#${m2})`}/>
      </g>
      <circle className="sv-a sv-d1" cx="0" cy="0" r="12"/>
      <circle className="sv-a sv-d2" cx="0" cy="0" r="12"/>
      <circle className="sv-a sv-d3" cx="0" cy="0" r="12"/>
      <circle className="sv-a sv-d4" cx="0" cy="0" r="12"/>
      <path className="sv-a sv-flash" d="M 0 -1 C 0.084 -0.24 0.24 -0.084 1 0 C 0.24 0.084 0.084 0.24 0 1 C -0.084 0.24 -0.24 0.084 -1 0 C -0.24 -0.084 -0.084 -0.24 0 -1 Z" fill="#1d1a14"/>
      <g className="sv-a sv-pop">
      <mask id={cut} maskUnits="userSpaceOnUse" x="-200" y="-200" width="1000" height="600"><rect x="-200" y="-200" width="1000" height="600" fill="#fff"/><path className="sv-a sv-orbit" d="M -26 112 C -70 156, 200 164, 360 146 C 452 136, 494 84, 498 -20" pathLength="100" fill="none" stroke="#000" strokeWidth="18" strokeLinecap="round"/>
      </mask>
      <g className="sv-a sv-wmk" mask={`url(#${cut})`}><path d="M 72.0 10.0 L 22.0 10.0 Q 10.0 10.0 10.0 22.0 L 10.0 38.0 Q 10.0 50.0 22.0 50.0 L 50.0 50.0 Q 62.0 50.0 62.0 62.0 L 62.0 78.0 Q 62.0 90.0 50.0 90.0 L 0.0 90.0" fill="none" stroke="#1d1a14" strokeWidth="20" strokeLinejoin="round" /><path d="M 96.0 40.0 L 96.0 64.0 Q 96.0 76.0 108.0 76.0 L 148.0 76.0" fill="none" stroke="#1d1a14" strokeWidth="20" strokeLinejoin="round" /><path d="M 138.0 40.0 L 138.0 110.0 Q 138.0 122.0 126.0 122.0 L 86.0 122.0" fill="none" stroke="#1d1a14" strokeWidth="20" strokeLinejoin="round" /><path d="M 172.0 100.0 L 172.0 52.0 Q 172.0 40.0 184.0 40.0 L 202.0 40.0 Q 214.0 40.0 214.0 52.0 L 214.0 100.0" fill="none" stroke="#1d1a14" strokeWidth="20" strokeLinejoin="round" /><path d="M 296.0 40.0 L 260.0 40.0 Q 248.0 40.0 248.0 52.0 L 248.0 78.0 Q 248.0 90.0 260.0 90.0 L 296.0 90.0" fill="none" stroke="#1d1a14" strokeWidth="20" strokeLinejoin="round" /><path d="M 320.0 0.0 L 320.0 78.0 Q 320.0 90.0 332.0 90.0 L 360.0 90.0 Q 372.0 90.0 372.0 78.0 L 372.0 0.0" fill="none" stroke="#1d1a14" strokeWidth="20" strokeLinejoin="round" /><path d="M 406.0 132.0 L 406.0 52.0 Q 406.0 40.0 418.0 40.0 L 436.0 40.0 Q 448.0 40.0 448.0 52.0 L 448.0 78.0 Q 448.0 90.0 436.0 90.0 L 396.0 90.0" fill="none" stroke="#1d1a14" strokeWidth="20" strokeLinejoin="round" /><path d="M -40 21 C -39.244 27.84 -37.84 29.244 -31 30 C -37.84 30.756 -39.244 32.16 -40 39 C -40.756 32.16 -42.16 30.756 -49 30 C -42.16 29.244 -40.756 27.84 -40 21 Z" fill="#1d1a14"/></g>
      <path className="sv-a sv-orbit" d="M -26 112 C -70 156, 200 164, 360 146 C 452 136, 494 84, 498 -20" pathLength="100" fill="none" stroke="#1d1a14" strokeWidth="5.5" strokeLinecap="round"/>
      <path className="sv-a sv-wstar" d="M 498 -40 C 499.68 -24.8 502.8 -21.68 518 -20 C 502.8 -18.32 499.68 -15.2 498 0 C 496.32 -15.2 493.2 -18.32 478 -20 C 493.2 -21.68 496.32 -24.8 498 -40 Z" fill="#1d1a14"/>
      <g className="sv-a sv-burst" fill="none" stroke="#1d1a14" strokeWidth="4.5" strokeLinecap="round"><line x1="12.9" y1="5.4" x2="31.4" y2="13.0"/><line x1="5.4" y1="12.9" x2="17.6" y2="42.5"/><line x1="-5.4" y1="12.9" x2="-13.0" y2="31.4"/><line x1="-12.9" y1="5.4" x2="-42.5" y2="17.6"/><line x1="-12.9" y1="-5.4" x2="-31.4" y2="-13.0"/><line x1="-5.4" y1="-12.9" x2="-17.6" y2="-42.5"/><line x1="5.4" y1="-12.9" x2="13.0" y2="-31.4"/><line x1="12.9" y1="-5.4" x2="42.5" y2="-17.6"/></g>
      <path className="sv-a sv-sp0" d="M 0 -1 C 0.08399999999999999 -0.24 0.24 -0.08399999999999999 1 0 C 0.24 0.08399999999999999 0.08399999999999999 0.24 0 1 C -0.08399999999999999 0.24 -0.24 0.08399999999999999 -1 0 C -0.24 -0.08399999999999999 -0.08399999999999999 -0.24 0 -1 Z" fill="#1d1a14"/><path className="sv-a sv-sp1" d="M 0 -1 C 0.08399999999999999 -0.24 0.24 -0.08399999999999999 1 0 C 0.24 0.08399999999999999 0.08399999999999999 0.24 0 1 C -0.08399999999999999 0.24 -0.24 0.08399999999999999 -1 0 C -0.24 -0.08399999999999999 -0.08399999999999999 -0.24 0 -1 Z" fill="#1d1a14"/><path className="sv-a sv-sp2" d="M 0 -1 C 0.08399999999999999 -0.24 0.24 -0.08399999999999999 1 0 C 0.24 0.08399999999999999 0.08399999999999999 0.24 0 1 C -0.08399999999999999 0.24 -0.24 0.08399999999999999 -1 0 C -0.24 -0.08399999999999999 -0.08399999999999999 -0.24 0 -1 Z" fill="#1d1a14"/><path className="sv-a sv-sp3" d="M 0 -1 C 0.08399999999999999 -0.24 0.24 -0.08399999999999999 1 0 C 0.24 0.08399999999999999 0.08399999999999999 0.24 0 1 C -0.08399999999999999 0.24 -0.24 0.08399999999999999 -1 0 C -0.24 -0.08399999999999999 -0.08399999999999999 -0.24 0 -1 Z" fill="#1d1a14"/>
      </g>
      <path className="sv-a sv-star" d="M 0 -1 C 0.084 -0.24 0.24 -0.084 1 0 C 0.24 0.084 0.084 0.24 0 1 C -0.084 0.24 -0.24 0.084 -1 0 C -0.24 -0.084 -0.084 -0.24 0 -1 Z" fill="#1d1a14"/>
      </svg>
      {CAPTIONS.map((c) => (
        <div key={c.cls} className={`sv-cap ${c.cls}`}>
          <p style={mono}>{c.label}</p>
          <p style={display}>{c.line}</p>
          <p style={body}>{c.ko}</p>
        </div>
      ))}
      <div className="sv-cap sv-c5">
        <p style={mono}>SYNC UP · THINK UP</p>
        <p style={{ margin: 0, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 30 }}>Scattered chats, one decision.</p>
      </div>
    </div>
  );
}

export function StagesMotion() {
  const [run, setRun] = useState(0);
  return (
    <section className="sv-stage" aria-label="SyncUp 4단계가 로고가 되는 움직임">
      <Scene key={run} />
      <button type="button" className="sv-replay" onClick={() => setRun((n) => n + 1)}>
        ↻ REPLAY
      </button>
    </section>
  );
}
