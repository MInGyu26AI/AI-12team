// 켜기/끄기 스위치 모양. 바로 앞에 `peer sr-only` 체크박스가 있어야 켜짐 색이 바뀐다
export function SwitchTrack() {
  return (
    <span className="relative h-6 w-11 shrink-0 rounded-full bg-gray-300 transition-colors peer-checked:bg-tag-decision after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5" />
  );
}
