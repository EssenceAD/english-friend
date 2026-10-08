# 영어 친구 — AI 원어민 회화 친구 (형철 버전)

명세: 성인이 원어민과 일상 대화를 5분 이상 이어 가는 수준까지 가는 회화 연습 앱.

```
index.html                         ← 앱 전체 (바닐라 JS). 깃허브 페이지로 배포
supabase/migrations/0001_init.sql  ← DB 테이블 4개 + RLS (본인 행만)
supabase/functions/chat/index.ts   ← AI 호출 Edge Function (API 키는 여기 Secrets에만)
```

## 먼저 화면만 보기 (서버 없이)

`index.html`을 아무 정적 서버로 열고 주소 뒤에 `?mock=1`을 붙인다. CONFIG가 비어 있어도 자동으로 목업 모드가 된다.
AI 대신 정해진 답이 나오고, 기록은 이 브라우저에만 저장된다.

```bash
python -m http.server 5178
```

→ http://localhost:5178/?mock=1

## 실제로 쓰기 — 설정 순서 (한 번만)

### 1. Supabase 프로젝트
1. supabase.com → New project (무료 플랜으로 충분)
2. **SQL Editor**에 `supabase/migrations/0001_init.sql` 내용을 붙여 넣고 Run
3. **Authentication → Sign In / Providers → Email**: "Allow new users to sign up" **끄기** (나 말고 아무도 가입 못 하게)
4. **Authentication → Users → Add user → Create new user**: 내 이메일 + 비밀번호 (Auto Confirm 체크)

### 2. AI 키 (Anthropic)
1. console.anthropic.com → API Keys → 키 발급
2. **Billing → Limits**에서 월 사용 한도 설정 (예: $10). 명세 3-10.

### 3. Edge Function 배포
Supabase CLI 사용 (`npm i -g supabase` 또는 `npx supabase`):

```bash
npx supabase login
```

```bash
npx supabase link --project-ref <프로젝트-REF>
```

```bash
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-... ALLOWED_EMAILS=내이메일@gmail.com
```

```bash
npx supabase functions deploy chat
```

선택 Secrets (안 넣으면 기본값):

| 이름 | 기본값 | 설명 |
|---|---|---|
| `AI_MODEL` | `claude-haiku-5-5` | 모델 바꾸기 (예: `claude-sonnet-5-5`) |
| `AI_EFFORT` | `low` | 생각 깊이. 지원 안 하는 모델이면 `none` |
| `AI_STRUCTURED` | `on` | JSON 스키마 강제. 문제 생기면 `off` |
| `DAILY_CALL_LIMIT` | `300` | 하루 AI 호출 상한 |
| `ALLOWED_ORIGIN` | `*` | 깃허브 페이지 주소로 좁히기: `https://essencead.github.io` |

`ALLOWED_EMAILS`가 비어 있으면 함수가 아무 요청도 받지 않는다 (일부러 그렇게 만듦).

### 4. index.html 설정
Supabase **Project Settings → API**에서 Project URL과 anon(또는 publishable) 키를 복사해 `index.html` 위쪽 `CONFIG`에 넣는다.
이 키는 공개돼도 되는 키다 (RLS + 로그인 + 이메일 허용 목록으로 막혀 있음). **AI 키는 절대 여기 넣지 않는다.** 고친 뒤 commit + push하면 깃허브 페이지에 반영된다.

### 5. 깃허브 페이지 (설정 완료)
- 저장소: https://github.com/EssenceAD/english-friend (공개)
- 앱 주소: **https://essencead.github.io/english-friend/** (Settings → Pages: `main` 브랜치 / root)
- `main`에 push하면 1~2분 뒤 자동으로 반영된다.
- 4번(CONFIG)을 채우기 전에는 목업 모드로 뜬다.
- 폰 크롬에서 앱 주소 열기 → 메뉴 → "홈 화면에 추가"

마이크는 https에서만 동작한다 (깃허브 페이지는 https라 OK).

## 공개 저장소 주의

이 저장소는 누구나 볼 수 있다. 아래만 지키면 안전하다.
- **AI 키(`sk-ant-...`)·비밀번호·service_role 키는 절대 커밋하지 않는다.** 모두 Supabase Secrets / Auth에만 둔다.
- 내 이메일은 `ALLOWED_EMAILS` 시크릿에만 넣는다 (코드에 쓰지 않음).
- `CONFIG`의 Supabase URL·anon(publishable) 키는 원래 브라우저에 공개되는 값이라 커밋해도 된다. 막는 건 RLS + 가입 차단 + `ALLOWED_EMAILS`가 한다.
- 커밋 작성자 이메일은 GitHub noreply 주소로 설정돼 있다 (이 저장소의 `git config user.email`).
- push 전 점검:

```bash
git grep -n -E "sk-ant-[A-Za-z0-9]|service_role|sb_secret_"
```

## 동작 요약

- **세션 흐름**: 워밍업(지난 표현 3개 듣고 따라 말하기) → 메인 대화 → 마무리 정리. 목표 시간 3분 전부터 AI가 마무리 쪽으로 이끌고, 시간이 다 되면 다음 답 뒤에 자동으로 정리한다. "끝" / "That's it for today"라고 말하거나 "오늘은 여기까지" 버튼을 눌러도 된다.
- **첫 세션 = 레벨 진단** (5분). 이후 모드는 기본 "번갈아" (자유 수다 ↔ 시나리오 1~12번 순서대로).
- **자동 레벨업**: 최근 5세션 영어 답변 비율 80% 이상 + 마무리 평가 "다음 단계 가능" → 다음 세션부터 +1.
- **복습**: 마무리 때 표현 5개 + 내일 문장 1개를 저장 → 다음 날(한국 시간 자정)부터 복습 탭에 뜬다. 알았음 1→3→7→18→45일, 헷갈림 간격 유지, 몰랐음 1일로 리셋.
- **핸즈프리**: 🖐️ 버튼. AI가 말을 끝내면 자동으로 듣고, 2초 조용하면 보낸다. 30초 동안 아무 말이 없으면 멈춘다.
- **음성 교체 지점**: `index.html`의 `STT.listen()`(듣기), `TTS.speak()`(말하기)만 바꾸면 클라우드 음성으로 교체된다.

## 명세와 다른 점 (작게)

- 테이블이 3개가 아니라 **4개**: `settings`를 따로 둬서 레벨·친구 이름·다음 시나리오가 폰·PC에서 같게 보인다.
- `messages`에 `repeat`, `recast`, `spoke_english` 칸 추가: 이어 하기 화면을 다시 그리고, "최근 틀린 패턴"을 뽑는 데 쓴다.
- 대화 중 `phrases`(턴마다 0~2개)는 바로 저장하지 않고 마무리 정리의 후보로만 넘긴다. 저장은 마무리 때 5개 + 내일 문장 1개만 (중복은 자동으로 건너뜀).
- 하루 호출 상한은 "오늘(한국 시간) AI 답변 수"로 센다.

## 완료 기준 체크 (명세 3-11)

- [ ] 폰 크롬에서 로그인 → 마이크 → 영어로 말하면 영어 답 + 목소리
- [ ] `한/영` 전환 → 한국어로 말하면 영어 문장(노란 박스)을 주고 따라 말하게 함
- [ ] 틀린 영어 → 내 말풍선 아래 "→ 더 자연스럽게: ..."
- [ ] 핸즈프리로 손 안 대고 5턴 이상
- [ ] 마무리 정리 → 복습에 저장
- [ ] 다음 날 복습 탭에 그 표현
- [ ] PC에서 로그인해도 같은 기록
- [ ] 개발자도구·깃허브 어디에도 AI 키 없음 (`grep -r sk-ant .` 결과 없음)

## 아이폰 사파리

`webkitSpeechRecognition`은 iOS 14.5+에서 동작하지만 기기·버전마다 불안정하다. 안 되면 텍스트 입력칸을 쓰면 되고, 듣기(TTS)는 정상 동작한다. 첫 소리는 화면을 한 번 탭한 뒤에 난다 (iOS 정책).
