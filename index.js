/**
 * INDEX V13 — LIA CONVERSACIONAL OTIMIZADA
 *
 * Base: INDEX 4 híbrida + Conversational Funnel + Diagnostic Script + Question Priority Engine.
 *
 * OBJETIVO:
 * - mais humana no início (50% IA / 50% regras)
 * - responder perguntas ANTES do funil
 * - usar evidência com números/percentuais no momento certo
 * - manter agenda, lock de horários e Mercado Pago determinísticos
 * - aumentar conversão sem perder compliance
 *
 * PRINCÍPIOS:
 * 1) Pergunta do paciente vem primeiro.
 * 2) Rapport no início, sem parecer formulário.
 * 3) Diagnostic Script com no máximo 3 perguntas.
 * 4) Evidence com percentual no máximo 2x por conversa.
 * 5) Agenda, preço, plano e pagamento continuam no código.
 *
 * ENV:
 * OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, DATABASE_URL
 * MP_ACCESS_TOKEN, PUBLIC_BASE_URL
 * MODEL_CHAT (opcional, padrão gpt-4.1)
 * MIN_DELAY_SEC / MAX_DELAY_SEC (opcional)
 */

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());
app.use("/mp", express.json({ type: ["application/json", "text/json", "*/*"] }));

const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  DATABASE_URL,
  MODEL_CHAT,
  MIN_DELAY_SEC,
  MAX_DELAY_SEC,
  MP_ACCESS_TOKEN,
  PUBLIC_BASE_URL,
  CRON_SECRET,
} = process.env;

if (!OPENAI_API_KEY) console.error("❌ Falta OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) console.error("❌ Falta TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN");
if (!DATABASE_URL) console.error("❌ Falta DATABASE_URL");
if (!MP_ACCESS_TOKEN) console.error("❌ Falta MP_ACCESS_TOKEN");
if (!PUBLIC_BASE_URL) console.warn("⚠️ PUBLIC_BASE_URL não definido.");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const CHAT_MODEL = MODEL_CHAT || "gpt-4.1";
const MIN_DELAY = Number(MIN_DELAY_SEC || 1);
const MAX_DELAY = Number(MAX_DELAY_SEC || 4);
const BASE_URL = (PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "") || "http://localhost:10000";
const HOLD_MINUTES = 15;
const ADMIN_RESET_PHONE_DIGITS = "556581422637";
const FOLLOWUP_STAGE_WINDOWS = [
  { minMs: 30 * 60 * 1000, maxMs: 90 * 60 * 1000 },
  { minMs: 2 * 60 * 60 * 1000, maxMs: 6 * 60 * 60 * 1000 },
  { minMs: 24 * 60 * 60 * 1000, maxMs: 24 * 60 * 60 * 1000 },
];

const PLANS = {
  full: {
    key: "full",
    label: "Acompanhamento Médico Especializado",
    subtitle: "Consulta + Retorno ~30 dias",
    price: 447,
    short: "1",
  },
  basic: {
    key: "basic",
    label: "Avaliação Médica Especializada",
    subtitle: "45 min",
    price: 347,
    short: "2",
  },
  retorno: {
    key: "retorno",
    label: "Consulta de Ajuste",
    subtitle: "Retorno avulso",
    price: 200,
    short: "3",
  },
};

// Agenda inicial: quarta, quinta e sexta, 9h–21h, horário de Brasília.
const FIXED_SCHEDULE = {
  "11-03": { dayName: "quarta-feira", slots: ["9h", "10h", "11h", "12h", "13h", "14h", "15h", "16h", "17h", "18h", "19h", "20h", "21h"] },
  "12-03": { dayName: "quinta-feira", slots: ["9h", "10h", "11h", "12h", "13h", "14h", "15h", "16h", "17h", "18h", "19h", "20h", "21h"] },
  "13-03": { dayName: "sexta-feira", slots: ["9h", "10h", "11h", "12h", "13h", "14h", "15h", "16h", "17h", "18h", "19h", "20h", "21h"] },
};

const PREMIUM_SLOT_PRIORITY = ["19h", "18h", "20h", "17h", "21h", "16h", "15h", "14h", "13h", "12h", "11h", "10h", "9h"];
const WEEKDAY_PT = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
pool.on("error", (err) => console.error("❌ Postgres pool error:", err));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_users (
      phone TEXT PRIMARY KEY,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_slot_locks (
      slot_key TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'held',
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );
  `);

  console.log("✅ Tabelas prontas.");
}
initDB().catch((e) => console.error("❌ initDB erro:", e));

async function getUserState(phone) {
  const { rows } = await pool.query("SELECT state FROM wa_users WHERE phone=$1", [phone]);
  if (rows.length) return rows[0].state || {};

  await pool.query(
    "INSERT INTO wa_users (phone, state) VALUES ($1, $2::jsonb) ON CONFLICT (phone) DO NOTHING",
    [phone, JSON.stringify({})]
  );
  return {};
}

async function saveUserState(phone, newState) {
  await pool.query(
    `INSERT INTO wa_users (phone, state, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (phone)
     DO UPDATE SET state=$2::jsonb, updated_at=NOW()`,
    [phone, JSON.stringify(newState)]
  );
}

function mergeState(oldState, updates) {
  const out = { ...(oldState || {}) };
  for (const [k, v] of Object.entries(updates || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = v;
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randMs(minMs, maxMs) { return randInt(minMs, maxMs); }
function pad2(n) { return String(n).padStart(2, "0"); }
function currentYear() { return new Date().getFullYear(); }
function nowMs() { return Date.now(); }
function removeDuplicates(arr) { return [...new Set(arr)]; }
function pickRandom(arr) { return Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : ""; }

function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function clip(text, max = 1100) {
  const t = (text || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trim();
}

function similar(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  if (x.length > 60 && y.length > 60 && x.slice(0, 60) === y.slice(0, 60)) return true;
  return false;
}

function makeDateKey(day, month = 3) {
  return `${pad2(day)}-${pad2(month)}`;
}

function parseDateKeyToDate(dateKey) {
  const [dd, mm] = dateKey.split("-").map(Number);
  return new Date(currentYear(), mm - 1, dd);
}

function formatDatePt(dateKey) {
  const dt = parseDateKeyToDate(dateKey);
  const wd = WEEKDAY_PT[dt.getDay()];
  return `${wd} (${dateKey.replace("-", "/")})`;
}

function slotKey(dateKey, time) {
  return `${dateKey}|${time}`;
}

function prettySlot(dateKey, time) {
  return `${formatDatePt(dateKey)} às ${time} (horário de Brasília)`;
}

function extractNameFromText(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const low = norm(t);

  if (/(sim|ok|beleza|pode|claro|show|tanto faz|nao|não|dor|sono|ansiedade|fibromialgia|insônia|insonia)/.test(low) && t.split(" ").length <= 2) {
    if (/(dor|sono|ansiedade|fibromialgia|insônia|insonia)/.test(low)) return null;
  }

  const cleaned = t.replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  const mCall = cleaned.match(/(?:pode me chamar de|pode chamar de|me chama de)\s+(.+)$/iu);
  const m = cleaned.match(/(?:me chamo|sou|nome e|nome é)\s+(.+)$/iu);
  const candidate = (mCall?.[1] || m?.[1] || cleaned).trim();
  const parts = candidate.split(" ").filter(Boolean);

  if (parts.length < 1 || parts.length > 5) return null;
  if (/^\d+$/.test(candidate)) return null;
  if (/^(pode|sim|nao|não|ok|beleza|claro)$/i.test(parts[0]) && parts.length === 1) return null;
  if (/(dor|sono|ansiedade|fibromialgia|artrose|artrite|enxaqueca|coluna|insônia|insonia)/i.test(candidate) && parts.length <= 2) return null;

  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

function extractFirstName(text) {
  const n = extractNameFromText(text);
  return n ? n.split(" ")[0] : null;
}

function extractFullName(text) {
  const cleaned = (text || "").replace(/[^\p{L}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

function extractBirthDate(text) {
  const t = (text || "").trim();
  const m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
  if (!m) return null;

  let dd = Number(m[1]);
  let mm = Number(m[2]);
  let yy = Number(m[3]);
  if (yy < 100) yy += 1900;
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
  return `${pad2(dd)}/${pad2(mm)}/${yy}`;
}

function extractEmail(text) {
  const m = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].trim() : null;
}

function detectCondition(text) {
  const t = norm(text);
  if (t.includes("fibromialgia")) return "fibromialgia";
  if (t.includes("dor neuropatica") || t.includes("dor neuropática") || t.includes("neuropat")) return "dor_neuropatica";
  if (t.includes("artrose")) return "artrose";
  if (t.includes("artrite")) return "artrite";
  if (t.includes("lombar") || t.includes("coluna")) return "dor_lombar";
  if (t.includes("insônia") || t.includes("insonia") || t.includes("sono") || t.includes("dormir")) return "insonia";
  if (t.includes("ansiedade") || t.includes("panico") || t.includes("pânico")) return "ansiedade";
  if (t.includes("enxaqueca")) return "enxaqueca";
  if (t.includes("dor")) return "dor_cronica";
  return null;
}

function extractProblemText(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const low = norm(t);
  if (/(dor|fibromialgia|insônia|insonia|sono|ansiedade|panico|pânico|artrose|artrite|enxaqueca|coluna|lombar|neuropat)/.test(low)) return t;
  const m = t.match(/(?:quero tratar|tratar|meu problema e|meu problema é|tenho|sofro com)\s+(.+)$/i);
  if (m?.[1]) return m[1].trim();
  return null;
}

function extractDateKey(text) {
  const t = String(text || "");
  const m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})\b/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    if (mm === 3 && dd >= 1 && dd <= 31) return makeDateKey(dd, mm);
  }
  const low = norm(t);
  if (/\bquarta\b/.test(low)) return "11-03";
  if (/\bquinta\b/.test(low)) return "12-03";
  if (/\bsexta\b/.test(low)) return "13-03";
  return null;
}

function extractHourOnly(text) {
  const low = norm(text);
  const m = low.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    return mm === 0 ? `${hh}h` : `${pad2(hh)}:${pad2(mm)}`;
  }
  const m2 = low.match(/\b([01]?\d|2[0-3])\s?h\b/);
  if (m2) return `${Number(m2[1])}h`;
  return null;
}

function extractNumericChoice(text) {
  const t = norm(text);
  if (/\b1\b|primeiro|primeira/.test(t)) return 1;
  if (/\b2\b|segundo|segunda/.test(t)) return 2;
  if (/\b3\b|terceiro|terceira/.test(t)) return 3;
  return null;
}

function extractPlanChoice(text) {
  const t = norm(text);
  if (!t) return null;
  if (/^\s*(1|opcao 1|opção 1|primeira|primeiro)\s*$/.test(t)) return "full";
  if (/^\s*(2|opcao 2|opção 2|segunda|segundo)\s*$/.test(t)) return "basic";
  if (/^\s*(3|opcao 3|opção 3|terceira|terceiro)\s*$/.test(t)) return "retorno";

  const choose1 = /\b(quero|prefiro|vou|fecho|pode ser|acho melhor|faz mais sentido)\b.*\b(opcao|opção|plano)?\s*1\b/.test(t);
  const choose2 = /\b(quero|prefiro|vou|fecho|pode ser|acho melhor|faz mais sentido)\b.*\b(opcao|opção|plano)?\s*2\b/.test(t)
    || /\b(a|opcao|opção)\s*2\b.*\b(faz mais sentido|pra mim|para mim)\b/.test(t);
  const choose3 = /\b(quero|prefiro|vou|fecho|pode ser|acho melhor|faz mais sentido)\b.*\b(opcao|opção|plano)?\s*3\b/.test(t);
  if (choose1) return "full";
  if (choose2) return "basic";
  if (choose3) return "retorno";

  if (/\b(447|consulta com retorno|com retorno|acompanhamento|mais completa|mais completo|plano completo)\b/.test(t)) return "full";
  if (/\b(347|avaliacao|avaliação|consulta inicial|primeira consulta|mais simples|so a consulta|só a consulta)\b/.test(t)) return "basic";
  if (/\b(200|retorno avulso|consulta de ajuste|so retorno|só retorno|apenas retorno|a de retorno|de retorno)\b/.test(t)) return "retorno";

  if (/\b(link)\b.*\b(opcao|opção)\s*1\b/.test(t)) return "full";
  if (/\b(link)\b.*\b(opcao|opção)\s*2\b/.test(t)) return "basic";
  if (/\b(link)\b.*\b(opcao|opção)\s*3\b/.test(t)) return "retorno";

  return null;
}

function wantsReschedule(text) {
  const t = norm(text);
  return /(trocar|mudar|alterar|pode ser|prefiro|so posso|só posso|nao posso|não posso|melhor)/.test(t) && !!extractHourOnly(text);
}

function maybeUseName(state) {
  const nome = state?.nome;
  if (!nome) return "";
  const used = Number(state?.name_used_count || 0);
  if (used < 2 || used % 6 === 0) return nome;
  return "";
}

const EVIDENCE_DB = {
  fibromialgia: {
    empathy: [
      "Entendo… fibromialgia realmente pode ser muito desgastante.",
      "Fibromialgia costuma impactar muito a rotina, o sono e até o emocional.",
      "Quem tem fibromialgia muitas vezes sente que o corpo nunca descansa.",
    ],
    study: "Um estudo publicado no *Pain Medicine* mostrou redução média de cerca de *60% na intensidade da dor* em pacientes com fibromialgia após algumas semanas de tratamento com canabinoides.",
    bridge: "Claro que cada caso é diferente, e é justamente isso que o Dr. Alef avalia com precisão na consulta.",
  },
  dor_cronica: {
    empathy: [
      "Entendo… viver com dor constante desgasta muito a qualidade de vida.",
      "Dor crônica realmente pode mexer com sono, humor e energia.",
      "Muita gente com dor passa anos tentando melhorar sem encontrar algo que ajude de verdade.",
    ],
    study: "Estudos clínicos mostram redução relevante da intensidade da dor em muitos pacientes com dor crônica, e em alguns cenários a melhora observada ficou por volta de *50%*.",
    bridge: "O ponto importante é avaliar se isso pode fazer sentido para o seu quadro, com segurança.",
  },
  dor_lombar: {
    empathy: [
      "Entendo… dor lombar pode limitar muito a rotina.",
      "Quando a coluna dói todos os dias, isso vai desgastando bastante.",
      "Dor lombar crônica costuma atrapalhar movimento, sono e produtividade.",
    ],
    study: "Estudos em dor lombar crônica mostram melhora relevante de sintomas em parte dos pacientes tratados com canabinoides, com resultados que podem se aproximar de *40% a 50%* em alguns desfechos clínicos.",
    bridge: "Mas quem vai dizer se isso faz sentido para você é o Dr. Alef, avaliando seu histórico completo.",
  },
  dor_neuropatica: {
    empathy: [
      "Entendo… dor neuropática é uma das dores mais difíceis de tratar.",
      "Dor neuropática costuma ser muito incômoda, principalmente quando vem como queimação, choque ou formigamento.",
      "Muita gente com dor neuropática passa muito tempo buscando algo que realmente ajude.",
    ],
    study: "Em dor neuropática, estudos clínicos mostram melhora significativa em uma parcela dos pacientes, com reduções de sintomas que em alguns trabalhos ficaram na faixa de *30% a 50%*.",
    bridge: "Isso pode indicar um quadro de dor neuropática, porém somente o Dr. Alef pode avaliar com precisão e te dizer o melhor caminho.",
  },
  ansiedade: {
    empathy: [
      "Entendo… ansiedade constante desgasta muito a mente e o corpo.",
      "Ansiedade pode dominar o dia da pessoa e atrapalhar até o descanso.",
      "Muita gente com ansiedade sente dificuldade até para relaxar de verdade.",
    ],
    study: "Um estudo publicado no *Neurotherapeutics* mostrou redução significativa dos sintomas de ansiedade em muitos pacientes, com respostas clinicamente relevantes.",
    bridge: "Mas a consulta é justamente para entender se esse caminho pode fazer sentido para o seu caso, com segurança.",
  },
  insonia: {
    empathy: [
      "Entendo… dormir mal afeta absolutamente tudo.",
      "Insônia realmente compromete energia, humor e concentração.",
      "Quando a pessoa dorme mal por muito tempo, isso vai desgastando várias áreas da vida.",
    ],
    study: "Estudos clínicos mostram melhora significativa da qualidade do sono em muitos pacientes, e em alguns levantamentos o impacto percebido no sono foi um dos principais motivos de procura por cannabis medicinal.",
    bridge: "A avaliação serve para entender o seu padrão de sono e se esse tratamento pode fazer sentido para você.",
  },
  artrose: {
    empathy: [
      "Entendo… artrose pode limitar muito movimento e qualidade de vida.",
      "Artrose costuma gerar dor constante e rigidez nas articulações.",
      "Muita gente com artrose sente dificuldade até nas tarefas simples.",
    ],
    study: "Em artrose, estudos indicam redução de dor e melhora funcional em parte dos pacientes, com respostas que em alguns cenários ficam na faixa de *30% a 50%*.",
    bridge: "Mas isso precisa ser individualizado, principalmente considerando seu histórico e outras medicações.",
  },
  artrite: {
    empathy: [
      "Entendo… artrite realmente pode causar muita dor e inflamação.",
      "A artrite costuma limitar bastante o dia a dia.",
      "Muita gente com artrite sofre com dor articular constante e rigidez.",
    ],
    study: "Estudos sugerem melhora de dor e inflamação em parte dos pacientes com artrite, com resultados clínicos relevantes em alguns trabalhos.",
    bridge: "Só que isso sempre precisa ser avaliado com critério pelo médico responsável.",
  },
  enxaqueca: {
    empathy: [
      "Entendo… enxaqueca pode ser extremamente incapacitante.",
      "Quem sofre com enxaqueca sabe como isso pode parar o dia inteiro.",
      "Enxaqueca recorrente realmente desgasta muito.",
    ],
    study: "Estudos clínicos indicam redução da frequência e da intensidade das crises em parte dos pacientes com enxaqueca.",
    bridge: "O Dr. Alef avalia se isso pode fazer sentido para o seu caso específico.",
  },
};

function buildEvidenceMessage(condition) {
  const ev = EVIDENCE_DB[condition];
  if (!ev) return null;
  return `${pickRandom(ev.empathy)}\n\n${ev.study}\n\n${ev.bridge}`;
}

function shouldUseEvidence(flags, state, incomingText) {
  if (Number(state.evidence_used_count || 0) >= 2) return false;
  if (flags.asksHowConsultWorks || flags.asksLegal || flags.asksIfOnline || flags.asksChapado || flags.asksPriceDirect) return false;
  const cond = detectCondition(incomingText) || state.condition || null;
  if (!cond) return false;
  if (flags.asksIfWorks) return true;
  if (flags.saysUnsure && !flags.asksHowConsultWorks) return true;
  if (!state.problem_text && cond) return true;
  const t = norm(incomingText);
  if (/(nao aguento|não aguento|to sofrendo|tô sofrendo|muito ruim|muito dificil|muito difícil)/.test(t)) return true;
  return false;
}

function getGenericSlotsForDate(dateKey) {
  return FIXED_SCHEDULE[dateKey] ? [...FIXED_SCHEDULE[dateKey].slots] : [];
}
function getBaseSlotsForDate(dateKey) { return getGenericSlotsForDate(dateKey); }
function sortSlotsSmart(slots) {
  const unique = removeDuplicates(slots);
  const prioritized = [];
  for (const p of PREMIUM_SLOT_PRIORITY) if (unique.includes(p)) prioritized.push(p);
  for (const s of unique) if (!prioritized.includes(s)) prioritized.push(s);
  return prioritized;
}

async function cleanupExpiredLocks() {
  await pool.query(`DELETE FROM wa_slot_locks WHERE status='held' AND expires_at IS NOT NULL AND expires_at < NOW()`);
}

async function getBlockedSlotKeysForDate(dateKey) {
  await cleanupExpiredLocks();
  const { rows } = await pool.query(
    `SELECT slot_key
     FROM wa_slot_locks
     WHERE slot_key LIKE $1
       AND (status='paid' OR (status='held' AND expires_at > NOW()))`,
    [`${dateKey}|%`]
  );
  return new Set(rows.map((r) => r.slot_key));
}

async function getAvailableSlotsForDate(dateKey) {
  const base = getBaseSlotsForDate(dateKey);
  const blocked = await getBlockedSlotKeysForDate(dateKey);
  return base.filter((t) => !blocked.has(slotKey(dateKey, t)));
}

async function chooseBestSlotsForDate(dateKey, max = 3) {
  const available = await getAvailableSlotsForDate(dateKey);
  return sortSlotsSmart(available).slice(0, max);
}

async function acquireSlotHold(dateKey, time, phone, minutes = HOLD_MINUTES) {
  await cleanupExpiredLocks();
  const key = slotKey(dateKey, time);
  const existing = await pool.query(`SELECT * FROM wa_slot_locks WHERE slot_key=$1`, [key]);

  if (!existing.rows.length) {
    await pool.query(
      `INSERT INTO wa_slot_locks (slot_key, phone, status, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'held', NOW() + ($3 || ' minutes')::interval, NOW(), NOW())`,
      [key, phone, String(minutes)]
    );
    return { ok: true, slot_key: key };
  }

  const row = existing.rows[0];
  if (row.status === "paid") return { ok: false, reason: "paid" };

  if (row.status === "held" && row.phone === phone) {
    await pool.query(
      `UPDATE wa_slot_locks SET expires_at = NOW() + ($2 || ' minutes')::interval, updated_at = NOW() WHERE slot_key=$1`,
      [key, String(minutes)]
    );
    return { ok: true, slot_key: key };
  }

  if (row.status === "held" && row.expires_at && new Date(row.expires_at) > new Date()) {
    return { ok: false, reason: "held" };
  }

  await pool.query(
    `UPDATE wa_slot_locks
     SET phone=$2, status='held', expires_at = NOW() + ($3 || ' minutes')::interval, updated_at = NOW(), paid_at = NULL
     WHERE slot_key=$1`,
    [key, phone, String(minutes)]
  );
  return { ok: true, slot_key: key };
}

async function markSlotPaid(key, phone) {
  if (!key) return;
  await pool.query(
    `UPDATE wa_slot_locks
     SET status='paid', expires_at = NULL, paid_at = NOW(), updated_at = NOW()
     WHERE slot_key=$1 AND phone=$2`,
    [key, phone]
  );
}

async function releaseOldHeldSlotsForPhone(phone, keepSlotKey = null) {
  if (!phone) return;
  if (keepSlotKey) {
    await pool.query(`DELETE FROM wa_slot_locks WHERE phone=$1 AND status='held' AND slot_key <> $2`, [phone, keepSlotKey]);
  } else {
    await pool.query(`DELETE FROM wa_slot_locks WHERE phone=$1 AND status='held'`, [phone]);
  }
}

async function getSuggestedDayKeys() {
  const base = Object.keys(FIXED_SCHEDULE);
  const out = [];
  for (const d of base) {
    const slots = await getAvailableSlotsForDate(d);
    if (slots.length) out.push(d);
  }
  return out.slice(0, 3);
}

function urgencyAgendaPrefix() {
  return "Essa semana ainda tenho alguns horários disponíveis em horário de Brasília.\n\n";
}

function formatDayOptions(dayKeys) {
  return dayKeys.map((d, i) => `${i + 1}) *${formatDatePt(d)}*`).join("\n");
}

function consultationExplanationReply() {
  return (
    "A avaliação com o Dr. Alef é *100% online, segura e individualizada*, com duração média de *45 minutos*.\n\n" +
    "Nela, ele analisa seu histórico, o que você já tentou, medicações em uso, como os sintomas impactam sua rotina e se esse tratamento pode fazer sentido para o seu caso.\n\n" +
    "Se fizer sentido, ele orienta os próximos passos com segurança."
  );
}

function legalReply() {
  return "Sim 🙂 O uso medicinal de canabinoides é legal no Brasil, mas sempre com avaliação e prescrição médica quando indicado.";
}

function chapadoReply() {
  return (
    "Essa é uma dúvida muito comum 🙂\n\n" +
    "O tratamento medicinal não é a mesma coisa que uso recreativo. Tudo depende da avaliação médica, do tipo de formulação e da indicação correta."
  );
}

function neuroHintReply() {
  return "Isso pode indicar um quadro de dor neuropática, porém somente o Dr. Alef, que é o médico responsável, pode avaliar com precisão e te dizer como tratar.";
}

function onlineReply() {
  return "Sim 🙂 A consulta é *100% online* e não precisa ir presencialmente a nenhum lugar.";
}

function whoReply() {
  return "O Dr. Alef Kotula é o médico responsável pelos atendimentos. A consulta é individualizada e focada em entender com profundidade se esse tratamento pode fazer sentido para o seu caso.";
}

function prePriceValueReply() {
  return (
    "Claro 🙂\n\n" +
    "Antes de te passar as opções, eu te explico rapidamente o que está incluído, para o valor fazer sentido no contexto.\n\n" +
    "O Dr. Alef faz uma avaliação médica aprofundada do seu caso, entende o que você já tentou, confere medicações em uso e define com mais clareza quais caminhos podem fazer sentido para você."
  );
}

function priceReply() {
  return (
    "Hoje trabalhamos com estas opções:\n\n" +
    `1) *${PLANS.full.label}* (${PLANS.full.subtitle}) — *R$${PLANS.full.price}* *(87% das pessoas escolhem essa opção)* ⭐\n` +
    `2) *${PLANS.basic.label}* (${PLANS.basic.subtitle}) — *R$${PLANS.basic.price}*\n` +
    `3) *${PLANS.retorno.label}* (${PLANS.retorno.subtitle}) — *R$${PLANS.retorno.price}*\n\n` +
    "Qual dessas opções faz mais sentido para você agora? Me responda com *1, 2 ou 3*.")
}

function askNameIntroReply() {
  return "Oi 🙂\nEu sou a Lia, da equipe do Dr. Alef Kotula. Muito prazer.\n\nQual é o seu *primeiro nome*?";
}

function askProblemAfterNameReply(state) {
  const nome = maybeUseName(state) || state.nome || "";
  return `${nome ? `Prazer, ${nome} 🙂\n\n` : ""}Me conta uma coisa rápida: o que tem te incomodado mais hoje?\n\n*Dor, sono, ansiedade ou outro problema?*`;
}

function q1Reply(state) {
  const nome = maybeUseName(state) || state.nome || "";
  return `${nome ? `${nome}, ` : ""}só para eu entender melhor seu caso: isso já acontece há quanto tempo com você?`;
}

function q2Reply(state) {
  const cond = state.condition || state.focus || "";
  if (cond === "fibromialgia") return "Entendi. E hoje o que mais te incomoda nisso: a dor em si, o cansaço, o sono ou tudo isso junto?";
  if (cond === "insonia") return "Entendi. Você tem mais dificuldade para pegar no sono, manter o sono ou acorda várias vezes durante a noite?";
  if (cond === "ansiedade") return "Entendi. No seu caso pesa mais a mente acelerada, a insônia, a tensão no corpo ou as crises?";
  if (cond === "dor_neuropatica") return "Entendi. No seu caso incomoda mais como ardência, choque, formigamento ou dor contínua?";
  if (cond === "artrose") return "Entendi. No seu caso incomoda mais joelho, quadril, mãos, coluna ou outra articulação?";
  if (cond === "artrite") return "Entendi. Hoje o que mais te incomoda é a dor, a rigidez ou o inchaço nas articulações?";
  return "Entendi. E hoje o que mais te incomoda nisso: a dor em si, o sono, o cansaço ou o impacto na sua rotina?";
}

function q3Reply() {
  return "Entendi. Você já tentou algum tratamento ou medicação para isso antes?";
}

function bridgeToConsultReply(state) {
  const cond = state.condition || detectCondition(state.problem_text || "") || "dor_cronica";
  const ev = buildEvidenceMessage(cond);
  return (
    "Faz sentido. Muitas pessoas chegam aqui depois de já terem tentado algumas opções e ainda assim continuarem sofrendo.\n\n" +
    (ev ? `${ev}\n\n` : "") +
    consultationExplanationReply() +
    "\n\nSe você quiser, eu posso te mostrar os próximos horários disponíveis 🙂"
  );
}

async function askDayReply() {
  const dayKeys = await getSuggestedDayKeys();
  if (!dayKeys.length) return "No momento os horários desta semana já estão completos. Quer que eu te coloque na lista de prioridade assim que abrir uma vaga? 🙂";
  return (
    "Perfeito 🙂\n\n" +
    urgencyAgendaPrefix() +
    "Nos próximos dias tenho agenda em:\n" +
    `${formatDayOptions(dayKeys)}\n\n` +
    "Qual você prefere?"
  );
}

async function offerSlotsReply(state) {
  const dateKey = state.date_key;
  const best = await chooseBestSlotsForDate(dateKey, 3);
  if (!best.length) return "Esse dia acabou de ficar sem vagas 🙏 Quer que eu te mostre outra data próxima?";
  state.offered_slots = best;
  return (
    "Perfeito 🙂\n\n" +
    urgencyAgendaPrefix() +
    `Para *${formatDatePt(dateKey)}* tenho:\n\n` +
    best.map((s, i) => `${i + 1}) *${s}*`).join("\n") +
    "\n\nQual fica melhor para você?"
  );
}

function askPreferredTimeReply(state) {
  return `Sem problema 🙂 Que horário em *${formatDatePt(state.date_key)}* funciona melhor para você?`;
}

function askFullNameReply(state) {
  return `Perfeito. Vou reservar provisoriamente *${prettySlot(state.date_key, state.slot_time)}* para você por alguns minutos.\n\nSó preciso confirmar alguns dados rápidos.\n\nQual seu *nome completo*?`;
}
function askBirthdateReply(state) {
  return `Obrigado, ${state.nome_completo.split(" ")[0]} 🙂\n\nQual sua *data de nascimento*?`;
}
function askEmailReply() {
  return "Perfeito 🙂\n\nE qual *e-mail* você prefere usar para receber as orientações da consulta?";
}

function askPlanReply() {
  return consultationExplanationReply() + "\n\n" + priceReply();
}

function paymentSentReply(plan, link, state) {
  return (
    `Perfeito, finalizei sua pré-reserva ✅\n\n` +
    `📅 *${prettySlot(state.date_key, state.slot_time)}*\n\n` +
    `Plano escolhido:\n*${plan.label}*\n${plan.subtitle} — R$${plan.price}\n\n` +
    `Esse horário fica reservado no sistema por alguns minutos enquanto você finaliza.\n\n` +
    `Para confirmar sua consulta, é só concluir aqui:\n${link}\n\n` +
    `Assim que o pagamento entrar, eu confirmo sua consulta aqui imediatamente 🙂\n\n` +
    `Se tiver qualquer dificuldade com o pagamento, me avise que eu te ajudo rapidinho.`
  );
}

function pendingPaymentReply(state) {
  return (
    `Seu horário ainda está reservado 🙂\n\n` +
    `📅 *${prettySlot(state.date_key, state.slot_time)}*\n\n` +
    `Para confirmar a consulta, só falta finalizar o pagamento aqui:\n${state.payment.link}\n\n` +
    `Assim que o pagamento for confirmado, eu libero a confirmação da consulta para você.`
  );
}

function afterPaidReply(state) {
  return (
    "Pagamento confirmado ✅\n\n" +
    `Sua consulta ficou confirmada para *${prettySlot(state.date_key, state.slot_time)}*.\n\n` +
    "Mais perto do horário eu envio as orientações da consulta 🙂"
  );
}

function buildExpensiveReply() {
  return (
    "Entendo você pensar nisso 🙂\n\n" +
    "Mas aqui não é só uma conversa rápida. É uma avaliação médica individualizada, com profundidade, justamente para entender seu histórico, o que você já tentou e qual caminho pode fazer sentido para você com segurança.\n\n" +
    "Se quiser, eu posso te explicar rapidamente a diferença entre as opções."
  );
}

function buildThinkingReply(state) {
  if (state?.date_key && state?.slot_time) {
    return `Claro 🙂\n\nSe quiser, eu consigo manter *${prettySlot(state.date_key, state.slot_time)}* pré-reservado por alguns minutos enquanto você decide.`;
  }
  return "Claro 🙂\n\nSe quiser, eu posso te mostrar os horários disponíveis e você decide com calma.";
}

function buildUnsureReply(state, incomingText) {
  const cond = detectCondition(incomingText) || state.condition || null;
  const base = "É super normal ter essa dúvida 🙂\n\nA avaliação serve justamente para entender seu caso com profundidade e ver se esse tratamento pode fazer sentido para você, com segurança e individualização.";
  const ev = cond && Number(state.evidence_used_count || 0) < 2 ? buildEvidenceMessage(cond) : null;
  if (ev) {
    state.evidence_used_count += 1;
    return `${base}\n\n${ev}`;
  }
  return base;
}

function buildWorksReply(state, incomingText) {
  const cond = detectCondition(incomingText) || state.condition || state.focus || null;
  const ev = cond ? buildEvidenceMessage(cond) : null;
  if (ev) {
    state.evidence_used_count = Number(state.evidence_used_count || 0) + 1;
    return `Sim, existem evidências interessantes 🙂\n\n${ev}`;
  }
  return "Sim, existem evidências interessantes em alguns casos 🙂 Mas a avaliação médica é importante para entender se isso faz sentido para o seu caso e com segurança.";
}

function detectIntent(text) {
  const t = norm(text);
  const wantsPrice = /\b(preco|preço|valor|quanto custa|investimento|custa|valores)\b/.test(t);
  const asksPriceDirect = wantsPrice;
  const intentPay = /\b(como (pagar|fa[cç]o para pagar)|pagar|pagamento|pix|cartao|cartão|credito|crédito|debito|débito|boleto|link|parcel|parcela|quero pagar)\b/.test(t);
  const wantsBook = /\b(quero marcar|quero agendar|agendar|marcar|confirmar consulta|quero consulta|gostaria de agendar|tem horario|tem horário|agenda)\b/.test(t);
  const asksHours = /\b(horarios|horário|horario|que horas|vagas|disponibilidade)\b/.test(t);
  const confirms = /\b(sim|ok|beleza|pode|confirmo|fechado|vamos|pode ser|serve|confirmar)\b/.test(t);
  const refuses = /\b(nao quero|não quero|pare|para|chega|rude|grosso|nao gostei|não gostei)\b/.test(t);
  const asksStartNow = /\b(como tomar|dose|dosagem|quantas gotas|comecar agora|começar agora)\b/.test(t);
  const urgency = /\b(dor no peito|falta de ar|desmaio|avc|convuls|paralisia|confusao|confusão)\b/.test(t);
  const asksWho = /\b(quem e|quem eh|quem é|quem e o dr|quem é o dr|quem e o doutor|quem é o doutor)\b/.test(t);
  const asksIfWorks = /\b(funciona|serve|vale a pena|ajuda|melhora|tem resultado)\b/.test(t);
  const saysWillSee = /\b(vou ver|depois te falo|vou confirmar|vou pensar|te aviso|depois vejo)\b/.test(t);
  const saysIndecisive = /\b(tanto faz|qual voce acha melhor|qual você acha melhor)\b/.test(t);
  const saysExpensive = /\b(caro|caríssima|carissimo|caríssimo|achei caro|muito caro|pesado)\b/.test(t);
  const saysUnsure = /\b(nao tenho certeza|não tenho certeza|nao sei|não sei|sera|será|to na duvida|tô na dúvida|duvida|dúvida)\b/.test(t);
  const asksHowConsultWorks = /\b(como funciona a consulta|como funciona essa consulta|como funciona essa avaliacao|como funciona essa avaliação|como funciona a avaliacao|como funciona a avaliação)\b/.test(t);
  const asksIfOnline = /\b(e online|é online|online mesmo|presencial|precisa ir|tem que ir|ir em algum lugar|precisa ir na clinica|precisa ir na clínica)\b/.test(t);
  const asksLegal = /\b(legal no brasil|e legal|é legal|precisa de receita|receita|pode comprar|comprar sem receita|anvisa)\b/.test(t);
  const asksChapado = /\b(chapado|chapar|maconha mesmo|isso e maconha|isso é maconha|droga)\b/.test(t);

  const focus =
    (/\b(insonia|insônia|dormir|sono|acordar)\b/.test(t) && "insonia") ||
    (/\b(ansiedade|panico|pânico|crise)\b/.test(t) && "ansiedade") ||
    (/\b(fibromialgia)\b/.test(t) && "fibromialgia") ||
    (/\b(neuropat)\b/.test(t) && "dor_neuropatica") ||
    (/\b(artrose)\b/.test(t) && "artrose") ||
    (/\b(artrite)\b/.test(t) && "artrite") ||
    (/\b(coluna|lombar)\b/.test(t) && "dor_lombar") ||
    (/\b(dor)\b/.test(t) && "dor_cronica") ||
    null;

  return {
    wantsPrice,
    asksPriceDirect,
    intentPay,
    wantsBook,
    asksHours,
    confirms,
    refuses,
    asksStartNow,
    urgency,
    asksWho,
    asksIfWorks,
    saysWillSee,
    saysIndecisive,
    saysExpensive,
    saysUnsure,
    asksHowConsultWorks,
    asksIfOnline,
    asksLegal,
    asksChapado,
    focus,
  };
}

function getOrInitObjectionMemory(state) {
  state.objection_memory = state.objection_memory || {};
  const m = state.objection_memory;
  if (typeof m.legalidade_answered !== "boolean") m.legalidade_answered = false;
  if (typeof m.price_answered !== "boolean") m.price_answered = false;
  if (typeof m.future_cost_answered !== "boolean") m.future_cost_answered = false;
  if (typeof m.plan_explained !== "boolean") m.plan_explained = false;
  if (typeof m.scam_answered !== "boolean") m.scam_answered = false;
  if (typeof m.effects_answered !== "boolean") m.effects_answered = false;
  return m;
}

function summarizeLastContext(state) {
  const chunks = [];
  if (state?.problem_text) chunks.push(`foco: ${state.problem_text}`);
  else if (state?.focus) chunks.push(`foco: ${state.focus}`);
  if (state?.stage) chunks.push(`etapa: ${state.stage}`);
  if (state?.date_key && state?.slot_time) chunks.push(`slot: ${prettySlot(state.date_key, state.slot_time)}`);
  if (state?.selected_plan_key) chunks.push(`plano: ${state.selected_plan_key}`);
  if (state?.payment?.status) chunks.push(`pagamento: ${state.payment.status}`);
  return clip(chunks.join(" | "), 280) || "conversa iniciada";
}

function deriveConversationStage(state, signals) {
  if (state?.payment?.status === "approved" || state?.stage === "CONFIRMED") return "PAYMENT_DECISION";
  if (state?.payment?.status === "pending" || state?.stage === "WAIT_PAYMENT") return "PAYMENT_DECISION";
  if (state?.stage === "ASK_PLAN") return "PLAN_DECISION";
  if (["ASK_DAY", "OFFER_SLOTS", "ASK_SPECIFIC_TIME"].includes(state?.stage)) return "SCHEDULING";
  if (["DIAG_Q1", "DIAG_Q2", "DIAG_Q3", "ASK_PROBLEM"].includes(state?.stage)) return "QUALIFYING";
  if (signals?.dominantObjection || signals?.explicitQuestion) return "TRUST_BUILDING";
  if (state?.stage === "AFTER_DIAGNOSTIC") return "VALUE_BUILDING";
  if (!state?.nome || state?.stage === "ASK_NAME") return "OPEN";
  return "TRUST_BUILDING";
}

function ensureFollowupState(state) {
  state.followup = state.followup || {};
  const f = state.followup;
  if (typeof f.enabled !== "boolean") f.enabled = true;
  f.stage_when_paused = f.stage_when_paused || state.stage || null;
  f.last_context = f.last_context || summarizeLastContext(state);
  f.last_user_message_at = Number(f.last_user_message_at || 0);
  f.sent_count = Number(f.sent_count || 0);
  f.next_at = Number(f.next_at || 0);
  f.last_sent_at = Number(f.last_sent_at || 0);
  f.completed = !!f.completed;
  return f;
}

function scheduleNextFollowupTimestamp(sentCount, baseTs) {
  const window = FOLLOWUP_STAGE_WINDOWS[Math.min(sentCount, FOLLOWUP_STAGE_WINDOWS.length - 1)];
  return Number(baseTs) + randMs(window.minMs, window.maxMs);
}

function touchFollowupOnInbound(state, incomingText) {
  const f = ensureFollowupState(state);
  if (state?.payment?.status === "approved") {
    f.enabled = false;
    f.completed = true;
    f.next_at = 0;
    return;
  }
  const now = nowMs();
  f.enabled = true;
  f.completed = false;
  f.stage_when_paused = state.stage || f.stage_when_paused || null;
  f.last_context = clip(`${summarizeLastContext(state)} | user: ${(incomingText || "").trim()}`, 300);
  f.last_user_message_at = now;
  f.sent_count = 0;
  f.last_sent_at = 0;
  f.next_at = scheduleNextFollowupTimestamp(0, now);
  state.awaiting_followup = false;
}

function buildReengagementReply(state, attempt = null) {
  const f = ensureFollowupState(state);
  const step = Number(attempt || f.sent_count + 1);
  const firstName = state?.nome || "";
  const greeting = firstName ? `Oi, ${firstName} 🙂` : "Oi 🙂";

  if (step <= 1) {
    return `${greeting}\nFiquei pensando no que você comentou.\nSe quiser, eu sigo daqui com você.`;
  }
  if (step === 2) {
    return `${greeting}\nVi que nossa conversa ficou pausada.\nSe ainda fizer sentido entender melhor seu caso, eu sigo aqui com você.`;
  }
  return `${greeting}\nPassando para não te deixar sem resposta.\nSe quiser, eu retomo daqui com você quando for um bom momento.`;
}

function extractExplicitQuestionType(text, flags) {
  const t = norm(text);
  if (!t) return null;
  if (flags.asksPriceDirect) return "price";
  if (flags.asksLegal) return "legality";
  if (flags.asksChapado) return "effects";
  if (flags.asksIfOnline) return "online";
  if (flags.asksHowConsultWorks) return "how_consult_works";
  if (flags.asksWho) return "doctor_identity";
  if (/(golpe|fraude|curso|suplemento|produto|isca|confiar|confiavel|confiável|legitimo|legítimo)/.test(t)) return "scam";
  if (/(inclui|incluido|incluído|o que vem|o que tem|o que contempla).*(447|acompanhamento|plano 1|opcao 1|opção 1)/.test(t)) return "plan_includes";
  if (/(diferenca|diferença|qual muda|muda entre).*(447|347|plano|opcao|opção|acompanhamento|avaliacao|avaliação)/.test(t)) return "plan_difference";
  if (/(custo|valor|preco|preço).*(tratamento|medicamento).*(mes|mês|mensal|futuro)|medicamento.*caro/.test(t)) return "future_cost";
  if (/(serve pro meu caso|serve para meu caso|funciona pra mim|funciona para mim|isso serve pra|isso serve para)/.test(t)) return "fit";
  if (/(funciona|resultado|melhora de verdade|vale a pena)/.test(t)) return "efficacy";
  if (/(diferencial|diferenca do dr|diferença do dr|por que com voces|por que com vocês|o que muda|comparando)/.test(t)) return "differential";
  if (/(sai com receita|receita|prescricao|prescrição|proximos passos|próximos passos)/.test(t)) return "prescription";
  return null;
}

function detectLeadSignals(text, state) {
  const flags = detectIntent(text);
  const t = norm(text);
  const explicitQuestionType = extractExplicitQuestionType(text, flags);
  const explicitQuestion = explicitQuestionType
    ? (text || "").trim()
    : ((/\?/.test(text || "") || /^(qual|quais|quanto|como|onde|isso|serve|funciona|tem|pode|é|e)\b/.test(t)) ? (text || "").trim() : null);

  const planSignal = extractPlanChoice(text);
  const buyingSignal = !!planSignal
    || flags.intentPay
    || /\b(fecho|quero fechar|vamos fechar|quero confirmar|pode confirmar|manda o link|me manda o link|quero essa opcao|quero essa opção|vou nessa|vou nessa opcao|vou nessa opção)\b/.test(t);
  const paymentResistance = flags.saysExpensive
    || flags.saysWillSee
    || /\b(vou pensar|depois|agora nao|agora não|nao consigo agora|não consigo agora|mais pra frente)\b/.test(t);
  const futureCostResistance = /(custo|valor|preco|preço).*(futuro|mensal|mes|mês)|medicamento.*caro|continuar o tratamento/.test(t);

  let dominantObjection = null;
  if (explicitQuestionType) dominantObjection = explicitQuestionType;
  else if (futureCostResistance) dominantObjection = "future_cost";
  else if (flags.saysExpensive) dominantObjection = "price";

  let leadProfile = "morno";
  if (dominantObjection === "scam" || dominantObjection === "legality") leadProfile = "desconfiado";
  else if (dominantObjection === "differential") leadProfile = "comparador";
  else if (dominantObjection === "price" || dominantObjection === "future_cost") leadProfile = "travado_por_preco";
  else if (buyingSignal) leadProfile = "quente";
  else if (flags.asksIfWorks) leadProfile = "cetico";

  let dominantIntent = "conversation";
  if (state?.payment?.status === "pending" && buyingSignal) dominantIntent = "payment";
  else if (buyingSignal) dominantIntent = "close";
  else if (flags.wantsBook || flags.asksHours) dominantIntent = "schedule";
  else if (flags.wantsPrice) dominantIntent = "price";
  else if (dominantObjection) dominantIntent = "objection";
  else if (explicitQuestion) dominantIntent = "question";

  const complianceRisk = flags.asksStartNow
    || /(dose|dosagem|quantas gotas|qual marca|onde comprar|qual produto|como comprar)/.test(t);
  const shouldInterruptFlow = !!(explicitQuestionType || futureCostResistance || dominantObjection);

  return {
    explicitQuestion,
    explicitQuestionType,
    dominantIntent,
    dominantObjection,
    leadProfile,
    buyingSignal,
    planSignal,
    paymentResistance,
    futureCostResistance,
    shouldInterruptFlow,
    isUrgent: !!flags.urgency,
    complianceRisk,
    flags,
  };
}

function getConversationPriority(signals, state) {
  if (signals.isUrgent) return "URGENT";
  if (signals.complianceRisk) return "COMPLIANCE";
  if (signals.explicitQuestion && signals.shouldInterruptFlow) return "ANSWER_FIRST";
  if (signals.dominantObjection && signals.shouldInterruptFlow) return "HANDLE_OBJECTION";
  if ((signals.planSignal || signals.buyingSignal) && state.stage === "ASK_PLAN") return "PLAN_CLOSE";
  if (signals.buyingSignal && state.payment?.status === "pending") return "PAYMENT_CLOSE";
  if (state.followup?.enabled && state.awaiting_followup) return "REENGAGE";
  return "FLOW_NEXT";
}

function markObjectionMemory(state, key) {
  const m = getOrInitObjectionMemory(state);
  if (key && Object.prototype.hasOwnProperty.call(m, key)) m[key] = true;
}

function answerLiteralQuestion(signals, state) {
  const qType = signals.explicitQuestionType;
  if (!qType) return "Perfeito 🙂 Me conta sua principal dúvida para eu te responder de forma objetiva.";

  switch (qType) {
    case "price":
      markObjectionMemory(state, "price_answered");
      return priceReply();
    case "plan_includes":
      markObjectionMemory(state, "plan_explained");
      return "Claro 🙂 Nesse acompanhamento de R$447 você faz a consulta inicial com o Dr. Alef e já fica com um retorno em torno de 30 dias. Esse retorno serve para revisar como você ficou e ajustar a conduta, se necessário.";
    case "plan_difference":
      markObjectionMemory(state, "plan_explained");
      return "Resumo rápido 🙂 A opção de R$447 inclui consulta + retorno em torno de 30 dias. A de R$347 é a avaliação inicial de 45 minutos, sem retorno incluso.";
    case "future_cost":
      markObjectionMemory(state, "future_cost_answered");
      return "Essa é uma dúvida importante 🙂 O valor pode variar conforme produto e dose, então não existe um número único para todo mundo. O Dr. Alef orienta de forma realista, pensando no que faz sentido para o caso e no que é viável para o paciente.";
    case "prescription":
      return "Sim 🙂 Se o Dr. Alef entender que faz sentido para o seu caso, ele orienta os próximos passos com segurança e emite a prescrição quando houver indicação.";
    case "legality":
      markObjectionMemory(state, "legalidade_answered");
      return "Sim 🙂 O uso medicinal de canabinoides é legal no Brasil quando existe avaliação e prescrição médica, seguindo as regras da Anvisa.";
    case "scam":
      markObjectionMemory(state, "scam_answered");
      return "Você faz muito bem em perguntar 🙂 É consulta médica de verdade, individualizada, por telemedicina. Não é curso nem venda de produto.";
    case "effects":
      markObjectionMemory(state, "effects_answered");
      return "Essa preocupação é comum 🙂 Dependendo da formulação e da dose, pode haver sonolência em alguns casos. Por isso o Dr. Alef avalia com cautela para ajustar com segurança à sua rotina.";
    case "differential":
      return "O principal diferencial costuma ser a individualização do caso, com cuidado em segurança e ajustes, sem protocolo pronto. O Dr. Alef revisa histórico, medicações e objetivos para decidir o que realmente faz sentido para você.";
    case "fit":
      return "Pode fazer sentido sim, dependendo do seu caso 🙂 A consulta existe justamente para avaliar com segurança se esse caminho é indicado para você.";
    case "efficacy":
      return "Na prática, muitos pacientes relatam melhora, mas depende bastante do caso. A consulta serve para avaliar com honestidade se faz sentido para você, sem promessa de milagre.";
    case "online":
      return onlineReply();
    case "how_consult_works":
      return consultationExplanationReply();
    case "doctor_identity":
      return whoReply();
    default:
      return "Perfeito 🙂 Me conta só o que você quer entender primeiro, que eu te respondo de forma direta.";
  }
}

function handleDominantObjection(signals, state) {
  if (!signals.dominantObjection) return "Perfeito 🙂 Me conta sua principal dúvida que eu te respondo de forma objetiva.";
  return answerLiteralQuestion({ ...signals, explicitQuestionType: signals.dominantObjection }, state);
}

function appendSmartTransition(reply, signals, state) {
  if (!reply) return reply;
  if (/Me responda com \*1, 2 ou 3\*/.test(reply)) return reply;
  let transition = "";

  if (state?.payment?.status === "pending") {
    transition = "Se fizer sentido, eu sigo com você no próximo passo com calma.";
  } else if (state?.stage === "ASK_PLAN" && !state?.selected_plan_key) {
    transition = "Se fizer sentido, você pode me responder com 1, 2 ou 3 que eu sigo daqui com você.";
  } else if (["legality", "scam", "effects", "differential"].includes(signals?.dominantObjection)) {
    transition = "Se quiser, eu te explico rapidinho como funciona e te mostro os horários.";
  } else if (["price", "future_cost", "plan_includes", "plan_difference"].includes(signals?.dominantObjection)) {
    transition = "Se quiser, eu te explico qual opção tende a fazer mais sentido no seu caso.";
  } else {
    transition = "Se quiser, eu te mostro os próximos horários.";
  }

  if (!transition) return reply;
  return `${reply}\n\n${transition}`;
}

function urgentReply() {
  return "Entendi. Pela sua mensagem, isso pode precisar de avaliação urgente. Procure um pronto atendimento agora (ou SAMU 192). Assim que estiver seguro(a), me chama aqui.";
}

function complianceSafeReply() {
  return "Entendi sua vontade de começar. Por segurança, eu não consigo orientar dose, marca ou compra por aqui 🙏 Isso depende de avaliação médica individual. Se quiser, eu te explico como funciona a avaliação.";
}

function shouldSuppressPendingLink(signals, state) {
  if (!state?.payment?.link || state?.payment?.status !== "pending") return false;
  if (signals?.explicitQuestion || signals?.dominantObjection) return true;
  const lastBlocked = Number(state?.link_guard?.last_blocked_at || 0);
  if (lastBlocked && nowMs() - lastBlocked < 10 * 60 * 1000 && !signals?.buyingSignal) return true;
  return false;
}

function markLinkGuard(state) {
  state.link_guard = state.link_guard || {};
  state.link_guard.last_blocked_at = nowMs();
  state.link_guard.blocked_count = Number(state.link_guard.blocked_count || 0) + 1;
}

function objectionResolvedEnough(signals, state) {
  const m = getOrInitObjectionMemory(state);
  if (!signals?.dominantObjection) return true;
  if (signals.dominantObjection === "legality") return m.legalidade_answered;
  if (signals.dominantObjection === "price") return m.price_answered;
  if (signals.dominantObjection === "future_cost") return m.future_cost_answered;
  if (signals.dominantObjection === "plan_includes" || signals.dominantObjection === "plan_difference") return m.plan_explained;
  if (signals.dominantObjection === "scam") return m.scam_answered;
  if (signals.dominantObjection === "effects") return m.effects_answered;
  return false;
}

function moveToValueOrAgenda(state) {
  if (state?.date_key) {
    state.stage = state.slot_time ? "ASK_FULLNAME" : "OFFER_SLOTS";
    return;
  }
  state.stage = "AFTER_DIAGNOSTIC";
}

async function resolvePlanSelection({ signals, state, phone }) {
  const planKey = signals.planSignal || state.selected_plan_key;
  if (!planKey) return "Qual dessas opções faz mais sentido para você? Me responde com 1, 2 ou 3 🙂";

  if (!state.date_key || !state.slot_time) {
    state.stage = "ASK_DAY";
    return "Perfeito 🙂 Antes de confirmar o plano, eu te mostro os horários para deixar sua consulta reservada.";
  }

  state.selected_plan_key = planKey;
  const holdCheck = await acquireSlotHold(state.date_key, state.slot_time, phone);
  if (!holdCheck.ok) {
    state.slot_time = null;
    state.slot_key = null;
    state.stage = "OFFER_SLOTS";
    return "Esse horário acabou de ser preenchido antes da confirmação 🙏 Vou te mostrar as próximas melhores opções.\n\n" + (await offerSlotsReply(state));
  }

  state.slot_key = holdCheck.slot_key;
  const already = state.payment && state.payment.preference_id && state.payment.plan_key === planKey && state.payment.status === "pending";
  if (already && state.payment.link) {
    state.stage = "WAIT_PAYMENT";
    return paymentSentReply(PLANS[planKey], state.payment.link, state);
  }

  const pref = await mpCreatePreference({ phone, planKey });
  state.payment = {
    status: "pending",
    plan_key: planKey,
    preference_id: pref.preference_id,
    link: pref.link,
    external_reference: pref.external_reference,
    created_at: nowMs(),
  };
  state.stage = "WAIT_PAYMENT";
  return paymentSentReply(pref.plan, pref.link, state);
}

function resolvePaymentStep(state) {
  if (state?.payment?.status === "pending" && state?.payment?.link) {
    state.stage = "WAIT_PAYMENT";
    return pendingPaymentReply(state);
  }
  return "Perfeito 🙂 Para pagamento, eu primeiro reservo seu horário e confirmo os dados essenciais.";
}

async function runFollowupScheduler() {
  const now = nowMs();
  const counters = { scanned: 0, sent: 0, skipped: 0, updated: 0, errors: 0 };
  const { rows } = await pool.query(`SELECT phone, state FROM wa_users WHERE state ? 'followup'`);

  for (const row of rows) {
    counters.scanned += 1;
    const phone = row.phone;
    const state = row.state || {};
    const f = ensureFollowupState(state);

    if (!f.enabled || f.completed) {
      counters.skipped += 1;
      continue;
    }
    if (state?.payment?.status === "approved") {
      f.enabled = false;
      f.completed = true;
      f.next_at = 0;
      await saveUserState(phone, state);
      counters.updated += 1;
      continue;
    }
    if (!state.last_bot_from) {
      counters.skipped += 1;
      continue;
    }
    if (f.sent_count >= 3) {
      f.enabled = false;
      f.completed = true;
      f.next_at = 0;
      await saveUserState(phone, state);
      counters.updated += 1;
      continue;
    }
    if (!f.next_at || now < f.next_at) {
      counters.skipped += 1;
      continue;
    }
    if (f.last_sent_at && now - f.last_sent_at < 90 * 1000) {
      counters.skipped += 1;
      continue;
    }

    const attempt = f.sent_count + 1;
    const followReply = buildReengagementReply(state, attempt);
    try {
      await twilioClient.messages.create({
        to: `whatsapp:${phone}`,
        from: state.last_bot_from,
        body: followReply,
      });
      f.sent_count = attempt;
      f.last_sent_at = now;
      state.awaiting_followup = true;
      state.last_bot_reply = followReply;
      state.last_sent_at = now;

      if (attempt >= 3) {
        f.enabled = false;
        f.completed = true;
        f.next_at = 0;
      } else {
        f.next_at = scheduleNextFollowupTimestamp(attempt, now);
      }
      await saveUserState(phone, state);
      counters.sent += 1;
    } catch (err) {
      counters.errors += 1;
      console.error(`❌ Follow-up erro para ${phone}:`, err?.message || err);
    }
  }
  return counters;
}

function compactMemory(state) {
  const s = state || {};
  return {
    nome: s.nome || null,
    focus: s.focus || null,
    condition: s.condition || null,
    problem_text: s.problem_text || null,
    stage: s.stage || null,
    conversation_stage: s.conversation_stage || null,
    date_key: s.date_key || null,
    slot_time: s.slot_time || null,
    nome_completo: s.nome_completo || null,
    birthdate: s.birthdate || null,
    email: s.email || null,
    selected_plan_key: s.selected_plan_key || null,
    payment_status: s.payment?.status || null,
    evidence_used_count: s.evidence_used_count || 0,
    objection_used_count: s.objection_used_count || 0,
    diag_questions_asked: s.diag_questions_asked || 0,
    rapport_done: !!s.rapport_done,
    diagnostic_step: s.diagnostic_step || 0,
    price_ask_count: s.price_ask_count || 0,
    objection_memory: s.objection_memory || null,
    followup: s.followup || null,
    link_guard: s.link_guard || null,
    last_user_message: s.last_user_message || "",
    last_bot_reply: s.last_bot_reply || "",
  };
}

function buildSystemPrompt() {
  return `
Você é "Lia", secretária humana e premium do Dr. Alef Kotula.

OBJETIVO:
- soar humana, acolhedora, clara e objetiva
- responder perguntas abertas com naturalidade
- conduzir a conversa com elegância até consulta/agendamento
- nunca parecer robótica ou apressada

REGRAS ABSOLUTAS:
- Nunca invente preço.
- Nunca envie links.
- Nunca cite valores em R$ por conta própria.
- Nunca prometa cura ou resultado garantido.
- Nunca prescreva dose, marca, compra ou produto.
- Responda como uma ótima secretária humana.
- No máximo 1 pergunta principal por mensagem.
- Responda primeiro a pergunta do paciente, depois conduza.

COMANDOS ESPECIAIS:
- Se pedirem preço ou valor: responda exatamente "PRECISA_PRECO"
- Se pedirem pagamento ou link: responda exatamente "PRECISA_PAGAR"
- Se pedirem horários ou agendar: responda exatamente "PRECISA_AGENDAR"
- Se houver urgência médica: responda exatamente "URGENTE"

FORMATO JSON:
{
  "reply": "mensagem",
  "updates": {
    "nome": "...",
    "problem_text": "...",
    "condition": "...",
    "rapport_done": true
  }
}
`;
}

function buildUserPrompt({ incomingText, state, flags, mode }) {
  return `
MODO:
${mode}

MEMÓRIA:
${JSON.stringify(compactMemory(state))}

MENSAGEM DO PACIENTE:
${incomingText}

SINAIS DETECTADOS:
${JSON.stringify(flags)}

INSTRUÇÕES:
- Responda primeiro a dúvida principal do paciente.
- Depois conduza com suavidade, sem pressão.
- Se o paciente estiver frio, seja acolhedora.
- Se já houver contexto suficiente, avance com naturalidade.
- Pode salvar nome, problema e condição em updates quando identificar.
`;
}

function violatesNoPriceNoLink(text) {
  if (!text) return false;
  if (/\bhttps?:\/\//i.test(text)) return true;
  if (/R\$\s?\d/i.test(text)) return true;
  if (/\b(200|347|447)\b/.test(text)) return true;
  return false;
}

async function runLia({ incomingText, state, flags, mode = "guided" }) {
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.55,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt({ incomingText, state, flags, mode }) },
    ],
  });

  const content = resp.choices?.[0]?.message?.content?.trim() || "";
  let parsed = null;
  try { parsed = JSON.parse(content); } catch { parsed = null; }

  if (!parsed || typeof parsed !== "object" || !parsed.reply) {
    return { reply: "Entendi 🙂 Me conta só qual é sua principal dúvida agora?", updates: {} };
  }

  const r = String(parsed.reply || "").trim();
  if (r === "PRECISA_PRECO") return { reply: "__NEED_PRICE__", updates: parsed.updates || {} };
  if (r === "PRECISA_PAGAR") return { reply: "__NEED_PAY__", updates: parsed.updates || {} };
  if (r === "PRECISA_AGENDAR") return { reply: "__NEED_BOOK__", updates: parsed.updates || {} };
  if (r === "URGENTE") return { reply: "__URGENT__", updates: parsed.updates || {} };

  if (violatesNoPriceNoLink(r)) {
    return { reply: "Entendi 🙂 Me conta só qual é sua principal dúvida agora?", updates: {} };
  }

  parsed.reply = clip(r, 1100);
  if (!parsed.updates) parsed.updates = {};
  return parsed;
}

async function mpCreatePreference({ phone, planKey }) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error("Plano inválido");

  const external_reference = `lia_${phone}_${planKey}_${Date.now()}`;
  const body = {
    items: [{ title: `Dr. Alef Kotula — ${plan.label}`, quantity: 1, unit_price: plan.price, currency_id: "BRL" }],
    external_reference,
    notification_url: `${BASE_URL}/mp/webhook`,
    back_urls: {
      success: `${BASE_URL}/mp/thanks?status=success`,
      failure: `${BASE_URL}/mp/thanks?status=failure`,
      pending: `${BASE_URL}/mp/thanks?status=pending`,
    },
    auto_return: "approved",
    statement_descriptor: "CONSULTA ONLINE",
    metadata: { phone, plan_key: planKey, plan_price: plan.price },
  };

  const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`MP preference erro: ${r.status} ${t}`);
  }
  const data = await r.json();
  return {
    preference_id: data.id,
    link: data.init_point || data.sandbox_init_point,
    plan,
    external_reference,
  };
}

async function mpGetPayment(paymentId) {
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`MP payment fetch erro: ${r.status} ${t}`);
  }
  return await r.json();
}

function mpExtractPhoneFromPayment(payment) {
  const md = payment?.metadata || {};
  return md.phone ? String(md.phone).trim() : null;
}

function computeHumanDelay(flags, state) {
  let base = randInt(MIN_DELAY, MAX_DELAY);
  if (flags.wantsBook || flags.asksHours) base = randInt(1, 3);
  if (flags.wantsPrice) base = randInt(2, 4);
  if (flags.intentPay) base = randInt(1, 3);
  if (flags.asksIfWorks) base = randInt(2, 4);
  if (flags.refuses) base = randInt(2, 4);
  const lastAt = Number(state.last_sent_at || 0);
  if (Date.now() - lastAt < 2000) base += 1;
  return Math.max(1, base);
}

async function sendWhatsApp(to, from, body, delaySec) {
  await sleep(delaySec * 1000);
  await twilioClient.messages.create({ to, from, body });
}

app.get("/", (req, res) => res.send("OK"));
app.get("/mp/thanks", (req, res) => res.send("OK"));

function hasValidCronSecret(req) {
  if (!CRON_SECRET) return true;
  const headerSecret = req.headers["x-cron-secret"];
  const auth = String(req.headers.authorization || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const querySecret = req.query?.secret ? String(req.query.secret) : "";
  return headerSecret === CRON_SECRET || bearer === CRON_SECRET || querySecret === CRON_SECRET;
}

app.post("/cron/followup", async (req, res) => {
  if (!hasValidCronSecret(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  try {
    const result = await runFollowupScheduler();
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("❌ followup scheduler erro:", err);
    return res.status(500).json({ ok: false, error: "followup_scheduler_error" });
  }
});

app.post("/mp/webhook", async (req, res) => {
  res.status(200).send("OK");
  try {
    const body = req.body || {};
    const type = body.type || body.topic;
    const paymentId = body?.data?.id || body?.id;
    if (!paymentId) return;

    if (type && String(type).includes("payment")) {
      const payment = await mpGetPayment(paymentId);
      const status = payment.status;
      const phone = mpExtractPhoneFromPayment(payment);
      if (!phone) return;

      const state = await getUserState(phone);
      state.payment = state.payment || {};
      state.payment.payment_id = paymentId;
      state.payment.status = status;
      state.payment.updated_at = Date.now();
      state.payment.amount = payment.transaction_amount || null;
      state.payment.plan_key = payment?.metadata?.plan_key || state.payment.plan_key || null;

      if (status === "approved" && state.slot_key) await markSlotPaid(state.slot_key, phone);
      if (status === "approved") {
        const f = ensureFollowupState(state);
        f.enabled = false;
        f.completed = true;
        f.next_at = 0;
        state.awaiting_followup = false;
      }
      await saveUserState(phone, state);

      if (status === "approved") {
        const botFrom = state?.last_bot_from || null;
        if (botFrom) {
          try {
            await twilioClient.messages.create({
              to: `whatsapp:${phone}`,
              from: botFrom,
              body: afterPaidReply(state),
            });
          } catch {}
        }
      }
    }
  } catch (err) {
    console.error("❌ MP webhook erro:", err);
  }
});

function initializeState(state, bot) {
  state.last_bot_reply = state.last_bot_reply || "";
  state.last_user_message = state.last_user_message || "";
  state.last_sent_at = state.last_sent_at || 0;
  state.nome = state.nome || null;
  state.focus = state.focus || null;
  state.condition = state.condition || null;
  state.problem_text = state.problem_text || null;
  state.payment = state.payment || null;
  state.stage = state.stage || null;
  state.conversation_stage = state.conversation_stage || null;
  state.selected_plan_key = state.selected_plan_key || null;
  state.rapport_done = !!state.rapport_done;
  state.name_used_count = Number(state.name_used_count || 0);
  state.evidence_used_count = Number(state.evidence_used_count || 0);
  state.objection_used_count = Number(state.objection_used_count || 0);
  state.offered_slots = state.offered_slots || [];
  state.date_key = state.date_key || null;
  state.slot_time = state.slot_time || null;
  state.slot_key = state.slot_key || null;
  state.nome_completo = state.nome_completo || null;
  state.birthdate = state.birthdate || null;
  state.email = state.email || null;
  state.price_ask_count = Number(state.price_ask_count || 0);
  state.diagnostic_step = Number(state.diagnostic_step || 0);
  state.diag_questions_asked = Number(state.diag_questions_asked || 0);
  state.diagnostic_answers = state.diagnostic_answers || {};
  state.awaiting_operational_permission = !!state.awaiting_operational_permission;
  state.awaiting_followup = !!state.awaiting_followup;
  getOrInitObjectionMemory(state);
  ensureFollowupState(state);
  state.link_guard = state.link_guard || {};
  state.last_bot_from = bot;
  return state;
}

app.post("/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  res.type("text/xml").send(twiml.toString());

  (async () => {
    try {
      const lead = req.body.From || "";
      const bot = req.body.To || "";
      const phone = lead.replace("whatsapp:", "").trim();
      const phoneDigits = String(phone).replace(/\D/g, "");
      const incomingText = (req.body.Body || "").trim();
      const finalText = incomingText;

      if (finalText.trim().toLowerCase() === "reset" && phoneDigits === ADMIN_RESET_PHONE_DIGITS) {
        await pool.query(
          `UPDATE wa_users
           SET state = '{}'::jsonb, updated_at = NOW()
           WHERE regexp_replace(phone, '\\D', '', 'g') = $1`,
          [phoneDigits]
        );
        await pool.query(`DELETE FROM wa_slot_locks WHERE phone = $1 AND status='held'`, [phone]);
        await sendWhatsApp(`whatsapp:+${phoneDigits}`, bot, "🔁 Memória resetada. Pode testar do zero agora.", 0);
        return;
      }

      if (["simular pagamento", "paguei_teste", "simular_pagamento", "aprovar_teste"].includes(norm(finalText)) && phoneDigits === ADMIN_RESET_PHONE_DIGITS) {
        const st = await getUserState(phone);
        st.payment = st.payment || {};
        st.payment.status = "approved";
        st.payment.simulated = true;
        const sf = ensureFollowupState(st);
        sf.enabled = false;
        sf.completed = true;
        sf.next_at = 0;
        if (st.slot_key) await markSlotPaid(st.slot_key, phone);
        await saveUserState(phone, st);
        await sendWhatsApp(lead, bot, afterPaidReply(st), 0);
        return;
      }

      let state = initializeState(await getUserState(phone), bot);
      const signals = detectLeadSignals(finalText, state);
      const flags = signals.flags;
      const priority = getConversationPriority(signals, state);
      if (flags.focus && !state.focus) state.focus = flags.focus;
      const detectedCondition = detectCondition(finalText);
      if (detectedCondition && !state.condition) state.condition = detectedCondition;
      const detectedProblem = extractProblemText(finalText);
      if (detectedProblem && !state.problem_text) state.problem_text = detectedProblem;
      touchFollowupOnInbound(state, finalText);
      state.conversation_stage = deriveConversationStage(state, signals);

      let reply = "";

      // 0) confirmado
      if (state.payment?.status === "approved") {
        const f = ensureFollowupState(state);
        f.enabled = false;
        f.completed = true;
        f.next_at = 0;
        state.awaiting_followup = false;
        reply = afterPaidReply(state);
      }

      // 1) orquestrador principal por prioridade
      else if (priority === "URGENT") {
        reply = urgentReply();
      }
      else if (priority === "COMPLIANCE") {
        reply = complianceSafeReply(signals, state);
      }
      else if (priority === "PAYMENT_CLOSE") {
        reply = resolvePaymentStep(state);
      }
      else if (priority === "PLAN_CLOSE") {
        reply = await resolvePlanSelection({ signals, state, phone });
      }
      else if (priority === "ANSWER_FIRST") {
        reply = appendSmartTransition(answerLiteralQuestion(signals, state), signals, state);
        if (state.payment?.status === "pending") markLinkGuard(state);
        if (!state.nome && !state.stage) {
          state.stage = "ASK_NAME";
          reply += "\n\nAntes de seguir, me diz só seu primeiro nome?";
        }
      }
      else if (priority === "HANDLE_OBJECTION") {
        reply = appendSmartTransition(handleDominantObjection(signals, state), signals, state);
        if (state.payment?.status === "pending") markLinkGuard(state);
        if (!state.nome && !state.stage) {
          state.stage = "ASK_NAME";
          reply += "\n\nAntes de seguir, me diz só seu primeiro nome?";
        }
      }
      else if (priority === "REENGAGE") {
        reply = buildReengagementReply(state);
        state.awaiting_followup = false;
      }

      // 2) abertura
      else if (!state.stage && !state.nome) {
        state.stage = "ASK_NAME";
        reply = askNameIntroReply();
      }

      // 4) captura do nome
      else if (state.stage === "ASK_NAME" && !state.nome) {
        const nm = extractFirstName(finalText);
        if (nm) {
          state.nome = nm;
          state.rapport_done = true;
          state.stage = "ASK_PROBLEM";
          reply = askProblemAfterNameReply(state);
        } else {
          const ai = await runLia({ incomingText: finalText, state, flags, mode: "rapport" });
          if (ai.reply === "__NEED_PRICE__" || ai.reply === "__NEED_BOOK__" || ai.reply === "__NEED_PAY__") {
            reply = askNameIntroReply();
          } else {
            reply = "Perfeito 🙂 Antes de seguir, me diz só seu *primeiro nome*.";
          }
        }
      }

      // 5) captura problema
      else if (state.stage === "ASK_PROBLEM" || (state.nome && !state.problem_text && !state.date_key)) {
        const pb = extractProblemText(finalText);
        if (pb) {
          state.problem_text = pb;
          state.condition = state.condition || detectCondition(pb) || state.focus || null;
          state.stage = "DIAG_Q1";
          state.diagnostic_step = 1;
          state.diag_questions_asked = 0;
          reply = q1Reply(state);
        } else {
          const ai = await runLia({ incomingText: finalText, state, flags, mode: "qualify_problem" });
          if (ai.reply === "__NEED_PRICE__") reply = "Claro 🙂 Antes de entrar nos valores, eu quero entender rapidinho seu foco principal. O que você gostaria de tratar hoje?";
          else reply = askProblemAfterNameReply(state);
        }
      }

      // 6) script diagnóstico
      else if (state.stage === "DIAG_Q1") {
        state.diagnostic_answers.q1 = finalText;
        state.diag_questions_asked = Number(state.diag_questions_asked || 0) + 1;
        state.diagnostic_step = 2;
        state.stage = "DIAG_Q2";
        reply = q2Reply(state);
      }
      else if (state.stage === "DIAG_Q2") {
        state.diagnostic_answers.q2 = finalText;
        state.diag_questions_asked = Number(state.diag_questions_asked || 0) + 1;
        if (Number(state.diag_questions_asked || 0) >= 2 && objectionResolvedEnough(signals, state)) {
          state.diagnostic_step = 3;
          moveToValueOrAgenda(state);
          reply = bridgeToConsultReply(state);
        } else {
          state.diagnostic_step = 3;
          state.stage = "DIAG_Q3";
          reply = q3Reply();
        }
      }
      else if (state.stage === "DIAG_Q3") {
        state.diagnostic_answers.q3 = finalText;
        state.diag_questions_asked = Number(state.diag_questions_asked || 0) + 1;
        state.diagnostic_step = 3;
        state.stage = "AFTER_DIAGNOSTIC";
        reply = bridgeToConsultReply(state);
      }

      // 7) se o paciente quiser ver horários após a ponte
      else if (state.stage === "AFTER_DIAGNOSTIC" && (flags.wantsBook || flags.asksHours || flags.confirms)) {
        state.stage = "ASK_DAY";
        reply = await askDayReply();
      }
      else if (state.stage === "AFTER_DIAGNOSTIC") {
        const ai = await runLia({ incomingText: finalText, state, flags, mode: "after_diagnostic" });
        if (ai.reply === "__NEED_BOOK__") {
          state.stage = "ASK_DAY";
          reply = await askDayReply();
        } else if (ai.reply === "__NEED_PRICE__") {
          state.price_ask_count += 1;
          reply = state.price_ask_count >= 2 ? priceReply() : prePriceValueReply();
          if (state.price_ask_count >= 2) markObjectionMemory(state, "price_answered");
          if (state.price_ask_count >= 2) state.stage = "ASK_PLAN";
        } else {
          reply = ai.reply;
          state = mergeState(state, ai.updates);
        }
      }

      // 8) intenção de pagar / pagamento pendente
      else if (state.payment?.status === "pending" && state.payment?.link) {
        if (flags.intentPay || signals.buyingSignal) {
          reply = pendingPaymentReply(state);
          state.stage = "WAIT_PAYMENT";
        } else if (shouldSuppressPendingLink(signals, state)) {
          const core = signals.explicitQuestion ? answerLiteralQuestion(signals, state) : handleDominantObjection(signals, state);
          reply = appendSmartTransition(core, signals, state);
          markLinkGuard(state);
          state.stage = "WAIT_PAYMENT";
        } else if (flags.saysExpensive) {
          markObjectionMemory(state, "price_answered");
          reply = appendSmartTransition(buildExpensiveReply(), signals, state);
          state.stage = "WAIT_PAYMENT";
        } else if (signals.futureCostResistance) {
          markObjectionMemory(state, "future_cost_answered");
          reply = appendSmartTransition(
            "Essa é uma dúvida importante 🙂 O valor pode variar conforme produto e dose, então não existe um número único para todo mundo. O Dr. Alef orienta com realismo para o que é viável no seu caso.",
            signals,
            state
          );
          markLinkGuard(state);
          state.stage = "WAIT_PAYMENT";
        } else if (flags.saysWillSee || flags.saysUnsure) {
          reply = buildThinkingReply(state);
          state.stage = "WAIT_PAYMENT";
        } else {
          const blockedRecently = Number(state?.link_guard?.last_blocked_at || 0) && nowMs() - Number(state.link_guard.last_blocked_at) < 10 * 60 * 1000;
          reply = blockedRecently ? buildThinkingReply(state) : pendingPaymentReply(state);
          state.stage = "WAIT_PAYMENT";
        }
      }
      else if (flags.intentPay) {
        if (!state.nome) {
          state.stage = "ASK_NAME";
          reply = askNameIntroReply();
        } else if (!state.problem_text) {
          state.stage = "ASK_PROBLEM";
          reply = askProblemAfterNameReply(state);
        } else if (!state.date_key) {
          state.stage = "ASK_DAY";
          reply = "Perfeito 🙂 Antes do pagamento, vou te mostrar os horários disponíveis para reservar seu atendimento.";
        } else if (!state.slot_time || !state.slot_key) {
          state.stage = "OFFER_SLOTS";
          reply = await offerSlotsReply(state);
        } else if (!state.nome_completo) {
          state.stage = "ASK_FULLNAME";
          reply = askFullNameReply(state);
        } else if (!state.birthdate) {
          state.stage = "ASK_BIRTHDATE";
          reply = askBirthdateReply(state);
        } else if (!state.email) {
          state.stage = "ASK_EMAIL";
          reply = askEmailReply();
        } else if (state.selected_plan_key) {
          const planKey = state.selected_plan_key;
          const holdCheck = await acquireSlotHold(state.date_key, state.slot_time, phone);
          if (!holdCheck.ok) {
            state.slot_time = null;
            state.slot_key = null;
            state.stage = "OFFER_SLOTS";
            reply = "Esse horário acabou de ser preenchido antes da confirmação 🙏 Vou te mostrar as próximas melhores opções.\n\n" + (await offerSlotsReply(state));
          } else {
            state.slot_key = holdCheck.slot_key;
            const pref = await mpCreatePreference({ phone, planKey });
            state.payment = {
              status: "pending",
              plan_key: planKey,
              preference_id: pref.preference_id,
              link: pref.link,
              external_reference: pref.external_reference,
              created_at: Date.now(),
            };
            reply = paymentSentReply(pref.plan, pref.link, state);
            state.stage = "WAIT_PAYMENT";
          }
        } else {
          state.stage = "ASK_PLAN";
          reply = askPlanReply();
        }
      }

      // 9) preço: uma vez faz rapport/valor, duas vezes revela
      else if (flags.wantsPrice) {
        state.price_ask_count += 1;
        if (!state.nome) {
          state.stage = "ASK_NAME";
          reply = state.price_ask_count >= 2 ? `${prePriceValueReply()}\n\n${priceReply()}` : "Claro 🙂 Antes de te passar as opções, eu quero entender rapidinho seu caso para te orientar melhor.\n\nQual é o seu *primeiro nome*?";
          if (state.price_ask_count >= 2) markObjectionMemory(state, "price_answered");
          if (state.price_ask_count >= 2) state.stage = "ASK_PLAN";
        } else if (!state.problem_text && state.price_ask_count < 2) {
          state.stage = "ASK_PROBLEM";
          reply = prePriceValueReply() + "\n\nMe conta rapidinho o que você gostaria de tratar hoje.";
        } else {
          reply = priceReply();
          markObjectionMemory(state, "price_answered");
          state.stage = "ASK_PLAN";
        }
      }

      // 10) objeções e dúvidas
      else if (flags.asksStartNow) {
        reply = "Entendi sua vontade de começar. Por segurança, eu não consigo orientar dose/como tomar por aqui 🙏 Isso depende do seu caso e das medicações. Se quiser, eu te explico como funciona a avaliação e já te ajudo a confirmar.";
      }
      else if (flags.saysExpensive) {
        state.objection_used_count += 1;
        reply = buildExpensiveReply();
      }
      else if (flags.saysWillSee) {
        state.objection_used_count += 1;
        reply = buildThinkingReply(state);
      }
      else if (flags.saysUnsure) {
        state.objection_used_count += 1;
        reply = buildUnsureReply(state, finalText);
      }
      else if (flags.saysIndecisive) {
        reply = state?.date_key
          ? `Os horários que os pacientes costumam preferir são no início da noite.\n\nTenho *18h* ou *19h* disponíveis em *${formatDatePt(state.date_key)}*.\n\nQual fica melhor para você?`
          : "Os horários que os pacientes costumam preferir são no início da noite.\n\nTenho *18h* ou *19h* disponíveis.\n\nQual fica melhor para você?";
      }
      else if (flags.asksIfWorks) {
        reply = buildWorksReply(state, finalText) + "\n\nSe você quiser, eu posso te explicar rapidamente como funciona a avaliação.";
      }

      // 11) entrada de agendamento
      else if (flags.wantsBook || flags.asksHours) {
        if (!state.nome) {
          state.stage = "ASK_NAME";
          reply = askNameIntroReply();
        } else if (!state.problem_text) {
          state.stage = "ASK_PROBLEM";
          reply = askProblemAfterNameReply(state);
        } else if (!state.date_key) {
          state.stage = "ASK_DAY";
          reply = await askDayReply();
        } else if (!state.slot_time) {
          state.stage = "OFFER_SLOTS";
          reply = await offerSlotsReply(state);
        } else if (!state.nome_completo) {
          state.stage = "ASK_FULLNAME";
          reply = askFullNameReply(state);
        } else if (!state.birthdate) {
          state.stage = "ASK_BIRTHDATE";
          reply = askBirthdateReply(state);
        } else if (!state.email) {
          state.stage = "ASK_EMAIL";
          reply = askEmailReply();
        } else {
          state.stage = "ASK_PLAN";
          reply = askPlanReply();
        }
      }

      // 12) escolher dia
      else if (state.stage === "ASK_DAY") {
        const dayChoice = extractNumericChoice(finalText);
        const explicitDate = extractDateKey(finalText);
        const suggested = await getSuggestedDayKeys();
        if (dayChoice && suggested[dayChoice - 1]) {
          state.date_key = suggested[dayChoice - 1];
          state.stage = "OFFER_SLOTS";
          reply = await offerSlotsReply(state);
        } else if (explicitDate) {
          const avail = await getAvailableSlotsForDate(explicitDate);
          if (!avail.length) reply = "Esse dia está indisponível no momento 🙏 Quer que eu te mostre outra data próxima?";
          else {
            state.date_key = explicitDate;
            state.stage = "OFFER_SLOTS";
            reply = await offerSlotsReply(state);
          }
        } else {
          reply = "Qual data fica melhor para você? Pode me responder com o número da opção ou com o dia, por exemplo *quarta-feira* 🙂";
        }
      }

      // 13) escolher horário
      else if (state.stage === "OFFER_SLOTS") {
        const best = state.offered_slots?.length ? state.offered_slots : await chooseBestSlotsForDate(state.date_key, 3);
        const choiceNum = extractNumericChoice(finalText);
        const requestedTime = extractHourOnly(finalText);

        if (choiceNum && best[choiceNum - 1]) {
          const chosen = best[choiceNum - 1];
          const hold = await acquireSlotHold(state.date_key, chosen, phone);
          if (!hold.ok) {
            reply = "Esse horário acabou de ser preenchido 🙏 Vou te mostrar as próximas melhores opções.\n\n" + (await offerSlotsReply(state));
          } else {
            state.slot_time = chosen;
            state.slot_key = hold.slot_key;
            await releaseOldHeldSlotsForPhone(phone, hold.slot_key);
            state.stage = "ASK_FULLNAME";
            reply = askFullNameReply(state);
          }
        } else if (requestedTime) {
          const available = await getAvailableSlotsForDate(state.date_key);
          if (available.includes(requestedTime)) {
            const hold = await acquireSlotHold(state.date_key, requestedTime, phone);
            if (!hold.ok) {
              reply = "Esse horário acabou de ser preenchido 🙏 Posso te mostrar as próximas melhores opções.\n\n" + (await offerSlotsReply(state));
            } else {
              state.slot_time = requestedTime;
              state.slot_key = hold.slot_key;
              await releaseOldHeldSlotsForPhone(phone, hold.slot_key);
              state.stage = "ASK_FULLNAME";
              reply = askFullNameReply(state);
            }
          } else {
            const best2 = await chooseBestSlotsForDate(state.date_key, 3);
            reply = `Esse horário específico não está disponível em *${formatDatePt(state.date_key)}*.\n\nO mais próximo que tenho é:\n${best2.map((s, i) => `${i + 1}) *${s}*`).join("\n")}\n\nQual fica melhor para você?`;
          }
        } else if (/\b(outro horario|outro horário|nenhum desses|nenhum|tem outro|outro dia)\b/.test(norm(finalText))) {
          state.stage = "ASK_SPECIFIC_TIME";
          reply = askPreferredTimeReply(state);
        } else {
          reply = "Qual você prefere? Pode me responder com *1, 2, 3* ou com o horário exato 🙂";
        }
      }

      // 14) horário específico
      else if (state.stage === "ASK_SPECIFIC_TIME") {
        const requestedTime = extractHourOnly(finalText);
        if (!requestedTime) {
          reply = `Me diz o horário exato em *${formatDatePt(state.date_key)}*, por exemplo *16h* 🙂`;
        } else {
          const available = await getAvailableSlotsForDate(state.date_key);
          if (available.includes(requestedTime)) {
            const hold = await acquireSlotHold(state.date_key, requestedTime, phone);
            if (!hold.ok) {
              reply = "Esse horário acabou de ser preenchido 🙏 Vou te mostrar outras opções.\n\n" + (await offerSlotsReply(state));
              state.stage = "OFFER_SLOTS";
            } else {
              state.slot_time = requestedTime;
              state.slot_key = hold.slot_key;
              await releaseOldHeldSlotsForPhone(phone, hold.slot_key);
              state.stage = "ASK_FULLNAME";
              reply = askFullNameReply(state);
            }
          } else {
            reply = `Esse horário não está disponível em *${formatDatePt(state.date_key)}*.\n\nQuer que eu te mostre as melhores opções desse dia?`;
            state.stage = "OFFER_SLOTS";
          }
        }
      }

      // 15) dados cadastrais
      else if (state.stage === "ASK_FULLNAME") {
        const full = extractFullName(finalText);
        if (full) {
          state.nome_completo = full;
          state.stage = "ASK_BIRTHDATE";
          reply = askBirthdateReply(state);
        } else {
          reply = "Perfeito 🙂 Me manda seu *nome completo* certinho, por favor.";
        }
      }
      else if (state.stage === "ASK_BIRTHDATE") {
        const bd = extractBirthDate(finalText);
        if (bd) {
          state.birthdate = bd;
          state.stage = "ASK_EMAIL";
          reply = askEmailReply();
        } else {
          reply = "Me manda sua *data de nascimento* no formato *dd/mm/aaaa* 🙂";
        }
      }
      else if (state.stage === "ASK_EMAIL") {
        const em = extractEmail(finalText);
        if (em) {
          state.email = em;
          state.stage = "ASK_PLAN";
          reply = `Obrigado 🙂\n\nHorário provisoriamente reservado: *${prettySlot(state.date_key, state.slot_time)}*.\n\n${askPlanReply()}`;
        } else {
          reply = "Perfeito 🙂 Me manda seu *e-mail* certinho, por favor.";
        }
      }

      // 16) plano
      else if (state.stage === "ASK_PLAN") {
        const planKey = extractPlanChoice(finalText);
        if (flags.saysExpensive) {
          markObjectionMemory(state, "price_answered");
          reply = buildExpensiveReply();
        }
        else if (signals.futureCostResistance) {
          markObjectionMemory(state, "future_cost_answered");
          reply = "Essa é uma dúvida importante 🙂 O valor pode variar conforme produto e dose, então não existe um número único para todo mundo. O Dr. Alef orienta com realismo para o que é viável no seu caso.";
        }
        else if (flags.saysWillSee) reply = buildThinkingReply(state);
        else if (flags.saysUnsure) reply = buildUnsureReply(state, finalText);
        else if (planKey) {
          reply = await resolvePlanSelection({ signals: { ...signals, planSignal: planKey }, state, phone });
        } else {
          reply = "Qual dessas opções faz mais sentido para você? Me responde com *1, 2 ou 3* 🙂";
        }
      }

      // 17) resistência
      else if (flags.refuses) {
        reply = "Tranquilo 🙂 Desculpa se soou pressionado. Quer que eu te explique rapidinho como funciona ou prefere só tirar uma dúvida agora?";
      }

      // 18) evidence útil
      else if (shouldUseEvidence(flags, state, finalText)) {
        const cond = detectCondition(finalText) || state.condition;
        const ev = buildEvidenceMessage(cond);
        if (ev) {
          state.evidence_used_count += 1;
          reply = ev + "\n\nSe você quiser, eu posso te explicar rapidamente como funciona a avaliação.";
        } else {
          const ai = await runLia({ incomingText: finalText, state, flags, mode: "guided" });
          reply = ai.reply;
          state = mergeState(state, ai.updates);
        }
      }

      // 19) conversa aberta com autonomia guiada
      else {
        const ai = await runLia({ incomingText: finalText, state, flags, mode: "open_conversation" });
        if (ai.reply === "__NEED_PRICE__") {
          state.price_ask_count += 1;
          reply = state.price_ask_count >= 2 ? priceReply() : prePriceValueReply();
          if (state.price_ask_count >= 2) markObjectionMemory(state, "price_answered");
          if (state.price_ask_count >= 2) state.stage = "ASK_PLAN";
        } else if (ai.reply === "__NEED_BOOK__") {
          if (!state.nome) {
            state.stage = "ASK_NAME";
            reply = askNameIntroReply();
          } else if (!state.problem_text) {
            state.stage = "ASK_PROBLEM";
            reply = askProblemAfterNameReply(state);
          } else {
            state.stage = "ASK_DAY";
            reply = await askDayReply();
          }
        } else if (ai.reply === "__NEED_PAY__") {
          if (state.payment?.status === "pending" && state.payment?.link) {
            reply = pendingPaymentReply(state);
            state.stage = "WAIT_PAYMENT";
          } else {
            reply = "Perfeito 🙂 Antes de finalizar, eu só preciso reservar seu horário e confirmar alguns dados.";
          }
        } else if (ai.reply === "__URGENT__") {
          reply = "Pela sua mensagem, isso pode precisar de avaliação urgente. Procure um pronto atendimento agora (ou SAMU 192).";
        } else {
          reply = ai.reply;
          state = mergeState(state, ai.updates);
          if (!state.nome && ai.updates?.nome) state.nome = String(ai.updates.nome).trim();
          if (!state.problem_text && ai.updates?.problem_text) state.problem_text = String(ai.updates.problem_text).trim();
          if (!state.condition && (ai.updates?.condition || state.problem_text)) state.condition = ai.updates?.condition || detectCondition(state.problem_text);
        }
      }

      if (similar(reply, state.last_bot_reply)) {
        if (!state.nome) reply = askNameIntroReply();
        else if (!state.problem_text) reply = askProblemAfterNameReply(state);
        else if (state.stage === "DIAG_Q1") reply = q1Reply(state);
        else if (state.stage === "DIAG_Q2") reply = q2Reply(state);
        else if (state.stage === "DIAG_Q3") reply = q3Reply();
        else if (!state.date_key) reply = await askDayReply();
        else if (!state.slot_time) reply = await offerSlotsReply(state);
        else if (!state.nome_completo) reply = askFullNameReply(state);
        else if (!state.birthdate) reply = askBirthdateReply(state);
        else if (!state.email) reply = askEmailReply();
        else if (state.payment?.status === "pending" && state.payment?.link) {
          const blockedRecently = Number(state?.link_guard?.last_blocked_at || 0) && nowMs() - Number(state.link_guard.last_blocked_at) < 10 * 60 * 1000;
          reply = blockedRecently ? buildThinkingReply(state) : pendingPaymentReply(state);
        }
        else reply = "Entendi 🙂 Me diz só: seu foco hoje é mais dor, sono, ansiedade ou outra questão?";
      }

      if (state.nome && reply.includes(state.nome)) state.name_used_count = Number(state.name_used_count || 0) + 1;

      state.conversation_stage = deriveConversationStage(state, signals);
      state.followup.last_context = summarizeLastContext(state);
      if (state.payment?.status === "approved") {
        state.followup.enabled = false;
        state.followup.completed = true;
        state.followup.next_at = 0;
        state.awaiting_followup = false;
      }

      const delaySec = computeHumanDelay(flags, state);
      state.last_bot_reply = reply;
      state.last_user_message = finalText;
      state.last_sent_at = Date.now();

      await saveUserState(phone, state);
      await sendWhatsApp(lead, bot, reply, delaySec);
    } catch (err) {
      console.error("❌ Erro no processamento async:", err);
      try {
        const lead = req.body.From || "";
        const bot = req.body.To || "";
        await twilioClient.messages.create({
          to: lead,
          from: bot,
          body: "Tive uma instabilidade rápida aqui 🙏 Me manda de novo em 1 frase se você quer *agendar*, *tirar dúvida* ou *ver valores*.",
        });
      } catch {}
    }
  })();
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 LIA V14 rodando na porta ${PORT}`));
