/**
 * INDEX FINAL — LIA CONVERSACIONAL DE ALTA CONVERSÃO
 *
 * Baseado na V13, preservando o núcleo determinístico e reforçando:
 * - prioridade lógica conversacional
 * - tratamento de objeções em tempo real
 * - parsing robusto de plano/nome/intenção
 * - motor de transição curta
 * - follow-up automático para leads que somem
 *
 * ARQUITETURA DE AUTONOMIA (70% IA / 30% regras, distribuída por fase):
 * - Abertura e rapport: 85% IA / 15% regras
 * - Triagem curta: 70% IA / 30% regras
 * - Objeções e transições: 75% IA / 25% regras
 * - Agenda / plano / pagamento: 10% IA / 90% regras
 * - Locks / webhook / confirmação / compliance: 0% IA / 100% regras
 *
 * IMPORTANTE:
 * - A IA nunca inventa preço, link, horário, dose, marca, produto ou promessa de cura.
 * - Agenda, pagamento, plano e confirmação continuam no código.
 * - O foco é vender melhor respondendo na ordem certa.
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
  FOLLOWUP_SECRET,
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
    explanation:
      "Inclui a consulta inicial e um retorno em torno de 30 dias para revisar resposta, ajustar conduta se necessário e acompanhar o início do tratamento com mais segurança.",
  },
  basic: {
    key: "basic",
    label: "Avaliação Médica Especializada",
    subtitle: "45 min",
    price: 347,
    short: "2",
    explanation:
      "É a consulta inicial individualizada, com duração média de 45 minutos, para entender seu caso com profundidade e avaliar se esse caminho faz sentido para você.",
  },
  retorno: {
    key: "retorno",
    label: "Consulta de Ajuste",
    subtitle: "Retorno avulso",
    price: 200,
    short: "3",
    explanation:
      "É um retorno avulso voltado para ajuste ou reavaliação, quando já existe acompanhamento prévio.",
  },
};

// Agenda fixa preservada da V13.
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_followups (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      step INTEGER NOT NULL,
      due_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wa_followups_pending_due
    ON wa_followups(status, due_at);
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
    .replace(/[“”"']/g, "")
    .trim();
}

function clip(text, max = 1200) {
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
  if (x.length > 70 && y.length > 70 && x.slice(0, 70) === y.slice(0, 70)) return true;
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

function cleanWords(text) {
  return (text || "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseName(s) {
  return String(s || "")
    .split(" ")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

function extractNameFromText(text) {
  const raw = (text || "").trim();
  if (!raw) return null;
  const low = norm(raw);

  const explicit = raw.match(/(?:pode me chamar de|me chama de|me chamo|meu nome e|meu nome é|sou)\s+([\p{L}'-]{2,}(?:\s+[\p{L}'-]{2,}){0,3})/iu);
  if (explicit?.[1]) {
    const candidate = cleanWords(explicit[1]);
    if (candidate) return titleCaseName(candidate);
  }

  if (/(sim|ok|beleza|claro|show|tanto faz|nao|não|dor|sono|ansiedade|fibromialgia|insonia|insônia)/.test(low) && raw.split(" ").length <= 2) {
    if (/(dor|sono|ansiedade|fibromialgia|insônia|insonia)/.test(low)) return null;
  }

  const cleaned = cleanWords(raw);
  if (!cleaned) return null;
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length < 1 || parts.length > 5) return null;
  if (/^\d+$/.test(cleaned)) return null;
  if (/(dor|sono|ansiedade|fibromialgia|artrose|artrite|enxaqueca|coluna|insonia|insônia)/i.test(cleaned) && parts.length <= 2) return null;
  if (["pode", "chamar", "me", "sim"].includes(norm(parts[0]))) return null;

  return titleCaseName(cleaned);
}

function extractFirstName(text) {
  const n = extractNameFromText(text);
  return n ? n.split(" ")[0] : null;
}

function extractFullName(text) {
  const explicit = String(text || "").match(/(?:nome completo|sou|me chamo|meu nome e|meu nome é)?\s*([\p{L}'-]{2,}(?:\s+[\p{L}'-]{2,}){1,5})/iu);
  const cleaned = cleanWords(explicit?.[1] || text || "");
  if (!cleaned) return null;
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length < 2 || parts.length > 6) return null;
  return titleCaseName(cleaned);
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
  if (t.includes("dor neuropatica") || t.includes("neuropat")) return "dor_neuropatica";
  if (t.includes("artrose")) return "artrose";
  if (t.includes("artrite")) return "artrite";
  if (t.includes("lombar") || t.includes("coluna") || t.includes("costas")) return "dor_lombar";
  if (t.includes("insonia") || t.includes("sono") || t.includes("dormir")) return "insonia";
  if (t.includes("ansiedade") || t.includes("panico") || t.includes("crise")) return "ansiedade";
  if (t.includes("enxaqueca")) return "enxaqueca";
  if (t.includes("dor")) return "dor_cronica";
  return null;
}

function extractProblemText(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const low = norm(t);
  if (/(dor|fibromialgia|insonia|sono|ansiedade|panico|artrose|artrite|enxaqueca|coluna|lombar|neuropat)/.test(low)) return t;
  const m = t.match(/(?:quero tratar|tratar|meu problema e|meu problema é|tenho|sofro com|o que me incomoda e|o que me incomoda é)\s+(.+)$/i);
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

  if (/^(1|opcao 1|opção 1)$/.test(t)) return "full";
  if (/^(2|opcao 2|opção 2)$/.test(t)) return "basic";
  if (/^(3|opcao 3|opção 3)$/.test(t)) return "retorno";

  if (/\b(acho que a 1|acho que opcao 1|acho que opçao 1|prefiro a 1|quero a 1|vou na 1|primeira opcao|primeira opção)\b/.test(t)) return "full";
  if (/\b(acho que a 2|acho que opcao 2|acho que opção 2|prefiro a 2|quero a 2|vou na 2|segunda opcao|segunda opção)\b/.test(t)) return "basic";
  if (/\b(acho que a 3|acho que opcao 3|acho que opção 3|prefiro a 3|quero a 3|vou na 3|terceira opcao|terceira opção)\b/.test(t)) return "retorno";

  if (/\b(acompanhamento|consulta com retorno|com retorno|pacote|retorno em 30|acompanhamento medico|acompanhamento médico|447)\b/.test(t)) return "full";
  if (/\b(avaliacao especializada|avaliação especializada|avaliacao|avaliação|so a consulta|só a consulta|primeira avaliacao|primeira avaliação|consulta inicial|347)\b/.test(t)) return "basic";
  if (/\b(retorno avulso|consulta de ajuste|apenas retorno|so retorno|só retorno|200)\b/.test(t)) return "retorno";

  return null;
}

function wantsReschedule(text) {
  const t = norm(text);
  return /(trocar|mudar|alterar|prefiro|so posso|só posso|nao posso|não posso|melhor)/.test(t) && (!!extractHourOnly(text) || !!extractDateKey(text));
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
    study: "Estudos clínicos mostram melhora relevante de dor e qualidade de vida em parte dos pacientes com fibromialgia quando existe indicação e acompanhamento médico.",
    bridge: "Mas isso sempre precisa ser individualizado, e é justamente isso que o Dr. Alef avalia na consulta.",
  },
  dor_cronica: {
    empathy: [
      "Entendo… viver com dor constante desgasta muito a qualidade de vida.",
      "Dor crônica realmente pode mexer com sono, humor e energia.",
      "Muita gente com dor passa anos tentando melhorar sem encontrar algo que ajude de verdade.",
    ],
    study: "Em dor crônica, há pacientes que apresentam melhora relevante de sintomas quando o tratamento é bem indicado e ajustado.",
    bridge: "O ponto importante é avaliar se isso pode fazer sentido para o seu quadro, com segurança.",
  },
  dor_lombar: {
    empathy: [
      "Entendo… dor lombar pode limitar muito a rotina.",
      "Quando a coluna dói todos os dias, isso vai desgastando bastante.",
      "Dor lombar crônica costuma atrapalhar movimento, sono e produtividade.",
    ],
    study: "Em dor lombar crônica, parte dos pacientes consegue melhora importante de sintomas, mas a resposta precisa ser individualizada.",
    bridge: "Quem vai dizer se isso faz sentido para você é o Dr. Alef, avaliando seu histórico completo.",
  },
  dor_neuropatica: {
    empathy: [
      "Entendo… dor neuropática costuma ser bem difícil de lidar.",
      "Dor neuropática pode vir como queimação, choque ou formigamento e costuma ser muito incômoda.",
      "Muita gente com dor neuropática passa bastante tempo buscando algo que realmente ajude.",
    ],
    study: "Em dor neuropática, existem pacientes que apresentam melhora clínica relevante quando a indicação é bem feita.",
    bridge: "Isso precisa ser avaliado com precisão pelo médico responsável.",
  },
  ansiedade: {
    empathy: [
      "Entendo… ansiedade constante desgasta muito a mente e o corpo.",
      "Ansiedade pode dominar o dia da pessoa e atrapalhar até o descanso.",
      "Muita gente com ansiedade sente dificuldade até para relaxar de verdade.",
    ],
    study: "Em alguns perfis de ansiedade, canabinoides podem entrar como parte da estratégia terapêutica, mas isso depende muito do caso.",
    bridge: "A consulta serve justamente para entender se isso pode fazer sentido para você, com segurança.",
  },
  insonia: {
    empathy: [
      "Entendo… dormir mal afeta absolutamente tudo.",
      "Insônia realmente compromete energia, humor e concentração.",
      "Quando a pessoa dorme mal por muito tempo, isso vai desgastando várias áreas da vida.",
    ],
    study: "Em alguns pacientes, o sono é um dos pontos que mais melhora quando existe indicação correta.",
    bridge: "Mas é importante avaliar seu padrão de sono, rotina e outras medicações.",
  },
  artrose: {
    empathy: [
      "Entendo… artrose pode limitar muito movimento e qualidade de vida.",
      "Artrose costuma gerar dor constante e rigidez nas articulações.",
      "Muita gente com artrose sente dificuldade até nas tarefas simples.",
    ],
    study: "Em artrose, alguns pacientes percebem melhora de dor e funcionalidade, mas isso precisa ser definido caso a caso.",
    bridge: "Principalmente considerando seu histórico e outras medicações.",
  },
  artrite: {
    empathy: [
      "Entendo… artrite realmente pode causar muita dor e inflamação.",
      "A artrite costuma limitar bastante o dia a dia.",
      "Muita gente com artrite sofre com dor articular constante e rigidez.",
    ],
    study: "Em artrite, parte dos pacientes pode se beneficiar em controle de sintomas, desde que exista indicação médica adequada.",
    bridge: "Isso sempre precisa ser avaliado com critério.",
  },
  enxaqueca: {
    empathy: [
      "Entendo… enxaqueca pode ser extremamente incapacitante.",
      "Quem sofre com enxaqueca sabe como isso pode parar o dia inteiro.",
      "Enxaqueca recorrente realmente desgasta muito.",
    ],
    study: "Em alguns pacientes com enxaqueca, existe melhora de frequência ou intensidade das crises, mas isso não é automático nem igual para todo mundo.",
    bridge: "É justamente por isso que a avaliação individual faz diferença.",
  },
};

function buildEvidenceMessage(condition) {
  const ev = EVIDENCE_DB[condition];
  if (!ev) return null;
  return `${pickRandom(ev.empathy)}\n\n${ev.study}\n\n${ev.bridge}`;
}

function shouldUseEvidence(flags, state, incomingText) {
  if (Number(state.evidence_used_count || 0) >= 2) return false;
  if (flags.asksHowConsultWorks || flags.asksLegal || flags.asksIfOnline || flags.asksPriceDirect || flags.asksMedicationCost || flags.asksPlanIncludes || flags.asksScam) return false;
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

function compactMemory(state) {
  const s = state || {};
  return {
    nome: s.nome || null,
    lead_profile: s.lead_profile || null,
    stage: s.stage || null,
    focus: s.focus || null,
    condition: s.condition || null,
    problem_text: s.problem_text || null,
    date_key: s.date_key || null,
    slot_time: s.slot_time || null,
    selected_plan_key: s.selected_plan_key || null,
    evidence_used_count: s.evidence_used_count || 0,
    objection_used_count: s.objection_used_count || 0,
    price_ask_count: s.price_ask_count || 0,
    diagnostic_step: s.diagnostic_step || 0,
    last_user_message: s.last_user_message || "",
    last_bot_reply: s.last_bot_reply || "",
  };
}

function consultationExplanationReply() {
  return (
    "A avaliação com o Dr. Alef é *100% online, segura e individualizada*, com duração média de *45 minutos*.\n\n" +
    "Nela, ele analisa seu histórico, o que você já tentou, medicações em uso, como os sintomas impactam sua rotina e se esse tratamento pode fazer sentido para o seu caso.\n\n" +
    "Se fizer sentido, ele orienta os próximos passos com segurança."
  );
}

function legalReply() {
  return (
    "Sim 🙂 O uso medicinal de canabinoides é legal no Brasil quando existe avaliação e prescrição médica.\n\n" +
    "Quando indicado, o médico orienta o caminho regularizado com segurança, incluindo prescrição e orientação sobre os próximos passos."
  );
}

function legalAnvisaReply() {
  return (
    "Sim 🙂 Existem caminhos regularizados. Dependendo do caso, pode envolver produtos regularizados e/ou fluxo com autorização da Anvisa, sempre com documentação e prescrição quando houver indicação.\n\n" +
    "Ou seja: feito do jeito certo, não é algo sem controle."
  );
}

function chapadoReply() {
  return (
    "Essa é uma dúvida muito comum 🙂\n\n" +
    "Cannabis medicinal não é a mesma coisa que uso recreativo. Tudo depende da formulação, da dose e da indicação médica.\n\n" +
    "Em muitos casos, o objetivo é aliviar sintomas com segurança, e não deixar a pessoa 'alterada'."
  );
}

function drivingSafetyReply(state) {
  const nome = maybeUseName(state) || state.nome || "";
  return (
    `${nome ? `${nome}, ` : ""}entendo totalmente essa preocupação, ainda mais se sua rotina envolve direção.\n\n` +
    "Isso pode acontecer em algumas formulações, principalmente quando há THC ou durante fase de ajuste. Por isso esse ponto entra como prioridade na avaliação.\n\n" +
    "O Dr. Alef costuma orientar com cautela, pensando em segurança, rotina e risco de sonolência antes de qualquer direção."
  );
}

function onlineReply() {
  return "Sim 🙂 A consulta é *100% online* e você não precisa ir presencialmente a nenhum lugar.";
}

function whoReply() {
  return "O Dr. Alef Kotula é o médico responsável pelos atendimentos. A consulta é individualizada e focada em entender com profundidade se esse tratamento pode fazer sentido para o seu caso.";
}

function scamReply() {
  return (
    "Entendo sua preocupação 🙂\n\n" +
    "Aqui não é curso, não é grupo e não é venda de produto. É *consulta médica real*, individualizada, com o Dr. Alef.\n\n" +
    "Se houver indicação, ele orienta os próximos passos com segurança. Se não houver, isso também é dito com clareza."
  );
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
    "Se quiser, eu também posso te explicar rapidinho a diferença entre elas."
  );
}

function planIncludesReply(planKey) {
  const plan = PLANS[planKey || "full"] || PLANS.full;
  return `Claro 🙂\n\n${plan.explanation}`;
}

function prescriptionFlowReply() {
  return (
    "Sim 🙂 Se o Dr. Alef entender que faz sentido para o seu caso, ele orienta os próximos passos com segurança e emite a prescrição quando houver indicação.\n\n" +
    "A consulta existe justamente para avaliar isso de forma individual."
  );
}

function medicationCostReply() {
  return (
    "Essa é uma dúvida muito importante 🙂\n\n" +
    "O valor pode variar conforme o tipo de produto, a dose e o objetivo do tratamento, então não existe um número único para todo mundo.\n\n" +
    "Em muitos casos fica em uma faixa de algumas centenas de reais por mês, mas o Dr. Alef costuma orientar de forma realista, pensando no que faz sentido para o caso e também no que é viável para o paciente."
  );
}

function compareReply() {
  return (
    "Faz sentido comparar 🙂\n\n" +
    "Aqui o diferencial principal é que a consulta é médica, individualizada e focada em entender se esse caminho realmente faz sentido para você — não é abordagem genérica.\n\n" +
    "O Dr. Alef avalia histórico, sintomas, rotina, medicações em uso e segurança antes de orientar qualquer próximo passo."
  );
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
    "Essa semana ainda tenho alguns horários disponíveis em horário de Brasília.\n\n" +
    "Nos próximos dias tenho agenda em:\n" +
    dayKeys.map((d, i) => `${i + 1}) *${formatDatePt(d)}*`).join("\n") +
    "\n\nQual você prefere?"
  );
}

async function offerSlotsReply(state) {
  const dateKey = state.date_key;
  const best = await chooseBestSlotsForDate(dateKey, 3);
  if (!best.length) return "Esse dia acabou de ficar sem vagas. Quer que eu te mostre outra data próxima?";
  state.offered_slots = best;
  return (
    "Perfeito 🙂\n\n" +
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
  return (
    `Horário provisoriamente reservado.\n\n${consultationExplanationReply()}\n\n` +
    "Hoje trabalhamos com estas opções:\n\n" +
    `1) *${PLANS.full.label}* — consulta + retorno em torno de 30 dias — *R$${PLANS.full.price}* *(87% das pessoas escolhem essa opção)* ⭐\n` +
    `2) *${PLANS.basic.label}* — ${PLANS.basic.subtitle} — *R$${PLANS.basic.price}*\n` +
    `3) *${PLANS.retorno.label}* — ${PLANS.retorno.subtitle} — *R$${PLANS.retorno.price}*\n\n` +
    "Qual dessas faz mais sentido para você agora?"
  );
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

function worksForConditionReply(state, incomingText) {
  const cond = detectCondition(incomingText) || state.condition || state.focus || null;
  if (!cond) {
    return "Em alguns pacientes esse caminho pode ajudar, mas isso precisa ser avaliado caso a caso. A consulta serve justamente para definir se faz sentido para você com segurança.";
  }
  const ev = buildEvidenceMessage(cond);
  if (ev && Number(state.evidence_used_count || 0) < 2) {
    state.evidence_used_count = Number(state.evidence_used_count || 0) + 1;
    return `${ev}\n\nMas quem vai dizer se isso faz sentido para você é o Dr. Alef, avaliando seu caso com individualização.`;
  }
  return "Em alguns pacientes isso pode ajudar no controle dos sintomas, mas não é automático nem igual para todo mundo. É justamente esse tipo de análise que o Dr. Alef faz na consulta.";
}

function detectIntent(text) {
  const t = norm(text);
  const wantsPrice = /\b(preco|preço|valor|quanto custa|investimento|custa|valores|quanto sai)\b/.test(t);
  const intentPay = /\b(como pagar|faco para pagar|faço para pagar|pagar|pagamento|pix|cartao|cartão|credito|crédito|debito|débito|boleto|link|parcel|parcela|quero pagar)\b/.test(t);
  const wantsBook = /\b(quero marcar|quero agendar|agendar|marcar|confirmar consulta|quero consulta|gostaria de agendar|tem horario|tem horário|agenda|ver horarios|ver horários)\b/.test(t);
  const asksHours = /\b(horarios|horários|horário|horario|que horas|vagas|disponibilidade)\b/.test(t);
  const confirms = /\b(sim|ok|beleza|claro|confirmo|fechado|vamos|serve|perfeito)\b/.test(t);
  const refuses = /\b(nao quero|não quero|pare|para|chega|rude|grosso|nao gostei|não gostei)\b/.test(t);
  const asksStartNow = /\b(como tomar|dose|dosagem|quantas gotas|comecar agora|começar agora)\b/.test(t);
  const urgency = /\b(dor no peito|falta de ar|desmaio|avc|convuls|paralisia|confusao|confusão)\b/.test(t);
  const asksWho = /\b(quem e|quem é|quem eh|quem e o dr|quem é o dr|quem e o doutor|quem é o doutor)\b/.test(t);
  const asksIfWorks = /\b(funciona|serve|vale a pena|ajuda|melhora|tem resultado|da resultado|dá resultado)\b/.test(t);
  const saysWillSee = /\b(vou ver|depois te falo|vou confirmar|vou pensar|te aviso|depois vejo|vou analisar)\b/.test(t);
  const saysIndecisive = /\b(tanto faz|qual voce acha melhor|qual você acha melhor|nao sei qual|não sei qual)\b/.test(t);
  const saysExpensive = /\b(caro|carissima|caríssima|carissimo|caríssimo|achei caro|muito caro|pesado)\b/.test(t);
  const saysUnsure = /\b(nao tenho certeza|não tenho certeza|nao sei|não sei|sera|será|to na duvida|tô na dúvida|duvida|dúvida|fiquei inseguro|fiquei insegura)\b/.test(t);
  const asksHowConsultWorks = /\b(como funciona a consulta|como funciona essa consulta|como funciona essa avaliacao|como funciona essa avaliação|como funciona a avaliacao|como funciona a avaliação)\b/.test(t);
  const asksIfOnline = /\b(e online|é online|online mesmo|presencial|precisa ir|tem que ir|ir em algum lugar|precisa ir na clinica|precisa ir na clínica)\b/.test(t);
  const asksLegal = /\b(legal no brasil|e legal|é legal|precisa de receita|anvisa|autorizacao|autorização|regularizado|registrado)\b/.test(t);
  const asksChapado = /\b(chapado|chapar|maconha mesmo|isso e maconha|isso é maconha|droga)\b/.test(t);
  const asksScam = /\b(golpe|confiavel|confiável|isso e serio|isso é sério|isso nao e golpe|isso não é golpe|curso|produto|venda de oleo|venda de óleo)\b/.test(t);
  const asksPlanIncludes = /\b(inclui o que|inclui exatamente o que|o que inclui|nesse acompanhamento|tem retorno|consulta agora e depois um retorno|o que vem)\b/.test(t);
  const asksMedicationCost = /\b(medicamento.*caro|oleo.*caro|óleo.*caro|quanto custa por mes|quanto custa por mês|valor por mes|valor por mês|custo mensal|quanto fica por mes|quanto fica por mês)\b/.test(t);
  const asksPrescriptionFlow = /\b(saio com a receita|ja saio com a receita|já saio com a receita|orientacoes de como conseguir|orientações de como conseguir|prescricao|prescrição)\b/.test(t);
  const asksCompare = /\b(qual a diferenca|qual a diferença|qual o diferencial|por que com o dr|por que com o doutor|por que com voces|por que com vocês|comparando)\b/.test(t);
  const asksDriving = /\b(dirig|reflexo|alterado|sonolencia|sonolência|lento|cabeça lenta|cabeca lenta)\b/.test(t);

  const focus =
    (/\b(insonia|insônia|dormir|sono|acordar)\b/.test(t) && "insonia") ||
    (/\b(ansiedade|panico|pânico|crise)\b/.test(t) && "ansiedade") ||
    (/\b(fibromialgia)\b/.test(t) && "fibromialgia") ||
    (/\b(neuropat)\b/.test(t) && "dor_neuropatica") ||
    (/\b(artrose)\b/.test(t) && "artrose") ||
    (/\b(artrite)\b/.test(t) && "artrite") ||
    (/\b(coluna|lombar|costas)\b/.test(t) && "dor_lombar") ||
    (/\b(dor)\b/.test(t) && "dor_cronica") ||
    null;

  return {
    wantsPrice,
    asksPriceDirect: wantsPrice,
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
    asksScam,
    asksPlanIncludes,
    asksMedicationCost,
    asksPrescriptionFlow,
    asksCompare,
    asksDriving,
    focus,
  };
}

function inferLeadProfile(flags, state, text) {
  const t = norm(text);
  if (flags.asksScam || flags.asksLegal) return "desconfiado";
  if (flags.asksCompare) return "comparador";
  if (flags.wantsPrice && Number(state.price_ask_count || 0) >= 1) return "economico";
  if (flags.saysExpensive || flags.asksMedicationCost) return "travado_custo_futuro";
  if (flags.asksChapado || flags.asksDriving) return "travado_medo";
  if (flags.asksIfWorks || /\bfunciona mesmo|quero saber se funciona\b/.test(t)) return "cetico";
  if (flags.wantsBook || flags.asksHours || flags.intentPay) return "quente";
  if (state.date_key && !state.payment?.status) return "morno";
  return state.lead_profile || "curioso_frio";
}

function choosePriority(flags, state) {
  if (flags.urgency) return "urgent";
  if (flags.asksScam) return "scam";
  if (flags.asksLegal) return "legal";
  if (flags.asksChapado) return "chapado";
  if (flags.asksDriving) return "driving";
  if (flags.asksMedicationCost) return "medication_cost";
  if (flags.asksPlanIncludes) return "plan_includes";
  if (flags.asksPrescriptionFlow) return "prescription_flow";
  if (flags.asksCompare) return "compare";
  if (flags.asksIfOnline || flags.asksHowConsultWorks) return "consult_info";
  if (flags.asksIfWorks) return "works";
  if (flags.wantsPrice && (Number(state.price_ask_count || 0) >= 1 || state.lead_profile === "economico")) return "direct_price";
  if (flags.wantsPrice) return "soft_price";
  if (flags.asksWho) return "who";
  return null;
}

function buildSystemPrompt() {
  return `
Você é a Lia, secretária premium do Dr. Alef Kotula.

OBJETIVO:
- soar humana, acolhedora, clara e objetiva
- responder a pergunta real do paciente antes do fluxo
- vender consulta médica online com elegância
- nunca parecer robótica, evasiva ou apressada

REGRAS ABSOLUTAS:
- Nunca invente preço.
- Nunca invente horário.
- Nunca envie links por conta própria.
- Nunca cite valores em R$ por conta própria.
- Nunca prometa cura ou resultado garantido.
- Nunca prescreva dose, marca, compra ou produto.
- Nunca substitua consulta.
- No máximo 1 pergunta principal por mensagem.
- Responda primeiro a dúvida principal do paciente, depois conduza.
- Seja curta no WhatsApp.

COMANDOS ESPECIAIS:
- Se o paciente pedir preço e o sistema deve responder em código: responda exatamente "PRECISA_PRECO"
- Se o paciente pedir agendamento/horários e o sistema deve responder em código: responda exatamente "PRECISA_AGENDAR"
- Se o paciente pedir pagamento/link e o sistema deve responder em código: responda exatamente "PRECISA_PAGAR"
- Se houver urgência médica: responda exatamente "URGENTE"

FORMATO JSON:
{
  "reply": "mensagem",
  "updates": {
    "nome": "...",
    "problem_text": "...",
    "condition": "...",
    "lead_profile": "..."
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
- Responda primeiro a dúvida real do paciente.
- Seja natural, humana, elegante e curta.
- Se houver medo, valide antes de conduzir.
- Se já houver contexto suficiente, avance com micro-CTA.
- Se o paciente estiver quase comprando, não volte para texto educacional genérico.
- Pode salvar nome, problema, condição e lead_profile em updates quando identificar.
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
  if (flags.asksIfWorks || flags.asksLegal || flags.asksScam) base = randInt(2, 4);
  if (flags.refuses) base = randInt(2, 4);
  const lastAt = Number(state.last_sent_at || 0);
  if (Date.now() - lastAt < 2000) base += 1;
  return Math.max(1, base);
}

async function sendWhatsApp(to, from, body, delaySec = 0) {
  await sleep(delaySec * 1000);
  await twilioClient.messages.create({ to, from, body });
}

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
  state.last_bot_from = bot;
  state.last_priority = state.last_priority || null;
  state.lead_profile = state.lead_profile || null;
  return state;
}

function shouldShortCircuitPriority(state, priority) {
  if (!priority) return false;
  if (["ASK_FULLNAME", "ASK_BIRTHDATE", "ASK_EMAIL"].includes(state.stage) && !["medication_cost", "plan_includes", "prescription_flow"].includes(priority)) {
    return false;
  }
  return true;
}

function oneStepCTA(priority) {
  if (["legal", "scam", "chapado", "driving", "works", "consult_info", "compare"].includes(priority)) {
    return "\n\nSe quiser, eu posso te mostrar os horários disponíveis 🙂";
  }
  if (["medication_cost", "plan_includes", "prescription_flow", "direct_price", "soft_price"].includes(priority)) {
    return "\n\nSe quiser, eu te explico rapidinho como funciona a consulta ou já te mostro as opções 🙂";
  }
  return "";
}

async function handlePriorityQuestion({ priority, state, flags, incomingText }) {
  switch (priority) {
    case "who":
      return whoReply() + "\n\nSe quiser, eu posso te explicar rapidinho como funciona a avaliação.";
    case "consult_info":
      return `${consultationExplanationReply()}\n\n${flags.asksIfOnline ? `${onlineReply()}\n\n` : ""}Se quiser, eu posso te mostrar os próximos horários disponíveis 🙂`;
    case "legal":
      return (flags.asksLegal && /anvisa|regulariz|registrad|autoriza/.test(norm(incomingText)) ? legalAnvisaReply() : legalReply()) + oneStepCTA(priority);
    case "chapado":
      return chapadoReply() + oneStepCTA(priority);
    case "driving":
      return drivingSafetyReply(state) + oneStepCTA(priority);
    case "scam":
      return scamReply() + oneStepCTA(priority);
    case "plan_includes": {
      const planKey = state.selected_plan_key || extractPlanChoice(incomingText) || "full";
      return planIncludesReply(planKey) + "\n\nSe quiser, eu também te explico qual opção costuma fazer mais sentido em cada caso.";
    }
    case "prescription_flow":
      return prescriptionFlowReply() + oneStepCTA(priority);
    case "medication_cost":
      return medicationCostReply() + oneStepCTA(priority);
    case "compare":
      return compareReply() + oneStepCTA(priority);
    case "works":
      return worksForConditionReply(state, incomingText) + oneStepCTA(priority);
    case "soft_price":
      return prePriceValueReply() + "\n\n" + priceReply();
    case "direct_price":
      return priceReply();
    default:
      return null;
  }
}

async function scheduleFollowups(phone, state) {
  await pool.query(`UPDATE wa_followups SET status='cancelled', updated_at=NOW() WHERE phone=$1 AND status='pending'`, [phone]);

  const payload = {
    nome: state.nome || null,
    lead_profile: state.lead_profile || null,
    stage: state.stage || null,
    date_key: state.date_key || null,
    slot_time: state.slot_time || null,
  };

  const steps = [
    { step: 1, interval: "2 hours" },
    { step: 2, interval: "24 hours" },
    { step: 3, interval: "72 hours" },
  ];

  for (const item of steps) {
    await pool.query(
      `INSERT INTO wa_followups (phone, step, due_at, payload)
       VALUES ($1, $2, NOW() + ($3)::interval, $4::jsonb)`,
      [phone, item.step, item.interval, JSON.stringify(payload)]
    );
  }
}

async function cancelPendingFollowups(phone) {
  await pool.query(`UPDATE wa_followups SET status='cancelled', updated_at=NOW() WHERE phone=$1 AND status='pending'`, [phone]);
}

function followupText(step, state) {
  const nome = state?.nome ? `${state.nome}, ` : "";
  if (step === 1) {
    return `${nome}só passando para te deixar à vontade 🙂 Se ainda fizer sentido para você, eu posso retomar exatamente de onde paramos.`;
  }
  if (step === 2) {
    return `${nome}vi que você ficou na dúvida. Se quiser, eu posso te explicar rapidinho como funciona a consulta ou te mostrar as opções de horário sem compromisso.`;
  }
  return `${nome}deixo aqui a porta aberta 🙂 Se você quiser retomar depois, eu sigo de onde a conversa parou e te ajudo com calma.`;
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
      if (status === "approved") await cancelPendingFollowups(phone);
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

app.post("/cron/followups", async (req, res) => {
  if (FOLLOWUP_SECRET && req.headers["x-followup-secret"] !== FOLLOWUP_SECRET) {
    return res.status(401).send("unauthorized");
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, phone, step, payload
       FROM wa_followups
       WHERE status='pending' AND due_at <= NOW()
       ORDER BY due_at ASC
       LIMIT 50`
    );

    for (const row of rows) {
      const state = await getUserState(row.phone);
      if (state.payment?.status === "approved") {
        await pool.query(`UPDATE wa_followups SET status='cancelled', updated_at=NOW() WHERE id=$1`, [row.id]);
        continue;
      }
      if (similar(state.last_user_message || "", state.followup_last_user_snapshot || "")) {
        // segue
      }
      const botFrom = state?.last_bot_from;
      if (!botFrom) {
        await pool.query(`UPDATE wa_followups SET status='cancelled', updated_at=NOW() WHERE id=$1`, [row.id]);
        continue;
      }
      await twilioClient.messages.create({
        to: `whatsapp:${row.phone}`,
        from: botFrom,
        body: followupText(row.step, state),
      });
      await pool.query(`UPDATE wa_followups SET status='sent', updated_at=NOW() WHERE id=$1`, [row.id]);
    }

    res.send({ ok: true, sent: rows.length });
  } catch (err) {
    console.error("❌ followups erro:", err);
    res.status(500).send({ ok: false });
  }
});

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
          `UPDATE wa_users SET state = '{}'::jsonb, updated_at = NOW() WHERE regexp_replace(phone, '\\D', '', 'g') = $1`,
          [phoneDigits]
        );
        await pool.query(`DELETE FROM wa_slot_locks WHERE phone = $1 AND status='held'`, [phone]);
        await cancelPendingFollowups(phone);
        await sendWhatsApp(`whatsapp:+${phoneDigits}`, bot, "✅ Memória resetada. Pode testar do zero agora.", 0);
        return;
      }

      let state = initializeState(await getUserState(phone), bot);
      const flags = detectIntent(finalText);
      state.lead_profile = inferLeadProfile(flags, state, finalText);
      if (flags.focus && !state.focus) state.focus = flags.focus;
      const detectedCondition = detectCondition(finalText);
      if (detectedCondition && !state.condition) state.condition = detectedCondition;
      const detectedProblem = extractProblemText(finalText);
      if (detectedProblem && !state.problem_text) state.problem_text = detectedProblem;

      let reply = "";
      const priority = choosePriority(flags, state);
      state.last_priority = priority || state.last_priority || null;

      // 0) pagamento já confirmado
      if (state.payment?.status === "approved") {
        reply = afterPaidReply(state);
      }

      // 1) urgência
      else if (flags.urgency) {
        reply = "Entendi. Pela sua mensagem, isso pode precisar de avaliação urgente. Procure um pronto atendimento agora (ou SAMU 192). Assim que estiver seguro(a), me chama aqui.";
      }

      // 2) abertura
      else if (!state.stage && !state.nome) {
        state.stage = "ASK_NAME";
        reply = askNameIntroReply();
      }

      // 3) prioridade conversacional: responder primeiro a pergunta real do paciente
      else if (priority && shouldShortCircuitPriority(state, priority)) {
        if (priority === "soft_price" || priority === "direct_price") {
          state.price_ask_count += 1;
        }
        reply = await handlePriorityQuestion({ priority, state, flags, incomingText: finalText });

        if (priority === "direct_price") {
          state.stage = state.stage === "ASK_PLAN" ? "ASK_PLAN" : state.stage;
        }
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

      // 5) captura do problema
      else if (state.stage === "ASK_PROBLEM" || (state.nome && !state.problem_text && !state.date_key)) {
        const pb = extractProblemText(finalText);
        if (pb) {
          state.problem_text = pb;
          state.condition = state.condition || detectCondition(pb) || state.focus || null;
          state.stage = "DIAG_Q1";
          state.diagnostic_step = 1;
          reply = q1Reply(state);
        } else {
          const ai = await runLia({ incomingText: finalText, state, flags, mode: "qualify_problem" });
          if (ai.reply === "__NEED_PRICE__") reply = "Claro 🙂 Antes de entrar nos valores, eu quero entender rapidinho seu foco principal. O que você gostaria de tratar hoje?";
          else reply = askProblemAfterNameReply(state);
        }
      }

      // 6) script diagnóstico curto
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

      // 7) após diagnóstico
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
        } else {
          reply = ai.reply;
          state = mergeState(state, ai.updates);
        }
      }

      // 8) pagamento pendente com objeções tratadas antes do link
      else if (state.payment?.status === "pending" && state.payment?.link) {
        if (priority && ["medication_cost", "plan_includes", "prescription_flow", "direct_price", "compare", "works", "legal", "scam", "chapado", "driving"].includes(priority)) {
          reply = await handlePriorityQuestion({ priority, state, flags, incomingText: finalText });
          reply += "\n\nSe quiser seguir, seu link continua ativo aqui:\n" + state.payment.link;
        } else if (flags.intentPay) {
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

      // 9) intenção de pagar
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
          const holdCheck = await acquireSlotHold(state.date_key, state.slot_time, phone);
          if (!holdCheck.ok) {
            state.slot_time = null;
            state.slot_key = null;
            state.stage = "OFFER_SLOTS";
            reply = "Esse horário acabou de ser preenchido antes da confirmação. Vou te mostrar as próximas melhores opções.\n\n" + (await offerSlotsReply(state));
          } else {
            state.slot_key = holdCheck.slot_key;
            const pref = await mpCreatePreference({ phone, planKey: state.selected_plan_key });
            state.payment = {
              status: "pending",
              plan_key: state.selected_plan_key,
              preference_id: pref.preference_id,
              link: pref.link,
              external_reference: pref.external_reference,
              created_at: Date.now(),
            };
            reply = paymentSentReply(pref.plan, pref.link, state);
            state.stage = "WAIT_PAYMENT";
            await scheduleFollowups(phone, state);
          }
        } else {
          state.stage = "ASK_PLAN";
          reply = askPlanReply();
        }
      }

      // 10) preço
      else if (flags.wantsPrice) {
        state.price_ask_count += 1;
        if (!state.nome) {
          state.stage = "ASK_NAME";
          reply = state.price_ask_count >= 2 ? `${priceReply()}\n\nAntes de seguir, me diz só seu *primeiro nome* 🙂` : "Claro 🙂 Antes de te passar as opções, eu quero entender rapidinho seu caso para te orientar melhor.\n\nQual é o seu *primeiro nome*?";
        } else if (!state.problem_text && state.price_ask_count < 2) {
          state.stage = "ASK_PROBLEM";
          reply = prePriceValueReply() + "\n\nMe conta rapidinho o que você gostaria de tratar hoje.";
        } else {
          reply = priceReply();
          if (state.stage === "ASK_PLAN") state.stage = "ASK_PLAN";
        }
      }

      // 11) objeções gerais
      else if (flags.asksStartNow) {
        reply = "Entendi sua vontade de começar. Por segurança, eu não consigo orientar dose ou como tomar por aqui 🙂 Isso depende do seu caso e das medicações em uso. Se quiser, eu te explico como funciona a avaliação e já te ajudo a confirmar.";
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
        reply = worksForConditionReply(state, finalText) + "\n\nSe você quiser, eu posso te explicar rapidamente como funciona a avaliação.";
      }

      // 12) entrada de agendamento
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

      // 13) escolher dia
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
          if (!avail.length) reply = "Esse dia está indisponível no momento. Quer que eu te mostre outra data próxima?";
          else {
            state.date_key = explicitDate;
            state.stage = "OFFER_SLOTS";
            reply = await offerSlotsReply(state);
          }
        } else {
          reply = "Qual data fica melhor para você? Pode me responder com o número da opção ou com o dia, por exemplo *quinta-feira*.";
        }
      }

      // 14) escolher horário
      else if (state.stage === "OFFER_SLOTS") {
        const best = state.offered_slots?.length ? state.offered_slots : await chooseBestSlotsForDate(state.date_key, 3);
        const choiceNum = extractNumericChoice(finalText);
        const requestedTime = extractHourOnly(finalText);

        if (choiceNum && best[choiceNum - 1]) {
          const chosen = best[choiceNum - 1];
          const hold = await acquireSlotHold(state.date_key, chosen, phone);
          if (!hold.ok) {
            reply = "Esse horário acabou de ser preenchido. Vou te mostrar as próximas melhores opções.\n\n" + (await offerSlotsReply(state));
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
              reply = "Esse horário acabou de ser preenchido. Posso te mostrar as próximas melhores opções.\n\n" + (await offerSlotsReply(state));
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

      // 15) horário específico
      else if (state.stage === "ASK_SPECIFIC_TIME") {
        const requestedTime = extractHourOnly(finalText);
        if (!requestedTime) {
          reply = `Me diz o horário exato em *${formatDatePt(state.date_key)}*, por exemplo *16h*.`;
        } else {
          const available = await getAvailableSlotsForDate(state.date_key);
          if (available.includes(requestedTime)) {
            const hold = await acquireSlotHold(state.date_key, requestedTime, phone);
            if (!hold.ok) {
              reply = "Esse horário acabou de ser preenchido. Vou te mostrar outras opções.\n\n" + (await offerSlotsReply(state));
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

      // 16) dados cadastrais
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

      // 17) plano
      else if (state.stage === "ASK_PLAN") {
        const planKey = extractPlanChoice(finalText);
        if (priority && ["plan_includes", "medication_cost", "prescription_flow", "compare", "works", "legal", "scam", "chapado", "driving", "soft_price", "direct_price"].includes(priority)) {
          reply = await handlePriorityQuestion({ priority, state, flags, incomingText: finalText });
        } else if (flags.saysExpensive) {
          reply = buildExpensiveReply();
        } else if (flags.saysWillSee) {
          reply = buildThinkingReply(state);
        } else if (flags.saysUnsure) {
          reply = buildUnsureReply(state, finalText);
        } else if (planKey) {
          state.selected_plan_key = planKey;
          const holdCheck = await acquireSlotHold(state.date_key, state.slot_time, phone);
          if (!holdCheck.ok) {
            state.slot_time = null;
            state.slot_key = null;
            state.stage = "OFFER_SLOTS";
            reply = "Esse horário acabou de ser preenchido antes da confirmação. Vou te mostrar as próximas melhores opções.\n\n" + (await offerSlotsReply(state));
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
            await scheduleFollowups(phone, state);
          }
        } else {
          reply = "Qual dessas opções faz mais sentido para você agora? Se preferir, pode me responder com *1, 2 ou 3*.";
        }
      }

      // 18) resistência
      else if (flags.refuses) {
        reply = "Tranquilo 🙂 Desculpa se soou pressionado. Quer que eu te explique rapidinho como funciona ou prefere só tirar uma dúvida agora?";
      }

      // 19) evidence útil
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

      // 20) conversa aberta com autonomia guiada
      else {
        const ai = await runLia({ incomingText: finalText, state, flags, mode: "open_conversation" });
        if (ai.reply === "__NEED_PRICE__") {
          state.price_ask_count += 1;
          reply = state.price_ask_count >= 2 ? priceReply() : prePriceValueReply();
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
          if (!state.lead_profile && ai.updates?.lead_profile) state.lead_profile = ai.updates.lead_profile;
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

      const delaySec = computeHumanDelay(flags, state);
      state.last_bot_reply = reply;
      state.last_user_message = finalText;
      state.last_sent_at = Date.now();

      // cancela follow-up sempre que o lead responde de novo
      await cancelPendingFollowups(phone);
      if (state.payment?.status === "pending") {
        await scheduleFollowups(phone, state);
      }

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
          body: "Tive uma instabilidade rápida aqui 🙂 Me manda de novo em 1 frase se você quer *agendar*, *tirar dúvida* ou *ver valores*.",
        });
      } catch {}
    }
  })();
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ LIA FINAL rodando na porta ${PORT}`));
