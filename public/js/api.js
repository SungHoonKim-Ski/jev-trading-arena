/** 서버 API 호출. 응답 envelope {success, data, error}를 풀어 data만 반환 */
export async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  } catch {
    throw new Error('서버에 연결할 수 없습니다');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) throw new Error(body?.error ?? `요청 실패 (HTTP ${res.status})`);
  return body.data;
}

export const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
