// 영어 회화 친구 — AI 호출 Edge Function
// 액션: start(세션 시작+인사) / turn(대화 한 턴) / wrapup(세션 마무리 정리)
// API 키는 Supabase Secrets(ANTHROPIC_API_KEY)에만 있다. 브라우저로 절대 나가지 않는다.

import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const MODEL = Deno.env.get("AI_MODEL") || "claude-haiku-5-5";
const EFFORT = Deno.env.get("AI_EFFORT") || "low"; // "none"이면 effort를 안 보냄 (지원 안 하는 모델용)
const STRUCTURED = (Deno.env.get("AI_STRUCTURED") || "on") !== "off"; // JSON 스키마 강제 출력
const DAILY_LIMIT = Number(Deno.env.get("DAILY_CALL_LIMIT") || "300");
const ALLOWED_EMAILS = (Deno.env.get("ALLOWED_EMAILS") || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ───────────────────────── 커리큘럼 ─────────────────────────

const SCENARIOS = [
  { ko: "자기소개 / 하는 일 설명", en: "Introducing yourself and what you do" },
  { ko: "하루 일과, 주말에 한 일", en: "Daily routine and what you did last weekend" },
  { ko: "가족 이야기", en: "Talking about family" },
  { ko: "취미 (게임, 맛집, 여행)", en: "Hobbies: games, good restaurants, travel" },
  { ko: "식당에서 주문·요청·계산", en: "At a restaurant: ordering, asking for things, paying (you play the server)" },
  { ko: "길 묻기, 교통", en: "Asking for directions and getting around (you play a local)" },
  { ko: "호텔·공항 체크인", en: "Checking in at a hotel or airport (you play the staff)" },
  { ko: "제주 소개하기", en: "Introducing Jeju to a foreign friend who plans to visit" },
  { ko: "내 일 설명하기 — 식당 마케팅, 인플루언서, 리뷰", en: "Explaining my work: restaurant marketing, influencers, reviews" },
  { ko: "되묻기·시간 벌기", en: "Asking someone to repeat and buying time (you talk a bit fast on purpose so I practice 'Sorry, could you say that again?' and 'Let me think...')" },
  { ko: "의견 말하기, 맞장구, 대화 이어가기", en: "Giving opinions, reacting, and keeping a conversation going" },
  { ko: "전화·메시지로 예약하기", en: "Making a reservation by phone or message (you play the restaurant/hotel)" },
];

const LEVELS: Record<number, { desc: string; ko: string; len: string }> = {
  1: { desc: "거의 처음", ko: "자유롭게 허용. 내가 막히면 한국어로 도와줘도 된다", len: "5~6단어, 아주 쉬운 단어" },
  2: { desc: "짧은 답 가능", ko: "내가 막힐 때만 한국어로 짧게 도와준다", len: "8단어 안팎, 쉬운 단어" },
  3: { desc: "짧은 대화 가능", ko: "내가 뜻을 물을 때만 한국어를 쓴다", len: "10~12단어" },
  4: { desc: "일상 대화 조금", ko: "거의 쓰지 않는다. 영어로 쉽게 풀어서 설명한다", len: "자연스러운 길이 (그래도 1~2문장)" },
  5: { desc: "목표 도달", ko: "쓰지 않는다. 모르는 말은 영어로 다시 설명한다", len: "원어민 일상 대화 그대로" },
};

const DEFAULTS = {
  friend_name: "Emma",
  persona: "밝고 호기심 많고, 맛있는 음식과 여행 이야기를 좋아하는 친구",
  about_me:
    "40대 한국인 남성, 제주에 산다. 식당 위주로 온라인 마케팅 일을 한다. 아내와 초등학생 딸이 있다.\n목표: 원어민과 일상 대화를 버벅이더라도 끊기지 않고 이어 갈 수 있는 수준.",
  level: 1,
  level_mode: "auto",
  goal_min: 20,
  session_mode: "alternate",
  scenario_index: 0,
  diagnosed: false,
};
type Settings = typeof DEFAULTS & Record<string, unknown>;
type Mode = "free" | "scenario" | "diagnosis";

// ───────────────────────── 응답 스키마 ─────────────────────────

const RECAST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mine", "better", "note_ko"],
  properties: { mine: { type: "string" }, better: { type: "string" }, note_ko: { type: "string" } },
};
const TURN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["say", "ko", "repeat", "recast", "phrases", "user_spoke_english"],
  properties: {
    say: { type: "string" },
    ko: { type: "string" },
    repeat: { type: "string" },
    recast: { anyOf: [RECAST_SCHEMA, { type: "null" }] },
    phrases: { type: "array", items: { type: "string" } },
    user_spoke_english: { type: "boolean" },
  },
};
const WRAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["say", "ko", "phrases", "fixes", "tomorrow", "level"],
  properties: {
    say: { type: "string" },
    ko: { type: "string" },
    phrases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["english", "korean", "example"],
        properties: { english: { type: "string" }, korean: { type: "string" }, example: { type: "string" } },
      },
    },
    fixes: { type: "array", items: RECAST_SCHEMA },
    tomorrow: {
      type: "object",
      additionalProperties: false,
      required: ["english", "korean"],
      properties: { english: { type: "string" }, korean: { type: "string" } },
    },
    level: {
      type: "object",
      additionalProperties: false,
      required: ["level", "next_ok", "reason_ko"],
      properties: { level: { type: "integer" }, next_ok: { type: "boolean" }, reason_ko: { type: "string" } },
    },
  },
};

// ───────────────────────── 프롬프트 ─────────────────────────

function levelTable() {
  return Object.entries(LEVELS).map(([n, l]) => `L${n} ${l.desc}: 문장 ${l.len}, 한국어 ${l.ko}`).join("\n");
}

function buildTurnSystem(o: {
  s: Settings; mode: Mode; scenario: number | null; level: number;
  review: string[]; mistakes: { mine: string; better: string }[];
  userTurns: number; englishTurns: number; elapsedMin: number; goalMin: number;
}) {
  const L = LEVELS[o.level] ?? LEVELS[1];
  const parts: string[] = [];
  parts.push(
    `너는 나와 영어로 수다 떠는 친구 ${o.s.friend_name}야. 성격: ${o.s.persona}.
선생님 말고 친구처럼, 미국식 일상 영어로 말해.
너는 영어 연습을 돕는 AI 친구다. 사람인 척하지 마. 내가 물으면 "영어 연습을 돕는 AI 친구"라고 솔직히 말해. 취향이나 의견은 친구처럼 말해도 되지만, 실제로 겪은 일처럼 꾸며내지는 마.

[나에 대해]
${o.s.about_me}

[지금 내 수준] L${o.level} (${L.desc})
- 네 영어 문장 길이: ${L.len}
- 한국어 사용: ${L.ko}`,
  );

  parts.push(
    `[대화 규칙]
1. 한 번에 짧은 문장 1~2개. 반응 하나 + 쉬운 질문 하나.
2. 방금 내가 한 말에 대해서만 이어 간다.
3. 내가 한국어로 말하면 알아듣고, 그 말을 자연스러운 영어 문장으로 만들어 repeat에 넣고 따라 말하게 한다. say에서는 "You can say, ..." 처럼 짧게 이끈다.
4. 내가 영어로 틀리게 말하면 지적하지 말고, say 속에 맞는 표현을 자연스럽게 섞어서 되받는다. 그리고 recast에 기록한다.
   예: 나 "I go to Seoul yesterday" → say "Oh, you went to Seoul yesterday? For work?"
5. 한국어 도움은 점점 줄인다. 이번 세션에서 내 대답 ${o.userTurns}번 중 영어 ${o.englishTurns}번.${
      o.userTurns >= 2 ? " 이미 세 번째 대답 이후다. 내가 한국어로 말하면 부드럽게 영어로 해 보라고 이끌어 (첫 단어 몇 개를 힌트로 줘)." : ""
    }
6. 원어민이 실제로 쓰는 표현을 써. 교과서 문장 말고.
7. 네 say는 소리 내어 읽힌다. 이모지, 괄호, 목록, 마크다운 쓰지 마.
8. 내 말은 음성 인식 결과라 문장부호·대소문자가 없고, 가끔 엉뚱하게 인식된 단어가 섞인다. 그런 건 문제 삼지 말고 뜻을 짐작해서 이어 가.`,
  );

  if (o.mode === "diagnosis") {
    parts.push(
      `[오늘 모드: 레벨 진단]
첫 세션이다. 약 5분 동안 편하게 수다 떨면서 내 수준을 가늠해. 아주 쉬운 질문(이름, 사는 곳)부터 시작해서 하루 일과, 하는 일 설명, 간단한 의견 순으로 조금씩 어렵게. 시험 보는 느낌은 내지 마.`,
    );
  } else if (o.mode === "scenario" && o.scenario !== null) {
    const sc = SCENARIOS[o.scenario % SCENARIOS.length];
    parts.push(
      `[오늘 모드: 시나리오 ${o.scenario % SCENARIOS.length + 1}번 — ${sc.ko}]
상황: ${sc.en}
필요하면 네가 역할(점원, 직원, 현지인 등)을 맡아 상황극으로 진행해. 난이도는 L${o.level}에 맞춘다. 실제로 그 상황에서 쓰는 표현이 나오게 이끌어.`,
    );
  } else {
    parts.push(`[오늘 모드: 자유 수다]
내 일상(하루, 일, 가족, 취미, 제주, 주말 계획)에서 화제를 골라 편하게 이어 가.`);
  }

  if (o.review.length) {
    parts.push(`[복습 표현] 대화 중에 이 중 1~2개를 자연스럽게 써서, 내가 다시 쓰게 유도해:
${o.review.map((p) => `- ${p}`).join("\n")}`);
  }
  if (o.mistakes.length) {
    parts.push(`[최근 자주 틀린 패턴] 이 패턴이 다시 나오게 질문을 던져:
${o.mistakes.map((m) => `- "${m.mine}" → "${m.better}"`).join("\n")}`);
  }
  if (o.elapsedMin >= o.goalMin - 3) {
    parts.push(`[마무리 단계] 오늘 목표 시간(${o.goalMin}분)이 거의 다 됐다. 새 화제는 열지 말고, 1~2턴 안에 자연스럽게 대화를 마무리하는 쪽으로 가.`);
  }

  parts.push(
    `[응답 형식] 반드시 JSON 객체 하나만 출력한다. 다른 글은 쓰지 않는다.
- say: 네가 할 영어 말 (1~2문장)
- ko: say의 한국어 뜻
- repeat: 내가 따라 말할 짧은 영어 문장. 없으면 ""
- recast: 내가 영어로 말했고 더 자연스럽게 고칠 게 있을 때만 {"mine": 내가 한 말, "better": 더 자연스러운 표현, "note_ko": 한 줄 설명}. 아니면 null. 사소한 것(문장부호, 대소문자, 음성 인식 오류로 보이는 것)은 고치지 않는다.
- phrases: 오늘 저장해 둘 만한 원어민 표현 0~2개 (짧게). 없으면 []
- user_spoke_english: 내 마지막 말이 주로 영어였으면 true`,
  );
  return parts.join("\n\n");
}

function buildWrapSystem(s: Settings, mode: Mode, level: number, candidates: string[]) {
  return `너는 영어 회화 코치이자 학습자의 친구 ${s.friend_name}다. 아래는 오늘 영어 회화 세션 기록이다.

[학습자]
${s.about_me}
현재 레벨: L${level}

[레벨 기준]
${levelTable()}
${mode === "diagnosis" ? "\n이번 세션은 첫 레벨 진단이었다. level.level을 신중하게 판정해라.\n" : ""}
아래 JSON 하나만 출력한다:
- say: 친구로서 오늘 대화를 마무리하는 영어 인사 1~2문장 (L${level} 수준에 맞게), ko: 그 뜻
- phrases: 오늘 대화에서 나온 쓸 만한 원어민 표현 정확히 5개. {english: 짧은 표현이나 문장, korean: 뜻, example: 오늘 대화 맥락의 짧은 예문}. 학습자가 실제로 다시 쓸 만한 것 우선.${
    candidates.length ? `\n  후보(대화 중 뽑아 둔 것): ${candidates.join(" / ")}` : ""
  }
- fixes: 학습자가 자주 틀린 것 최대 3개 {mine: 학습자가 실제로 한 말, better: 더 나은 문장, note_ko: 한 줄 설명}. 영어를 거의 안 했다면, 한국어로 말한 것 중 영어로 해 봤으면 하는 것을 mine에 넣고 better에 영어 문장을 준다.
- tomorrow: 내일 써 볼 문장 1개 {english, korean}
- level: {level: 오늘 대화 기준 학습자 수준 1~5, next_ok: L${level}에서 한 단계 올려도 될 만하면 true, reason_ko: 판정 이유 한 줄}`;
}

// ───────────────────────── AI 호출 ─────────────────────────

type Msg = { role: "user" | "assistant"; content: string };

function looseParse(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text); } catch { /* 아래로 */ }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch { /* 아래로 */ }
  }
  return null;
}

async function callAI(system: string, messages: Msg[], schema: object, maxTokens: number) {
  const output_config: Record<string, unknown> = {};
  if (EFFORT !== "none") output_config.effort = EFFORT;
  if (STRUCTURED) output_config.format = { type: "json_schema", schema };
  // deno-lint-ignore no-explicit-any
  const res: any = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages,
    ...(Object.keys(output_config).length ? { output_config } : {}),
    // deno-lint-ignore no-explicit-any
  } as any);
  if (res.stop_reason === "refusal") return { parsed: null, raw: "" };
  // deno-lint-ignore no-explicit-any
  const raw = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  return { parsed: looseParse(raw), raw };
}

/** 대화 기록을 API 형식으로: 같은 역할이 연달아 오면 합치고, 첫 메시지는 user로 시작 */
function toApiMessages(rows: { role: string; text: string }[]): Msg[] {
  const out: Msg[] = [];
  for (const r of rows) {
    const role = r.role === "assistant" ? "assistant" : "user";
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += "\n" + r.text;
    else out.push({ role, content: r.text });
  }
  if (!out.length || out[0].role !== "user") out.unshift({ role: "user", content: "(세션 시작)" });
  return out;
}

/** 모델 응답을 3-5 형식으로 정리. JSON이 깨졌으면 say만 살린다. */
function cleanTurn(parsed: Record<string, unknown> | null, raw: string) {
  const p = parsed ?? {};
  const say = typeof p.say === "string" && p.say.trim()
    ? p.say.trim()
    : (raw.replace(/[{}"]/g, "").trim().slice(0, 300) || "Sorry, could you say that again?");
  const rc = p.recast as Record<string, string> | null | undefined;
  return {
    say,
    ko: typeof p.ko === "string" ? p.ko : "",
    repeat: typeof p.repeat === "string" ? p.repeat : "",
    recast: rc && rc.better && rc.mine ? { mine: rc.mine, better: rc.better, note_ko: rc.note_ko ?? "" } : null,
    phrases: Array.isArray(p.phrases) ? (p.phrases as unknown[]).filter((x) => typeof x === "string").slice(0, 2) : [],
    user_spoke_english: p.user_spoke_english === true,
  };
}

// ───────────────────────── DB 도우미 ─────────────────────────

/** 한국 시간 기준 자정 (offsetDays일 뒤) */
function kstDayStart(offsetDays = 0) {
  const k = new Date(Date.now() + 9 * 3600e3);
  k.setUTCHours(0, 0, 0, 0);
  return new Date(k.getTime() - 9 * 3600e3 + offsetDays * 86400e3);
}

async function getSettings(sb: SupabaseClient): Promise<Settings> {
  const { data } = await sb.from("settings").select("data").maybeSingle();
  return { ...DEFAULTS, ...(data?.data ?? {}) } as Settings;
}

async function saveSettings(sb: SupabaseClient, userId: string, s: Settings) {
  await sb.from("settings").upsert({ user_id: userId, data: s, updated_at: new Date().toISOString() });
}

async function reviewPhrases(sb: SupabaseClient) {
  const { data } = await sb.from("phrases").select("english").neq("status", "known")
    .order("next_review_at", { ascending: true }).limit(5);
  return (data ?? []).map((r) => r.english as string);
}

async function recentMistakes(sb: SupabaseClient) {
  const { data: last } = await sb.from("sessions").select("summary_json").not("summary_json", "is", null)
    .order("started_at", { ascending: false }).limit(1).maybeSingle();
  const fixes = ((last?.summary_json as { fixes?: { mine: string; better: string }[] })?.fixes ?? []).slice(0, 3);
  if (fixes.length >= 3) return fixes;
  const { data } = await sb.from("messages").select("recast").not("recast", "is", null)
    .order("created_at", { ascending: false }).limit(3 - fixes.length);
  return [...fixes, ...(data ?? []).map((r) => r.recast as { mine: string; better: string })];
}

function elapsedMinutes(startedAt: string) {
  return Math.max(0, (Date.now() - new Date(startedAt).getTime()) / 60000);
}

function goalFor(s: Settings, mode: Mode) {
  return mode === "diagnosis" ? 5 : Number(s.goal_min) || 20;
}

// ───────────────────────── 액션 ─────────────────────────

async function actionStart(sb: SupabaseClient, userId: string) {
  const s = await getSettings(sb);
  let mode: Mode;
  if (!s.diagnosed) mode = "diagnosis";
  else if (s.session_mode === "free" || s.session_mode === "scenario") mode = s.session_mode as Mode;
  else {
    const { data: last } = await sb.from("sessions").select("mode").neq("mode", "diagnosis")
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    mode = last?.mode === "scenario" ? "free" : "scenario";
  }
  const scenario = mode === "scenario" ? Number(s.scenario_index) % SCENARIOS.length : null;
  const level = Number(s.level) || 1;

  const { data: session, error } = await sb.from("sessions")
    .insert({ mode, scenario, level }).select().single();
  if (error) throw error;

  // 워밍업: 오늘 복습할 표현 → 부족하면 최근 표현으로 채움 (3개)
  const { data: due } = await sb.from("phrases").select("id, english, korean, example")
    .lte("next_review_at", new Date().toISOString()).order("next_review_at").limit(3);
  let warmup = due ?? [];
  if (warmup.length < 3) {
    const { data: recent } = await sb.from("phrases").select("id, english, korean, example")
      .order("created_at", { ascending: false }).limit(6);
    for (const r of recent ?? []) {
      if (warmup.length >= 3) break;
      if (!warmup.some((w) => w.id === r.id)) warmup.push(r);
    }
  }
  warmup = warmup.slice(0, 3);

  const system = buildTurnSystem({
    s, mode, scenario, level,
    review: await reviewPhrases(sb), mistakes: await recentMistakes(sb),
    userTurns: 0, englishTurns: 0, elapsedMin: 0, goalMin: goalFor(s, mode),
  });
  const kickoff = mode === "scenario"
    ? "(세션 시작. 오늘 시나리오 상황을 짧게 열고 첫 질문 하나. ko에는 상황 설명도 한국어로 한 줄 넣어 줘.)"
    : "(세션 시작. 먼저 짧게 인사하고, 오늘 하루가 어땠는지 하나만 물어봐.)";
  const { parsed, raw } = await callAI(system, [{ role: "user", content: kickoff }], TURN_SCHEMA, 3000);
  const reply = cleanTurn(parsed, raw);
  reply.recast = null;

  await sb.from("messages").insert({
    session_id: session.id, role: "assistant", text: reply.say, ko: reply.ko, repeat: reply.repeat || null,
  });

  return {
    session, reply, warmup,
    scenario_title: scenario !== null ? `${scenario + 1}. ${SCENARIOS[scenario].ko}` : null,
    goal_min: goalFor(s, mode),
    user_id: userId,
  };
}

async function actionTurn(sb: SupabaseClient, body: { session_id: string; text: string }) {
  const text = String(body.text ?? "").trim().slice(0, 1000);
  if (!text) return json({ error: "빈 메시지" }, 400);

  const { data: session, error } = await sb.from("sessions").select("*").eq("id", body.session_id).single();
  if (error || !session) return json({ error: "세션을 찾을 수 없음" }, 404);
  if (session.ended_at) return json({ error: "이미 끝난 세션" }, 409);

  const { data: userMsg } = await sb.from("messages")
    .insert({ session_id: session.id, role: "user", text }).select("id").single();

  const { data: hist } = await sb.from("messages").select("role, text")
    .eq("session_id", session.id).order("created_at", { ascending: false }).limit(20);
  const history = toApiMessages((hist ?? []).reverse());

  const s = await getSettings(sb);
  const system = buildTurnSystem({
    s, mode: session.mode, scenario: session.scenario, level: session.level,
    review: await reviewPhrases(sb), mistakes: await recentMistakes(sb),
    userTurns: session.user_turns, englishTurns: session.english_turns,
    elapsedMin: elapsedMinutes(session.started_at), goalMin: goalFor(s, session.mode),
  });
  const { parsed, raw } = await callAI(system, history, TURN_SCHEMA, 3000);
  const reply = cleanTurn(parsed, raw);
  if (!reply.user_spoke_english) reply.recast = null;

  await sb.from("messages").insert({
    session_id: session.id, role: "assistant", text: reply.say, ko: reply.ko,
    repeat: reply.repeat || null, recast: reply.recast,
  });
  if (userMsg) await sb.from("messages").update({ spoke_english: reply.user_spoke_english }).eq("id", userMsg.id);

  const user_turns = session.user_turns + 1;
  const english_turns = session.english_turns + (reply.user_spoke_english ? 1 : 0);
  const minutes = Math.round(elapsedMinutes(session.started_at) * 10) / 10;
  await sb.from("sessions").update({ user_turns, english_turns, minutes }).eq("id", session.id);

  return json({ reply, user_turns, english_turns, minutes });
}

async function actionWrapup(sb: SupabaseClient, userId: string, body: { session_id: string; candidates?: string[] }) {
  const { data: session, error } = await sb.from("sessions").select("*").eq("id", body.session_id).single();
  if (error || !session) return json({ error: "세션을 찾을 수 없음" }, 404);
  if (session.ended_at && session.summary_json) return json({ summary: session.summary_json, already: true });

  const { data: msgs } = await sb.from("messages").select("role, text")
    .eq("session_id", session.id).order("created_at").limit(80);
  const transcript = (msgs ?? []).map((m) => `${m.role === "user" ? "학습자" : "친구"}: ${m.text}`).join("\n");

  const s = await getSettings(sb);
  const candidates = (body.candidates ?? []).filter((c) => typeof c === "string").slice(0, 20);
  const system = buildWrapSystem(s, session.mode, session.level, candidates);
  const { parsed } = await callAI(
    system,
    [{ role: "user", content: `[오늘 대화 기록]\n${transcript || "(대화 없음)"}` }],
    WRAP_SCHEMA,
    6000,
  );
  // deno-lint-ignore no-explicit-any
  const p: any = parsed ?? {};
  const summary = {
    say: String(p.say ?? "Great job today! See you tomorrow."),
    ko: String(p.ko ?? "오늘 잘했어! 내일 또 보자."),
    phrases: (Array.isArray(p.phrases) ? p.phrases : []).filter((x: { english?: string }) => x?.english).slice(0, 5),
    fixes: (Array.isArray(p.fixes) ? p.fixes : []).filter((x: { better?: string }) => x?.better).slice(0, 3),
    tomorrow: p.tomorrow?.english ? p.tomorrow : null,
    level: {
      level: Math.min(5, Math.max(1, Math.round(Number(p.level?.level) || session.level))),
      next_ok: p.level?.next_ok === true,
      reason_ko: String(p.level?.reason_ko ?? ""),
    },
    level_before: session.level,
    level_after: session.level,
    english_ratio: session.user_turns ? session.english_turns / session.user_turns : 0,
  };

  // 표현 저장 → 다음 날(한국 시간 자정)부터 복습에 뜸
  const nextReview = kstDayStart(1).toISOString();
  const rows = [
    ...summary.phrases.map((x: { english: string; korean?: string; example?: string }) => ({
      english: x.english.trim(), korean: x.korean ?? null, example: x.example ?? null,
    })),
    ...(summary.tomorrow ? [{ english: summary.tomorrow.english.trim(), korean: summary.tomorrow.korean ?? null, example: null }] : []),
  ].map((r) => ({ ...r, source_session_id: session.id, next_review_at: nextReview, interval_days: 1, status: "new" }));
  if (rows.length) {
    await sb.from("phrases").upsert(rows, { onConflict: "user_id,english_norm", ignoreDuplicates: true });
  }

  const minutes = Math.round(elapsedMinutes(session.started_at) * 10) / 10;
  await sb.from("sessions").update({ ended_at: new Date().toISOString(), minutes, summary_json: summary }).eq("id", session.id);

  // 레벨·커리큘럼 진행
  const next = { ...s };
  if (session.mode === "diagnosis") {
    next.diagnosed = true;
    if (s.level_mode === "auto") next.level = summary.level.level;
  } else if (s.level_mode === "auto" && summary.level.next_ok && s.level < 5) {
    const { data: recent } = await sb.from("sessions").select("user_turns, english_turns")
      .not("ended_at", "is", null).gt("user_turns", 0).order("started_at", { ascending: false }).limit(5);
    const r = recent ?? [];
    const ut = r.reduce((a, x) => a + x.user_turns, 0);
    const et = r.reduce((a, x) => a + x.english_turns, 0);
    if (r.length >= 5 && ut > 0 && et / ut >= 0.8) next.level = s.level + 1;
  }
  if (session.mode === "scenario") next.scenario_index = (Number(s.scenario_index) + 1) % SCENARIOS.length;
  summary.level_after = next.level;
  await saveSettings(sb, userId, next);
  if (summary.level_after !== summary.level_before) {
    await sb.from("sessions").update({ summary_json: summary }).eq("id", session.id);
  }

  return json({ summary, settings: next });
}

// ───────────────────────── 진입점 ─────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST만 가능" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "로그인 필요" }, 401);

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return json({ error: "로그인 필요" }, 401);
  if (!ALLOWED_EMAILS.length) return json({ error: "서버 설정 필요: ALLOWED_EMAILS 시크릿이 비어 있음" }, 403);
  if (!ALLOWED_EMAILS.includes((user.email ?? "").toLowerCase())) return json({ error: "허용되지 않은 계정" }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "잘못된 요청" }, 400); }

  try {
    if (body.action === "start" || body.action === "turn") {
      const { count } = await sb.from("messages").select("id", { count: "exact", head: true })
        .eq("role", "assistant").gte("created_at", kstDayStart(0).toISOString());
      if ((count ?? 0) >= DAILY_LIMIT) {
        return json({ error: `오늘 호출 한도(${DAILY_LIMIT}회)를 다 썼어요. 내일 다시!` }, 429);
      }
    }
    switch (body.action) {
      case "start": return json(await actionStart(sb, user.id));
      case "turn": return await actionTurn(sb, body as { session_id: string; text: string });
      case "wrapup": return await actionWrapup(sb, user.id, body as { session_id: string; candidates?: string[] });
      default: return json({ error: "알 수 없는 action" }, 400);
    }
  } catch (e) {
    console.error(e);
    const status = e instanceof Anthropic.RateLimitError ? 429
      : e instanceof Anthropic.APIError ? 502 : 500;
    return json({ error: status === 429 ? "AI가 잠깐 바빠요. 몇 초 뒤 다시." : "서버 오류" }, status);
  }
});
