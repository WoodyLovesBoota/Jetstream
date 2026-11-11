// 링크 정규화 — 같은 기사가 utm·쿼리·해시·www·끝 슬래시 차이로 갈라지지 않게.
//
// 쿼리스트링은 통째로 버린다. 예외는 쿼리가 곧 콘텐츠 ID인 몇몇 호스트(유튜브 v)뿐 —
// 그것까지 버리면 모든 영상이 `youtube.com/watch` 하나로 뭉친다(DECISIONS.md).

export interface NormalizedLink {
  /** `apnews.com/article/abc` — 스킴 없음 */
  url: string;
  /** `apnews.com` */
  domain: string;
}

const STRIP_SUBDOMAINS = /^(www\d*|m|mobile|amp)\./;

/** 쿼리 중 남길 파라미터 — 호스트별. 그 외 쿼리는 전부 제거 */
const KEEP_QUERY: Record<string, string[]> = {
  "youtube.com": ["v"],
};

/** 경로 길이 상한 — 비정상적으로 긴 URL이 키 공간을 부풀리지 않게 */
const MAX_PATH = 200;

export function normalizeUrl(raw: string): NormalizedLink | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null; // 파싱 불가 URL은 후보가 아니다 — 의도된 무시
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let host = u.hostname.toLowerCase().replace(/\.$/, "");
  while (STRIP_SUBDOMAINS.test(host)) host = host.replace(STRIP_SUBDOMAINS, "");
  if (host.length === 0 || !host.includes(".")) return null;

  let path = u.pathname;
  // youtu.be/ID → youtube.com/watch?v=ID 로 합친다
  if (host === "youtu.be" && path.length > 1) {
    return { url: `youtube.com/watch?v=${path.slice(1).split("/")[0]}`, domain: "youtube.com" };
  }
  path = path.replace(/\/+$/, "");
  try {
    path = decodeURI(path);
  } catch {
    // 잘못된 퍼센트 인코딩 — 인코딩된 원문 그대로 쓴다
  }
  if (path.length > MAX_PATH) path = path.slice(0, MAX_PATH);

  let query = "";
  const keep = KEEP_QUERY[host];
  if (keep !== undefined) {
    const parts: string[] = [];
    for (const k of keep) {
      const v = u.searchParams.get(k);
      if (v !== null && v.length > 0) parts.push(`${k}=${v}`);
    }
    if (parts.length > 0) query = `?${parts.join("&")}`;
  }
  return { url: `${host}${path}${query}`, domain: host };
}
