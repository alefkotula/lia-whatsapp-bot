/**
try {
  require('dotenv').config();
} catch (e) {}
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
 */require('dotenv').config();

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
function pad2(n) { return String(n).padStart(2, "0"); }
function currentYear() { return new Date().getFullYear(); }
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

  const m = cleaned.match(/(?:me chamo|sou|nome e|nome é)\s+(.+)$/i);
  const candidate = (m?.[1] || cleaned).trim();
  const parts = candidate.split(" ").filter(Boolean);

  if (parts.length < 1 || parts.length > 5) return null;
  if (/^\d+$/.test(candidate)) return null;
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
  if (/^(1|opcao 1|opção 1)$/.test(t)) return "full";
  if (/^(2|opcao 2|opção 2)$/.test(t)) return "basic";
  if (/^(3|opcao 3|opção 3)$/.test(t)) return "retorno";
  if (/\b(acompanhamento|consulta com retorno|com retorno|pacote|retorno em 30|acompanhamento medico|acompanhamento médico)\b/.test(t)) return "full";
  if (/\b(avaliacao especializada|avaliação especializada|avaliacao|avaliação|so a consulta|só a consulta|opcao 2|opção 2)\b/.test(t)) return "basic";
  if (/\b(retorno avulso|consulta de ajuste|apenas retorno)\b/.test(t)) return "retorno";
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
  const wantsPrice = /(preco|preço|valor|quanto custa|investimento|custa|valores)/.test(t);
  const asksPriceDirect = wantsPrice;
  const intentPay = /(como (pagar|fa[cç]o para pagar)|pagar|pagamento|pix|cartao|cartão|credito|crédito|debito|débito|boleto|link|parcel|parcela|quero pagar)/.test(t);
  const wantsBook = /(quero marcar|quero agendar|agendar|marcar|confirmar consulta|quero consulta|gostaria de agendar|tem horario|tem horário|agenda)/.test(t);
  const asksHours = /(horarios|horário|horario|que horas|vagas|disponibilidade)/.test(t);
  const confirms = /(sim|ok|beleza|pode|confirmo|fechado|vamos|pode ser|serve|confirmar)/.test(t);
  const refuses = /(nao quero|não quero|pare|para|chega|rude|grosso|nao gostei|não gostei)/.test(t);
  const asksStartNow = /(como tomar|dose|dosagem|quantas gotas|comecar agora|começar agora)/.test(t);
  const urgency = /(dor no peito|falta de ar|desmaio|avc|convuls|paralisia|confusao|confusão)/.test(t);
  const asksWho = /(quem e|quem eh|quem é|quem e o dr|quem é o dr|quem e o doutor|quem é o doutor)/.test(t);
  const asksIfWorks = /(funciona|serve|ajuda|melhora|tem resultado)/.test(t);
  const asksWorthConsult = /(vale a pena|por que essa consulta vale a pena|essa consulta vale a pena|compensa fazer a consulta|vale mesmo)/.test(t);
  const asksTrustedProduct = /(produto confiavel|produto confiável|como saber qual produto|qual produto e confiavel|qual produto é confiável|como sei que o produto e confiavel|como sei que o produto é confiável|produto seguro)/.test(t);
  const asksServeCondition = /(serve para minha condicao|serve para a minha condicao|serve pra minha condicao|serve para meu caso|serve pro meu caso|isso serve para a minha condicao|isso serve para meu caso|funciona pro meu caso)/.test(t);
  const asksMonthlyCost = /(custo por mes|custo por mês|quanto custa por mes|quanto custa por mês|tratamento por mes|tratamento por mês|gasto por mes|gasto por mês)/.test(t);
  const asksRecipe = /(precisa de receita|precisa receita|tem receita|receita medica|receita médica)/.test(t);
  const asksPharmacy = /(comprar em farmacia|comprar em farmácia|consigo comprar em farmacia|consigo comprar em farmácia|farmacia|farmácia)/.test(t);
  const asksSideEffects = /(efeitos colaterais|efeito colateral|faz mal|risco|e seguro|é seguro|efeitos ruins)/.test(t);
  const asksTimeToEffect = /(demora para fazer efeito|quanto tempo para fazer efeito|em quanto tempo faz efeito|quando comeca a fazer efeito|quando começa a fazer efeito)/.test(t);
  const asksScam = /(golpe|confiavel mesmo|confiável mesmo|como sei que e serio|como sei que é serio|telemedicina e segura|telemedicina é segura|serio mesmo|sério mesmo)/.test(t);
  const asksDependence = /(vicia|dependencia|dependência)/.test(t);
  const saysWillSee = /(vou ver|depois te falo|vou confirmar|vou pensar|te aviso|depois vejo)/.test(t);
  const saysIndecisive = /(tanto faz|qual voce acha melhor|qual você acha melhor)/.test(t);
  const saysExpensive = /(caro|caríssima|carissimo|caríssimo|achei caro|muito caro|pesado)/.test(t);
  const saysUnsure = /(nao tenho certeza|não tenho certeza|nao sei|não sei|sera|será|to na duvida|tô na dúvida|duvida|dúvida|medo de gastar dinheiro a toa|gastar dinheiro a toa|medo de me frustrar)/.test(t);
  const asksHowConsultWorks = /(como funciona a consulta|como funciona essa consulta|como funciona essa avaliacao|como funciona essa avaliação|como funciona a avaliacao|como funciona a avaliação)/.test(t);
  const asksIfOnline = /(e online|é online|online mesmo|presencial|precisa ir|tem que ir|ir em algum lugar|precisa ir na clinica|precisa ir na clínica)/.test(t);
  const asksLegal = /(legal no brasil|e legal|é legal|isso e legal|isso é legal|regular no brasil|regular no brasil hoje|anvisa|legalmente regular)/.test(t);
  const asksChapado = /(chapado|chapar|maconha mesmo|isso e maconha|isso é maconha|droga)/.test(t);

  const focus =
    (/(insonia|insônia|dormir|sono|acordar)/.test(t) && "insonia") ||
    (/(ansiedade|panico|pânico|crise)/.test(t) && "ansiedade") ||
    (/(fibromialgia)/.test(t) && "fibromialgia") ||
    (/(neuropat)/.test(t) && "dor_neuropatica") ||
    (/(artrose)/.test(t) && "artrose") ||
    (/(artrite)/.test(t) && "artrite") ||
    (/(coluna|lombar)/.test(t) && "dor_lombar") ||
    (/(dor)/.test(t) && "dor_cronica") ||
    null;

  const hasDirectQuestion =
    asksWho || asksIfOnline || asksHowConsultWorks || asksLegal || asksChapado || asksIfWorks ||
    asksWorthConsult || asksTrustedProduct || asksServeCondition || asksMonthlyCost || asksRecipe ||
    asksPharmacy || asksSideEffects || asksTimeToEffect || asksScam || asksDependence || asksPriceDirect;

  return {
    wantsPrice, asksPriceDirect, intentPay, wantsBook, asksHours, confirms, refuses, asksStartNow,
    urgency, asksWho, asksIfWorks, asksWorthConsult, asksTrustedProduct, asksServeCondition,
    asksMonthlyCost, asksRecipe, asksPharmacy, asksSideEffects, asksTimeToEffect, asksScam,
    asksDependence, saysWillSee, saysIndecisive, saysExpensive, saysUnsure, asksHowConsultWorks,
    asksIfOnline, asksLegal, asksChapado, hasDirectQuestion, focus,
  };
}

function hasPriorityQuestion(flags) {
  return !!(
    flags?.asksWho || flags?.asksIfOnline || flags?.asksHowConsultWorks || flags?.asksLegal ||
    flags?.asksChapado || flags?.asksIfWorks || flags?.asksWorthConsult || flags?.asksTrustedProduct ||
    flags?.asksServeCondition || flags?.asksMonthlyCost || flags?.asksRecipe || flags?.asksPharmacy ||
    flags?.asksSideEffects || flags?.asksTimeToEffect || flags?.asksScam || flags?.asksDependence ||
    flags?.asksPriceDirect
  );
}

function followUpAfterAnswer(state, incomingText) {
  const cond = detectCondition(incomingText) || state?.condition || state?.focus || null;
  if (state?.problem_text) {
    if (!state?.date_key) return "Se você quiser, eu posso te mostrar os próximos horários disponíveis 🙂";
    if (!state?.slot_time) return "Se você quiser, eu posso te mostrar os melhores horários desse dia 🙂";
  }
  if (cond === "insonia") return "Hoje o que mais te incomoda: dificuldade para pegar no sono, acordar à noite ou os dois?";
  if (cond === "ansiedade") return "Hoje o que mais pesa para você: ansiedade, sono ou os dois?";
  return "No seu caso, o que mais tem te incomodado hoje: dor, sono, ansiedade ou outro problema?";
}

function buildDirectQuestionReply(state, flags, incomingText) {
  const cond = detectCondition(incomingText) || state?.condition || state?.focus || null;
  const condLabelMap = {
    fibromialgia: "fibromialgia",
    dor_cronica: "dor crônica",
    dor_lombar: "dor na coluna",
    dor_neuropatica: "dor neuropática",
    artrose: "artrose",
    artrite: "artrite",
    insonia: "insônia",
    ansiedade: "ansiedade",
    enxaqueca: "enxaqueca",
  };
  const condLabel = cond ? (condLabelMap[cond] || "seu quadro") : "seu caso";

  if (flags.asksPriceDirect) {
    return `Claro 🙂\n\nHoje trabalhamos com estas opções:\n\n1) *${PLANS.full.label}* (${PLANS.full.subtitle}) — *R$${PLANS.full.price}* *(87% das pessoas escolhem essa opção)* ⭐\n2) *${PLANS.basic.label}* (${PLANS.basic.subtitle}) — *R$${PLANS.basic.price}*\n3) *${PLANS.retorno.label}* (${PLANS.retorno.subtitle}) — *R$${PLANS.retorno.price}*\n\nSe você quiser, eu também posso te explicar rapidamente a diferença entre elas.`;
  }
  if (flags.asksWorthConsult) {
    return `Porque a consulta não é uma tentativa no escuro 🙂\n\nO Dr. Alef avalia seu histórico, o que você já tentou, medicações em uso e se esse tratamento realmente pode fazer sentido para o seu caso com segurança.\n\nOu seja: a ideia é te dar mais clareza antes de qualquer decisão.`;
  }
  if (flags.asksTrustedProduct || flags.asksScam) {
    return `Essa é uma dúvida muito importante 🙂\n\nO caminho seguro é fazer avaliação médica primeiro. A partir daí, quando existe indicação, o médico orienta a forma correta e segura de seguir — sem tentativa no escuro e sem depender de produto aleatório da internet.\n\nIsso reduz muito o risco de cair em algo ruim ou inadequado para o seu caso.`;
  }
  if (flags.asksLegal || flags.asksRecipe) {
    return `Sim 🙂 Hoje o uso medicinal é regular no Brasil quando existe avaliação médica e prescrição quando o caso faz sentido.\n\nO ponto principal é fazer isso com orientação correta, porque a indicação muda de pessoa para pessoa.`;
  }
  if (flags.asksPharmacy) {
    return `Em alguns casos, sim 🙂 Mas isso depende do tipo de produto, da formulação e da orientação médica.\n\nPor isso a avaliação vem primeiro: o Dr. Alef analisa seu caso e orienta o caminho certo, com segurança.`;
  }
  if (flags.asksChapado) {
    return `Essa é uma dúvida muito comum 🙂\n\nO tratamento medicinal não é a mesma coisa que uso recreativo. Tudo depende da formulação, do objetivo clínico e da avaliação do médico.\n\nQuando o caso é bem conduzido, a proposta é terapêutica, não “deixar chapado”.`;
  }
  if (flags.asksDependence) {
    return `Essa possibilidade precisa ser avaliada com seriedade 🙂\n\nPor isso a indicação, a formulação e o acompanhamento médico fazem diferença. O objetivo é sempre segurança e individualização, não uso solto.`;
  }
  if (flags.asksSideEffects) {
    return `Podem existir efeitos colaterais, como em qualquer tratamento 🙂\n\nJustamente por isso a avaliação individual é importante: o Dr. Alef considera seu histórico, sintomas e medicações para ver se faz sentido e como conduzir com segurança.`;
  }
  if (flags.asksTimeToEffect) {
    return `Isso varia de caso para caso 🙂\n\nAlgumas pessoas percebem mais cedo melhora de sono ou redução de desconforto, enquanto outras precisam de ajuste e acompanhamento. Não é igual para todo mundo.`;
  }
  if (flags.asksServeCondition || flags.asksIfWorks) {
    const ev = cond && Number(state?.evidence_used_count || 0) < 2 ? buildEvidenceMessage(cond) : null;
    if (ev) state.evidence_used_count = Number(state?.evidence_used_count || 0) + 1;
    const evidenceChunk = ev ? `${ev}\n\n` : "Mas isso depende do seu histórico, do que você já tentou e do objetivo do tratamento.\n\n";
    return `Pode fazer sentido, sim, para ${condLabel} em alguns casos 🙂\n\n${evidenceChunk}O ponto é avaliar se isso realmente combina com o seu caso, em vez de prometer algo genérico.`;
  }
  if (flags.asksMonthlyCost) {
    return `O custo mensal do tratamento pode variar bastante 🙂\n\nIsso depende da formulação, da dose e do que faz sentido para o seu caso. Por isso eu prefiro não te passar um número solto e impreciso antes da avaliação.\n\nO que eu consigo te passar com clareza agora são os valores da consulta, se você quiser.`;
  }
  if (flags.asksIfOnline || flags.asksHowConsultWorks) {
    return consultationExplanationReply() + "\n\n" + (flags.asksIfOnline ? onlineReply() : "");
  }
  if (flags.asksWho) return whoReply();
  return null;
}

function shouldAnswerBeforeFunnel(state, flags) {
  if (!hasPriorityQuestion(flags)) return false;
  if (["ASK_FULLNAME", "ASK_BIRTHDATE", "ASK_EMAIL", "ASK_PLAN", "WAIT_PAYMENT"].includes(state?.stage)) return false;
  return true;
}

function compactMemory(state) {
  const s = state || {};
  return {
    nome: s.nome || null,
    focus: s.focus || null,
    condition: s.condition || null,
    problem_text: s.problem_text || null,
    stage: s.stage || null,
    date_key: s.date_key || null,
    slot_time: s.slot_time || null,
    nome_completo: s.nome_completo || null,
    birthdate: s.birthdate || null,
    email: s.email || null,
    selected_plan_key: s.selected_plan_key || null,
    payment_status: s.payment?.status || null,
    evidence_used_count: s.evidence_used_count || 0,
    objection_used_count: s.objection_used_count || 0,
    rapport_done: !!s.rapport_done,
    diagnostic_step: s.diagnostic_step || 0,
    price_ask_count: s.price_ask_count || 0,
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
  state.diagnostic_answers = state.diagnostic_answers || {};
  state.awaiting_operational_permission = !!state.awaiting_operational_permission;
  state.last_bot_from = bot;
  return state;
}


async function processIncomingMessage({ phone, bot, finalText, channel = "twilio" }) {
  let state = initializeState(await getUserState(phone), bot);
  const flags = detectIntent(finalText);
  if (flags.focus && !state.focus) state.focus = flags.focus;
  const detectedCondition = detectCondition(finalText);
  if (detectedCondition && !state.condition) state.condition = detectedCondition;
  const detectedProblem = extractProblemText(finalText);
  if (detectedProblem && !state.problem_text) state.problem_text = detectedProblem;

  let reply = "";

  if (state.payment?.status === "approved") {
    reply = afterPaidReply(state);
  }
  else if (flags.urgency) {
    reply = "Entendi. Pela sua mensagem, isso pode precisar de avaliação urgente. Procure um pronto atendimento agora (ou SAMU 192). Assim que estiver seguro(a), me chama aqui.";
  }
  else if (shouldAnswerBeforeFunnel(state, flags)) {
    const direct = buildDirectQuestionReply(state, flags, finalText);
    if (direct) {
      reply = `${direct}

${followUpAfterAnswer(state, finalText)}`;
      if (!state.problem_text && detectedProblem) {
        state.problem_text = detectedProblem;
        state.condition = state.condition || detectedCondition || state.focus || null;
      }
      if (!state.stage) state.stage = state.problem_text ? "AFTER_DIAGNOSTIC" : "ANSWER_FIRST";
    }
  }
  else if (!state.stage && !state.nome) {
    state.stage = "ASK_NAME";
    reply = askNameIntroReply();
  }
  else if (state.stage === "ASK_NAME" && !state.nome) {
    const nm = extractFirstName(finalText);
    if (nm) {
      state.nome = nm;
      state.rapport_done = true;
      state.stage = state.problem_text ? "AFTER_DIAGNOSTIC" : "ASK_PROBLEM";
      reply = state.problem_text ? `Prazer, ${state.nome} 🙂

${followUpAfterAnswer(state, finalText)}` : askProblemAfterNameReply(state);
    } else if (hasPriorityQuestion(flags)) {
      const direct = buildDirectQuestionReply(state, flags, finalText);
      reply = direct ? `${direct}

${followUpAfterAnswer(state, finalText)}` : "Perfeito 🙂 Antes de seguir, me diz só seu *primeiro nome*.";
      state.stage = state.problem_text ? "AFTER_DIAGNOSTIC" : "ANSWER_FIRST";
    } else {
      const ai = await runLia({ incomingText: finalText, state, flags, mode: "rapport" });
      if (ai.reply === "__NEED_PRICE__") {
        reply = priceReply();
        state.stage = "ASK_PLAN";
      } else if (ai.reply === "__NEED_BOOK__" || ai.reply === "__NEED_PAY__") {
        reply = askNameIntroReply();
      } else {
        reply = "Perfeito 🙂 Antes de seguir, me diz só seu *primeiro nome*.";
      }
    }
  }
  else if (state.stage === "ASK_PROBLEM" || state.stage === "ANSWER_FIRST" || (state.nome && !state.problem_text && !state.date_key)) {
    if (hasPriorityQuestion(flags)) {
      const direct = buildDirectQuestionReply(state, flags, finalText);
      if (direct) {
        reply = `${direct}

${followUpAfterAnswer(state, finalText)}`;
        state.stage = state.problem_text ? "AFTER_DIAGNOSTIC" : "ASK_PROBLEM";
      }
    }
    if (!reply) {
      const pb = extractProblemText(finalText);
      if (pb) {
        state.problem_text = pb;
        state.condition = state.condition || detectCondition(pb) || state.focus || null;
        state.stage = "DIAG_Q1";
        state.diagnostic_step = 1;
        reply = q1Reply(state);
      } else {
        const ai = await runLia({ incomingText: finalText, state, flags, mode: "qualify_problem" });
        if (ai.reply === "__NEED_PRICE__") {
          reply = priceReply();
          state.stage = "ASK_PLAN";
        } else {
          reply = askProblemAfterNameReply(state);
        }
      }
    }
  }
  else if (state.stage === "DIAG_Q1") {
    state.diagnostic_answers.q1 = finalText;
    state.diagnostic_step = 2;
    state.stage = "DIAG_Q2";
    reply = q2Reply(state);
  }
  else if (state.stage === "DIAG_Q2") {
    state.diagnostic_answers.q2 = finalText;
    state.diagnostic_step = 3;
    state.stage = "DIAG_Q3";
    reply = q3Reply();
  }
  else if (state.stage === "DIAG_Q3") {
    state.diagnostic_answers.q3 = finalText;
    state.diagnostic_step = 3;
    state.stage = "AFTER_DIAGNOSTIC";
    reply = bridgeToConsultReply(state);
  }
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
      if (state.price_ask_count >= 2) state.stage = "ASK_PLAN";
    } else {
      reply = ai.reply;
      state = mergeState(state, ai.updates);
    }
  }
  else if (state.payment?.status === "pending" && state.payment?.link) {
    if (flags.intentPay) {
      reply = pendingPaymentReply(state);
      state.stage = "WAIT_PAYMENT";
    } else if (flags.saysExpensive) {
      reply = buildExpensiveReply() + `\n\nSe quiser confirmar agora, seu link continua ativo:\n${state.payment.link}`;
      state.stage = "WAIT_PAYMENT";
    } else if (flags.saysWillSee || flags.saysUnsure) {
      reply = buildThinkingReply(state) + `\n\nSe quiser finalizar agora, seu link continua aqui:\n${state.payment.link}`;
      state.stage = "WAIT_PAYMENT";
    } else {
      reply = pendingPaymentReply(state);
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
  else if (flags.wantsPrice) {
    state.price_ask_count += 1;
    if (!state.nome) {
      state.stage = "ASK_NAME";
      reply = state.price_ask_count >= 2 ? `${prePriceValueReply()}\n\n${priceReply()}` : "Claro 🙂 Antes de te passar as opções, eu quero entender rapidinho seu caso para te orientar melhor.\n\nQual é o seu *primeiro nome*?";
      if (state.price_ask_count >= 2) state.stage = "ASK_PLAN";
    } else if (!state.problem_text && state.price_ask_count < 2) {
      state.stage = "ASK_PROBLEM";
      reply = prePriceValueReply() + "\n\nMe conta rapidinho o que você gostaria de tratar hoje.";
    } else {
      reply = priceReply();
      state.stage = "ASK_PLAN";
    }
  }
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
  else if (state.stage === "ASK_PLAN") {
    const planKey = extractPlanChoice(finalText);
    if (flags.saysExpensive) reply = buildExpensiveReply();
    else if (flags.saysWillSee) reply = buildThinkingReply(state);
    else if (flags.saysUnsure) reply = buildUnsureReply(state, finalText);
    else if (planKey) {
      state.selected_plan_key = planKey;
      const holdCheck = await acquireSlotHold(state.date_key, state.slot_time, phone);
      if (!holdCheck.ok) {
        state.slot_time = null;
        state.slot_key = null;
        state.stage = "OFFER_SLOTS";
        reply = "Esse horário acabou de ser preenchido antes da confirmação 🙏 Vou te mostrar as próximas melhores opções.\n\n" + (await offerSlotsReply(state));
      } else {
        state.slot_key = holdCheck.slot_key;
        const already = state.payment && state.payment.preference_id && state.payment.plan_key === planKey && state.payment.status === "pending";
        if (already && state.payment.link) {
          reply = paymentSentReply(PLANS[planKey], state.payment.link, state);
        } else {
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
        }
        state.stage = "WAIT_PAYMENT";
      }
    } else {
      reply = "Qual dessas opções faz mais sentido para você? Me responde com *1, 2 ou 3* 🙂";
    }
  }
  else if (flags.refuses) {
    reply = "Tranquilo 🙂 Desculpa se soou pressionado. Quer que eu te explique rapidinho como funciona ou prefere só tirar uma dúvida agora?";
  }
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
  else {
    const ai = await runLia({ incomingText: finalText, state, flags, mode: "open_conversation" });
    if (ai.reply === "__NEED_PRICE__") {
      state.price_ask_count += 1;
      reply = state.price_ask_count >= 2 ? priceReply() : prePriceValueReply();
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
    else if (state.payment?.status === "pending" && state.payment?.link) reply = pendingPaymentReply(state);
    else reply = "Entendi 🙂 Me diz só: seu foco hoje é mais dor, sono, ansiedade ou outra questão?";
  }

  if (state.nome && reply.includes(state.nome)) state.name_used_count = Number(state.name_used_count || 0) + 1;

  const delaySec = channel === "simulator" ? 0 : computeHumanDelay(flags, state);
  state.last_bot_reply = reply;
  state.last_user_message = finalText;
  state.last_sent_at = Date.now();

  await saveUserState(phone, state);
  return { reply, state, flags, delaySec };
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
      const finalText = String(req.body.Body || "").trim();

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
        const st = initializeState(await getUserState(phone), bot);
        st.payment = st.payment || {};
        st.payment.status = "approved";
        st.payment.simulated = true;
        if (st.slot_key) await markSlotPaid(st.slot_key, phone);
        await saveUserState(phone, st);
        await sendWhatsApp(lead, bot, afterPaidReply(st), 0);
        return;
      }

      const result = await processIncomingMessage({ phone, bot, finalText, channel: "twilio" });
      await sendWhatsApp(lead, bot, result.reply, result.delaySec);
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

app.post("/simulator", async (req, res) => {
  try {
    const from = String(req.body.From || req.body.phone || "simulator:+5500000000000").trim();
    const to = String(req.body.To || req.body.botNumber || "simulator").trim();
    const finalText = String(req.body.Body || req.body.message || "").trim();
    const phone = from.replace(/^whatsapp:/, "").replace(/^simulator:/, "").trim();

    if (!phone || !finalText) {
      return res.status(400).json({ ok: false, error: "missing_phone_or_message" });
    }

    const result = await processIncomingMessage({ phone, bot: to, finalText, channel: "simulator" });
    const wantsJson = String(req.query.format || "").toLowerCase() === "json" || String(req.headers.accept || "").includes("application/json");

    if (wantsJson) {
      return res.json({ ok: true, reply: result.reply, delaySec: 0, stage: result.state.stage || null });
    }

    return res.type("text/plain; charset=utf-8").send(result.reply);
  } catch (err) {
    console.error("❌ Erro /simulator:", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 LIA V13 rodando na porta ${PORT}`));
