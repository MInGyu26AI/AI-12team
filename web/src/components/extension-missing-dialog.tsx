"use client";
// 확장이 요청을 받지 않을 때(설치 안 됨, 또는 팝업의 개인 검토함 주소가 이 페이지가 아님) 화면에 한 번 띄우는 안내.
// 확인: 닫고 지금 화면에 그대로 둔다. 설치: 확장 설치 안내(/install)로 간다.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function ExtensionMissingDialog({ missing }: { missing: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const open = missing && !dismissed;

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="extension-missing-title"
      onClose={() => setDismissed(true)}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl bg-background p-6 shadow-xl backdrop:bg-[#2b2f3a]/80"
    >
      <h2 id="extension-missing-title" className="text-lg font-semibold">
        확장 프로그램이 설치되지 않았습니다.
      </h2>
      <p className="mt-2 text-sm text-muted-foreground break-keep">
        설치했다면 확장 팝업의 개인 검토함 주소가 이 페이지 주소인지 확인해 주세요.
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="outline" onClick={() => dialog.current?.close()}>
          확인
        </Button>
        <Button
          onClick={() => {
            // Next 는 떠난 화면을 숨긴 채 남겨 두므로, 열린 채로 이동하면 설치 화면이 클릭되지 않는다
            dialog.current?.close();
            router.push("/install");
          }}
        >
          설치
        </Button>
      </div>
    </dialog>
  );
}
