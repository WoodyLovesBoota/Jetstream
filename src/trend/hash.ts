// 32비트 해시 — FNV-1a(UTF-16 코드 유닛 단위) + murmur3 finalizer.
// CMS 인덱스, DID 해시, post-ID 집합이 모두 이걸 쓴다. 할당 없음.

/** 문자열 → 부호 없는 32비트 해시 */
export function hash32(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h);
}

/** murmur3 finalizer — FNV의 하위 비트 편향을 섞어 준다 */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 두 32비트 해시를 하나로 — (DID, 후보) 쌍 키 */
export function combine32(a: number, b: number): number {
  return fmix32((a ^ Math.imul(b, 0x9e3779b1)) >>> 0);
}

/** post 식별자(did/rkey) 해시 — 이벤트 묶기의 겹침 계수용 */
export function postIdHash(did: string, rkey: string): number {
  return hash32(rkey, hash32(did));
}
