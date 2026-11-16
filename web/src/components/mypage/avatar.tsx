"use client";

import { useState } from "react";
import { initialOf } from "@/lib/profile";
import { cn } from "@/lib/utils";

/** 프로필 동그라미: 올린 사진 → GitHub 사진 → 이름 첫 글자(연분홍 바탕). 사진을 못 불러오면 첫 글자로 돌아간다 */
export function Avatar({ name, photo, githubAvatar, className }: {
  name: string;
  photo: string | null;
  githubAvatar: string | null;
  className?: string; // 크기·글자 크기 (예: size-28 text-[40px])
}) {
  const src = photo ?? githubAvatar;
  return <AvatarImage key={src ?? "none"} name={name} src={src} className={className} />;
}

function AvatarImage({ name, src, className }: { name: string; src: string | null; className?: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <span aria-hidden className={cn("relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-soft font-medium text-ink", className)}>
      {src && !broken
        // eslint-disable-next-line @next/next/no-img-element -- 업로드 data URL·GitHub 사진은 최적화 대상이 아니다
        ? <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="size-full object-cover" />
        : initialOf(name)}
    </span>
  );
}
