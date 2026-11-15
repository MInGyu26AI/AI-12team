const PRODUCTION_WEB_ORIGIN = "https://syncup-ashen.vercel.app";

// Vercel bakes NEXT_PUBLIC values into the client bundle. Refuse a production build with demo data or a
// different OAuth origin instead of shipping a plausible-looking but disconnected application.
function validateProductionConfig(env) {
  if (env.VERCEL_ENV !== "production") return;
  for (const key of ["NEXT_PUBLIC_USE_MOCK", "NEXT_PUBLIC_DEMO_MODE", "NEXT_PUBLIC_LOCAL_BRIDGE"]) {
    if (env[key] === "true") throw new Error(`운영 배포에서 ${key}=true를 사용할 수 없습니다.`);
  }
  if (env.SYNCUP_CONNECTION_FILE) throw new Error("운영 웹에 로컬 연결 파일을 설정하지 마세요.");
  if (env.SYNCUP_WEB_ORIGIN !== PRODUCTION_WEB_ORIGIN) throw new Error(`SYNCUP_WEB_ORIGIN을 ${PRODUCTION_WEB_ORIGIN}으로 설정하세요.`);
  if (env.SYNCUP_TEAM_API_URL !== "https://syncup-api-production-36de.up.railway.app") throw new Error("운영 팀 API 주소를 확인하세요.");
  if (env.NEXT_PUBLIC_SUPABASE_URL !== "https://gmwvivrmmzsrpdwdfeul.supabase.co") throw new Error("운영 GitHub 로그인 프로젝트 주소를 확인하세요.");
}

exports.PRODUCTION_WEB_ORIGIN = PRODUCTION_WEB_ORIGIN;
exports.validateProductionConfig = validateProductionConfig;
