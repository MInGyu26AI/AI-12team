// 웹 개인 검토함 ↔ 확장 프로그램(web-bridge 콘텐츠 스크립트) window.postMessage 형식
import type { RelatedCard } from "./types";

export const BRIDGE_FROM_WEB = "syncup-web";
export const BRIDGE_FROM_EXT = "syncup-ext";

// 웹 → 확장
export type WebToExt =
  | { source: typeof BRIDGE_FROM_WEB; type: "hello" } // "확장 있으면 검토 대기 카드 보내 줘"
  | { source: typeof BRIDGE_FROM_WEB; type: "remove"; ids: string[]; reason: "approved" | "dismissed" };

// 확장 → 웹
export type ExtToWeb = {
  source: typeof BRIDGE_FROM_EXT;
  type: "pending";
  cards: RelatedCard[]; // 개인(personal)은 이미 버렸고, 민감정보는 가린 상태
  userName: string;
};

export const isExtToWeb = (d: unknown): d is ExtToWeb =>
  typeof d === "object" && d !== null && (d as ExtToWeb).source === BRIDGE_FROM_EXT && (d as ExtToWeb).type === "pending";

export const isWebToExt = (d: unknown): d is WebToExt =>
  typeof d === "object" && d !== null && (d as WebToExt).source === BRIDGE_FROM_WEB;
