
/**
 * INDEX V14 — LIA 90% IA / 10% SCRIPT
 *
 * OBJETIVO:
 * - 90% da condução pela IA
 * - 10% determinístico apenas para: valores, agenda, lock de horário e pagamento
 * - responder perguntas do paciente ANTES de tentar vender/agendar
 * - evitar loops de agenda
 * - evitar mini-consulta longa no WhatsApp
 * - conduzir com naturalidade até a conversão
 *
 * BASE USADA:
 * - inspirado na estrutura do INDEX V13 enviado pelo usuário
 * - agenda, planos e pagamento continuam determinísticos
 * - conversa, objeções e condução ficam majoritariamente com IA
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
} = process.env;

if (!OPENAI_API_KEY) console.error("❌ Falta OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) console.error("❌ Falta TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN");
if (!DATABASE_URL) console.error("❌ Falta DATABASE_URL");
if (!MP_ACCESS_TOKEN) console.error("❌ Falta MP_ACCESS_TOKEN");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const CHAT_MODEL = MODEL_CHAT || "gpt-4.1";
const MIN_DELAY = Number(MIN_DELAY_SEC || 1);
const MAX_DELAY = Number(MAX_DELAY_SEC || 4);
const BASE_URL = (PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "") || "http://localhost:10000";
const HOLD_MINUTES = 15;

const appPort = process.env.PORT || 10000;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on("error", (err) => console.error("❌ Postgres pool error:", err));

const PLANS = {
  full: {
    key: "full",
    short: "1",
    label: "Acompanhamento Médico Especializado",
    subtitle: "Consulta + Retorno ~30 dias",
    price: 447,
  },
  basic: {
    key: "basic",
    short: "2",
    label: "Avaliação Médica Especializada",
    subtitle: "45 min",
    price: 347,
  },
  retorno: {
    key: "retorno",
    short: "3",
    label: "Consulta de Ajuste",
    subtitle: "Retorno avulso",
    price: 200,
  },
};

const FIXED_SCHEDULE = {
  "11-03": { dayName: "quarta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "12-03": { dayName: "quinta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "13-03": { dayName: "sexta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
};

const PREMIUM_SLOT_PRIORITY = ["19h", "18h", "20h", "17h", "21h", "16h", "15h", "14h", "13h", "12h", "11h", "10h", "9h"];
const WEEKDAY_PT = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

/* ------------------------ DB ------------------------ */

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

  console.log("✅ DB pronta.");
}

async function getUserState(phone) {
  const { rows } = await pool.query("SELECT state FROM wa_users WHERE phone=$1", [phone]);
  if (rows.length) return rows[0].state || {};
  await pool.query(
    `INSERT INTO wa_users (phone, state, updated_at)
     VALUES ($1, '{}'::jsonb, NOW())
     ON CONFLICT (phone) DO NOTHING`,
    [phone]
  );
  return {};
}

async function saveUserState(phone, state) {
  await pool.query(
    `INSERT INTO wa_users (phone, state, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (phone)
     DO UPDATE SET state=$2::jsonb, updated_at=NOW()`,
    [phone, JSON.stringify(state || {})]
  );
}

/* ------------------------ Helpers ------------------------ */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pad2(n) { return String(n).padStart(2, "0"); }
function currentYear() { return new Date().getFullYear(); }
function removeDuplicates(arr) { return [...new Set(arr)]; }

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text, max = 1100) {
  const t = String(text || "").trim();
  return t.length <= max ? t : t.slice(0, max).trim();
}

function initializeState(state, bot) {
  const s = state || {};
  s.nome = s.nome || null;
  s.problem_text = s.problem_text || null;
  s.condition = s.condition || null;
  s.stage = s.stage || null;

  s.date_key = s.date_key || null;
  s.slot_time = s.slot_time || null;
  s.slot_key = s.slot_key || null;
  s.offered_slots = Array.isArray(s.offered_slots) ? s.offered_slots : [];

  s.nome_completo = s.nome_completo || null;
  s.birthdate = s.birthdate || null;
  s.email = s.email || null;

  s.selected_plan_key = s.selected_plan_key || null;
  s.payment = s.payment || null;

  s.last_bot_reply = s.last_bot_reply || "";
  s.last_user_message = s.last_user_message || "";
  s.last_bot_from = bot || s.last_bot_from || null;
  s.direct_question_missed_count = Number(s.direct_question_missed_count || 0);
  s.followup_count = Number(s.followup_count || 0);

  return s;
}

function extractFirstName(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const m = raw.match(/(?:me chamo|me chama|sou|pode me chamar de|meu nome e|meu nome é)\s+([A-Za-zÀ-ÿ' -]+)/i);
  let candidate = m ? m[1].trim() : raw.trim();

  candidate = candidate
    .replace(/^[,:;\- ]+|[,:;\- ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!candidate) return null;

  const parts = candidate.split(" ").filter(Boolean);
  if (!parts.length) return null;

  const first = parts[0];
  if (norm(first) === "pode") return parts[1] ? capitalize(parts[1]) : null;
  if (norm(first) === "me") return parts[1] ? capitalize(parts[1]) : null;
  return capitalize(first);
}

function extractFullName(text) {
  const cleaned = String(text || "")
    .replace(/[^\p{L}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const m = cleaned.match(/(?:meu nome completo e|meu nome completo é|nome completo e|nome completo é)\s+(.+)/i);
  const candidate = (m ? m[1] : cleaned).trim();
  const parts = candidate.split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  return parts.map(capitalize).join(" ");
}

function extractBirthDate(text) {
  const m = String(text || "").match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
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

function capitalize(s) {
  const t = String(s || "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : t;
}

function detectCondition(text) {
  const t = norm(text);
  if (t.includes("fibromialgia")) return "fibromialgia";
  if (t.includes("artrose")) return "artrose";
  if (t.includes("artrite")) return "artrite";
  if (t.includes("neuropat")) return "dor_neuropatica";
  if (t.includes("lombar") || t.includes("coluna") || t.includes("costas")) return "dor_lombar";
  if (t.includes("insônia") || t.includes("insonia") || t.includes("sono") || t.includes("dormir")) return "insonia";
  if (t.includes("ansiedade") || t.includes("panico") || t.includes("pânico")) return "ansiedade";
  if (t.includes("dor")) return "dor_cronica";
  return null;
}

function extractProblemText(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const low = norm(t);
  if (/(dor|sono|insônia|insonia|ansiedade|fibromialgia|artrose|artrite|coluna|costas|lombar|dormir)/.test(low)) return t;
  return null;
}

function detectIntent(text) {
  const t = norm(text);

  return {
    wantsPrice: /\b(preco|preço|valor|quanto custa|investimento|valores|custa)\b/.test(t),
    wantsBook: /\b(quero marcar|quero agendar|agendar|marcar|horarios|horário|horario|agenda|ver horarios|ver horários|disponibilidade)\b/.test(t),
    wantsPay: /\b(pagar|pagamento|link|pix|cartao|cartão|credito|crédito|boleto|parcelar|parcela)\b/.test(t),
    asksLegal: /\b(e legal|é legal|legal no brasil|anvisa|receita|prescricao|prescrição)\b/.test(t),
    asksDoctorDirect: /\b(direto com o dr|direto com o doutor|direto com dr|triagem|triagem antes|consulta direto com o dr|consulta direto com o doutor)\b/.test(t),
    asksTreatmentFormat: /\b(oleo|óleo|capsula|cápsula|gotas|remedio|remédio|como funciona o tratamento|como e o tratamento|como é o tratamento|como funciona na pratica|como funciona na prática)\b/.test(t),
    asksMedicationCost: /\b(medicamento.*caro|tratamento.*caro|quanto custa por mes|quanto custa por mês|valor por mes|valor por mês|custa por mes|custa por mês)\b/.test(t),
    asksIfWorks: /\b(funciona|ajuda|melhora|serve|vale a pena|resultado)\b/.test(t),
    asksDifferential: /\b(diferenca|diferença|o que diferencia|o que muda|comparando alguns medicos|comparando alguns médicos|outros medicos|outros médicos)\b/.test(t),
    asksScam: /\b(golpe|curso|suplemento|kit|isca|fraude)\b/.test(t),
    unsure: /\b(nao sei|não sei|to na duvida|tô na dúvida|duvida|dúvida|receio|medo|pensar)\b/.test(t),
    directQuestion: /\?/.test(String(text || "")) || /\b(como|qual|quanto|isso e|isso é|direto com|funciona|diferenca|diferença)\b/.test(t),
  };
}

/* ------------------------ Agenda & slots ------------------------ */

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

function extractNumericChoice(text) {
  const t = norm(text);
  if (/\b1\b|primeiro|primeira/.test(t)) return 1;
  if (/\b2\b|segundo|segunda/.test(t)) return 2;
  if (/\b3\b|terceiro|terceira/.test(t)) return 3;
  return null;
}

function extractDateKey(text) {
  const low = norm(text);
  const m = low.match(/\b(\d{1,2})[\/.-](\d{1,2})\b/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    if (mm === 3 && dd >= 1 && dd <= 31) return `${pad2(dd)}-${pad2(mm)}`;
  }
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

function extractPlanChoice(text) {
  const t = norm(text);

  if (/^(1|opcao 1|opção 1)$/.test(t)) return "full";
  if (/^(2|opcao 2|opção 2)$/.test(t)) return "basic";
  if (/^(3|opcao 3|opção 3)$/.test(t)) return "retorno";

  if (/\b(acompanhamento|consulta com retorno|com retorno)\b/.test(t)) return "full";
  if (/\b(avaliacao|avaliação|primeira consulta|avaliacao especializada|avaliação especializada)\b/.test(t)) return "basic";
  if (/\b(retorno avulso|consulta de ajuste|retorno)\b/.test(t)) return "retorno";

  return null;
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
  const base = FIXED_SCHEDULE[dateKey] ? [...FIXED_SCHEDULE[dateKey].slots] : [];
  const blocked = await getBlockedSlotKeysForDate(dateKey);
  const filtered = base.filter((t) => !blocked.has(slotKey(dateKey, t)));
  const ordered = [];
  for (const p of PREMIUM_SLOT_PRIORITY) if (filtered.includes(p)) ordered.push(p);
  for (const s of filtered) if (!ordered.includes(s)) ordered.push(s);
  return ordered;
}

async function chooseBestSlotsForDate(dateKey, max = 3) {
  const available = await getAvailableSlotsForDate(dateKey);
  return available.slice(0, max);
}

async function getSuggestedDayKeys() {
  const out = [];
  for (const d of Object.keys(FIXED_SCHEDULE)) {
    const slots = await getAvailableSlotsForDate(d);
    if (slots.length) out.push(d);
  }
  return out.slice(0, 3);
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
      `UPDATE wa_slot_locks
       SET expires_at = NOW() + ($2 || ' minutes')::interval, updated_at = NOW()
       WHERE slot_key=$1`,
      [key, String(minutes)]
    );
    return { ok: true, slot_key: key };
  }

  if (row.status === "held" && row.expires_at && new Date(row.expires_at) > new Date()) {
    return { ok: false, reason: "held" };
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
        if (st.slot_key) await markSlotPaid(st.slot_key, phone);
        await saveUserState(phone, st);
        await sendWhatsApp(lead, bot, afterPaidReply(st), 0);
        return;
      }

      let state = initializeState(await getUserState(phone), bot);
      const flags = detectIntent(finalText);
      if (flags.focus && !state.focus) state.focus = flags.focus;
      const detectedCondition = detectCondition(finalText);
      if (detectedCondition && !state.condition) state.condition = detectedCondition;
      const detectedProblem = extractProblemText(finalText);
      if (detectedProblem && !state.problem_text) state.problem_text = detectedProblem;

      let reply = "";

      // 0) confirmado
      if (state.payment?.status === "approved") {
        reply = afterPaidReply(state);
      
  }

  await pool.query(
    `UPDATE wa_slot_locks
     SET phone=$2, status='held', expires_at = NOW() + ($3 || ' minutes')::interval, updated_at = NOW(), paid_at = NULL
     WHERE slot_key=$1`,
    [key, phone, String(minutes)]
  );
  return { ok: true, slot_key: key };
}

async function releaseOldHeldSlotsForPhone(phone, keepSlotKey = null) {
  if (!phone) return;
  if (keepSlotKey) {
    await pool.query(`DELETE FROM wa_slot_locks WHERE phone=$1 AND status='held' AND slot_key <> $2`, [phone, keepSlotKey]);
  } else {
    await pool.query(`DELETE FROM wa_slot_locks WHERE phone=$1 AND status='held'`, [phone]);
  }
}

async function markSlotPaid(key, phone) {
  if (!key) return;
  await pool.query(
    `UPDATE wa_slot_locks
     SET status='paid', expires_at=NULL, paid_at=NOW(), updated_at=NOW()
     WHERE slot_key=$1 AND phone=$2`,
    [key, phone]
  );
}

/* ------------------------ Script replies (the 10%) ------------------------ */

function consultationExplanationReply() {
  return (
    "A avaliação com o Dr. Alef é *100% online, por videochamada*, dura em média *45 minutos* e é totalmente individualizada.\n\n" +
    "Ele analisa seu histórico, o que você já tentou, suas medicações e define com você se esse tratamento faz sentido no seu caso."
  );
}

function priceReply() {
  return (
    "Hoje trabalhamos com estas opções:\n\n" +
    `1) *${PLANS.full.label}* (${PLANS.full.subtitle}) — *R$${PLANS.full.price}* *(87% das pessoas escolhem essa opção)* ⭐\n` +
    `2) *${PLANS.basic.label}* (${PLANS.basic.subtitle}) — *R$${PLANS.basic.price}*\n` +
    `3) *${PLANS.retorno.label}* (${PLANS.retorno.subtitle}) — *R$${PLANS.retorno.price}*\n\n` +
    "Qual dessas opções faz mais sentido para você agora? Me responda com *1, 2 ou 3*."
  );
}

async function askDayReply() {
  const dayKeys = await getSuggestedDayKeys();
  if (!dayKeys.length) {
    return "No momento os horários desta semana já estão completos. Se quiser, eu posso te avisar assim que abrir uma vaga 🙂";
  }

  return (
    "Perfeito 🙂\n\n" +
    "Essa semana ainda tenho alguns horários disponíveis em horário de Brasília.\n\n" +
    "Nos próximos dias tenho agenda em:\n" +
    dayKeys.map((d, i) => `${i + 1}) *${formatDatePt(d)}*`).join("\n") +
    "\n\nQual você prefere?"
  );
}

async function offerSlotsReply(state) {
  const best = await chooseBestSlotsForDate(state.date_key, 3);
  if (!best.length) return "Esse dia acabou de ficar sem vagas 🙏 Quer que eu te mostre outra data próxima?";
  state.offered_slots = best;
  return (
    "Perfeito 🙂\n\n" +
    `Para *${formatDatePt(state.date_key)}* tenho:\n\n` +
    best.map((s, i) => `${i + 1}) *${s}*`).join("\n") +
    "\n\nQual fica melhor para você?"
  );
}

function askFullNameReply(state) {
  return (
    `Perfeito. Vou reservar provisoriamente *${prettySlot(state.date_key, state.slot_time)}* para você por alguns minutos.\n\n` +
    "Só preciso confirmar alguns dados rápidos.\n\n" +
    "Qual seu *nome completo*?"
  );
}

function askBirthdateReply(state) {
  return `Obrigado, ${String(state.nome_completo || "").split(" ")[0]} 🙂\n\nQual sua *data de nascimento*?`;
}

function askEmailReply() {
  return "Perfeito 🙂\n\nE qual *e-mail* você prefere usar para receber as orientações da consulta?";
}

function askPlanReply(state) {
  return (
    `Obrigado 🙂\n\nHorário provisoriamente reservado: *${prettySlot(state.date_key, state.slot_time)}*.\n\n` +
    consultationExplanationReply() +
    "\n\n" +
    priceReply()
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
    "Assim que o pagamento for confirmado, eu libero a confirmação da consulta para você."
  );
}

function afterPaidReply(state) {
  return (
    "Pagamento confirmado ✅\n\n" +
    `Sua consulta ficou confirmada para *${prettySlot(state.date_key, state.slot_time)}*.\n\n` +
    "Mais perto do horário eu envio as orientações da consulta 🙂"
  );
}

/* ------------------------ Mercado Pago ------------------------ */

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

/* ------------------------ AI core (the 90%) ------------------------ */

function compactMemory(state) {
  return {
    nome: state.nome || null,
    problem_text: state.problem_text || null,
    condition: state.condition || null,
    stage: state.stage || null,
    date_key: state.date_key || null,
    slot_time: state.slot_time || null,
    nome_completo: state.nome_completo || null,
    birthdate: state.birthdate || null,
    email: state.email || null,
    selected_plan_key: state.selected_plan_key || null,
    payment_status: state.payment?.status || null,
    last_bot_reply: state.last_bot_reply || "",
    last_user_message: state.last_user_message || "",
  };
}

function buildSystemPrompt() {
  return `
Você é a LIA, secretária de alta conversão do Dr. Alef Kotula no WhatsApp.

MISSÃO:
- conduzir o paciente com naturalidade até consulta
- responder a pergunta do paciente ANTES de tentar agendar
- converter sem parecer robô
- ser acolhedora, humana, objetiva e persuasiva

ESTILO:
- WhatsApp brasileiro
- frases curtas e médias
- no máximo 1 pergunta por mensagem
- sempre soar humana
- nunca responder com bloco gigante e frio
- nunca repetir agenda se a dúvida principal ainda não foi respondida
- nunca ignorar pergunta direta
- nunca entrar em loop

REGRAS DE CONVERSÃO:
1. Pergunta direta do paciente vem antes do funil.
2. Se o paciente quiser entender tratamento, explique primeiro em linguagem simples.
3. Se o paciente estiver inseguro, valide e responda com clareza.
4. Depois de responder, faça CTA suave.
5. Não empurre agenda cedo demais.
6. Não transforme o WhatsApp em consulta longa.
7. Se o paciente repetir a mesma pergunta, responda de forma ainda mais direta.
8. Se o paciente estiver comparando médicos, explique diferenciais reais.
9. Se o paciente perguntar se é direto com o Dr. Alef, responda objetivamente.
10. Se o paciente perguntar como funciona o tratamento, responda objetivamente.

INFORMAÇÕES FIXAS E VERDADEIRAS:
- a consulta é com o Dr. Alef Kotula
- é online, por videochamada
- dura em média 45 minutos
- é individualizada
- o objetivo é avaliar se tratamento com canabinoides faz sentido para o caso
- quando indicado, o tratamento costuma envolver formulações prescritas de cannabis medicinal, com apresentações que podem variar conforme o caso, frequentemente óleo oral/sublingual, mas isso depende da avaliação
- não prometa cura
- não prometa resultado garantido
- não prescreva dose
- não informe preços
- não informe horários
- não envie links
- não invente dados
- pode dizer que o tratamento e a formulação variam conforme o caso
- pode dizer que o médico avalia segurança, medicações em uso e objetivos do paciente
- pode dizer que muitos pacientes buscam melhora de dor, sono, ansiedade e qualidade de vida
- pode dizer que quando indicado há acompanhamento e ajustes

QUANDO DEVOLVER COMANDO:
- Se o paciente pedir preço/valor/investimento: devolva exatamente "PRECISA_PRECO"
- Se o paciente pedir horários/agendar/agenda: devolva exatamente "PRECISA_AGENDAR"
- Se o paciente pedir pagamento/link para pagar: devolva exatamente "PRECISA_PAGAR"

FORMATO OBRIGATÓRIO:
Responda sempre em JSON válido:
{
  "reply": "mensagem",
  "updates": {
    "nome": null,
    "problem_text": null,
    "condition": null
  }
}

Se não quiser atualizar algo, use null.
`;
}

function buildUserPrompt({ incomingText, state, flags }) {
  return `
CONTEXTO DO PACIENTE:
${JSON.stringify(compactMemory(state), null, 2)}

MENSAGEM ATUAL DO PACIENTE:
${incomingText}

INTENÇÕES DETECTADAS:
${JSON.stringify(flags, null, 2)}

INSTRUÇÕES:
- responda a dúvida principal com clareza
- se já houver base suficiente, feche com CTA suave
- se o paciente estiver frio, não force agenda cedo demais
- se o paciente estiver quente, conduza para consulta
- não ignore a pergunta
- não repita script
- não fale de preço, horários ou links
`;
}

function violatesNoPriceNoLink(text) {
  const t = String(text || "");
  return /\bhttps?:\/\//i.test(t) || /R\$\s?\d/i.test(t);
}

async function runLiaAI({ incomingText, state, flags }) {
  const response = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.65,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt({ incomingText, state, flags }) },
    ],
  });

  const content = response.choices?.[0]?.message?.content?.trim() || "";
  let parsed = null;

  try {
    parsed = JSON.parse(content);
  } catch {
    return { reply: "Entendi 🙂 Me diz só qual é sua principal dúvida agora?", updates: {} };
  }

  if (!parsed || typeof parsed !== "object" || !parsed.reply) {
    return { reply: "Entendi 🙂 Me diz só qual é sua principal dúvida agora?", updates: {} };
  }

  const reply = String(parsed.reply || "").trim();

  if (reply === "PRECISA_PRECO") return { reply: "__NEED_PRICE__", updates: parsed.updates || {} };
  if (reply === "PRECISA_AGENDAR") return { reply: "__NEED_BOOK__", updates: parsed.updates || {} };
  if (reply === "PRECISA_PAGAR") return { reply: "__NEED_PAY__", updates: parsed.updates || {} };

  if (violatesNoPriceNoLink(reply)) {
    return { reply: "Entendi 🙂 Me diz só qual é sua principal dúvida agora?", updates: {} };
  }

  return {
    reply: clip(reply, 1100),
    updates: parsed.updates || {},
  };
}

/* ------------------------ Twilio send ------------------------ */

function computeHumanDelay(flags) {
  let base = randInt(MIN_DELAY, MAX_DELAY);
  if (flags.wantsBook || flags.wantsPrice || flags.wantsPay) base = randInt(1, 3);
  return Math.max(1, base);
}

async function sendWhatsApp(to, from, body, delaySec) {
  await sleep(delaySec * 1000);
  await twilioClient.messages.create({ to, from, body });
}

/* ------------------------ Routes ------------------------ */

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

      const state = initializeState(await getUserState(phone), null);
      state.payment = state.payment || {};
      state.payment.status = status;
      state.payment.payment_id = paymentId;
      state.payment.updated_at = Date.now();

      if (status === "approved" && state.slot_key) {
        await markSlotPaid(state.slot_key, phone);
      }

      await saveUserState(phone, state);

      if (status === "approved" && state.last_bot_from) {
        try {
          await twilioClient.messages.create({
            to: `whatsapp:${phone}`,
            from: state.last_bot_from,
            body: afterPaidReply(state),
          });
        } catch (e) {
          console.error("❌ erro ao avisar pagamento aprovado:", e);
        }
      }
    }
  } catch (err) {
    console.error("❌ MP webhook erro:", err);
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
      const incomingText = String(req.body.Body || "").trim();

      let state = initializeState(await getUserState(phone), bot);
      const flags = detectIntent(incomingText);

      state.last_user_message = incomingText;

      if (!state.nome) {
        const maybeName = extractFirstName(incomingText);
        if (maybeName) state.nome = maybeName;
      }

      if (!state.problem_text) {
        const problem = extractProblemText(incomingText);
        if (problem) state.problem_text = problem;
      }

      if (!state.condition) {
        const condition = detectCondition(incomingText);
        if (condition) state.condition = condition;
      }

      let reply = "";

      /* ---------- Payment approved ---------- */
      if (state.payment?.status === "approved") {
        reply = afterPaidReply(state);
      }

      /* ---------- Booking deterministic flow ---------- */
      else if (state.stage === "ASK_DAY") {
        const dayChoice = extractNumericChoice(incomingText);
        const explicitDate = extractDateKey(incomingText);
        const suggested = await getSuggestedDayKeys();

        if (dayChoice && suggested[dayChoice - 1]) {
          state.date_key = suggested[dayChoice - 1];
          state.stage = "OFFER_SLOTS";
          reply = await offerSlotsReply(state);
        } else if (explicitDate && FIXED_SCHEDULE[explicitDate]) {
          state.date_key = explicitDate;
          state.stage = "OFFER_SLOTS";
          reply = await offerSlotsReply(state);
        } else {
          reply = "Qual data fica melhor para você? Pode me responder com o número da opção ou com o dia, por exemplo *quinta-feira* 🙂";
        }
      }
      else if (state.stage === "OFFER_SLOTS") {
        const options = state.offered_slots?.length ? state.offered_slots : await chooseBestSlotsForDate(state.date_key, 3);
        const choiceNum = extractNumericChoice(incomingText);
        const requestedTime = extractHourOnly(incomingText);

        let chosen = null;
        if (choiceNum && options[choiceNum - 1]) chosen = options[choiceNum - 1];
        else if (requestedTime) chosen = requestedTime;

        if (!chosen) {
          reply = "Qual fica melhor para você? Pode me responder com *1, 2, 3* ou com o horário exato 🙂";
        } else {
          const available = await getAvailableSlotsForDate(state.date_key);
          if (!available.includes(chosen)) {
            reply = "Esse horário não está disponível agora 🙏 Vou te mostrar as melhores opções desse dia.\n\n" + await offerSlotsReply(state);
          } else {
            const hold = await acquireSlotHold(state.date_key, chosen, phone);
            if (!hold.ok) {
              reply = "Esse horário acabou de ser preenchido 🙏 Vou te mostrar outras opções.\n\n" + await offerSlotsReply(state);
            } else {
              state.slot_time = chosen;
              state.slot_key = hold.slot_key;
              await releaseOldHeldSlotsForPhone(phone, hold.slot_key);
              state.stage = "ASK_FULLNAME";
              reply = askFullNameReply(state);
            }
          }
        }
      }
      else if (state.stage === "ASK_FULLNAME") {
        const full = extractFullName(incomingText);
        if (full) {
          state.nome_completo = full;
          state.stage = "ASK_BIRTHDATE";
          reply = askBirthdateReply(state);
        } else {
          reply = "Perfeito 🙂 Me manda seu *nome completo* certinho, por favor.";
        }
      }
      else if (state.stage === "ASK_BIRTHDATE") {
        const bd = extractBirthDate(incomingText);
        if (bd) {
          state.birthdate = bd;
          state.stage = "ASK_EMAIL";
          reply = askEmailReply();
        } else {
          reply = "Me manda sua *data de nascimento* no formato *dd/mm/aaaa* 🙂";
        }
      }
      else if (state.stage === "ASK_EMAIL") {
        const email = extractEmail(incomingText);
        if (email) {
          state.email = email;
          state.stage = "ASK_PLAN";
          reply = askPlanReply(state);
        } else {
          reply = "Perfeito 🙂 Me manda seu *e-mail* certinho, por favor.";
        }
      }
      else if (state.stage === "ASK_PLAN") {
        const planKey = extractPlanChoice(incomingText);
        if (!planKey) {
          reply = "Qual dessas opções faz mais sentido para você agora? Pode me responder com *1, 2 ou 3* 🙂";
        } else {
          state.selected_plan_key = planKey;

          const holdCheck = await acquireSlotHold(state.date_key, state.slot_time, phone);
          if (!holdCheck.ok) {
            state.slot_time = null;
            state.slot_key = null;
            state.stage = "OFFER_SLOTS";
            reply = "Esse horário acabou de ser preenchido antes da confirmação 🙏 Vou te mostrar as próximas melhores opções.\n\n" + await offerSlotsReply(state);
          } else {
            state.slot_key = holdCheck.slot_key;
            const pref = await mpCreatePreference({ phone, planKey });
            state.payment = {
              status: "pending",
              preference_id: pref.preference_id,
              link: pref.link,
              external_reference: pref.external_reference,
              created_at: Date.now(),
              plan_key: planKey,
            };
            state.stage = "WAIT_PAYMENT";
            reply = paymentSentReply(pref.plan, pref.link, state);
          }
        }
      }
      else if (state.stage === "WAIT_PAYMENT") {
        if (state.payment?.link) {
          reply = pendingPaymentReply(state);
        } else {
          state.stage = null;
          reply = "Perfeito 🙂 Se quiser, eu posso retomar sua confirmação daqui.";
        }
      }

      /* ---------- Deterministic entry points: price / book / pay ---------- */
      else if (flags.wantsPrice) {
        reply = priceReply();
        state.stage = "ASK_PLAN";
      }
      else if (flags.wantsBook) {
        reply = await askDayReply();
        state.stage = "ASK_DAY";
      }
      else if (flags.wantsPay) {
        if (!state.date_key || !state.slot_time) {
          reply = "Perfeito 🙂 Antes do pagamento, vou te mostrar os horários disponíveis para reservar seu atendimento.\n\n" + await askDayReply();
          state.stage = "ASK_DAY";
        } else if (!state.nome_completo) {
          state.stage = "ASK_FULLNAME";
          reply = askFullNameReply(state);
        } else if (!state.birthdate) {
          state.stage = "ASK_BIRTHDATE";
          reply = askBirthdateReply(state);
        } else if (!state.email) {
          state.stage = "ASK_EMAIL";
          reply = askEmailReply();
        } else if (!state.selected_plan_key) {
          state.stage = "ASK_PLAN";
          reply = askPlanReply(state);
        } else if (state.payment?.link) {
          state.stage = "WAIT_PAYMENT";
          reply = pendingPaymentReply(state);
        } else {
          state.stage = "ASK_PLAN";
          reply = askPlanReply(state);
        }
      }

      /* ---------- 90% AI ---------- */
      else {
        const ai = await runLiaAI({ incomingText, state, flags });

        if (ai.reply === "__NEED_PRICE__") {
          reply = priceReply();
          state.stage = "ASK_PLAN";
        } else if (ai.reply === "__NEED_BOOK__") {
          reply = await askDayReply();
          state.stage = "ASK_DAY";
        } else if (ai.reply === "__NEED_PAY__") {
          if (!state.date_key || !state.slot_time) {
            reply = "Perfeito 🙂 Antes do pagamento, vou te mostrar os horários disponíveis para reservar seu atendimento.\n\n" + await askDayReply();
            state.stage = "ASK_DAY";
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
            reply = askPlanReply(state);
          }
        } else {
          reply = ai.reply;
          const updates = ai.updates || {};

          if (updates.nome && !state.nome) state.nome = extractFirstName(updates.nome) || updates.nome;
          if (updates.problem_text && !state.problem_text) state.problem_text = updates.problem_text;
          if (updates.condition && !state.condition) state.condition = updates.condition;
        }
      }

      state.last_bot_reply = reply;
      state.last_sent_at = Date.now();

      await saveUserState(phone, state);
      await sendWhatsApp(lead, bot, reply, computeHumanDelay(flags));
    } catch (err) {
      console.error("❌ erro no /whatsapp:", err);
      try {
        await sendWhatsApp(req.body.From, req.body.To, "Desculpa 🙏 Tive uma instabilidade agora. Pode me mandar sua última mensagem de novo?", 0);
      } catch {}
    }
  })();
});

initDB()
  .then(() => {
    app.listen(appPort, () => {
      console.log(`✅ LIA V14 rodando na porta ${appPort}`);
    });
  })
  .catch((err) => {
    console.error("❌ Falha ao iniciar DB:", err);
    process.exit(1);
  });
