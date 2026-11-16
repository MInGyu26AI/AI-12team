// SyncUp 앱(PC 연결 프로그램) 설치 파일 목록. /install 페이지와 대시보드의 'PC 연결하기' 슬라이드가 같은 값을 쓴다.
// 주소는 배포 환경 변수에서만 받고, 아래 download() 검사를 통과한 것만 링크로 낸다 (통과 못 하면 null = '배포 준비 중').
// process.env.NEXT_PUBLIC_* 는 빌드 때 값으로 바뀌므로 변수 이름을 그대로 적어야 한다.

export type DesktopDownload = { name: string; detail: string; url: string | null };

/** 같은 사이트의 /downloads/*.zip 이거나, 사용자 정보 없는 https 주소만 받는다 */
function download(value: string | undefined) {
  if (value && /^\/downloads\/[A-Za-z0-9._-]+\.zip$/.test(value)) return value;
  try { const u = new URL(value ?? ""); return u.protocol === "https:" && !u.username && !u.password ? u.href : null; }
  catch { return null; }
}

export function desktopDownloads(): DesktopDownload[] {
  return [
    { name: "Mac · Apple Silicon", detail: "M1·M2·M3·M4 등 Apple 칩", url: download(process.env.NEXT_PUBLIC_DESKTOP_MAC_ARM64_URL) },
    { name: "Mac · Intel", detail: "Intel 프로세서 Mac", url: download(process.env.NEXT_PUBLIC_DESKTOP_MAC_INTEL_URL) },
    { name: "Windows", detail: "Windows 10·11, x64", url: download(process.env.NEXT_PUBLIC_DESKTOP_WINDOWS_URL) },
  ];
}
