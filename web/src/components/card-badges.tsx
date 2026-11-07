import { BADGE_COLOR, TAG_COLOR, TAG_LABEL, statusBadges } from "@shared/labels";
import type { Card } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// 카드 위 배지 줄: 표시(tag) · 소주제 · 확인 필요 · 민감정보 가림 · 변경
export function CardBadges({ card, showSubtopic = true }: { card: Card; showSubtopic?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {card.relevance === "related" && (
        <>
          <Badge variant="outline" className={TAG_COLOR[card.tag]}>
            {TAG_LABEL[card.tag]}
          </Badge>
          {showSubtopic && card.subtopic && (
            <Badge variant="outline" className={BADGE_COLOR.subtopic}>
              {card.subtopic}
            </Badge>
          )}
        </>
      )}
      {statusBadges(card).map((b) => (
        <Badge key={b.label} variant="outline" className={cn(b.color)}>
          {b.label}
        </Badge>
      ))}
    </div>
  );
}
