import { createTeamApi } from "@shared/api";

// NEXT_PUBLIC_API_URL 이 비어 있으면 목업 API
export const api = createTeamApi(process.env.NEXT_PUBLIC_API_URL || undefined);
