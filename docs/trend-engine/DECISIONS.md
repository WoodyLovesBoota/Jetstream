# 결정 기록

한 줄씩, 왜 그렇게 했는지만 남긴다.

- 엔진 위치는 지시대로 `src/trend/`. 기존 코드는 루트의 `lib/`·`components/`라 혼재하지만, 엔진이 순수 TS 모듈이라는 경계를 디렉터리로 드러내는 편이 낫다.
- `src/trend/` 내부 import는 `.ts` 확장자를 붙인다(`allowImportingTsExtensions`). 그래야 `scripts/*.ts`가 빌드 없이 Node 25 타입 스트리핑으로 바로 엔진을 돌린다(record/replay/build-prior). Next 번들러는 확장자 붙은 import를 그대로 처리한다.
- 녹화 포맷은 `SlimEvent`(src/trend/slim.ts) — 원시 JSON 대신 엔진이 읽는 필드만, 키 1~2자. 녹화기·워커·리플레이가 같은 `slimEvent()`를 거치므로 "엔진 입력"의 정의가 한 곳뿐이다.
- `recordings/`는 gitignore. 녹화본은 수십 MB라 커밋하지 않고, 산출물(`public/prior.json`)과 테스트용 소형 합성 픽스처만 커밋한다.
- URL 정규화에서 쿼리를 통째로 버리되 `youtube.com`의 `v`만 남기고 `youtu.be/ID`를 합친다 — 안 그러면 모든 영상이 한 키로 뭉친다. `m.`·`mobile.`·`amp.` 서브도메인도 `www.`처럼 뗀다.
- 단어 추출은 라틴뿐 아니라 키릴·그리스 등 띄어쓰기 문자 전체(3자+)로 넓혔다. 띄어쓰기 없는 타이 등은 30자 상한에 걸려 자연히 빠진다.
- CJK는 텍스트에 CJK 문자가 있을 때만 `Intl.Segmenter`를 탄다(비용). 로캘은 langs[0] → 없으면 문자로 추정(한글→ko, 가나→ja, 나머지→zh). 히라가나만으로 된 4자 미만 토큰은 기능어로 보고 버린다.
- `node --no-warnings` — package.json에 `"type":"module"`을 넣으면 Next 설정·빌드 쪽 위험이 생겨, 스크립트 실행 시 ESM 재해석 경고만 끈다.
