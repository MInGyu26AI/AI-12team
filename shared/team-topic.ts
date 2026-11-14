// 프로젝트 주제는 팀이 함께 쓴다. 한 팀원이 저장하면 팀 서버(server/team_settings.py)에 올라가고,
// 다른 팀원의 로컬 수집기가 30초 안에 따라간다(collector/collection_settings.py sync_team_topic).
// 주제는 외부 AI 분류와 기기 안 개인정보 판정의 기준이라, 바꾸기 전에 확인을 받는다. 확장 팝업과 웹이 같은 문구를 쓴다
export const TOPIC_EDIT_CONFIRM = "수정하시겠습니까? 수정 시에 대화 수집 기준이 달라질 수 있습니다.";
export const TOPIC_SHARED_NOTE = "팀 전원이 함께 쓰는 주제예요. 바꾸면 모든 팀원의 수집 기준이 함께 바뀌어요.";

/** 처음 설정(저장된 주제가 없음)이면 확인 없이 바로 쓰고, 주제가 있으면 '수정' → 확인 뒤에만 고친다 */
export const startsEditable = (savedTopic: string) => !savedTopic.trim();
