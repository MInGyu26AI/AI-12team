"use client";

// '이용 방법' 슬라이드 팝업 (6단계). 글은 첫 화면 이용 방법 페이지와 같은 lib/guide-steps.ts 의 STEPS 를 쓴다.
// 단계마다 이동 버튼 하나: 1단계는 팀 만들기, 2단계는 PC 연결하기 팝업, 나머지는 해당 화면으로 가는 링크
import Link from "next/link";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { STEPS } from "@/lib/guide-steps";
import { DialogFrame, SlideFooter, slideSmall } from "./dialog-frame";

const TITLE_ID = "flow-slide-title";
// STEPS 의 cta 는 첫 화면 페이지용이라, 팝업에서는 단계별로 짧은 이름을 쓴다
const CTA = ["새 팀 만들기", "PC 연결 안내 보기", "대화 수집 보기", "승인함 열기", "팀 보드 열기", "팀 결정 기록 보기"];

function FlowDeck({
  onClose,
  onCreateTeam,
  onOpenInstall,
}: {
  onClose: () => void;
  onCreateTeam: () => void;
  onOpenInstall: () => void;
}) {
  const [step, setStep] = useState(0);
  const slide = STEPS[step];
  const cta = CTA[step];
  const arrow = <ArrowRight className="size-4" strokeWidth={1.5} aria-hidden />;
  return (
    <DialogFrame
      open
      onClose={onClose}
      title="이용 방법"
      counter={`${step + 1} / ${STEPS.length}`}
      labelledBy={TITLE_ID}
      scrollKey={step}
      bodyClassName="px-6 py-8"
      footer={
        <SlideFooter
          labels={STEPS.map((s, i) => `${i + 1}단계 ${s.title}`)}
          index={step}
          onIndex={setStep}
          onFinish={onClose}
          finishLabel="닫기"
        />
      }
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center bg-ink font-mono text-[13px] text-white">
          {step + 1}
        </span>
        <div className="flex flex-col gap-2">
          <h2 id={TITLE_ID} className="text-xl leading-[1.4] font-bold text-ink">
            {slide.title}
          </h2>
          <p className="text-sm leading-[1.7] break-keep text-ink-body">{slide.body}</p>
        </div>
      </div>
      <p className="ml-10 bg-blush px-4 py-3 text-[13px] leading-[1.6] break-keep text-ink-body">{slide.tip}</p>
      {step <= 1 ? (
        // 이 팝업을 닫고 다음 팝업(팀 만들기·PC 연결하기)을 연다
        <button
          type="button"
          onClick={() => {
            onClose();
            (step === 0 ? onCreateTeam : onOpenInstall)();
          }}
          className={`${slideSmall} ml-10 self-start`}
        >
          {cta}
          {arrow}
        </button>
      ) : (
        <Link href={slide.href} onClick={onClose} className={`${slideSmall} ml-10 self-start`}>
          {cta}
          {arrow}
        </Link>
      )}
    </DialogFrame>
  );
}

/** 이용 방법 슬라이드. 닫혔다 다시 열면 1단계부터 시작한다 */
export function FlowSlidesDialog({
  open,
  onClose,
  onCreateTeam,
  onOpenInstall,
}: {
  open: boolean;
  onClose: () => void;
  onCreateTeam: () => void;
  onOpenInstall: () => void;
}) {
  return open ? <FlowDeck onClose={onClose} onCreateTeam={onCreateTeam} onOpenInstall={onOpenInstall} /> : null;
}
