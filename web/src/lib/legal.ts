// 이용약관·개인정보 처리방침의 버전과 운영자 연락처. 약관 화면(/terms·/privacy), 푸터, 가입 동의 화면(/signup/consent)이
// 모두 이 파일 하나만 본다. 문서를 고치면 여기 버전을 올린다: 서버가 같은 버전을 기대하므로(동의 기록), 서버 쪽 값과 함께 바꾼다.
// 이 레포는 공개라서, 전화번호 같은 개인 연락처는 허락받기 전에는 넣지 않는다 (phone 은 비워 두고, 값이 있을 때만 화면에 보인다).

/** 서버(POST /onboarding/consent)에 보내는 동의 문서 버전. 바뀌면 이미 동의한 계정도 다시 동의를 받는다 */
export const TERMS_VERSION = "beta-0.1";
export const PRIVACY_VERSION = "beta-0.1";

/** 화면에 보이는 버전 이름 (두 문서가 같은 버전으로 나간다) */
export const LEGAL_VERSION_LABEL = "베타 0.1";
/** 푸터의 작은 칩 글자 */
export const BETA_BADGE = "BETA 0.1";

/** 시행일: 기록용 ISO 날짜와 화면용 글자 */
export const LEGAL_EFFECTIVE_DATE = "2026-11-16";
export const LEGAL_EFFECTIVE_DATE_LABEL = "2026. 11. 16.";

export const CONTACT: {
  operator: string;
  privacyOfficer: string;
  email: string;
  phone: string | null; // 공개해도 된다고 확인되기 전까지 null. 값이 생기면 약관 문의·처리방침 10절에만 한 줄 더 보인다
} = {
  operator: "SyncUp",
  privacyOfficer: "김동균",
  email: "hi@donggyun.kim",
  phone: null,
};

export const CONTACT_MAILTO = `mailto:${CONTACT.email}`;

/** 동의 화면이 서버에 보내는 본문. 서버가 문서 버전이 달라졌다고 하면 409 로 거절한다 */
export const CONSENT_BODY = { terms: TERMS_VERSION, privacy: PRIVACY_VERSION, age14: true, transfer: true } as const;
