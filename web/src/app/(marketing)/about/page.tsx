import type { Metadata } from "next";
import { AboutDeck } from "@/components/about/about-deck";

export const metadata: Metadata = {
  title: "서비스 소개 · SyncUp",
  description: "팀원마다 다른 AI를 써도 팀의 결정은 하나로 — SyncUp이 푸는 문제와 차별점",
};

// 내용(문제 · 차별점 · AI 분류 · 개인정보)은 그대로, 화면 한 장에 한 슬라이드씩 넘기는 발표형으로 보인다
export default function AboutPage() {
  return <AboutDeck />;
}
