import { createTeamApi } from '@shared/api';

// WXT_API_URL 이 비어 있으면 목업 API
export const api = createTeamApi(import.meta.env.WXT_API_URL || undefined);
