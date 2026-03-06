/**
 * INDEX 14 — LIA V12.1 + agenda temporária inteligente (pré-API ProDoctor)
 *
 * Mantém:
 * - Tom humano + empatia
 * - Premium intro
 * - Prova social 87% no plano 1
 * - Anti-alucinação (IA não solta preço/link)
 * - Link real Mercado Pago + webhook
 *
 * Adiciona:
 * - Agenda temporária real (dias/horários fixos)
 * - Smart scheduling (mostra 2-3 opções, prioriza 19h/18h/20h)
 * - Proteção contra double booking com trava no Postgres
 * - Reserva temporária de horário por 15 min
 * - Coleta de dados antes do pagamento:
 *   nome completo, data de nascimento, e-mail
 * - Gatilho de urgência/agenda quase cheia
 *
 * Regras operacionais:
 * - Horários sempre em hora cheia
 * - Se o paciente quiser outro dia de março:
 *   - segunda: indisponível
 *   - terça: só a partir de 16h
 *   - sábado: apenas 9h, 10h, 11h
 *   - domingo: indisponível
 *
 * ENV:
 * OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, DATABASE_URL
 * MP_ACCESS_TOKEN
 * PUBLIC_BASE_URL
 * MODEL_CHAT (opcional)
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

console.log("NODE VERSION:", process.version);

// ====== ENV ======
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
const MIN_DELAY = Number(MIN_DELAY_SEC || 0);
const MAX_DELAY = Number(MAX_DELAY_SEC || 0);

const BASE_URL = (PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "") || "http://localhost:10000";
const HOLD_MINUTES = 15;

// ====== PLANOS ======
const PLANS = {
  full: {
    key: "full",
    label: "Acompanhamento Médico Especializado (Consulta + Retorno ~30 dias)",
    price: 447,
    short: "1",
  },
  basic: {
    key: "basic",
    label: "Avaliação Médica Especializada (45 min)",
    price: 347,
    short: "2",
  },
  retorno: {
    key: "retorno",
    label: "Consulta de Ajuste (Retorno avulso)",
    price: 200,
    short: "3",
  },
};

// ====== AGENDA TEMPORÁRIA REAL ======
const FIXED_SCHEDULE = {
  "10-03": { dayName: "terça-feira", slots: ["15h", "16h", "17h", "18h", "19h", "20h", "21h"] },
  "11-03": { dayName: "quarta-feira", slots: ["9h", "10h", "11h", "13h", "14h", "15h", "16h", "17h", "18h", "19h"] },
  "12-03": { dayName: "quinta-feira", slots: ["9h", "10h", "11h", "13h", "14h", "15h", "16h", "17h", "18h", "19h"] },
};

const PREMIUM_SLOT_PRIORITY = ["19h", "18h", "20h", "17h", "21h", "16h", "15h", "14h", "13h", "11h", "10h", "9h"];
const WEEKDAY_PT = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

// ====== POSTGRES ======
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
      status TEXT NOT NULL DEFAULT 'held', -- held | paid
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );
  `);

  console.log("✅ Tabelas prontas.");
}
initDB().catch((e) => console.error("❌ initDB erro:", e));

// ====== MEMORY HELPERS ======
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

// ====== UTILS ======
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function similar(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  if (x.length > 55 && y.length > 55 && x.slice(0, 55) === y.slice(0, 55)) return true;
  return false;
}

function clip(text, max = 700) {
  const t = (text || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trim();
}

function pad2(n) { return String(n).padStart(2, "0"); }

function currentYear() {
  return new Date().getFullYear();
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
  return `${formatDatePt(dateKey)} às ${time}`;
}

function removeDuplicates(arr) {
  return [...new Set(arr)];
}

// ====== NOME / DADOS ======
function extractNameFromText(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const low = norm(t);
  if (/(sim|ok|beleza|pode|claro|s|ss|show|tanto faz|nao|não)/.test(low)) return null;

  const cleaned = t.replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  const m = cleaned.match(/(?:me chamo|sou|nome é|nome e)\s+(.+)$/i);
  const candidate = (m?.[1] || cleaned).trim();

  const parts = candidate.split(" ").filter(Boolean);
  if (parts.length < 1 || parts.length > 5) return null;
  if (/^\d+$/.test(candidate)) return null;

  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

function extractFullName(text) {
  const cleaned = (text || "").replace(/[^\p{L}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

function extractBirthDate(text) {
  const t = (text || "").trim();
  let m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
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

function maybeUseName(state) {
  const nome = state?.nome;
  if (!nome) return "";
  const used = Number(state?.name_used_count || 0);
  if (used < 2 || used % 6 === 0) return nome;
  return "";
}

// ====== AGENDA HELPERS ======
function getGenericSlotsForDate(dateKey) {
  const dt = parseDateKeyToDate(dateKey);
  const day = dt.getDay(); // 0 dom ... 6 sab

  // domingo indisponível
  if (day === 0) return [];

  // segunda indisponível
  if (day === 1) return [];

  // terça: só a partir de 16h
  if (day === 2) return ["16h", "17h", "18h", "19h", "20h", "21h"];

  // sábado: só 9h, 10h, 11h
  if (day === 6) return ["9h", "10h", "11h"];

  // quarta, quinta, sexta
  return ["9h", "10h", "11h", "13h", "14h", "15h", "16h", "17h", "18h", "19h"];
}

function getBaseSlotsForDate(dateKey) {
  if (FIXED_SCHEDULE[dateKey]) return [...FIXED_SCHEDULE[dateKey].slots];
  return getGenericSlotsForDate(dateKey);
}

function sortSlotsSmart(slots) {
  const unique = removeDuplicates(slots);
  const prioritized = [];
  for (const p of PREMIUM_SLOT_PRIORITY) {
    if (unique.includes(p)) prioritized.push(p);
  }
  for (const s of unique) {
    if (!prioritized.includes(s)) prioritized.push(s);
  }
  return prioritized;
}

async function cleanupExpiredLocks() {
  await pool.query(
    `DELETE FROM wa_slot_locks
     WHERE status='held' AND expires_at IS NOT NULL AND expires_at < NOW()`
  );
}

async function getBlockedSlotKeysForDate(dateKey) {
  await cleanupExpiredLocks();
  const prefix = `${dateKey}|`;
  const { rows } = await pool.query(
    `SELECT slot_key
     FROM wa_slot_locks
     WHERE slot_key LIKE $1
       AND (status='paid' OR (status='held' AND expires_at > NOW()))`,
    [`${prefix}%`]
  );
  return new Set(rows.map(r => r.slot_key));
}

async function getAvailableSlotsForDate(dateKey) {
  const base = getBaseSlotsForDate(dateKey);
  const blocked = await getBlockedSlotKeysForDate(dateKey);
  return base.filter(t => !blocked.has(slotKey(dateKey, t)));
}

async function chooseBestSlotsForDate(dateKey, max = 3) {
  const available = await getAvailableSlotsForDate(dateKey);
  return sortSlotsSmart(available).slice(0, max);
}

async function acquireSlotHold(dateKey, time, phone, minutes = HOLD_MINUTES) {
  await cleanupExpiredLocks();
  const key = slotKey(dateKey, time);

  const existing = await pool.query(
    `SELECT *
     FROM wa_slot_locks
     WHERE slot_key=$1`,
    [key]
  );

  if (!existing.rows.length) {
    await pool.query(
      `INSERT INTO wa_slot_locks (slot_key, phone, status, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'held', NOW() + ($3 || ' minutes')::interval, NOW(), NOW())`,
      [key, phone, String(minutes)]
    );
    return { ok: true, held: true, slot_key: key };
  }

  const row = existing.rows[0];

  // já pago = indisponível
  if (row.status === "paid") {
    return { ok: false, reason: "paid" };
  }

  // mesma pessoa estende a reserva
  if (row.status === "held" && row.phone === phone) {
    await pool.query(
      `UPDATE wa_slot_locks
       SET expires_at = NOW() + ($2 || ' minutes')::interval,
           updated_at = NOW()
       WHERE slot_key=$1`,
      [key, String(minutes)]
    );
    return { ok: true, held: true, slot_key: key };
  }

  // segurado por outra pessoa e ainda válido
  if (row.status === "held" && row.expires_at && new Date(row.expires_at) > new Date()) {
    return { ok: false, reason: "held" };
  }

  // expirado: assume a trava
  await pool.query(
    `UPDATE wa_slot_locks
     SET phone=$2,
         status='held',
         expires_at = NOW() + ($3 || ' minutes')::interval,
         updated_at = NOW(),
         paid_at = NULL
     WHERE slot_key=$1`,
    [key, phone, String(minutes)]
  );

  return { ok: true, held: true, slot_key: key };
}

async function markSlotPaid(key, phone) {
  if (!key) return;
  await pool.query(
    `UPDATE wa_slot_locks
     SET status='paid',
         expires_at = NULL,
         paid_at = NOW(),
         updated_at = NOW()
     WHERE slot_key=$1 AND phone=$2`,
    [key, phone]
  );
}

async function releaseOldHeldSlotsForPhone(phone, keepSlotKey = null) {
  if (!phone) return;
  if (keepSlotKey) {
    await pool.query(
      `DELETE FROM wa_slot_locks
       WHERE phone=$1 AND status='held' AND slot_key <> $2`,
      [phone, keepSlotKey]
    );
  } else {
    await pool.query(
      `DELETE FROM wa_slot_locks
       WHERE phone=$1 AND status='held'`,
      [phone]
    );
  }
}

function extractDateKey(text) {
  const t = String(text || "");
  let m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})\b/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    if (mm === 3 && dd >= 1 && dd <= 31) return makeDateKey(dd, mm);
  }

  const low = norm(t);
  if (/\bterca|terça\b/.test(low)) return "10-03";
  if (/\bquarta\b/.test(low)) return "11-03";
  if (/\bquinta\b/.test(low)) return "12-03";

  return null;
}

function extractHourOnly(text) {
  const low = norm(text);
  let m = low.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (mm === 0) return `${hh}h`;
    return `${pad2(hh)}:${pad2(mm)}`;
  }
  let m2 = low.match(/\b([01]?\d|2[0-3])\s?h\b/);
  if (m2) return `${Number(m2[1])}h`;
  return null;
}

function extractNumericChoice(text) {
  const t = norm(text);
  if (/\b1\b|primeiro/.test(t)) return 1;
  if (/\b2\b|segundo/.test(t)) return 2;
  if (/\b3\b|terceiro/.test(t)) return 3;
  return null;
}

function isWantsDifferentTime(text) {
  const t = norm(text);
  return /\b(outro horario|outro horário|nenhum desses|nenhum|nao consigo nesses|não consigo nesses|tem outro|outro dia)\b/.test(t);
}

function formatDayOptions(dayKeys) {
  return dayKeys.map((d, i) => `${i + 1}) *${formatDatePt(d)}*`).join("\n");
}

function urgencyAgendaPrefix() {
  return "Essa semana os horários estão quase completos, mas ainda tenho alguns disponíveis.\n\n";
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

// ====== TEXTO PREMIUM ======
function premiumIntroReply() {
  return (
    "A consulta é *100% online, segura e individualizada*, com duração média de *45 minutos*.\n\n" +
    "O Dr. Alef analisa seu caso com bastante profundidade — com base na experiência clínica e na formação médica na Rússia.\n" +
    "Ele revisa todo seu histórico, entende como os sintomas impactam sua rotina, analisa o que você já tentou, confere medicações em uso e define objetivos claros de melhora — tudo alinhado ao seu caso.\n\n" +
    "A maioria dos pacientes prefere já iniciar com acompanhamento, porque assim conseguimos ajustar o plano com mais segurança."
  );
}

// ====== INTENTS ======
function detectIntent(text) {
  const t = norm(text);

  const wantsPrice = /\b(preco|preço|valor|quanto custa|investimento|custa|valores)\b/.test(t);
  const intentPay = /\b(como (pagar|fa[cç]o para pagar)|pagar|pagamento|pix|cartao|cartão|credito|crédito|debito|débito|boleto|link|parcel|parcela)\b/.test(t);
  const wantsBook = /\b(quero marcar|quero agendar|agendar|marcar|confirmar consulta|quero consulta|gostaria de agendar|tem horario|tem horário|agenda)\b/.test(t);
  const asksHours = /\b(horarios|horário|horario|que horas|vagas|disponibilidade)\b/.test(t);
  const confirms = /\b(sim|ok|pode|confirmo|fechado|beleza|vamos|pode ser|serve|confirmar)\b/.test(t);
  const refuses = /\b(nao quero|não quero|pare|para|chega|rude|grosso|nao gostei|não gostei)\b/.test(t);

  const asksStartNow = /\b(como tomar|dose|dosagem|quantas gotas|comecar agora|começar agora)\b/.test(t);
  const urgency = /\b(dor no peito|falta de ar|desmaio|avc|convuls|paralisia|confusao|confusão)\b/.test(t);
  const asksWho = /\b(quem e|quem eh|quem e o dr|quem é|quem é o dr)\b/.test(t);
  const asksIfWorks = /\b(funciona|serve|vale a pena|ajuda|melhora|tem resultado)\b/.test(t);
  const saysWillSee = /\b(vou ver|depois te falo|vou confirmar|vou pensar|te aviso)\b/.test(t);
  const saysIndecisive = /\b(tanto faz|qual voce acha melhor|qual você acha melhor)\b/.test(t);

  const choosesFull = /\b(1|447|consulta com retorno|com retorno|acompanhamento|pacote|retorno em 30|acompanhamento medico)\b/.test(t);
  const choosesBasic = /\b(2|347|avaliacao|avaliação|avaliacao especializada|avaliação especializada|so a consulta|só a consulta)\b/.test(t);
  const choosesRetorno = /\b(3|200|retorno avulso|apenas retorno|consulta de ajuste)\b/.test(t);

  const focus =
    (/\b(insonia|insomnia|dormir|sono|acordar)\b/.test(t) && "insonia") ||
    (/\b(ansiedade|panico|pânico|crise)\b/.test(t) && "ansiedade") ||
    (/\b(dor|fibromialgia|lombar|artrose|artrite|neuropat|enxaqueca)\b/.test(t) && "dor") ||
    null;

  return {
    wantsPrice, intentPay, wantsBook, asksHours, confirms,
    refuses, asksStartNow, urgency, asksWho, asksIfWorks,
    choosesFull, choosesBasic, choosesRetorno,
    saysWillSee, saysIndecisive,
    focus,
  };
}

// ====== RESPOSTAS DETERMINÍSTICAS ======
function urgencyReply() {
  return "Entendi. Pela sua mensagem, isso pode precisar de avaliação URGENTE. Procure um pronto atendimento agora (ou SAMU 192). Assim que estiver seguro(a), me chama aqui.";
}

function whoReply() {
  return "Oi 🙂 Eu sou a Lia, da equipe do Dr. Alef Kotula. Atendimento 100% online. Quer que eu te explique em 30 segundos como funciona?";
}

function safetyDoseReply() {
  return "Entendi sua vontade de começar. Por segurança, eu não consigo orientar dose/como tomar por aqui 🙏 Isso depende do seu caso e das medicações. Se quiser, eu te explico como funciona a avaliação e já te ajudo a confirmar. Seu foco hoje é mais dor, sono ou ansiedade?";
}

function priceReply() {
  return (
    premiumIntroReply() + "\n\n" +
    "O investimento é:\n" +
    `1) *${PLANS.full.label}* — R$${PLANS.full.price} *(87% das pessoas escolhem essa opção)* ⭐\n` +
    `2) *${PLANS.basic.label}* — R$${PLANS.basic.price}\n` +
    `3) *${PLANS.retorno.label}* — R$${PLANS.retorno.price}\n\n` +
    "Qual você prefere? Me responda com *1*, *2* ou *3*."
  );
}

function askPlanReply() {
  return (
    premiumIntroReply() + "\n\n" +
    "O investimento é:\n" +
    `1) *${PLANS.full.label}* — R$${PLANS.full.price} *(87% das pessoas escolhem essa opção)* ⭐\n` +
    `2) *${PLANS.basic.label}* — R$${PLANS.basic.price}\n` +
    `3) *${PLANS.retorno.label}* — R$${PLANS.retorno.price}\n\n` +
    "Qual você prefere? Me responda com *1*, *2* ou *3*."
  );
}

function askNameReply() {
  return "Perfeito 🙂 Antes de eu te ajudar a agendar, qual seu *primeiro nome*?";
}

async function askDayReply() {
  const dayKeys = await getSuggestedDayKeys();
  if (!dayKeys.length) {
    return "No momento os horários dessa semana já estão completos. Quer que eu te coloque na lista de prioridade assim que abrir uma vaga? 🙂";
  }

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

  if (!best.length) {
    return "Esse dia acabou de ficar sem vagas 🙏 Quer que eu te mostre outra data próxima?";
  }

  return (
    "Claro 🙂\n" +
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
  return (
    `Perfeito. Vou reservar provisoriamente *${prettySlot(state.date_key, state.slot_time)}* para você por alguns minutos.\n\n` +
    "A consulta é *100% online* e dura cerca de *45 minutos*.\n\n" +
    "Só preciso confirmar alguns dados rápidos.\n\n" +
    "Qual seu *nome completo*?"
  );
}

function askBirthdateReply(state) {
  return `Obrigado, ${state.nome_completo.split(" ")[0]} 🙂\n\nQual sua *data de nascimento*?`;
}

function askEmailReply() {
  return "Perfeito 🙂\n\nE qual *e-mail* você prefere usar para receber as orientações da consulta?";
}

function paymentSentReply(plan, link, state) {
  return (
    `Fechado ✅\n` +
    `*${plan.label}* — R$${plan.price}\n\n` +
    `Horário pré-reservado: *${prettySlot(state.date_key, state.slot_time)}*\n` +
    `Essa reserva fica segura por alguns minutos enquanto você finaliza.\n\n` +
    `Para confirmar, é só pagar por aqui:\n${link}\n\n` +
    "Assim que o pagamento for confirmado, eu te aviso aqui e deixo sua consulta confirmada 🙂"
  );
}

function afterPaidReply(state) {
  return (
    "Pagamento confirmado ✅\n\n" +
    `Sua consulta online ficou confirmada para *${prettySlot(state.date_key, state.slot_time)}*.\n\n` +
    "Mais perto do horário eu envio as orientações da consulta 🙂"
  );
}

function willSeeReply(state) {
  if (state?.date_key && state?.slot_time) {
    return (
      "Claro 🙂\n" +
      "Só te aviso que os horários costumam preencher rápido.\n\n" +
      `Se quiser, posso deixar *${prettySlot(state.date_key, state.slot_time)}* reservado temporariamente para você enquanto decide.`
    );
  }
  return (
    "Claro 🙂\n" +
    "Só te aviso que os horários costumam preencher rápido.\n\n" +
    "Se quiser, posso pré-reservar um horário por algumas horas para você enquanto decide."
  );
}

function indecisiveReply(state) {
  if (state?.date_key) {
    return `Os horários que os pacientes costumam preferir são no início da noite.\n\nTenho *18h* ou *19h* disponíveis em *${formatDatePt(state.date_key)}*.\n\nQual fica melhor para você?`;
  }
  return "Os horários que os pacientes costumam preferir são no início da noite.\n\nTenho *18h* ou *19h* disponíveis.\n\nQual fica melhor para você?";
}

// ====== HUMAN DELAY ======
function computeHumanDelay(flags, state) {
  let base = randInt(MIN_DELAY, MAX_DELAY);
  if (flags.wantsBook || flags.asksHours) base = randInt(2, 5);
  if (flags.wantsPrice) base = randInt(3, 6);
  if (flags.intentPay) base = randInt(2, 4);
  if (flags.asksIfWorks) base = randInt(5, 9);
  if (flags.refuses) base = randInt(4, 8);

  const lastAt = Number(state.last_sent_at || 0);
  if (Date.now() - lastAt < 2000) base += 2;

  return Math.max(2, base);
}

async function sendWhatsApp(to, from, body, delaySec) {
  await sleep(delaySec * 1000);
  await twilioClient.messages.create({ to, from, body });
}

// ====== OPENAI ======
function compactMemory(state) {
  const s = state || {};
  return {
    nome: s.nome || null,
    focus: s.focus || null,
    stage: s.stage || null,
    date_key: s.date_key || null,
    slot_time: s.slot_time || null,
    nome_completo: s.nome_completo || null,
    birthdate: s.birthdate || null,
    email: s.email || null,
    last_user_message: s.last_user_message || "",
    last_bot_reply: s.last_bot_reply || "",
  };
}

function buildSystemPrompt() {
  return `
Você é "Lia", secretária premium do Dr. Alef Kotula (consulta 100% online).

REGRAS ABSOLUTAS:
- Nunca inventar preço.
- Nunca enviar links.
- Nunca citar valores em R$ (isso é função do sistema).
- Nunca prescrever dose, nunca orientar compra, nunca recomendar marca.
- Nunca prometer cura/garantir resultado.
- 1 pergunta por mensagem. Mensagens curtas. Tom humano.

Se pedirem preço/valores/link de pagamento: responda "PRECISA_PRECO".
Se pedirem agendar: responda "PRECISA_AGENDAR".

FORMATO:
{ "reply": "...", "updates": { ... } }
`;
}

function buildUserPrompt({ incomingText, state, flags }) {
  return `
MEMÓRIA:
${JSON.stringify(compactMemory(state))}

MENSAGEM:
${incomingText}

SINAIS:
${JSON.stringify(flags)}

TAREFA:
- Responder curto e humano.
- 1 pergunta no final.
- Se detectar nome do usuário, salvar em updates.nome.
`;
}

function violatesNoPriceNoLink(text) {
  if (!text) return false;
  if (/\bhttps?:\/\//i.test(text)) return true;
  if (/R\$\s?\d/i.test(text)) return true;
  if (/\b(200|347|447)\b/.test(text)) return true;
  return false;
}

async function runLia({ incomingText, state, flags }) {
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.4,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt({ incomingText, state, flags }) },
    ],
  });

  const content = resp.choices?.[0]?.message?.content?.trim() || "";
  let parsed = null;
  try { parsed = JSON.parse(content); } catch {}

  if (!parsed || typeof parsed !== "object" || !parsed.reply) {
    return { reply: "Entendi 🙂 Só pra eu te guiar melhor: seu foco hoje é mais dor, sono ou ansiedade?", updates: {} };
  }

  const r = String(parsed.reply || "").trim();

  if (r === "PRECISA_PRECO") return { reply: "__NEED_PRICE__", updates: parsed.updates || {} };
  if (r === "PRECISA_AGENDAR") return { reply: "__NEED_BOOK__", updates: parsed.updates || {} };

  if (violatesNoPriceNoLink(r)) {
    return { reply: "Entendi 🙂 Pra eu te explicar direitinho, seu foco hoje é mais dor, sono ou ansiedade?", updates: {} };
  }

  if (!parsed.updates) parsed.updates = {};
  parsed.reply = clip(r, 700);
  return parsed;
}

// ====== MERCADO PAGO ======
async function mpCreatePreference({ phone, planKey }) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error("Plano inválido");

  const external_reference = `lia_${phone}_${planKey}_${Date.now()}`;

  const body = {
    items: [
      {
        title: `Dr. Alef Kotula — ${plan.label}`,
        quantity: 1,
        unit_price: plan.price,
        currency_id: "BRL",
      },
    ],
    external_reference,
    notification_url: `${BASE_URL}/mp/webhook`,
    back_urls: {
      success: `${BASE_URL}/mp/thanks?status=success`,
      failure: `${BASE_URL}/mp/thanks?status=failure`,
      pending: `${BASE_URL}/mp/thanks?status=pending`,
    },
    auto_return: "approved",
    statement_descriptor: "CONSULTA ONLINE",
    metadata: {
      phone,
      plan_key: planKey,
      plan_price: plan.price,
    },
  };

  const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`MP preference erro: ${r.status} ${t}`);
  }

  const data = await r.json();
  const link = data.init_point || data.sandbox_init_point;

  return {
    preference_id: data.id,
    link,
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
  const phone = md.phone || null;
  return phone ? String(phone).trim() : null;
}

// ====== MP THANKS ======
app.get("/mp/thanks", (req, res) => {
  res.send("OK");
});

// ====== MP WEBHOOK ======
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

      if (status === "approved" && state.slot_key) {
        await markSlotPaid(state.slot_key, phone);
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

// ====== WHATSAPP WEBHOOK ======
app.post("/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  res.type("text/xml").send(twiml.toString());

  (async () => {
    try {
      const lead = req.body.From || "";
      const bot = req.body.To || "";
      const phone = lead.replace("whatsapp:", "").trim();

      const incomingText = (req.body.Body || "").trim();
      const finalText = incomingText;

      const phoneDigits = String(phone).replace(/\D/g, "");

      if (finalText.trim().toLowerCase() === "reset" && phoneDigits === "556581422637") {
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

      let state = await getUserState(phone);

      // defaults
      state.last_bot_reply = state.last_bot_reply || "";
      state.last_user_message = state.last_user_message || "";
      state.last_sent_at = state.last_sent_at || 0;
      state.nome = state.nome || null;
      state.focus = state.focus || null;
      state.payment = state.payment || null;
      state.stage = state.stage || null;
      state.name_used_count = Number(state.name_used_count || 0);

      state.date_key = state.date_key || null;
      state.slot_time = state.slot_time || null;
      state.slot_key = state.slot_key || null;
      state.nome_completo = state.nome_completo || null;
      state.birthdate = state.birthdate || null;
      state.email = state.email || null;

      state.last_bot_from = bot;

      const flags = detectIntent(finalText);
      if (flags.focus) state.focus = flags.focus;

      let reply = "";

      // 0) pagamento aprovado
      if (state.payment?.status === "approved") {
        reply = afterPaidReply(state);
      }

      // 1) urgência
      else if (flags.urgency) {
        reply = urgencyReply();
      }

      // 2) quem é
      else if (flags.asksWho) {
        reply = whoReply();
      }

      // 3) pergunta nome simples
      else if (state.stage === "ASK_NAME" && !state.nome) {
        const nm = extractNameFromText(finalText);
        if (nm) {
          state.nome = nm;
          state.stage = "ASK_DAY";
          reply = await askDayReply();
        } else {
          reply = "Me diz só seu *primeiro nome* 🙂";
        }
      }

      // 4) intent pagar
      else if (flags.intentPay) {
        if (!state.nome) {
          state.stage = "ASK_NAME";
          reply = askNameReply();
        } else if (state.payment?.status === "pending" && state.payment?.link) {
          reply =
            "Perfeito 🙂 Pra confirmar, é só pagar por aqui:\n" +
            `${state.payment.link}\n\n` +
            "Se preferir, posso te explicar rapidinho como funciona a confirmação também.";
          state.stage = "WAIT_PAYMENT";
        } else if (state.date_key && state.slot_time && state.nome_completo && state.birthdate && state.email) {
          reply = askPlanReply();
          state.stage = "ASK_PLAN";
        } else {
          reply = "Perfeito 🙂 Antes do pagamento, vou só deixar seu horário provisoriamente reservado e confirmar os dados rapidinho.";
          if (!state.date_key) {
            state.stage = "ASK_DAY";
          }
        }
      }

      // 5) preço
      else if (flags.wantsPrice) {
        if (!state.nome) {
          state.stage = "ASK_NAME";
          reply = askNameReply();
        } else {
          reply = priceReply();
          state.stage = "ASK_PLAN";
        }
      }

      // 6) dose
      else if (flags.asksStartNow) {
        reply = safetyDoseReply();
      }

      // 7) vou ver
      else if (flags.saysWillSee) {
        reply = willSeeReply(state);
      }

      // 8) indeciso
      else if (flags.saysIndecisive) {
        reply = indecisiveReply(state);
      }

      // 9) entrada de agendamento
      else if (flags.wantsBook || flags.asksHours) {
        if (!state.nome) {
          reply = premiumIntroReply() + "\n\nPra eu te ajudar a agendar direitinho: qual seu *primeiro nome*?";
          state.stage = "ASK_NAME";
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

      // 10) escolher dia
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
          if (!avail.length) {
            reply = "Esse dia está indisponível no momento 🙏 Quer que eu te mostre outra data próxima?";
          } else {
            state.date_key = explicitDate;
            state.stage = "OFFER_SLOTS";
            reply = await offerSlotsReply(state);
          }
        } else {
          reply = "Qual data fica melhor para você? Pode me responder com o número da opção ou com a data, por exemplo *10/03* 🙂";
        }
      }

      // 11) escolher horário
      else if (state.stage === "OFFER_SLOTS") {
        const best = await chooseBestSlotsForDate(state.date_key, 3);
        const choiceNum = extractNumericChoice(finalText);
        const requestedTime = extractHourOnly(finalText);

        if (choiceNum && best[choiceNum - 1]) {
          const chosen = best[choiceNum - 1];
          const hold = await acquireSlotHold(state.date_key, chosen, phone);
          if (!hold.ok) {
            reply = "Esse horário acabou de ser preenchido 🙏 Vou te mostrar as próximas melhores opções.";
            reply += "\n\n" + (await offerSlotsReply(state));
          } else {
            state.slot_time = chosen;
            state.slot_key = hold.slot_key;
            await releaseOldHeldSlotsForPhone(phone, hold.slot_key);
            state.stage = "ASK_FULLNAME";
            reply = askFullNameReply(state);
          }
        } else if (requestedTime) {
          // se pediu horário diferente explicitamente
          const available = await getAvailableSlotsForDate(state.date_key);
          if (available.includes(requestedTime)) {
            const hold = await acquireSlotHold(state.date_key, requestedTime, phone);
            if (!hold.ok) {
              reply = "Esse horário acabou de ser preenchido 🙏 Posso te mostrar as próximas melhores opções.";
              reply += "\n\n" + (await offerSlotsReply(state));
            } else {
              state.slot_time = requestedTime;
              state.slot_key = hold.slot_key;
              await releaseOldHeldSlotsForPhone(phone, hold.slot_key);
              state.stage = "ASK_FULLNAME";
              reply = askFullNameReply(state);
            }
          } else {
            const best2 = await chooseBestSlotsForDate(state.date_key, 3);
            reply =
              `Esse horário específico não está disponível em *${formatDatePt(state.date_key)}*.\n\n` +
              `O mais próximo que tenho é:\n${best2.map((s, i) => `${i + 1}) *${s}*`).join("\n")}\n\nQual fica melhor para você?`;
          }
        } else if (isWantsDifferentTime(finalText)) {
          state.stage = "ASK_SPECIFIC_TIME";
          reply = askPreferredTimeReply(state);
        } else {
          reply = "Qual você prefere? Pode me responder com *1, 2, 3* ou com o horário exato 🙂";
        }
      }

      // 12) pedir horário específico
      else if (state.stage === "ASK_SPECIFIC_TIME") {
        const requestedTime = extractHourOnly(finalText);
        if (!requestedTime) {
          reply = `Me diz o horário exato em *${formatDatePt(state.date_key)}*, por exemplo *16h* 🙂`;
        } else {
          const available = await getAvailableSlotsForDate(state.date_key);
          if (available.includes(requestedTime)) {
            const hold = await acquireSlotHold(state.date_key, requestedTime, phone);
            if (!hold.ok) {
              reply = "Esse horário acabou de ser preenchido 🙏 Vou te mostrar outras opções.";
              state.stage = "OFFER_SLOTS";
              reply += "\n\n" + (await offerSlotsReply(state));
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

      // 13) nome completo
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

      // 14) nascimento
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

      // 15) email
      else if (state.stage === "ASK_EMAIL") {
        const em = extractEmail(finalText);
        if (em) {
          state.email = em;
          state.stage = "ASK_PLAN";
          reply =
            "Obrigado 🙂\n\n" +
            `Horário provisoriamente reservado: *${prettySlot(state.date_key, state.slot_time)}*.\n\n` +
            askPlanReply();
        } else {
          reply = "Perfeito 🙂 Me manda seu *e-mail* certinho, por favor.";
        }
      }

      // 16) escolha de plano / link
      else if (flags.choosesFull || flags.choosesBasic || flags.choosesRetorno || (state.stage === "ASK_PLAN" && flags.confirms)) {
        if (!state.nome) {
          state.stage = "ASK_NAME";
          reply = askNameReply();
        } else if (!state.date_key || !state.slot_time || !state.slot_key) {
          state.stage = "ASK_DAY";
          reply = "Antes de finalizar, vou te ajudar a escolher o melhor horário 🙂";
        } else if (!state.nome_completo || !state.birthdate || !state.email) {
          if (!state.nome_completo) {
            state.stage = "ASK_FULLNAME";
            reply = askFullNameReply(state);
          } else if (!state.birthdate) {
            state.stage = "ASK_BIRTHDATE";
            reply = askBirthdateReply(state);
          } else {
            state.stage = "ASK_EMAIL";
            reply = askEmailReply();
          }
        } else {
          let planKey = null;
          if (flags.choosesFull) planKey = "full";
          else if (flags.choosesBasic) planKey = "basic";
          else if (flags.choosesRetorno) planKey = "retorno";

          if (!planKey) {
            reply = askPlanReply();
            state.stage = "ASK_PLAN";
          } else {
            const holdCheck = await acquireSlotHold(state.date_key, state.slot_time, phone);
            if (!holdCheck.ok) {
              state.slot_time = null;
              state.slot_key = null;
              state.stage = "OFFER_SLOTS";
              reply = "Esse horário acabou de ser preenchido antes da confirmação 🙏 Vou te mostrar as próximas melhores opções.";
              reply += "\n\n" + (await offerSlotsReply(state));
            } else {
              state.slot_key = holdCheck.slot_key;

              const already =
                state.payment &&
                state.payment.preference_id &&
                state.payment.plan_key === planKey &&
                state.payment.status === "pending";

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
          }
        }
      }

      // 17) aguardando pagamento
      else if (state.payment?.status === "pending" && state.payment?.link) {
        reply =
          `Perfeito 🙂 Seu horário continua pré-reservado em *${prettySlot(state.date_key, state.slot_time)}*.\n\n` +
          `Para confirmar, só falta o pagamento pelo link:\n${state.payment.link}\n\n` +
          "Assim que entrar, eu te aviso aqui ✅";
      }

      // 18) resistência
      else if (flags.refuses) {
        reply = "Tranquilo 🙂 Desculpa se soou pressionado. Quer que eu te explique rapidinho como funciona ou prefere só tirar uma dúvida agora?";
      }

      // 19) conversa aberta (IA)
      else {
        const ai = await runLia({ incomingText: finalText, state, flags });

        if (ai.reply === "__NEED_PRICE__") {
          if (!state.nome) {
            state.stage = "ASK_NAME";
            reply = askNameReply();
          } else {
            reply = priceReply();
            state.stage = "ASK_PLAN";
          }
        } else if (ai.reply === "__NEED_BOOK__") {
          if (!state.nome) {
            reply = premiumIntroReply() + "\n\nPra eu te ajudar a agendar direitinho: qual seu *primeiro nome*?";
            state.stage = "ASK_NAME";
          } else {
            state.stage = "ASK_DAY";
            reply = await askDayReply();
          }
        } else {
          reply = ai.reply;
          state = mergeState(state, ai.updates);
          if (!state.nome && ai.updates?.nome) state.nome = String(ai.updates.nome).trim();
        }
      }

      // anti-loop final
      if (similar(reply, state.last_bot_reply)) {
        if (!state.nome) reply = askNameReply();
        else if (!state.date_key) reply = await askDayReply();
        else if (!state.slot_time) reply = await offerSlotsReply(state);
        else if (!state.nome_completo) reply = askFullNameReply(state);
        else if (!state.birthdate) reply = askBirthdateReply(state);
        else if (!state.email) reply = askEmailReply();
        else reply = "Entendi 🙂 Me diz só: seu foco hoje é mais dor, sono ou ansiedade?";
      }

      if (state.nome && reply.includes(state.nome)) {
        state.name_used_count = Number(state.name_used_count || 0) + 1;
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

// ====== HEALTH CHECK ======
app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;

// ====== DEBUG PAYMENT ======
app.post("/create-payment", async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || "Pagamento");
    const phone = String(req.body?.phone || "").trim().replace(/^whatsapp:/, "");

    if (!amount || amount <= 0) return res.status(400).json({ error: "amount inválido" });

    const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: [{ title: description, quantity: 1, currency_id: "BRL", unit_price: amount }],
        notification_url: `${BASE_URL}/mp/webhook`,
        metadata: { phone: phone || null },
      }),
    });

    const data = await response.json();
    res.json({ payment_link: data.init_point || data.sandbox_init_point });

  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao criar pagamento");
  }
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
