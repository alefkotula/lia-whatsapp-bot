/**
 * ═══════════════════════════════════════════════════════════════════
 * INDEX V24.3 — ADAPTADO PARA N8N (API HTTP)
 * ═══════════════════════════════════════════════════════════════════
 *
 * BASE: index_lia_gpt_v24_3.js (ORIGINAL, INTOCADO NA LÓGICA)
 *
 * MUDANÇAS FEITAS (APENAS CANAL, NÃO LÓGICA):
 * 1. Twilio agora é OPCIONAL (não quebra se não estiver configurado)
 * 2. Lógica central extraída para processLiaMessage()
 * 3. Novo endpoint POST /lia/respond para n8n
 * 4. Handler /whatsapp original preservado (usa processLiaMessage)
 * 5. Webhook MP: envio Twilio condicional
 *
 * NADA MAIS FOI ALTERADO:
 * - Stages: IGUAIS
 * - Handlers: IGUAIS
 * - Anti-loop: IGUAL
 * - Textos: IGUAIS
 * - Reserva: IGUAL
 * - Pagamento/link: IGUAL
 * - Ordem de coleta: IGUAL
 * - CTA: IGUAL
 * - Lógica consulta vs medicamento: IGUAL
 * - CPF: NÃO EXISTE (nunca existiu, não foi adicionado)
 *
 * ═══════════════════════════════════════════════════════════════════
 */

const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const OpenAI = require("openai");

// Twilio é OPCIONAL — só carrega se as credenciais existirem
let twilio, twilioClient;
try {
  twilio = require("twilio");
} catch (e) {
  twilio = null;
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());
app.use("/mp", express.json({ type: ["application/json", "text/json", "*/*"] }));

/* ═══════════════════════════════════════════════════════════════════
   ENV + CLIENTS
   ═══════════════════════════════════════════════════════════════════ */

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
  TWILIO_WHATSAPP_NUMBER,
  MANUAL_SEND_SECRET,
  ADMIN_READ_SECRET,
} = process.env;

if (!OPENAI_API_KEY) console.error("❌ Falta OPENAI_API_KEY");
if (!DATABASE_URL) console.error("❌ Falta DATABASE_URL");
if (!MP_ACCESS_TOKEN) console.error("❌ Falta MP_ACCESS_TOKEN");
if (!PUBLIC_BASE_URL) console.warn("⚠️ PUBLIC_BASE_URL não definido.");

// Twilio: só inicializa se tiver credenciais
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && twilio) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log("✅ Twilio configurado.");
} else {
  twilioClient = null;
  console.warn("⚠️ Twilio não configurado (modo API-only / n8n).");
}

let openai = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  console.log("✅ OpenAI configurado.");
} else {
  console.warn("⚠️ OpenAI não configurado — LIA não responderá sem OPENAI_API_KEY.");
}

const CHAT_MODEL = MODEL_CHAT || "gpt-4.1";
const MIN_DELAY = Number(MIN_DELAY_SEC || 1);
const MAX_DELAY = Number(MAX_DELAY_SEC || 4);
const BASE_URL = (PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "") || "http://localhost:10000";
const HOLD_MINUTES = 15;
const ADMIN_RESET_PHONE_DIGITS = "556581422637";

// V24.2: Stages de coleta de dados — Camada 2 NÃO deve interceptar perguntas nestes stages
const DATA_COLLECTION_STAGES = [
  "ASK_DAY", "OFFER_SLOTS", "ASK_FULLNAME",
  "ASK_BIRTHDATE", "ASK_EMAIL", "ASK_PLAN", "WAIT_PAYMENT"
];

/* ═══════════════════════════════════════════════════════════════════
   PLANS + SCHEDULE (preservado)
   ═══════════════════════════════════════════════════════════════════ */

const PLANS = {
  full: {
    key: "full",
    label: "Acompanhamento Médico Especializado",
    subtitle: "Consulta + Retorno ~30 dias",
    price: 447,
    short: "1",
    description: "consulta com o Dr. Alef agora + retorno em ~30 dias para acompanhar evolução e ajustar tratamento",
  },
  basic: {
    key: "basic",
    label: "Avaliação Médica Especializada",
    subtitle: "45 min",
    price: 347,
    short: "2",
    description: "avaliação inicial completa de 45 minutos para entender seu caso e definir os próximos passos",
  },
  retorno: {
    key: "retorno",
    label: "Consulta de Ajuste",
    subtitle: "Retorno avulso",
    price: 200,
    short: "3",
    description: "retorno para quem já é paciente e precisa de ajuste",
  },
};

const FIXED_SCHEDULE = {
  // MARÇO 2026
  "24-03": { dayName: "terça-feira",  slots: ["16h","17h","18h","19h","20h","21h","22h"] },
  "25-03": { dayName: "quarta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h","22h"] },
  "26-03": { dayName: "quinta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h","22h"] },
  "27-03": { dayName: "sexta-feira",  slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h","22h"] },
  "28-03": { dayName: "sábado",       slots: ["9h","10h","11h","12h"] },
  "31-03": { dayName: "terça-feira",  slots: ["16h","17h","18h","19h","20h","21h","22h"] },
  // ABRIL 2026
  "01-04": { dayName: "quarta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h","22h"] },
  "02-04": { dayName: "quinta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h","22h"] },
  "03-04": { dayName: "sexta-feira",  slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h","22h"] },
  "04-04": { dayName: "sábado",       slots: ["9h","10h","11h","12h"] },
  "07-04": { dayName: "terça-feira",  slots: ["16h","17h","18h","19h","20h","21h","22h"] },
};

const PREMIUM_SLOT_PRIORITY = ["20h","21h","22h","19h","18h","17h","16h","15h","14h","13h","12h","11h","10h","9h"];

// V24.4: Prioridade de horário dinâmica por dia da semana
function getSlotPriority(dateKey) {
  const entry = FIXED_SCHEDULE[dateKey];
  if (!entry) return PREMIUM_SLOT_PRIORITY;
  const dn = norm(entry.dayName);
  if (dn.includes("sabado")) return ["9h","10h","11h","12h"];
  if (dn.includes("terca")) return ["20h","21h","22h","19h","18h","17h","16h"];
  // Quarta/Quinta/Sexta: noite > tarde > manhã
  return PREMIUM_SLOT_PRIORITY;
}
const WEEKDAY_PT = ["domingo","segunda-feira","terça-feira","quarta-feira","quinta-feira","sexta-feira","sábado"];

/* ═══════════════════════════════════════════════════════════════════
   DATABASE (preservado)
   ═══════════════════════════════════════════════════════════════════ */

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
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
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      from_number TEXT,
      to_number TEXT,
      body TEXT,
      direction TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
     ON CONFLICT (phone) DO UPDATE SET state=$2::jsonb, updated_at=NOW()`,
    [phone, JSON.stringify(newState)]
  );
}

async function logMessage(from, to, body, direction) {
  try {
    await pool.query(
      `INSERT INTO messages (from_number, to_number, body, direction) VALUES ($1, $2, $3, $4)`,
      [from, to, (body || "").slice(0, 4000), direction]
    );
  } catch (err) { console.error("❌ logMessage erro:", err.message); }
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

/* ═══════════════════════════════════════════════════════════════════
   UTILITÁRIOS (preservado)
   ═══════════════════════════════════════════════════════════════════ */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pad2(n) { return String(n).padStart(2, "0"); }
function currentYear() { return new Date().getFullYear(); }
function removeDuplicates(arr) { return [...new Set(arr)]; }
function pickRandom(arr) { return Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : ""; }

function norm(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim();
}

function clip(text, max = 900) {
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

/* ═══════════════════════════════════════════════════════════════════
   TRANSCRIÇÃO DE ÁUDIO (V24.1 — só funciona com Twilio)
   ═══════════════════════════════════════════════════════════════════ */

async function transcribeWhatsAppAudio(mediaUrl) {
  try {
    const fetch = (await import("node-fetch")).default;
    const authHeader = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const resp = await fetch(mediaUrl, {
      headers: { Authorization: authHeader },
      timeout: 15000,
    });
    if (!resp.ok) throw new Error(`Download falhou: ${resp.status} ${resp.statusText}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length < 100) throw new Error("Áudio muito curto ou vazio");

    const file = new File([buffer], "audio.ogg", { type: "audio/ogg" });
    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file,
      language: "pt",
    });

    const text = (transcription.text || "").trim();
    if (!text || text.length < 2) return null;
    console.log(`🎙️ Áudio transcrito (${buffer.length} bytes): "${text.slice(0, 120)}"`);
    return text;
  } catch (err) {
    console.error("❌ Erro ao transcrever áudio:", err.message);
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   DATE/SCHEDULE UTILS (preservado)
   ═══════════════════════════════════════════════════════════════════ */

function makeDateKey(day, month = 3) { return `${pad2(day)}-${pad2(month)}`; }

function parseDateKeyToDate(dateKey) {
  const [dd, mm] = dateKey.split("-").map(Number);
  return new Date(currentYear(), mm - 1, dd);
}

function formatDatePt(dateKey) {
  const dt = parseDateKeyToDate(dateKey);
  const wd = WEEKDAY_PT[dt.getDay()];
  return `${wd} (${dateKey.replace("-", "/")})`;
}

function slotKey(dateKey, time) { return `${dateKey}|${time}`; }

function prettySlot(dateKey, time) {
  return `${formatDatePt(dateKey)} às ${time} (horário de Brasília)`;
}

/* ═══════════════════════════════════════════════════════════════════
   EXTRACTORS (preservado da V23)
   ═══════════════════════════════════════════════════════════════════ */

function extractFirstName(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const low = norm(t);

  if (/^(sim|ok|beleza|pode|claro|show|tanto faz|nao|não)$/.test(low)) return null;
  if (/^(dor|sono|ansiedade|fibromialgia|insônia|insonia|artrose|artrite|coluna)$/.test(low)) return null;
  // V24.5: Bloquear palavras emocionais/médicas que podem ser confundidas com nome
  if (/^(sofro|sofrer|sofrimento|problema|mental|dificuldade|tristeza|depressao|depressão|angustia|angústia|desespero|ajuda|socorro|tratamento|medicamento|remedio|remédio|preciso|obrigad[oa]|brigad[oa])$/i.test(low.split(/\s+/)[0])) return null;

  const patterns = [
    /(?:pode\s+(?:me\s+)?chamar?\s+(?:de\s+)?)\s*(.+)/i,
    /(?:me\s+cham(?:a|o|e)\s+(?:de\s+)?)\s*(.+)/i,
    /(?:(?:eu\s+)?sou\s+(?:o|a)\s+)\s*(.+)/i,
    /(?:(?:meu\s+)?nome\s+(?:e|é)\s+)\s*(.+)/i,
    /^(.+?)(?:\s+aqui)$/i,
  ];

  let candidate = null;
  for (const p of patterns) {
    const m = t.match(p);
    if (m && m[1]) {
      candidate = m[1].trim();
      break;
    }
  }

  if (!candidate && t.includes("?")) return null;
  if (!candidate) candidate = t;

  candidate = candidate.split(/[\n.!?]/)[0].trim();
  candidate = candidate.replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!candidate) return null;

  const parts = candidate.split(" ").filter(Boolean);
  if (parts.length < 1 || parts.length > 5) return null;
  if (/^\d+$/.test(candidate)) return null;

  const condWords = /^(dor|sono|ansiedade|fibromialgia|artrose|artrite|enxaqueca|coluna|insônia|insonia|lombar|neuropat|depressao|depressão|tristeza|sofrimento|problema|mental|angustia|angústia)/i;
  if (condWords.test(parts[0]) && parts.length <= 2) return null;

  const notNames = /^(oi|ola|olá|bom|boa|dia|tarde|noite|tudo|bem|obrigad|brigad|quero|preciso|gostaria|tenho|sim|nao|não|legal|caro|certo|entendi|entendo|sera|será|claro|ok|verdade|seria|acho|pode|pois|tipo|vou|vai|meu|minha|mas|antes|deixa|outra|esse|essa|como|qual|quando|quanto|onde|porque|por|sofro|sofrer|dificuldade|desespero|socorro|ajuda|tratamento|medicamento|remedio|remédio)$/i;
  if (notNames.test(parts[0])) return null;

  return parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
}

function extractFullName(text) {
  const raw = (text || "").trim();
  if (!raw) return null;

  const introPatterns = [
    /(?:nome\s+completo\s+(?:e|é)\s+)/i,
    /(?:me\s+cham(?:a|o|e)\s+)/i,
    /(?:(?:meu|o)\s+nome\s+(?:e|é)\s+)/i,
    /(?:(?:eu\s+)?sou\s+(?:o|a)\s+)/i,
    /(?:pode\s+(?:me\s+)?chamar?\s+(?:de\s+)?)/i,
  ];

  let candidate = null;
  for (const p of introPatterns) {
    const m = raw.match(p);
    if (m) {
      candidate = raw.slice(m.index + m[0].length).trim();
      break;
    }
  }

  if (!candidate) candidate = raw;

  candidate = candidate.split(/[.!?\n]/)[0].trim();
  candidate = candidate.replace(/[^\p{L}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!candidate) return null;

  const stopWords = /^(claro|sim|ok|pode|certo|beleza|tudo|bem|obrigado|obrigada|é|e|o|a|meu|minha|com|certeza|bom|boa)$/i;
  let parts = candidate.split(" ").filter(Boolean);
  while (parts.length > 0 && stopWords.test(parts[0])) {
    parts.shift();
  }

  if (parts.length < 2) return null;
  if (parts.length > 5) parts = parts.slice(0, 5);

  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");
}

function extractBirthDate(text) {
  const t = (text || "").trim();
  const m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
  if (!m) return null;
  let dd = Number(m[1]), mm = Number(m[2]), yy = Number(m[3]);
  if (yy < 100) yy += 1900;
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
  return `${pad2(dd)}/${pad2(mm)}/${yy}`;
}

function extractEmail(text) {
  const m = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].trim() : null;
}

function extractDateKey(text) {
  const t = String(text || "");
  const validMonths = new Set(Object.keys(FIXED_SCHEDULE).map(k => Number(k.split("-")[1])));

  // 1) Data explícita (dd/mm)
  const m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})\b/);
  if (m) {
    const dd = Number(m[1]), mm = Number(m[2]);
    if (dd >= 1 && dd <= 31 && validMonths.has(mm)) {
      const key = makeDateKey(dd, mm);
      if (FIXED_SCHEDULE[key]) return key;
    }
  }

  // 2) Nome do dia → retorna a data MAIS PRÓXIMA futura com esse dia
  const low = norm(t);
  const now = new Date();
  let bestKey = null;
  let bestDiff = Infinity;

  for (const [key, val] of Object.entries(FIXED_SCHEDULE)) {
    const dayNorm = norm(val.dayName);
    const abbrev = dayNorm.replace("-feira", "").replace("á", "a"); // "sábado" → "sabado"
    if (low.includes(dayNorm) || low.includes(abbrev)) {
      const dt = parseDateKeyToDate(key);
      const diff = dt.getTime() - now.getTime();
      if (diff >= -86400000 && diff < bestDiff) {
        bestDiff = diff;
        bestKey = key;
      }
    }
  }
  return bestKey;
}

// V24.3: Extrai filtro de período do texto (ex: "depois das 18h" → 18)
function extractPeriodFilter(text) {
  const low = norm(text);
  const m = low.match(/(?:depois|apos|após|a partir)\s+(?:d[ao]s?\s+)?(\d{1,2})\s*h/);
  if (m) return Number(m[1]);
  if (/\b(noite|a noite)\b/.test(low)) return 18;
  if (/\b(fim da tarde)\b/.test(low)) return 16;
  if (/\b(tarde|a tarde)\b/.test(low)) return 14;
  if (/\b(manha|manhã)\b/.test(low)) return 6;
  return null;
}

function extractHourOnly(text) {
  const low = norm(text);
  const m = low.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);
  if (m) {
    const hh = Number(m[1]), mm = Number(m[2]);
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
  if (/\b1\b/.test(t) && !/\b2\b/.test(t) && !/\b3\b/.test(t)) return "full";
  if (/\b2\b/.test(t) && !/\b1\b/.test(t) && !/\b3\b/.test(t)) return "basic";
  if (/\b3\b/.test(t) && !/\b1\b/.test(t) && !/\b2\b/.test(t)) return "retorno";
  if (/(acompanhamento|com retorno|retorno em 30|retorno incluso|primeira opcao|primeira opção|opcao 1|opção 1)/.test(t)) return "full";
  if (/(avaliacao|avaliação|so a consulta|só a consulta|consulta inicial|segunda opcao|segunda opção|opcao 2|opção 2)/.test(t)) return "basic";
  if (/(retorno avulso|consulta de ajuste|ajuste|terceira opcao|terceira opção|opcao 3|opção 3|apenas retorno)/.test(t)) return "retorno";
  if (/(prefiro a avaliacao|prefiro a avaliação|quero a avaliacao|quero a avaliação|so a avaliacao|só a avaliação|comecar com a avaliacao|começar com a avaliação)/.test(t)) return "basic";
  if (/(quero o acompanhamento|prefiro o acompanhamento|quero o pacote|pacote completo)/.test(t)) return "full";
  return null;
}

/* ═══════════════════════════════════════════════════════════════════
   CONDITION DETECTION (preservado)
   ═══════════════════════════════════════════════════════════════════ */

function detectCondition(text) {
  const t = norm(text);
  if (t.includes("fibromialgia")) return "fibromialgia";
  if (t.includes("dor neuropatica") || t.includes("dor neuropática") || t.includes("neuropat")) return "dor_neuropatica";
  if (t.includes("artrose")) return "artrose";
  if (t.includes("artrite")) return "artrite";
  if (t.includes("lombar") || t.includes("coluna") || t.includes("costas")) return "dor_lombar";
  if (t.includes("insônia") || t.includes("insonia") || t.includes("dormir") || /\bsono\b/.test(t)) return "insonia";
  if (t.includes("ansiedade") || t.includes("panico") || t.includes("pânico")) return "ansiedade";
  if (t.includes("enxaqueca")) return "enxaqueca";
  if (t.includes("ombro")) return "dor_cronica";
  if (t.includes("dor")) return "dor_cronica";
  return null;
}

function extractProblemText(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const low = norm(t);
  if (/(dor|fibromialgia|insônia|insonia|sono|ansiedade|panico|pânico|artrose|artrite|enxaqueca|coluna|lombar|neuropat|ombro)/.test(low)) return t;
  const m = t.match(/(?:quero tratar|tratar|meu problema e|meu problema é|tenho|sofro com|incomoda)\s+(.+)$/i);
  if (m?.[1]) return m[1].trim();
  return null;
}

/* ═══════════════════════════════════════════════════════════════════
   INTENT DETECTION (preservado da V23)
   ═══════════════════════════════════════════════════════════════════ */

function detectIntent(text) {
  const t = norm(text);

  return {
    wantsPrice:       /\b(preco|preço|valor|quanto custa|investimento|custa|valores|quanto e|quanto é)\b/.test(t),
    intentPay:        /\b(como (pagar|fa[cç]o para pagar)|pagamento|pix|cartao|cartão|credito|crédito|debito|débito|boleto|link|parcel|parcela|quero pagar|posso pagar|manda o link|me manda o link)\b/.test(t)
                      && !/\b(nao tenho condicao de pagar|não tenho condição de pagar|nao consigo pagar|não consigo pagar|caro demais para pagar|muito caro para pagar)\b/.test(t),
    wantsBook:        /\b(quero marcar|quero agendar|vou marcar|vou agendar|queria marcar|queria agendar|gostaria de (marcar|agendar)|posso (marcar|agendar)|preciso (marcar|agendar)|bora (marcar|agendar)|confirmar consulta|quero consulta|quero uma vaga|me agenda|tem horario|tem horário)\b/.test(t),
    asksHours:        /\b(horarios|horário|horario|que horas|vagas|disponibilidade)\b/.test(t),
    confirms:         /\b(sim|ok|beleza|confirmo|fechado|vamos|pode ser|confirmar|bora|vamos la|vamos lá|com certeza|claro que sim)\b/.test(t),
    refuses:          /\b(nao quero|não quero|pare|para|chega|desisto|cancela)\b/.test(t),
    asksHowConsultWorks: /\b(como funciona|como e a consulta|como é a consulta|o que acontece na consulta)\b/.test(t),
    asksIfOnline:     /\b(e online|é online|online mesmo|presencial|precisa ir|tem que ir|por video|por vídeo)\b/.test(t),
    asksLegal:        /\b(legal no brasil|e legal|é legal|precisa de receita|receita|anvisa|legalizado|regularizado)\b/.test(t),
    asksChapado:      /\b(chapado|chapar|maconha mesmo|isso e maconha|isso é maconha|droga|fico alterado|fico alterada|ficar alterado|ficar alterada|meio alterado|meio alterada)\b/.test(t),
    asksWho:          /\b(quem e|quem eh|quem é|quem e o dr|quem é o dr|quem e o doutor|quem é o doutor)\b/.test(t),
    asksIfWorks:      /\b(funciona|vale a pena|ajuda mesmo|ajuda pra|ajuda para|costuma ajudar|costuma funcionar|costuma melhorar|realmente ajuda|realmente funciona|melhora mesmo|tem resultado|faz efeito|faz diferenca|faz diferença|resolve mesmo|e eficaz|é eficaz|tem eficacia|tem eficácia|da resultado|dá resultado|funciona mesmo|funciona de verdade)\b/.test(t),
    asksIfForMe:      /\b(serve pra mim|serve para mim|é só para|e so para|é pra caso grave|serve pra quem|funciona pra quem|ajuda quem tem|ajudar quem tem|precisa ter diagnostico|precisa ter diagnóstico|mesmo sem diagnostico|mesmo sem diagnóstico|no meu caso|meu caso|casos como o meu|como o meu|indicado pra|indicado para|pra quem tem)\b/.test(t),
    asksDifferential: /\b(diferença|diferenca|diferencial|por que o dr|por que o doutor|o que muda|o que diferencia|comparando)\b/.test(t),
    asksWhatIncludes: /\b(inclui o que|o que inclui|o que ta incluido|o que tá incluído|o que vem|o que tem dentro|explica o plano|explica a opcao|explica a opção)\b/.test(t),
    asksMedCost:      /\b(medicamento.*cust|remedio.*cust|remedío.*cust|caro.*depois|custo.*mensal|quanto.*mes|quanto.*mês|gast.*por mes|gast.*por mês|tratamento.*cust|oleo.*car|óleo.*car|oleo.*cust|óleo.*cust|frasco.*cust|frasco.*car|gota.*cust|gota.*car|quanto.*oleo|quanto.*óleo|quanto.*frasco|8.?000|oito mil|tratamento.*caro|caro.*tratamento|custo.*tratamento|tratamento.*depois|depois.*consulta.*quanto|depois.*consulta.*cust|manter.*tratamento|cabe.*orcamento|cabe.*orçamento|quanto.*fica.*por mes|quanto.*fica.*por mês|costuma.*ficar|normalmente.*fica|faixa.*gast|faixa.*cust)\b/.test(t),
    asksRecipe:       /\b(saio com receita|recebo receita|ja sai com|já sai com|prescrição|prescricao)\b/.test(t),
    asksCanReschedule:/\b(remarcar|reagendar|trocar.*horario|trocar.*horário|mudar.*data|cancelar.*consulta)\b/.test(t),
    asksPrivacy:      /\b(sigilo|sigiloso|ninguem fica sabendo|ninguém fica sabendo|privacidade|discreto)\b/.test(t),
    asksStartNow:     /\b(como tomar|dose|dosagem|quantas gotas|comecar agora|começar agora|comprar.*remedío|comprar.*remedio)\b/.test(t),
    asksIsScam:       /\b(golpe|fraude|piramide|pirâmide|e serio|é sério|confiavel|confiável|consulta.*mesmo|e verdade isso|é verdade isso|isso e verdade|isso é verdade)\b/.test(t),
    asksPayMethod:    /\b(parcela|parcelar|forma.*pagamento|aceita.*pix|aceita.*cartao|aceita.*cartão)\b/.test(t),
    saysExpensive:    /\b(caro|caríssim|carissim|achei caro|muito caro|pesado|puxado)\b/.test(t),
    saysWillSee:      /\b(vou ver|depois te falo|vou confirmar|vou pensar|te aviso|depois vejo|preciso pensar|aguarde|aguarda|me da um tempo|me dá um tempo|deixa eu pensar|espera eu|nao reserva ainda|não reserva ainda|nao marca ainda|não marca ainda)\b/.test(t),
    saysUnsure:       /\b(nao tenho certeza|não tenho certeza|nao sei|não sei|sera|será|to na duvida|tô na dúvida|duvida|dúvida)\b/.test(t),
    saysCheaperElsewhere: /\b(mais barato|medico.*barato|médico.*barato|outro.*medico|outro.*médico|pesquisando)\b/.test(t),
    saysCheckSpouse:  /\b(minha?\s+(esposa|marido|mulher)|falar com\s+(esposa|marido|mulher)|vou ver com\s+(esposa|marido|mulher|familia|família)|conversar\s+(com\s+)?(esposa|marido|mulher|familia|família)\s+antes|combinar\s+com)\b/.test(t),
    saysIndecisive:   /\b(tanto faz|qual voce acha|qual você acha|nao sei qual|não sei qual|me indica|me recomenda)\b/.test(t),
    urgency:          /\b(dor no peito|falta de ar|desmaio|avc|convuls|paralisia|confusao|confusão)\b/.test(t),
    strongPain:       /\b(nao aguento|não aguento|to sofrendo|tô sofrendo|muito ruim|muito dificil|muito difícil|desespero|nao consigo mais|não consigo mais|ajuda|socorro)\b/.test(t),
    focus: detectCondition(text),
    // V24.5: Encerramento educado (mensagem curta sem intent de compra)
    endsConversation: (() => {
      if (/\b(obrigad[oa]|brigad[oa]|valeu|boa noite|bom dia|boa tarde|ate mais|até mais|ate logo|até logo|tchau|falou|fui)\b/.test(t)) {
        const words = text.trim().split(/\s+/).length;
        if (words <= 10 && !/\b(marcar|agendar|horario|horário|consulta|pagar|link|valor|preco|preço|quero|preciso)\b/.test(t)) return true;
      }
      return false;
    })(),
    // V24.5: Risco emocional grave → suspender funil
    emotionalRisk: /\b(suicid|me matar|quero morrer|nao quero mais viver|não quero mais viver|vontade de morrer|acabar com tudo|pensamento de morte|tirar minha vida|nao aguento mais viver|não aguento mais viver|me machucar|me cortar)\b/.test(t),
    // V24.5: Sofrimento emocional (sem risco imediato) → cautela
    emotionalDistress: /\b(problema mental|saude mental|saúde mental|depressao|depressão|tristeza profunda|dificuldade de viver|sofrimento|nao vejo saida|não vejo saída|vontade de desistir)\b/.test(t),
    // V24.4: Detecta menção a dia específico com intenção de disponibilidade
    mentionsDayAvail: (() => {
      const lt = norm(text);
      const hasDay = /\b(segunda|terca|terça|quarta|quinta|sexta|sabado|sábado)\b/.test(lt)
                  || /\b\d{1,2}[\/.-]\d{1,2}\b/.test(text);
      if (!hasDay) return false;
      if (/\b(tem|pode|disponivel|disponível|vaga|livre|aberto|horario|horário|horas)\b/.test(lt)) return true;
      if (text.trim().length < 30 && text.includes("?")) return true;
      return false;
    })(),
  };
}

/* ═══════════════════════════════════════════════════════════════════
   LEAD CLASSIFIER (preservado)
   ═══════════════════════════════════════════════════════════════════ */

function classifyLead(flags, text, state) {
  const t = norm(text);
  if (flags.strongPain) return "emocional";
  if (flags.asksIsScam || /\b(golpe|fraude|serio|sério)\b/.test(t)) return "desconfiado";
  if (flags.wantsBook || flags.asksHours) return "quente";
  if (flags.wantsPrice && !state.problem_text) return "pragmatico";
  if (flags.asksDifferential || flags.saysCheaperElsewhere || /\b(pesquisando|comparando)\b/.test(t)) return "comparador";
  if (flags.asksIfForMe || /\b(serve pra mim|caso grave|sem diagnostico|sem diagnóstico)\b/.test(t)) return "frio";
  if (flags.asksIfWorks && /\b(promessa|tentei tudo|nada funciona|cansado)\b/.test(t)) return "cetico";
  if (flags.asksIfWorks) return "cetico";
  return state.lead_profile || "padrao";
}

/* ═══════════════════════════════════════════════════════════════════
   SLOT MANAGEMENT (preservado)
   ═══════════════════════════════════════════════════════════════════ */

function getGenericSlotsForDate(dateKey) {
  return FIXED_SCHEDULE[dateKey] ? [...FIXED_SCHEDULE[dateKey].slots] : [];
}
function getBaseSlotsForDate(dateKey) { return getGenericSlotsForDate(dateKey); }
function sortSlotsSmart(slots, dateKey) {
  const unique = removeDuplicates(slots);
  const priority = dateKey ? getSlotPriority(dateKey) : PREMIUM_SLOT_PRIORITY;
  const prioritized = [];
  for (const p of priority) if (unique.includes(p)) prioritized.push(p);
  for (const s of unique) if (!prioritized.includes(s)) prioritized.push(s);
  return prioritized;
}

async function cleanupExpiredLocks() {
  await pool.query(`DELETE FROM wa_slot_locks WHERE status='held' AND expires_at IS NOT NULL AND expires_at < NOW()`);
}

async function getBlockedSlotKeysForDate(dateKey) {
  await cleanupExpiredLocks();
  const { rows } = await pool.query(
    `SELECT slot_key FROM wa_slot_locks WHERE slot_key LIKE $1 AND (status='paid' OR (status='held' AND expires_at > NOW()))`,
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
  return sortSlotsSmart(available, dateKey).slice(0, max);
}

// V24.4: Encontra o dia disponível mais próximo de uma data-alvo
async function findNearestAvailableDay(targetDateKey) {
  const targetDate = parseDateKeyToDate(targetDateKey);
  const now = new Date(Date.now() - 86400000); // permite hoje
  const allKeys = Object.keys(FIXED_SCHEDULE);
  let bestKey = null;
  let bestDiff = Infinity;
  for (const k of allKeys) {
    const dt = parseDateKeyToDate(k);
    if (dt < now) continue;
    if (k === targetDateKey) continue;
    const slots = await getAvailableSlotsForDate(k);
    if (!slots.length) continue;
    const diff = Math.abs(dt.getTime() - targetDate.getTime());
    if (diff < bestDiff) { bestDiff = diff; bestKey = k; }
  }
  return bestKey;
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
    `UPDATE wa_slot_locks SET phone=$2, status='held', expires_at = NOW() + ($3 || ' minutes')::interval, updated_at = NOW(), paid_at = NULL WHERE slot_key=$1`,
    [key, phone, String(minutes)]
  );
  return { ok: true, slot_key: key };
}

async function markSlotPaid(key, phone) {
  if (!key) return;
  await pool.query(
    `UPDATE wa_slot_locks SET status='paid', expires_at = NULL, paid_at = NOW(), updated_at = NOW() WHERE slot_key=$1 AND phone=$2`,
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

/* ═══════════════════════════════════════════════════════════════════
   EVIDENCE DATABASE — V24 EXPANDIDA COM DIRECT_ANSWER
   ═══════════════════════════════════════════════════════════════════ */

const EVIDENCE_DB = {
  fibromialgia: {
    direct_answer: "Sim, para muitos pacientes funciona. Em estudos clínicos, houve redução de até 60% na dor. Aqui no consultório, a maioria relata melhora real no sono e na dor nas primeiras semanas.",
    empathy: [
      "Fibromialgia desgasta o corpo e a mente. Quem tem sabe que não é só dor — é exaustão, sono ruim, o corpo nunca descansa.",
      "Fibromialgia é muito mais do que dor. É acordar cansada, é o corpo pesado, é a sensação de que nada resolve de verdade.",
      "Sei que fibromialgia é daquelas coisas que ninguém entende até passar por isso. Não é frescura, é real.",
    ],
    testimony: [
      "O que eu vejo aqui no dia a dia é que muita gente com fibromialgia que começa o acompanhamento com o Dr. Alef volta no retorno relatando que a dor diminuiu bastante e que conseguiu dormir melhor pela primeira vez em anos.",
      "Acompanho esse consultório todos os dias, e o que eu posso te dizer é que muita gente que chega com esse mesmo quadro percebe melhora real depois de algumas semanas.",
      "Já vi muitos pacientes com fibromialgia chegarem aqui sem esperança e voltarem no retorno dizendo que conseguiram dormir a noite inteira e que a dor ficou suportável.",
    ],
    study: "Estudos clínicos mostram redução de até *60% na intensidade da dor* em pacientes com fibromialgia.",
    hope: "Não prometo nada porque cada caso é diferente, mas posso te dizer que existe um caminho real para quem está nessa situação.",
    bridge: "A avaliação serve justamente para entender se esse caminho faz sentido para você.",
    future: [
      "Imagina voltar a dormir a noite inteira e acordar com menos dor. Muita gente aqui conseguiu isso.",
      "Muita gente me diz que quando a dor diminui e o sono melhora, parece que a vida volta.",
      "Tem paciente que me conta que voltou a fazer coisas que tinha desistido. Isso é o que me motiva.",
    ],
  },
  dor_cronica: {
    direct_answer: "Sim, estudos mostram melhora de 40-50% na dor em muitos pacientes. Aqui no consultório, vemos resultado real, especialmente em quem já tentou outros caminhos sem sucesso.",
    empathy: [
      "Dor que dura anos e resiste a tudo é muito desgastante. Mexe com sono, humor, trabalho, tudo.",
      "Viver com dor constante desgasta muito. A pessoa vai perdendo qualidade de vida aos poucos.",
    ],
    testimony: [
      "Muita gente que chega aqui com dor crônica, especialmente quem já tentou anti-inflamatório e fisioterapia sem resultado duradouro, volta relatando melhora real tanto na dor quanto na qualidade de vida.",
      "O que eu vejo aqui com frequência é que pacientes que já tinham desistido de melhorar voltam no retorno com outra energia.",
    ],
    study: "Estudos mostram melhora de *40–50% na intensidade da dor* em parte dos pacientes com dor crônica.",
    hope: "Existe um caminho real, mesmo para quem já tentou muita coisa.",
    bridge: "É justamente esse tipo de análise que o Dr. Alef faz na consulta.",
    future: [
      "Muita gente me diz que a primeira semana que conseguiu trabalhar sem parar por causa da dor foi transformadora.",
      "Quando a dor diminui e a pessoa consegue voltar a fazer as coisas do dia a dia, muda tudo.",
    ],
  },
  dor_lombar: {
    direct_answer: "Sim, estudos mostram melhora de 40-50% nos sintomas de dor lombar crônica. Aqui vemos isso na prática com frequência.",
    empathy: [
      "Dor lombar constante atrapalha tudo — trabalho, sono, até ficar sentado fica difícil.",
      "Quando a coluna dói todos os dias, isso vai desgastando bastante a qualidade de vida.",
    ],
    testimony: [
      "Aqui no consultório, muita gente com dor lombar que já tentou anti-inflamatório e fisioterapia sem resultado duradouro percebe melhora real depois de algumas semanas acompanhando com o Dr. Alef.",
      "O que eu vejo com frequência é que pacientes com dor na coluna voltam no retorno dizendo que conseguiram voltar a fazer coisas que tinham desistido.",
    ],
    study: "Estudos mostram melhora de *40–50%* nos sintomas de dor lombar crônica em parte dos pacientes.",
    hope: "Para quem convive com dor na coluna há anos, existe uma possibilidade real de melhora.",
    bridge: "Quem vai avaliar isso com profundidade no seu caso é o Dr. Alef.",
    future: ["Poder sentar, dirigir, trabalhar sem aquela dor travando tudo — muita gente aqui conseguiu."],
  },
  dor_neuropatica: {
    direct_answer: "Sim, estudos mostram melhora de 30-50% em pacientes com dor neuropática, principalmente na intensidade das crises.",
    empathy: ["Dor neuropática é uma das dores mais difíceis de tratar. Queimação, choque, formigamento — incomoda demais."],
    testimony: ["Pacientes com dor neuropática que acompanham aqui costumam relatar melhora significativa, principalmente na intensidade das crises."],
    study: "Estudos mostram melhora de *30–50%* em parte dos pacientes com dor neuropática.",
    hope: "Dor neuropática é difícil, mas não é sem saída.",
    bridge: "O Dr. Alef avalia com cuidado o tipo de dor e o que faz sentido no seu caso.",
    future: ["Muita gente relata que as crises ficam mais espaçadas e bem menos intensas."],
  },
  ansiedade: {
    direct_answer: "Sim, a cannabis medicinal tem sido usada para ansiedade com resultados positivos em muitos pacientes. O sono costuma melhorar primeiro, e a ansiedade vai diminuindo junto.",
    empathy: [
      "Ansiedade constante desgasta demais. Mente acelerada, corpo tenso, sono ruim — fica difícil funcionar.",
      "Quando a ansiedade domina o dia, tudo fica mais pesado. Até relaxar vira um desafio.",
    ],
    testimony: [
      "O que eu vejo aqui é que muita gente com ansiedade que começa o acompanhamento percebe melhora significativa, principalmente no sono e naquela sensação de aceleração mental.",
      "Muita gente que chega aqui com ansiedade volta dizendo que conseguiu dormir melhor e que a mente desacelerou.",
    ],
    study: "Estudos mostram redução significativa dos sintomas de ansiedade em muitos pacientes.",
    hope: "Existe um caminho para quem está nessa situação, com segurança e acompanhamento.",
    bridge: "A consulta serve para entender se isso faz sentido no seu caso específico.",
    future: ["Muita gente me diz que a sensação de conseguir relaxar de verdade pela primeira vez é indescritível."],
  },
  insonia: {
    direct_answer: "Sim, o sono é uma das primeiras coisas que melhoram. Muita gente volta dizendo que está dormindo a noite inteira pela primeira vez em meses.",
    empathy: [
      "Dormir mal afeta absolutamente tudo — energia, humor, concentração, saúde.",
      "Quando a pessoa dorme mal por muito tempo, isso vai consumindo a vida aos poucos.",
    ],
    testimony: [
      "O que eu acompanho aqui é que o sono costuma ser uma das primeiras coisas que melhoram. Muita gente volta dizendo que está dormindo a noite inteira pela primeira vez em muito tempo.",
    ],
    study: "O sono é um dos principais motivos de procura por cannabis medicinal, e estudos mostram melhora significativa da qualidade do sono.",
    hope: "Dormir bem muda tudo. E é possível.",
    bridge: "O Dr. Alef avalia seu padrão de sono e entende se esse tratamento faz sentido para você.",
    future: ["Imagina deitar e dormir tranquilo, sem acordar várias vezes. Muita gente aqui conseguiu."],
  },
  artrose: {
    direct_answer: "Sim, estudos indicam redução de dor e melhora funcional de 30-50% em pacientes com artrose.",
    empathy: ["Artrose limita movimento, causa dor constante e atrapalha até as tarefas mais simples."],
    testimony: ["Muita gente com artrose que chega aqui, especialmente quem já fez infiltração sem resultado duradouro, volta relatando que conseguiu voltar a se movimentar com menos dor."],
    study: "Estudos indicam redução de dor e melhora funcional na faixa de *30–50%* em parte dos pacientes.",
    hope: "Para quem está limitado pela artrose, existe uma possibilidade real de melhora.",
    bridge: "A avaliação leva em conta seu histórico e a articulação afetada para definir o melhor caminho.",
    future: ["Poder caminhar sem aquela dor constante — muita gente aqui conseguiu isso."],
  },
  artrite: {
    direct_answer: "Sim, pacientes com artrite que acompanham aqui costumam relatar melhora na dor articular e na rigidez.",
    empathy: ["Artrite causa dor, rigidez e inflamação que atrapalham bastante o dia a dia."],
    testimony: ["Pacientes com artrite que acompanham aqui costumam relatar melhora na dor articular e na rigidez."],
    study: "Estudos mostram melhora de dor e inflamação em parte dos pacientes com artrite.",
    hope: "Existe caminho para aliviar esses sintomas com segurança.",
    bridge: "Isso precisa ser avaliado considerando suas medicações e histórico.",
    future: ["Menos dor e mais liberdade de movimento — é o que muita gente relata."],
  },
  enxaqueca: {
    direct_answer: "Sim, estudos indicam redução da frequência e intensidade das crises em pacientes com enxaqueca.",
    empathy: ["Enxaqueca pode ser extremamente incapacitante. Uma crise pode parar o dia inteiro."],
    testimony: ["Muita gente com enxaqueca que acompanha aqui relata que as crises ficaram menos frequentes e menos intensas."],
    study: "Estudos indicam redução da frequência e intensidade das crises em parte dos pacientes.",
    hope: "Ter menos crises e crises mais leves — isso é possível.",
    bridge: "A avaliação analisa frequência, gatilhos e histórico para definir a melhor abordagem.",
    future: ["Ter semanas sem crise, e quando vem, ser mais leve — muita gente aqui relata isso."],
  },
};

/* ═══════════════════════════════════════════════════════════════════
   KNOWLEDGE BASE — V24 NOVO
   ═══════════════════════════════════════════════════════════════════ */

const KNOWLEDGE_BASE = `
FATOS SOBRE A CONSULTA:
- A consulta é 100% online, por videochamada
- Dura em média 45 minutos
- É individualizada para cada caso
- O Dr. Alef avalia histórico, sintomas, remédios em uso e objetivo com o tratamento
- Na primeira consulta ele já consegue avaliar se o tratamento faz sentido e orientar próximos passos
- Se houver indicação, ele já faz a prescrição na própria consulta

FATOS SOBRE O DR. ALEF KOTULA:
- Formado em medicina em uma das melhores faculdades da Rússia
- Viveu seis anos na Europa
- Pós-graduação internacional em cannabis medicinal
- Médico com formação sólida e preparo específico para esse tipo de tratamento

FATOS SOBRE O TRATAMENTO:
- Cannabis medicinal é legal no Brasil quando existe avaliação e prescrição médica (normas da Anvisa)
- Funciona como tratamento médico: avaliação clínica, prescrição quando indicada, dose definida, acompanhamento
- O CBD não tem perfil de dependência como opioides ou benzodiazepínicos
- Formulações medicinais são diferentes de uso recreativo — dose controlada, acompanhamento médico
- O tratamento costuma começar de forma gradual, com doses ajustadas com cuidado
- A duração varia: alguns usam por meses, outros mantêm mais tempo. Decidido na consulta
- Efeito pode aparecer já nas primeiras semanas, mas varia por pessoa
- Quando o foco é CBD, preserva lucidez e rotina (não deixa "alterado")

FATOS SOBRE ACESSO:
- Se houver indicação, o Dr. Alef faz a prescrição e orienta o caminho de acesso
- Pode ser por farmácia no Brasil ou importação regularizada
- O paciente não precisa descobrir isso sozinho

FATOS SOBRE PAGAMENTO:
- Opção 1: Acompanhamento (consulta + retorno ~30 dias) — R$447 (87% escolhem)
- Opção 2: Avaliação inicial (45 min) — R$347
- Opção 3: Retorno avulso — R$200
- Aceita cartão, Pix e boleto
- A consulta é particular (não cobre plano, mas pode ter reembolso dependendo do convênio)
- Pode remarcar com antecedência

SIGILO: Total sigilo médico. Consulta individual por telemedicina.

FATOS SOBRE CUSTO DO MEDICAMENTO:
- O frasco de óleo medicinal custa em média entre R$150 e R$250 e dura de 2 a 3 meses (alguns pacientes usam por até 6 meses)
- A duração depende da dose prescrita (quantas gotas por dia) — isso é definido na consulta
- A medicina canábica evoluiu muito nos últimos anos. Hoje existem produtos fabricados no Brasil
- Antigamente era mais caro porque dependia de importação. Recentemente os preços caíram bastante
- NÃO é verdade que custa R$8.000 ou valores absurdos — isso era realidade de anos atrás com importação
- O custo mensal real fica acessível para a maioria dos pacientes
`;

/* ═══════════════════════════════════════════════════════════════════
   AGGRESSIVE PROFILE GUIDES — V24 NOVO
   ═══════════════════════════════════════════════════════════════════ */

const PROFILE_GUIDES = {
  cetico: `PERFIL DO PACIENTE: Cético. Quer dados, não entusiasmo.
COMO RESPONDER: Use dados de estudos. Evite "muita gente relata". Seja direto e técnico. Cite porcentagens. Não force agenda. Mostre que você entende a desconfiança.`,

  desconfiado: `PERFIL DO PACIENTE: Desconfiado de charlatanismo.
COMO RESPONDER: Mostre credenciais concretas do Dr. Alef (formação na Rússia, 6 anos na Europa, pós em cannabis). Seja transparente sobre limitações. Não pressione. Diga que se não houver indicação, isso também fica claro.`,

  comparador: `PERFIL DO PACIENTE: Comparando opções.
COMO RESPONDER: Fale do diferencial da consulta (45 min, individualizada, revisa medicações e interações). Não critique outros médicos. Compare com abordagens genéricas, não com pessoas.`,

  pragmatico: `PERFIL DO PACIENTE: Prático e objetivo. Quer saber preço e resultado.
COMO RESPONDER: Seja direto. Não enrole. Fale de valor, não de sentimento. Compare custo com medicação mensal que já gasta. Responda perguntas objetivas primeiro.`,

  emocional: `PERFIL DO PACIENTE: Sofrendo muito, precisa de acolhimento.
COMO RESPONDER: Intensifique acolhimento e esperança. Mostre que entende a dor. Use tom mais caloroso. Não seja frio nem técnico demais. Valide o sofrimento antes de conduzir.`,

  frio: `PERFIL DO PACIENTE: Frio, explorando sem urgência.
COMO RESPONDER: Não force. Deixe explorar. Responda perguntas sem pressão. CTA suave. Construa confiança aos poucos.`,

  quente: `PERFIL DO PACIENTE: Quer marcar consulta.
COMO RESPONDER: Facilite o caminho. Seja rápido e eficiente. Não faça perguntas desnecessárias. Conduza direto ao agendamento.`,

  padrao: "",
};

/* ═══════════════════════════════════════════════════════════════════
   NAME USAGE HELPER
   ═══════════════════════════════════════════════════════════════════ */

function maybeUseName(state) {
  const nome = state?.nome;
  if (!nome) return "";
  const used = Number(state?.name_used_count || 0);
  if (used < 3 || used % 5 === 0) return nome;
  return "";
}

/* ═══════════════════════════════════════════════════════════════════
   REPLY TEMPLATES — V24 (preservadas para stages estruturais)
   ═══════════════════════════════════════════════════════════════════ */

// V24.3: Resposta factual sobre custo de medicamento/óleo (centralizada)
function medCostReply(state) {
  const nome = state?.nome ? `, ${state.nome}` : "";
  return `Boa pergunta${nome} 😊\n\nO frasco do óleo medicinal custa em média entre R$150 e R$250, e dura de 2 a 3 meses — alguns pacientes usam por até 6 meses.\n\nDepende de quantas gotas o Dr. Alef vai prescrever para você e de quantas vezes por dia. Isso é avaliado na consulta.\n\nA medicina canábica evoluiu muito. Hoje temos produtos fabricados no Brasil, e os preços caíram bastante em comparação com anos atrás.`;
}

// V24.3: Detecta se a mensagem é sobre custo de medicamento (não consulta)
function isMedCostQuestion(flags, text) {
  if (flags.asksMedCost) return true;
  if (flags.saysExpensive && /(oleo|óleo|frasco|gota|medicamento|remedio|remédio|depois|mensal|tratamento|por mes|por mês)/i.test(text)) return true;
  return false;
}

function askNameIntroReply() {
  return "Oi 😊\nEu sou a Lia, da equipe do Dr. Alef Kotula. Muito prazer.\n\nQual é o seu *primeiro nome*?";
}

function askProblemReply(state) {
  const nome = maybeUseName(state);
  const variations = [
    `${nome ? `Prazer, ${nome} 😊\n\n` : ""}Me conta: o que tem te incomodado mais ultimamente?`,
    `${nome ? `Prazer, ${nome} 😊\n\n` : ""}Me conta um pouquinho: qual a sua principal queixa hoje?`,
    `${nome ? `Prazer, ${nome} 😊\n\n` : ""}Para eu te direcionar melhor, me diz: o que tem te incomodado mais?`,
  ];
  return pickRandom(variations);
}

function diagQ_tempo(state) {
  const nome = maybeUseName(state);
  return `${nome ? `${nome}, ` : ""}há quanto tempo isso acontece com você?`;
}

function diagQ_impacto(state) {
  const cond = state.condition || state.focus || "";
  if (cond === "fibromialgia") return "E hoje o que pesa mais: a dor, o cansaço, o sono ou tudo junto?";
  if (cond === "insonia") return "Você tem mais dificuldade para pegar no sono ou acorda várias vezes?";
  if (cond === "ansiedade") return "No seu caso pesa mais a mente acelerada, o corpo tenso ou o sono ruim?";
  if (cond === "artrose") return "Onde incomoda mais: joelho, quadril, mãos ou outra articulação?";
  if (cond === "artrite") return "Hoje o que mais incomoda é a dor, a rigidez ou o inchaço?";
  if (cond === "dor_neuropatica") return "A dor é mais como queimação, choque, formigamento ou dor contínua?";
  return "E o que mais te incomoda nisso no dia a dia?";
}

function diagQ_tratamento() {
  return "Você já tentou algum tratamento ou medicação para isso antes?";
}

async function askDayReply() {
  const dayKeys = await getSuggestedDayKeys();
  if (!dayKeys.length) return "No momento os horários desta semana já estão completos. Quer que eu te coloque na lista de prioridade? 😊";
  const opts = dayKeys.map((d) => `*${formatDatePt(d)}*`).join("\n");
  return `Essa semana ainda tenho horários disponíveis:\n\n${opts}\n\nQual fica melhor para você?`;
}

// V24.3: Param opcional periodMin para filtrar slots por período
async function offerSlotsReply(state, periodMin = null) {
  const dateKey = state.date_key;
  let best;
  if (periodMin) {
    const allAvail = await getAvailableSlotsForDate(dateKey);
    const filtered = allAvail.filter(s => {
      const h = parseInt(s.replace("h", ""));
      return h >= periodMin;
    });
    best = sortSlotsSmart(filtered, dateKey).slice(0, 3);
    if (!best.length) {
      best = await chooseBestSlotsForDate(dateKey, 3);
      if (!best.length) return "Esse dia acabou de ficar sem vagas 😕 Quer que eu te mostre outra data?";
      state.offered_slots = best;
      return `Não tenho horários disponíveis após as ${periodMin}h nesse dia, mas tenho:\n\n${best.map((s, i) => `${i + 1}) *${s}*`).join("\n")}\n\nAlgum funciona para você? 😊`;
    }
  } else {
    best = await chooseBestSlotsForDate(dateKey, 3);
  }
  if (!best.length) return "Esse dia acabou de ficar sem vagas 😕 Quer que eu te mostre outra data?";
  state.offered_slots = best;
  return `Para *${formatDatePt(dateKey)}* tenho:\n\n${best.map((s, i) => `${i + 1}) *${s}*`).join("\n")}\n\nQual fica melhor para você?`;
}

function askFullNameReply(state) {
  return `Perfeito. Vou reservar *${prettySlot(state.date_key, state.slot_time)}* para você 😊\n\nSó preciso de alguns dados rápidos.\n\nQual seu *nome completo*?`;
}

function askBirthdateReply(state) {
  return `Obrigada, ${state.nome_completo.split(" ")[0]}.\nQual sua *data de nascimento*?`;
}

function askEmailReply() {
  return "E qual *e-mail* você prefere para receber as orientações?";
}

function priceReply() {
  return (
    "Hoje trabalhamos com estas opções:\n\n" +
    `1️⃣ *${PLANS.full.label}* (${PLANS.full.subtitle}) — *R$${PLANS.full.price}* *(87% dos pacientes escolhem essa)* ⭐\n` +
    `2️⃣ *${PLANS.basic.label}* (${PLANS.basic.subtitle}) — *R$${PLANS.basic.price}*\n` +
    `3️⃣ *${PLANS.retorno.label}* (${PLANS.retorno.subtitle}) — *R$${PLANS.retorno.price}*\n\n` +
    "Qual faz mais sentido para você? Me responde com *1, 2 ou 3* 😊"
  );
}

function paymentSentReply(plan, link, state) {
  return (
    `Perfeito, pré-reserva feita ✅\n\n` +
    `📅 *${prettySlot(state.date_key, state.slot_time)}*\n\n` +
    `Plano: *${plan.label}* — R$${plan.price}\n\n` +
    `Para confirmar sua consulta, é só finalizar aqui:\n${link}\n\n` +
    `Assim que o pagamento entrar, eu confirmo tudo por aqui 😊\n\n` +
    `Se tiver qualquer dificuldade, me avisa que eu te ajudo.`
  );
}

function pendingPaymentReply(state) {
  return (
    `Seu horário está pré-reservado 😊\n\n` +
    `📅 *${prettySlot(state.date_key, state.slot_time)}*\n\n` +
    `Para confirmar, é só finalizar aqui:\n${state.payment.link}`
  );
}

function afterPaidReply(state) {
  return (
    "Pagamento confirmado ✅\n\n" +
    `Sua consulta está marcada para *${prettySlot(state.date_key, state.slot_time)}*.\n\n` +
    "Mais perto do horário eu envio as orientações 😊\nQualquer dúvida até lá, é só me chamar."
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SIGNAL DETECTION (preservado + melhorado)
   ═══════════════════════════════════════════════════════════════════ */

function isRepairSignal(text) {
  const t = norm(text);
  return /\b(voce nao respondeu|você não respondeu|nao respondeu|não respondeu|acho que estamos nos desencontrando|estamos nos desencontrando|isso parece automatico|isso parece automático|isso esta parecendo automatico|isso está parecendo automático|parece roteiro|eu fiz uma pergunta especifica|eu fiz uma pergunta específica|minha pergunta principal|voce esta desviando|você está desviando|responde isso primeiro|antes de pagar.*responde|pulou minha pergunta|travando um pouco na mesma parte|minha pergunta anterior|pulamos minha pergunta|a gente pulou|acabou pulando|ainda nao consegui|ainda não consegui|desencontrando na conversa)\b/.test(t);
}

function hasQuestion(text) {
  return text.includes("?") || /\b(queria saber|queria entender|quero entender|quero saber|posso tirar|uma duvida|uma dúvida|deixa eu perguntar|antes de|antes disso)\b/.test(norm(text));
}

function isSubstantiveQuestion(text) {
  const t = norm(text);
  return /\b(como funciona|como e a consulta|como é a consulta|o que acontece|o que inclui|qual a diferenca|qual a diferença|diferencial|e online|é online|precisa de receita|receita|saio com receita|e legal|é legal|anvisa|como consigo|como acesso|como compro|proximo passo|próximo passo|o que eu faco|o que eu faço|por que funciona|por que ajuda|causa|porque acontece|o que causa|qual o tratamento|como trata|como tratar|como e o acompanhamento|como é o acompanhamento|quanto tempo demora|quanto tempo leva|tem efeito colateral|efeito colateral|contraindicacao|contraindicação|posso tomar junto|interacao|interação|quem e o doutor|quem é o doutor|quem e o dr|quem é o dr|formacao|formação)\b/.test(t);
}

function extractMainQuestion(text) {
  const sentences = text.split(/[.!?\n]+/).map(s => s.trim()).filter(Boolean);
  const questionSentences = sentences.filter(s => s.includes("?") || /\b(queria saber|queria entender|quero saber|como funciona|funciona|é por|é online|ajuda|serve)\b/i.test(s));
  if (questionSentences.length > 0) return questionSentences[questionSentences.length - 1];
  return sentences[sentences.length - 1] || text;
}

/* ═══════════════════════════════════════════════════════════════════
   CTA INTELIGENTE — V24 NOVO
   ═══════════════════════════════════════════════════════════════════ */

function shouldShowCTA(state, flags, text) {
  // V24.5: NUNCA empurrar CTA quando lead pede tempo, encerra ou tem risco emocional
  if (flags.saysWillSee || flags.endsConversation || flags.saysCheckSpouse || flags.emotionalRisk || flags.emotionalDistress) return false;
  if (flags.wantsBook || flags.asksHours || flags.confirms || flags.intentPay) return true;
  if (hasQuestion(text)) return false;
  if (isSubstantiveQuestion(text)) return false;
  if (isRepairSignal(text)) return false;
  const answered = Number(state.questions_answered_since_last_cta || 0);
  if (answered >= 3) return true;
  if (["ASK_FULLNAME", "ASK_BIRTHDATE", "ASK_EMAIL", "ASK_PLAN", "WAIT_PAYMENT"].includes(state.stage)) return true;
  return false;
}

function getStageCTA(state) {
  const s = state.stage;
  if (s === "ASK_DAY") return "\n\nQual dia fica melhor para você? 😊";
  if (s === "OFFER_SLOTS") return "\n\nQual desses horários funciona melhor? 😊";
  if (s === "ASK_FULLNAME") return "\n\nMe passa seu *nome completo* para eu finalizar a reserva 😊";
  if (s === "ASK_BIRTHDATE") return "\n\nMe manda sua *data de nascimento* para eu prosseguir 😊";
  if (s === "ASK_EMAIL") return "\n\nMe passa seu *e-mail* para eu completar o cadastro 😊";
  if (s === "ASK_PLAN") return "\n\nQual dessas opções faz mais sentido? Me responde com *1, 2 ou 3* 😊";
  if (s === "WAIT_PAYMENT" && state.payment?.link) return `\n\nSeu horário está pré-reservado e o link segue ativo:\n${state.payment.link}`;
  if (["ASK_NAME", "ASK_PROBLEM", "DIAGNOSTIC"].includes(s) || !s) return "";
  return "\n\nSe quiser, eu posso te mostrar os horários disponíveis 😊";
}

function getSmartCTA(state, flags, text) {
  if (shouldShowCTA(state, flags, text)) {
    state.questions_answered_since_last_cta = 0;
    return getStageCTA(state);
  }
  state.questions_answered_since_last_cta = (state.questions_answered_since_last_cta || 0) + 1;
  return "";
}

/* ═══════════════════════════════════════════════════════════════════
   GPT ENGINE — V24 REESCRITO
   ═══════════════════════════════════════════════════════════════════ */

function buildSystemPrompt(state = {}) {
  const profileGuide = PROFILE_GUIDES[state.lead_profile] || PROFILE_GUIDES.padrao;
  const conditionData = state.condition ? EVIDENCE_DB[state.condition] : null;
  const conditionContext = conditionData
    ? `\nDADOS SOBRE A CONDIÇÃO DO PACIENTE (${state.condition}):\n- Resposta direta: ${conditionData.direct_answer}\n- Estudo: ${conditionData.study}\n- Esperança: ${conditionData.hope}`
    : "";

  return `Você é "Lia", secretária pessoal do Dr. Alef Kotula. Você trabalha ao lado dele todos os dias e já viu centenas de pacientes melhorarem.

QUEM VOCÊ É:
Você é humana, acolhedora, profissional, segura e experiente. Você acredita no tratamento porque vê resultado real no consultório todos os dias. Você transmite esperança fundamentada, nunca promessa vazia. Você é atenta e escuta de verdade — quando alguém pergunta algo, você responde EXATAMENTE o que foi perguntado.

═══ REGRAS ABSOLUTAS ═══

1. RESPONDA PRIMEIRO: Sempre responda a pergunta EXATA do paciente ANTES de qualquer condução ou CTA. Se o paciente perguntou "é por vídeo?", responda "Sim, é por videochamada" ANTES de falar qualquer outra coisa.

2. NUNCA REPITA: Se sua resposta anterior já cobriu um ponto, NÃO repita as mesmas palavras. Reformule com informação NOVA, ângulo diferente ou mais profundidade. Se o paciente insistiu na mesma pergunta, é porque sua resposta anterior NÃO foi satisfatória — mude a abordagem.

3. ESCUTE DE VERDADE: Se o paciente disse que você não respondeu, ele tem RAZÃO. Não repita a mesma resposta com "Você tem razão" na frente. Entenda O QUE ele realmente quer saber e responda isso de forma DIFERENTE e MAIS DIRETA.

4. SEM CTA AUTOMÁTICO: NÃO termine toda mensagem com "Se quiser, posso mostrar horários". Só conduza para agenda quando o paciente estiver pronto ou der sinal.

5. MÁXIMO 7 LINHAS: Seja conciso. WhatsApp não é e-mail.

6. VALIDAÇÃO EMOCIONAL: Quando o paciente compartilhar sofrimento (dor crônica, insônia, ansiedade prolongada, anos de tratamento sem resultado), ANTES de explicar o tratamento, valide com UMA frase curta e empática. Ex: "Conviver com isso por tanto tempo realmente pesa no dia a dia." / "Imagino como deve ser desgastante lidar com isso todo dia." Depois responda normalmente.

═══ O QUE VOCÊ PODE ═══
- Dizer "o que eu vejo aqui com frequência é que os pacientes melhoram"
- Transmitir esperança e dados de estudos
- Responder sobre consulta, tratamento, legalidade, acesso, preço
- Perguntar UMA coisa por mensagem

═══ O QUE VOCÊ NÃO PODE ═══
- Inventar preço / enviar links / citar valores em R$
- Prometer cura / garantir resultado
- Diagnosticar / sugerir dose / prescrever
- Fazer mais de 1 pergunta por mensagem
- Investigar sintomas clínicos em profundidade
- Repetir a mesma resposta de mensagens anteriores
- NUNCA diga que a consulta está "confirmada" ou "agendada" — enquanto o pagamento não foi confirmado, use SEMPRE "pré-reserva" ou "pré-reservado". Só use "confirmada" depois do pagamento aprovado.

═══ QUANDO O PACIENTE PEDE TEMPO ═══
Se o paciente disser "vou pensar", "preciso ver", "aguarde", "obrigada" ou equivalente:
- Responda CURTO (1-2 linhas), acolhendo
- NÃO repita opções de plano, agenda ou CTA
- NÃO tente convencer
- Encerre ali, sem forçar continuidade

${KNOWLEDGE_BASE}
${conditionContext}
${profileGuide ? `\n${profileGuide}` : ""}

═══ COMANDOS ESPECIAIS ═══
Se o paciente pedir preço/valor, responda: "PRECISA_PRECO"
Se o paciente pedir pagamento/link, responda: "PRECISA_PAGAR"
Se o paciente pedir horários/agendar, responda: "PRECISA_AGENDAR"
Se urgência médica, responda: "URGENTE"

FORMATO DE RESPOSTA (JSON):
{ "reply": "sua mensagem aqui", "updates": { "nome": "...", "problem_text": "...", "condition": "..." } }
Só inclua campos em "updates" que você conseguiu extrair da mensagem.`;
}

function buildUserPrompt({ incomingText, state, flags, stageCTA = "", isRepair = false }) {
  const history = (state.last_3_exchanges || [])
    .map(e => `Paciente: ${e.patient}\nLia: ${e.lia}`)
    .join("\n---\n");

  let repairContext = "";
  if (isRepair) {
    const lastQuestion = state.last_important_question || state.last_user_message || "";
    repairContext = `\n\n⚠️ ATENÇÃO: O paciente sinalizou que NÃO foi bem respondido. A pergunta original dele era: "${lastQuestion}". Sua resposta anterior foi: "${state.last_bot_reply}". Você DEVE responder de forma COMPLETAMENTE DIFERENTE, com mais profundidade e diretividade. NÃO repita o mesmo conteúdo.`;
  }

  const antiRepeatWarning = state.last_bot_reply
    ? `\n\nSUA ÚLTIMA RESPOSTA FOI: "${state.last_bot_reply.slice(0, 200)}..."\nNÃO repita o mesmo conteúdo. Se a pergunta for similar, mude o ângulo, acrescente informação nova ou seja mais direto.`
    : "";

  return `ESTADO DA CONVERSA:
${JSON.stringify({
  nome: state.nome,
  condition: state.condition,
  problem_text: state.problem_text,
  stage: state.stage,
  date_key: state.date_key,
  slot_time: state.slot_time,
  lead_profile: state.lead_profile || "padrao",
  repair_count: state.repair_count || 0,
})}

${history ? `HISTÓRICO RECENTE:\n${history}\n` : ""}
MENSAGEM DO PACIENTE: ${incomingText}
${stageCTA ? `\nDIREÇÃO SUAVE (use se fizer sentido): ${stageCTA}` : ""}${repairContext}${antiRepeatWarning}`;
}

function violatesNoPriceNoLink(text) {
  if (!text) return false;
  if (/\bhttps?:\/\//i.test(text)) return true;
  if (/R\$\s?\d/i.test(text)) return true;
  if (/\b(200|347|447)\b/.test(text)) return true;
  return false;
}

async function runLia({ incomingText, state, flags, stageCTA = "", isRepair = false }) {
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.6,
    messages: [
      { role: "system", content: buildSystemPrompt(state) },
      { role: "user", content: buildUserPrompt({ incomingText, state, flags, stageCTA, isRepair }) },
    ],
  });

  const content = resp.choices?.[0]?.message?.content?.trim() || "";
  let parsed = null;
  try { parsed = JSON.parse(content); } catch { parsed = null; }

  if (!parsed || typeof parsed !== "object" || !parsed.reply) {
    return { reply: "Me conta mais sobre o que está te incomodando 😊", updates: {} };
  }

  const r = String(parsed.reply || "").trim();
  if (r === "PRECISA_PRECO") return { reply: "__NEED_PRICE__", updates: parsed.updates || {} };
  if (r === "PRECISA_PAGAR") return { reply: "__NEED_PAY__", updates: parsed.updates || {} };
  if (r === "PRECISA_AGENDAR") return { reply: "__NEED_BOOK__", updates: parsed.updates || {} };
  if (r === "URGENTE") return { reply: "__URGENT__", updates: parsed.updates || {} };

  if (violatesNoPriceNoLink(r)) {
    return { reply: "Me conta: qual é a sua principal dúvida agora? 😊", updates: {} };
  }

  parsed.reply = clip(r, 900);
  if (!parsed.updates) parsed.updates = {};
  return parsed;
}

/* ═══════════════════════════════════════════════════════════════════
   ANTI-LOOP SYSTEM — V24 NOVO
   ═══════════════════════════════════════════════════════════════════ */

async function ensureNoRepeat(reply, state, incomingText, flags) {
  if (!reply || !state.last_bot_reply) return reply;

  const isSimilar = similar(reply, state.last_bot_reply) ||
    (state.second_last_bot_reply && similar(reply, state.second_last_bot_reply));

  if (!isSimilar) return reply;

  const ai = await runLia({
    incomingText,
    state,
    flags,
    stageCTA: "",
    isRepair: true,
  });

  if (ai.reply.startsWith("__") || similar(ai.reply, state.last_bot_reply)) {
    const nome = state.nome ? `, ${state.nome}` : "";
    return `Entendo${nome}. Me conta com suas palavras o que ficou sem resposta pra mim tentar de um jeito diferente.`;
  }

  return ai.reply;
}

/* ═══════════════════════════════════════════════════════════════════
   MERCADO PAGO (preservado)
   ═══════════════════════════════════════════════════════════════════ */

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
  return { preference_id: data.id, link: data.init_point || data.sandbox_init_point, plan, external_reference };
}

async function mpGetPayment(paymentId) {
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  if (!r.ok) throw new Error(`MP payment fetch erro: ${r.status}`);
  return await r.json();
}

function mpExtractPhoneFromPayment(payment) {
  const md = payment?.metadata || {};
  return md.phone ? String(md.phone).trim() : null;
}

/* ═══════════════════════════════════════════════════════════════════
   HUMAN DELAY (preservado — só usado no endpoint Twilio)
   ═══════════════════════════════════════════════════════════════════ */

function computeHumanDelay(flags, state) {
  let base = randInt(MIN_DELAY, MAX_DELAY);
  if (flags.wantsBook || flags.asksHours || flags.intentPay) base = randInt(1, 3);
  if (flags.wantsPrice) base = randInt(2, 4);
  if (flags.strongPain || state.lead_profile === "emocional") base = randInt(1, 2);
  const lastAt = Number(state.last_sent_at || 0);
  if (Date.now() - lastAt < 2000) base += 1;
  return Math.max(1, base);
}

async function sendWhatsApp(to, from, body, delaySec) {
  if (!twilioClient) {
    console.log(`📤 [Twilio OFF] Resposta para ${to}: "${(body || "").slice(0, 80)}..."`);
    return;
  }
  await sleep(delaySec * 1000);
  await twilioClient.messages.create({ to, from, body });
}

/* ═══════════════════════════════════════════════════════════════════
   TRIAGEM ADAPTATIVA (preservado)
   ═══════════════════════════════════════════════════════════════════ */

function getNextDiagQuestion(state, text) {
  const has = {
    tempo: !!(state.diag_has_tempo),
    impacto: !!(state.diag_has_impacto),
    tratamento: !!(state.diag_has_tratamento),
  };

  const low = norm(text);
  if (/(ha |há |faz |anos|meses|tempo|começo|comecou|começou)/.test(low)) has.tempo = true;
  if (/(rotina|dia a dia|trabalho|sono|atrapalha|incomoda|impacto|cansaço|cansaco)/.test(low)) has.impacto = true;
  if (/(ja tomei|já tomei|ja tentei|já tentei|remedio|remédio|anti.?inflamat|fisioterapia|medicacao|medicação|pregabalina|duloxetina|amitriptilina|gabapentina|infiltracao|infiltração)/.test(low)) has.tratamento = true;

  state.diag_has_tempo = has.tempo;
  state.diag_has_impacto = has.impacto;
  state.diag_has_tratamento = has.tratamento;

  const asked = Number(state.diagnostic_step || 0);
  if (asked >= 3) return null;
  if (state.lead_profile === "emocional" && asked >= 1) return null;

  if (!has.tempo && asked < 3) { state.diagnostic_step = asked + 1; return diagQ_tempo(state); }
  if (!has.impacto && asked < 3) { state.diagnostic_step = asked + 1; return diagQ_impacto(state); }
  if (!has.tratamento && asked < 3) { state.diagnostic_step = asked + 1; return diagQ_tratamento(); }

  return null;
}

/* ═══════════════════════════════════════════════════════════════════
   BRIDGE REPLY — V24 REESCRITO
   ═══════════════════════════════════════════════════════════════════ */

function bridgeReply(state) {
  const cond = state.condition || detectCondition(state.problem_text || "") || "dor_cronica";
  const ev = EVIDENCE_DB[cond];

  const nome = maybeUseName(state);
  const intro = `Faz todo sentido${nome ? `, ${nome}` : ""}. Muita gente chega aqui com esse mesmo tipo de histórico.`;

  let testimony = "O que eu posso te dizer é que acompanho o consultório do Dr. Alef todos os dias e vejo com frequência pacientes que percebem melhora real.";
  let study = "";
  if (ev) {
    testimony = pickRandom(ev.testimony);
    study = `\n\n${ev.study}`;
    state.evidence_used_count = Number(state.evidence_used_count || 0) + 1;
  }

  let future = "";
  if (state.lead_profile === "emocional" && ev?.future) {
    future = `\n\n${pickRandom(ev.future)}`;
  }

  const consult = "A avaliação é *100% online*, dura em média *45 minutos* e é individualizada para o seu caso.";
  const cta = "Se quiser, eu posso te mostrar os horários disponíveis 😊";

  return `${intro}\n\n${testimony}${study}${future}\n\n${consult}\n\n${cta}`;
}

/* ═══════════════════════════════════════════════════════════════════
   STATE INITIALIZATION — V24
   ═══════════════════════════════════════════════════════════════════ */

function initializeState(state, bot) {
  if (state.stage && /^DIAG_Q[123]$/.test(state.stage)) {
    const qNum = Number(state.stage.replace("DIAG_Q", "")) || 0;
    state.stage = "DIAGNOSTIC";
    state.diagnostic_step = Math.max(Number(state.diagnostic_step || 0), qNum);
  }
  if (state.stage === "AFTER_DIAGNOSTIC") {
    state.stage = "BRIDGE";
  }

  state.last_bot_reply = state.last_bot_reply || "";
  state.second_last_bot_reply = state.second_last_bot_reply || "";
  state.last_user_message = state.last_user_message || "";
  state.last_sent_at = state.last_sent_at || 0;
  state.nome = state.nome || null;
  state.focus = state.focus || null;
  state.condition = state.condition || null;
  state.problem_text = state.problem_text || null;
  state.payment = state.payment || null;
  state.stage = state.stage || null;
  state.selected_plan_key = state.selected_plan_key || null;
  state.name_used_count = Number(state.name_used_count || 0);
  state.evidence_used_count = Number(state.evidence_used_count || 0);
  state.offered_slots = state.offered_slots || [];
  state.date_key = state.date_key || null;
  state.slot_time = state.slot_time || null;
  state.slot_key = state.slot_key || null;
  state.nome_completo = state.nome_completo || null;
  state.birthdate = state.birthdate || null;
  state.email = state.email || null;
  state.price_ask_count = Number(state.price_ask_count || 0);
  state.diagnostic_step = Number(state.diagnostic_step || 0);
  state.diag_has_tempo = !!state.diag_has_tempo;
  state.diag_has_impacto = !!state.diag_has_impacto;
  state.diag_has_tratamento = !!state.diag_has_tratamento;
  state.lead_profile = state.lead_profile || null;
  state.last_important_question = state.last_important_question || null;
  state.last_prepayment_question = state.last_prepayment_question || null;
  state.last_3_exchanges = state.last_3_exchanges || [];
  state.repair_count = Number(state.repair_count || 0);
  state.questions_answered_since_last_cta = Number(state.questions_answered_since_last_cta || 0);
  state.last_bot_from = bot;
  return state;
}

function updateConversationHistory(state, patientMsg, liaReply) {
  const exchanges = state.last_3_exchanges || [];
  exchanges.push({ patient: patientMsg.slice(0, 300), lia: liaReply.slice(0, 300) });
  state.last_3_exchanges = exchanges.slice(-3);
}

/* ═══════════════════════════════════════════════════════════════════
   ███████████████████████████████████████████████████████████████████
   CORE LOGIC — processLiaMessage()
   ███████████████████████████████████████████████████████████████████

   Extraído do handler /whatsapp original.
   Lógica 100% idêntica, só retorna em vez de enviar.
   Usado tanto pelo /whatsapp (Twilio) quanto pelo /lia/respond (n8n).

   ═══════════════════════════════════════════════════════════════════ */

async function processLiaMessage(phone, incomingText) {
  const phoneDigits = String(phone).replace(/\D/g, "");

  // ── Reset universal (qualquer lead) ──
  const RESET_COMMANDS = ["reset", "reiniciar", "recomeçar", "recomecar"];
  if (RESET_COMMANDS.includes(norm(incomingText))) {
    await pool.query(`UPDATE wa_users SET state = '{}'::jsonb, updated_at = NOW() WHERE phone = $1`, [phone]);
    await pool.query(`DELETE FROM wa_slot_locks WHERE phone = $1 AND status='held'`, [phone]);
    return {
      reply: "Conversa reiniciada 😊 Pode começar de novo!",
      state: {},
      flags: {},
      intent: "reset",
    };
  }

  // ── Admin simular pagamento ──
  if (["simular pagamento","paguei_teste","simular_pagamento","aprovar_teste"].includes(norm(incomingText)) && phoneDigits === ADMIN_RESET_PHONE_DIGITS) {
    const st = await getUserState(phone);
    st.payment = st.payment || {};
    st.payment.status = "approved";
    st.payment.simulated = true;
    if (st.slot_key) await markSlotPaid(st.slot_key, phone);
    await saveUserState(phone, st);
    return {
      reply: afterPaidReply(st),
      state: st,
      flags: {},
      intent: "admin_simulate_payment",
    };
  }

  // ── Load state ──
  let state = initializeState(await getUserState(phone), `api:${phone}`);

  // Salvar mensagem inbound
  logMessage(phone, "lia", incomingText, "inbound");

  const flags = detectIntent(incomingText);

  // Atualizar focus/condition/problem passivamente
  if (flags.focus && !state.focus) state.focus = flags.focus;
  const detCond = detectCondition(incomingText);
  if (detCond && !state.condition) state.condition = detCond;
  const detProb = extractProblemText(incomingText);
  if (detProb && !state.problem_text) state.problem_text = detProb;

  // Classificar lead
  const lp = classifyLead(flags, incomingText, state);
  if (!state.lead_profile || ["emocional","desconfiado","quente"].includes(lp)) state.lead_profile = lp;

  // Rastrear pergunta importante
  if (hasQuestion(incomingText)) {
    state.last_important_question = extractMainQuestion(incomingText);
  }

  let reply = "";

  /* ═══════════════════════════════════════════════════════════════
     [CAMADA 0] — PROTEÇÕES
     ═══════════════════════════════════════════════════════════════ */

  if (state.payment?.status === "approved") {
    reply = afterPaidReply(state);
  }
  else if (flags.urgency) {
    reply = "Pela sua mensagem, isso pode precisar de atendimento urgente. Por favor, procure um pronto-socorro ou ligue para o SAMU (192) agora. Quando estiver seguro(a), me chama aqui 😊";
  }

  /* ═══════════════════════════════════════════════════════════════
     [CAMADA 0.5] — RISCO EMOCIONAL / SOFRIMENTO PSÍQUICO (V24.5)
     ═══════════════════════════════════════════════════════════════ */

  else if (flags.emotionalRisk) {
    const nome = state.nome ? `, ${state.nome}` : "";
    reply = `Preciso te perguntar algo importante${nome}: você está tendo pensamentos de se machucar ou de não querer mais viver?\n\nSe sim, por favor ligue agora para o *CVV: 188* (24h, gratuito, sigilo total). Você não precisa passar por isso sozinho(a).\n\nSe não, fica tranquilo(a) — me conta melhor o que está sentindo que eu te ajudo a encontrar o caminho certo.`;
    state.emotional_risk_flagged = true;
    state.needs_human = true;
  }

  else if (flags.emotionalDistress && !state.emotional_distress_handled) {
    const nome = state.nome ? `, ${state.nome}` : "";
    reply = `Entendo${nome}. O que você está sentindo é real e merece atenção.\n\nAntes de falar sobre tratamento, me conta um pouco mais: como está seu dia a dia com isso? Está conseguindo dormir, trabalhar, fazer suas coisas?`;
    state.emotional_distress_handled = true;
    state.lead_profile = "emocional";
  }

  /* ═══════════════════════════════════════════════════════════════
     [CAMADA 0.7] — PAUSA / ENCERRAMENTO EDUCADO (V24.5)
     ═══════════════════════════════════════════════════════════════ */

  else if (!DATA_COLLECTION_STAGES.includes(state.stage) && flags.endsConversation && !flags.wantsBook && !flags.wantsPrice && !flags.intentPay) {
    const nome = state.nome ? `, ${state.nome}` : "";
    reply = `Eu que agradeço${nome} 😊 Quando quiser, é só me chamar por aqui.`;
  }

  else if (flags.saysWillSee && !flags.wantsBook && !flags.intentPay) {
    const nome = state.nome ? `, ${state.nome}` : "";
    reply = `Claro${nome}, fica à vontade para pensar com calma 😊 Quando decidir, me chama por aqui que eu te ajudo.`;
  }

  else if (flags.saysCheckSpouse && !flags.wantsBook && !flags.intentPay) {
    const nome = state.nome ? `, ${state.nome}` : "";
    reply = `Faz todo sentido${nome}. Quando estiver decidido(a), me avisa por aqui que eu organizo tudo 😊`;
  }

  /* ═══════════════════════════════════════════════════════════════
     [CAMADA 1] — REPARO CONVERSACIONAL
     ═══════════════════════════════════════════════════════════════ */

  else if (isRepairSignal(incomingText)) {
    state.repair_count = (state.repair_count || 0) + 1;
    const ai = await runLia({
      incomingText,
      state,
      flags,
      stageCTA: "",
      isRepair: true,
    });

    if (ai.reply.startsWith("__")) {
      reply = "Me desculpa pela confusão. Me conta com suas palavras o que ficou sem resposta que eu tento de um jeito diferente.";
    } else {
      const ack = state.repair_count >= 3
        ? `Me desculpa pela confusão${state.nome ? `, ${state.nome}` : ""}. Vou ser bem direto(a):\n\n`
        : `Você tem razão${state.nome ? `, ${state.nome}` : ""} — obrigada por sinalizar.\n\n`;
      reply = ack + ai.reply;
      state = mergeState(state, ai.updates);
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     [CAMADA 2] — PERGUNTAS DO PACIENTE → GPT RESPONDE
     ═══════════════════════════════════════════════════════════════ */

  else if (!reply && state.stage && hasQuestion(incomingText)
    && !DATA_COLLECTION_STAGES.includes(state.stage)
  ) {
    if (isMedCostQuestion(flags, incomingText)) {
      reply = medCostReply(state);
      state.questions_answered_since_last_cta = (state.questions_answered_since_last_cta || 0) + 1;
    } else {
    const ctaHint = shouldShowCTA(state, flags, incomingText) ? getStageCTA(state).trim() : "";
    const ai = await runLia({
      incomingText,
      state,
      flags,
      stageCTA: ctaHint,
    });

    if (ai.reply === "__NEED_PRICE__") {
      state.price_ask_count += 1;
      reply = priceReply();
      state.stage = "ASK_PLAN";
    } else if (ai.reply === "__NEED_BOOK__") {
      state.stage = "ASK_DAY";
      reply = await askDayReply();
    } else if (ai.reply === "__NEED_PAY__") {
      if (state.payment?.link) { reply = pendingPaymentReply(state); state.stage = "WAIT_PAYMENT"; }
      else { state.stage = "ASK_DAY"; reply = await askDayReply(); }
    } else if (ai.reply === "__URGENT__") {
      reply = "Pela sua mensagem, isso pode precisar de atendimento urgente. Procure um pronto-socorro ou SAMU (192).";
    } else {
      reply = ai.reply;
      state = mergeState(state, ai.updates);
      if (shouldShowCTA(state, flags, incomingText)
          && !/(horários|horario|marcar|agendar|disponíveis|disponivel)/i.test(reply)
          && !["ASK_NAME","ASK_PROBLEM","DIAGNOSTIC"].includes(state.stage)
          && !isSubstantiveQuestion(incomingText)) {
        reply += getSmartCTA(state, flags, incomingText);
      } else {
        state.questions_answered_since_last_cta = (state.questions_answered_since_last_cta || 0) + 1;
      }
    }
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     [CAMADA 3] — STATE MACHINE
     ═══════════════════════════════════════════════════════════════ */

  if (!reply) {

    // ── V24.4: Atalho — paciente menciona dia específico → oferecer horários ──
    if (flags.mentionsDayAvail
      && !["OFFER_SLOTS","ASK_FULLNAME","ASK_BIRTHDATE","ASK_EMAIL","ASK_PLAN","WAIT_PAYMENT"].includes(state.stage)
    ) {
      const mentionedDate = extractDateKey(incomingText);
      if (mentionedDate) {
        const avail = await getAvailableSlotsForDate(mentionedDate);
        if (avail.length) {
          state.date_key = mentionedDate;
          state.stage = "OFFER_SLOTS";
          const periodMin = extractPeriodFilter(incomingText);
          reply = await offerSlotsReply(state, periodMin);
        } else {
          const nearest = await findNearestAvailableDay(mentionedDate);
          if (nearest) {
            state.date_key = nearest;
            reply = `Esse dia não tenho mais vaga disponível 😕 Mas o dia mais próximo que tenho é *${formatDatePt(nearest)}*. Quer ver os horários?`;
            state.stage = "ASK_DAY";
          } else {
            reply = "No momento todos os horários já estão preenchidos 😕 Quer que eu te coloque na lista de prioridade?";
          }
        }
      }
    }

    // ── Abertura: sem stage e sem nome ──
    if (!reply && !state.stage && !state.nome) {
      if (hasQuestion(incomingText)) {
        const ai = await runLia({ incomingText, state, flags, stageCTA: "" });
        if (!ai.reply.startsWith("__")) {
          reply = ai.reply + "\n\nAntes de mais nada, qual é o seu *primeiro nome*? 😊";
          state = mergeState(state, ai.updates);
        } else {
          reply = askNameIntroReply();
        }
      } else {
        reply = askNameIntroReply();
      }
      state.stage = "ASK_NAME";
    }

    // ── Captura do nome ──
    else if (state.stage === "ASK_NAME") {
      if (state.nome) {
        if (!state.problem_text) {
          state.stage = "ASK_PROBLEM";
          reply = askProblemReply(state);
        } else {
          state.stage = "DIAGNOSTIC";
          const nextQ = getNextDiagQuestion(state, state.problem_text || incomingText);
          if (nextQ) { reply = nextQ; }
          else { state.stage = "BRIDGE"; reply = bridgeReply(state); }
        }
      } else {
        const nm = extractFirstName(incomingText);
        if (nm) {
          state.nome = nm;
          state.name_used_count = 0;

          if (state.problem_text) {
            if (state.lead_profile === "quente" || flags.wantsBook) {
              state.stage = "ASK_DAY";
              reply = `Prazer, ${nm} 😊 Vou te mostrar os horários disponíveis.\n\n` + await askDayReply();
            } else if (state.lead_profile === "pragmatico" || flags.wantsPrice) {
              state.stage = "ASK_PLAN";
              reply = `Prazer, ${nm} 😊\n\n${priceReply()}`;
            } else {
              state.stage = "DIAGNOSTIC";
              const nextQ = getNextDiagQuestion(state, state.problem_text || incomingText);
              if (nextQ) {
                reply = `Prazer, ${nm} 😊\n\n${nextQ}`;
              } else {
                state.stage = "BRIDGE";
                reply = `Prazer, ${nm} 😊\n\n${bridgeReply(state)}`;
              }
            }
          } else {
            state.stage = "ASK_PROBLEM";
            reply = askProblemReply(state);
          }
        } else {
          if (hasQuestion(incomingText)) {
            const ai = await runLia({ incomingText, state, flags, stageCTA: "" });
            if (!ai.reply.startsWith("__")) {
              reply = ai.reply + "\n\nAntes de seguir, me diz seu *primeiro nome* 😊";
              state = mergeState(state, ai.updates);
            } else {
              reply = "Antes de tudo, me diz seu *primeiro nome* 😊";
            }
          } else {
            reply = "Antes de tudo, me diz seu *primeiro nome* 😊";
          }
        }
      }
    }

    // ── Captura do problema ──
    else if (state.stage === "ASK_PROBLEM") {
      const pb = extractProblemText(incomingText);
      if (pb) {
        state.problem_text = pb;
        state.condition = state.condition || detectCondition(pb) || state.focus || null;

        state.stage = "DIAGNOSTIC";
        const nextQ = getNextDiagQuestion(state, incomingText);
        if (nextQ) {
          reply = nextQ;
        } else {
          state.stage = "BRIDGE";
          reply = bridgeReply(state);
        }
      } else {
        const ai = await runLia({ incomingText, state, flags, stageCTA: "Me conta: o que tem te incomodado mais?" });
        if (ai.reply.startsWith("__")) {
          reply = askProblemReply(state);
        } else {
          reply = ai.reply;
          state = mergeState(state, ai.updates);
        }
      }
    }

    // ── Triagem adaptativa ──
    else if (state.stage === "DIAGNOSTIC") {
      const low = norm(incomingText);
      if (/(ha |há |faz |anos|meses)/.test(low)) state.diag_has_tempo = true;
      if (/(rotina|dia a dia|trabalho|sono|atrapalha|incomoda|cansaço)/.test(low)) state.diag_has_impacto = true;
      if (/(ja tomei|já tomei|ja tentei|já tentei|remedio|remédio|anti.?inflam|fisioterapia|medicac|pregabalina|duloxetina|amitriptilina|infiltrac)/.test(low)) state.diag_has_tratamento = true;

      const nextQ = getNextDiagQuestion(state, incomingText);
      if (nextQ) {
        reply = nextQ;
      } else {
        state.stage = "BRIDGE";
        reply = bridgeReply(state);
      }
    }

    // ── Bridge ──
    else if (state.stage === "BRIDGE") {
      if (flags.wantsBook || flags.asksHours || flags.confirms || flags.mentionsDayAvail) {
        state.stage = "ASK_DAY";
        reply = await askDayReply();
      } else if (flags.wantsPrice) {
        state.price_ask_count += 1;
        reply = priceReply();
        state.stage = "ASK_PLAN";
      } else {
        const ai = await runLia({ incomingText, state, flags, stageCTA: "Se quiser, eu posso te mostrar os horários disponíveis" });
        if (ai.reply === "__NEED_BOOK__") { state.stage = "ASK_DAY"; reply = await askDayReply(); }
        else if (ai.reply === "__NEED_PRICE__") { state.price_ask_count += 1; reply = priceReply(); state.stage = "ASK_PLAN"; }
        else { reply = ai.reply; state = mergeState(state, ai.updates); }
      }
    }

    // ── Escolher dia ──
    else if (state.stage === "ASK_DAY") {
      if (state.date_key && !state.slot_time) {
        state.stage = "OFFER_SLOTS";
        reply = await offerSlotsReply(state);
      } else {
        const dayChoice = extractNumericChoice(incomingText);
        const explicitDate = extractDateKey(incomingText);
        const suggested = await getSuggestedDayKeys();

        if (dayChoice && suggested[dayChoice - 1]) {
          state.date_key = suggested[dayChoice - 1];
          state.stage = "OFFER_SLOTS";
          reply = await offerSlotsReply(state);
        } else if (explicitDate) {
          const avail = await getAvailableSlotsForDate(explicitDate);
          if (!avail.length) {
            const nearest = await findNearestAvailableDay(explicitDate);
            if (nearest) {
              state.date_key = nearest;
              reply = `Esse dia não tenho mais vaga 😕 Mas o mais próximo que tenho é *${formatDatePt(nearest)}*. Quer ver os horários?`;
            } else {
              reply = "Esse dia está sem vagas no momento 😕 Quer que eu te mostre outra data?";
            }
          } else {
            state.date_key = explicitDate;
            state.stage = "OFFER_SLOTS";
            const periodMin = extractPeriodFilter(incomingText);
            reply = await offerSlotsReply(state, periodMin);
          }
        } else if (flags.confirms && suggested.length) {
          state.date_key = suggested[0];
          state.stage = "OFFER_SLOTS";
          reply = await offerSlotsReply(state);
        // V24.5: Pergunta direta sobre horários sem indicar dia → re-oferecer dias
        } else if (flags.asksHours && !extractDateKey(incomingText)) {
          const dayKeys = await getSuggestedDayKeys();
          if (dayKeys.length) {
            const opts = dayKeys.map((d) => `*${formatDatePt(d)}*`).join("\n");
            reply = `Me diz qual dia você prefere que eu te mostro os horários disponíveis dele 😊\n\n${opts}`;
          } else {
            reply = await askDayReply();
          }
        } else if (hasQuestion(incomingText)) {
          const ai = await runLia({ incomingText, state, flags, stageCTA: "Qual dia fica melhor para você?" });
          if (ai.reply === "__NEED_PRICE__") { state.price_ask_count += 1; reply = priceReply(); state.stage = "ASK_PLAN"; }
          else if (ai.reply.startsWith("__")) { reply = await askDayReply(); }
          else { reply = ai.reply; state = mergeState(state, ai.updates); }
        // V24.5: Se lead pede tempo/encerra em ASK_DAY, respeitar
        } else if (flags.saysWillSee || flags.endsConversation || flags.saysCheckSpouse) {
          const nome = state.nome ? `, ${state.nome}` : "";
          reply = `Sem problema${nome} 😊 Quando decidir o dia, me avisa por aqui que eu organizo tudo.`;
        } else {
          reply = await askDayReply();
        }
      }
    }

    // ── Escolher horário ──
    else if (state.stage === "OFFER_SLOTS") {
      const best = state.offered_slots?.length ? state.offered_slots : await chooseBestSlotsForDate(state.date_key, 3);
      const choiceNum = extractNumericChoice(incomingText);
      const requestedTime = extractHourOnly(incomingText);

      let chosen = null;
      if (choiceNum && best[choiceNum - 1]) chosen = best[choiceNum - 1];
      else if (requestedTime) {
        const available = await getAvailableSlotsForDate(state.date_key);
        if (available.includes(requestedTime)) chosen = requestedTime;
        else {
          const best2 = await chooseBestSlotsForDate(state.date_key, 3);
          reply = `Esse horário não está disponível. O mais próximo que tenho é:\n${best2.map((s,i) => `${i+1}) *${s}*`).join("\n")}\n\nQual fica melhor? 😊`;
        }
      } else if (/\b(outro|nenhum|tem mais)\b/.test(norm(incomingText))) {
        reply = `Sem problema 😊 Que horário em *${formatDatePt(state.date_key)}* funciona melhor para você?`;
      }

      if (chosen && !reply) {
        const hold = await acquireSlotHold(state.date_key, chosen, phone);
        if (!hold.ok) {
          reply = "Esse horário acabou de ser preenchido 😕 Vou te mostrar outras opções.\n\n" + (await offerSlotsReply(state));
        } else {
          state.slot_time = chosen;
          state.slot_key = hold.slot_key;
          await releaseOldHeldSlotsForPhone(phone, hold.slot_key);
          state.stage = "ASK_FULLNAME";
          reply = askFullNameReply(state);
        }
      }

      if (!reply) {
        if (hasQuestion(incomingText)) {
          const ai = await runLia({ incomingText, state, flags, stageCTA: "Qual desses horários funciona melhor?" });
          if (ai.reply.startsWith("__")) { reply = await offerSlotsReply(state); }
          else { reply = ai.reply; state = mergeState(state, ai.updates); }
        } else {
          reply = "Qual horário fica melhor? Pode me responder com *1, 2, 3* ou com o horário exato 😊";
        }
      }
    }

    // ── Dados cadastrais ──
    else if (state.stage === "ASK_FULLNAME") {
      const full = extractFullName(incomingText);
      if (full) {
        state.nome_completo = full;
        state.stage = "ASK_BIRTHDATE";
        reply = askBirthdateReply(state);
      } else if (hasQuestion(incomingText)) {
        const ai = await runLia({ incomingText, state, flags, stageCTA: "Me passa seu nome completo para finalizar a reserva" });
        if (!ai.reply.startsWith("__")) { reply = ai.reply + "\n\nMe passa seu *nome completo* 😊"; state = mergeState(state, ai.updates); }
        else { reply = "Me manda seu *nome completo* certinho, por favor."; }
      } else {
        reply = "Me manda seu *nome completo* certinho, por favor.";
      }
    }
    else if (state.stage === "ASK_BIRTHDATE") {
      const bd = extractBirthDate(incomingText);
      if (bd) {
        state.birthdate = bd;
        state.stage = "ASK_EMAIL";
        reply = askEmailReply();
      } else {
        reply = "Me manda sua *data de nascimento* no formato *dd/mm/aaaa*.";
      }
    }
    else if (state.stage === "ASK_EMAIL") {
      const em = extractEmail(incomingText);
      if (em) {
        state.email = em;
        state.stage = "ASK_PLAN";
        reply = `Obrigada 😊\n\nHorário pré-reservado: *${prettySlot(state.date_key, state.slot_time)}*.\n\nAssim que o pagamento for confirmado, sua reserva fica garantida 😊\n\n${priceReply()}`;
      } else {
        reply = "Me manda seu *e-mail* certinho, por favor.";
      }
    }

    // ── Escolha do plano ──
    else if (state.stage === "ASK_PLAN") {
      const planKey = extractPlanChoice(incomingText);

      if (planKey) {
        state.selected_plan_key = planKey;
        const holdCheck = state.date_key && state.slot_time ? await acquireSlotHold(state.date_key, state.slot_time, phone) : { ok: true };
        if (state.date_key && !holdCheck.ok) {
          state.slot_time = null;
          state.slot_key = null;
          state.stage = "OFFER_SLOTS";
          reply = "Esse horário acabou de ser preenchido 😕 Vou te mostrar outras opções.\n\n" + (await offerSlotsReply(state));
        } else {
          if (holdCheck.slot_key) state.slot_key = holdCheck.slot_key;

          if (!state.date_key) {
            state.stage = "ASK_DAY";
            reply = `Perfeito 😊 Vou organizar sua reserva.\n\n${await askDayReply()}`;
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
            const pref = await mpCreatePreference({ phone, planKey });
            state.payment = {
              status: "pending", plan_key: planKey,
              preference_id: pref.preference_id, link: pref.link,
              external_reference: pref.external_reference, created_at: Date.now(),
            };
            reply = paymentSentReply(pref.plan, pref.link, state);
            state.stage = "WAIT_PAYMENT";
          }
        }
      } else if (isMedCostQuestion(flags, incomingText)) {
        reply = medCostReply(state);
        state.questions_answered_since_last_cta = (state.questions_answered_since_last_cta || 0) + 1;
      // V24.5: Respeitar pausa em ASK_PLAN
      } else if (flags.saysWillSee || flags.endsConversation || flags.saysCheckSpouse) {
        const nome = state.nome ? `, ${state.nome}` : "";
        reply = `Sem problema${nome} 😊 Quando decidir, me chama por aqui que eu organizo tudo.`;
      } else {
        const ai = await runLia({ incomingText, state, flags, stageCTA: "Qual dessas opções faz mais sentido? Me responde com 1, 2 ou 3" });
        if (ai.reply.startsWith("__")) {
          reply = "Se quiser, eu posso te explicar a diferença entre as opções. Qual faz mais sentido: *1, 2 ou 3*?";
        } else {
          reply = ai.reply;
          state = mergeState(state, ai.updates);
        }
      }
    }

    // ── Aguardando pagamento ──
    else if (state.stage === "WAIT_PAYMENT") {
      if (state.payment?.status === "pending" && state.payment?.link) {
        if (flags.intentPay || flags.confirms) {
          reply = pendingPaymentReply(state);
        } else {
          const ai = await runLia({ incomingText, state, flags, stageCTA: `Seu horário está pré-reservado. Para confirmar é só finalizar aqui: ${state.payment.link}` });
          if (ai.reply.startsWith("__")) {
            reply = pendingPaymentReply(state);
          } else {
            reply = ai.reply;
            state = mergeState(state, ai.updates);
          }
        }
      } else {
        reply = "Me conta: como posso te ajudar agora? 😊";
      }
    }

    // ── Intenções fora de stage ──
    else if (flags.wantsBook || flags.asksHours || flags.mentionsDayAvail) {
      if (!state.nome) { state.stage = "ASK_NAME"; reply = askNameIntroReply(); }
      else if (!state.problem_text) { state.stage = "ASK_PROBLEM"; reply = askProblemReply(state); }
      else if (!state.date_key) { state.stage = "ASK_DAY"; reply = await askDayReply(); }
      else if (!state.slot_time) { state.stage = "OFFER_SLOTS"; reply = await offerSlotsReply(state); }
      else { state.stage = "ASK_PLAN"; reply = priceReply(); }
    }

    else if (flags.wantsPrice) {
      state.price_ask_count += 1;
      if (!state.nome) {
        if (state.price_ask_count >= 2) { state.stage = "ASK_PLAN"; reply = priceReply(); }
        else { state.stage = "ASK_NAME"; reply = "Claro, vou te passar as opções 😊 Antes, me diz seu *primeiro nome*?"; }
      } else { reply = priceReply(); state.stage = "ASK_PLAN"; }
    }

    else if (flags.intentPay) {
      if (state.payment?.status === "pending" && state.payment?.link) { reply = pendingPaymentReply(state); state.stage = "WAIT_PAYMENT"; }
      else if (!state.date_key) { state.stage = "ASK_DAY"; reply = `Perfeito 😊 Antes do pagamento, vou reservar seu horário.\n\n${await askDayReply()}`; }
      else { state.stage = "ASK_PLAN"; reply = priceReply(); }
    }

    else if (flags.refuses) {
      reply = "Tranquilo, sem problema 😊 Se quiser tirar qualquer dúvida ou entender melhor como funciona, estou aqui.";
    }

    else if (isMedCostQuestion(flags, incomingText)) {
      reply = medCostReply(state);
      state.questions_answered_since_last_cta = (state.questions_answered_since_last_cta || 0) + 1;
    }

    /* ═══════════════════════════════════════════════════════════════
       [CAMADA 4/5] — OBJEÇÕES + FALLBACK GPT
       ═══════════════════════════════════════════════════════════════ */

    else {
      const cta = shouldShowCTA(state, flags, incomingText) ? getStageCTA(state).trim() : "";
      const ai = await runLia({ incomingText, state, flags, stageCTA: cta });

      if (ai.reply === "__NEED_PRICE__") {
        state.price_ask_count += 1;
        reply = priceReply();
        state.stage = "ASK_PLAN";
      } else if (ai.reply === "__NEED_BOOK__") {
        if (!state.nome) { state.stage = "ASK_NAME"; reply = askNameIntroReply(); }
        else if (!state.problem_text) { state.stage = "ASK_PROBLEM"; reply = askProblemReply(state); }
        else { state.stage = "ASK_DAY"; reply = await askDayReply(); }
      } else if (ai.reply === "__NEED_PAY__") {
        if (state.payment?.link) { reply = pendingPaymentReply(state); state.stage = "WAIT_PAYMENT"; }
        else { reply = "Perfeito 😊 Antes de finalizar, preciso reservar seu horário." + getStageCTA(state); }
      } else if (ai.reply === "__URGENT__") {
        reply = "Pela sua mensagem, isso pode precisar de atendimento urgente. Procure um pronto-socorro ou SAMU (192).";
      } else {
        reply = ai.reply;
        state = mergeState(state, ai.updates);
        if (!state.nome && ai.updates?.nome) state.nome = String(ai.updates.nome).trim();
        if (!state.problem_text && ai.updates?.problem_text) state.problem_text = String(ai.updates.problem_text).trim();
        if (!state.condition && (ai.updates?.condition || state.problem_text)) {
          state.condition = ai.updates?.condition || detectCondition(state.problem_text);
        }
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     ANTI-REPETIÇÃO V24
     ═══════════════════════════════════════════════════════════════ */

  if (state.payment?.status === "approved") {
    // OK — repetir afterPaidReply é comportamento correto
  } else {
    reply = await ensureNoRepeat(reply, state, incomingText, flags);
  }

  // Contar uso do nome
  if (state.nome && reply.includes(state.nome)) {
    state.name_used_count = Number(state.name_used_count || 0) + 1;
  }

  // Atualizar histórico
  updateConversationHistory(state, incomingText, reply);

  state.second_last_bot_reply = state.last_bot_reply;
  state.last_bot_reply = reply;
  state.last_user_message = incomingText;
  state.last_sent_at = Date.now();

  await saveUserState(phone, state);
  logMessage("lia", phone, reply, "outbound");

  return { reply, state, flags };
}

/* ═══════════════════════════════════════════════════════════════════
   ROUTES
   ═══════════════════════════════════════════════════════════════════ */

app.get("/", (req, res) => res.send("OK"));
app.get("/mp/thanks", (req, res) => res.send("OK"));

/* ═══════════════════════════════════════════════════════════════════
   ENDPOINT PRINCIPAL PARA N8N — POST /lia/respond
   ═══════════════════════════════════════════════════════════════════ */

app.post("/lia/respond", async (req, res) => {
  try {
    const { telefone, mensagem } = req.body || {};

    if (!telefone || !mensagem) {
      return res.status(400).json({
        ok: false,
        error: "campos 'telefone' e 'mensagem' são obrigatórios",
      });
    }

    const phone = String(telefone).replace(/\D/g, "");
    if (!phone || phone.length < 10) {
      return res.status(400).json({ ok: false, error: "telefone inválido" });
    }

    const incomingText = String(mensagem).trim();
    if (!incomingText) {
      return res.status(400).json({ ok: false, error: "mensagem vazia" });
    }

    const result = await processLiaMessage(phone, incomingText);

    // V24.5: Calcular delay humano baseado no tamanho da resposta
    const replyLen = (result.reply || "").length;
    let delay_ms;
    if (replyLen < 80)       delay_ms = randInt(2000, 4000);   // curta: 2-4s
    else if (replyLen < 250) delay_ms = randInt(4000, 7000);   // média: 4-7s
    else                     delay_ms = randInt(6000, 10000);  // longa: 6-10s

    return res.json({
      ok: true,
      reply: result.reply,
      stage: result.state?.stage || null,
      intent: detectMainIntent(result.flags) || null,
      action: null,
      needs_payment: result.state?.stage === "WAIT_PAYMENT",
      needs_human: !!(result.state?.needs_human || result.state?.emotional_risk_flagged),
      payment_link: result.state?.payment?.link || null,
      delay_ms,
      debug: {
        lead_profile: result.state?.lead_profile || null,
        condition: result.state?.condition || null,
        nome: result.state?.nome || null,
        emotional_risk: result.state?.emotional_risk_flagged || false,
      },
    });
  } catch (err) {
    console.error("❌ Erro /lia/respond:", err);
    return res.status(500).json({
      ok: false,
      error: "erro interno",
      reply: "Tive uma instabilidade rápida aqui 😊 Me manda de novo em 1 frase: quer *agendar*, *tirar dúvida* ou *ver valores*?",
    });
  }
});

// Helper para extrair a intent principal das flags
function detectMainIntent(flags) {
  if (!flags) return null;
  if (flags.urgency) return "URGENCIA";
  if (flags.wantsBook || flags.asksHours) return "AGENDAR";
  if (flags.wantsPrice) return "PRECO";
  if (flags.intentPay) return "PAGAMENTO";
  if (flags.confirms) return "CONFIRMA";
  if (flags.refuses) return "RECUSA";
  if (flags.asksHowConsultWorks || flags.asksIfOnline) return "DUVIDA_CONSULTA";
  if (flags.asksIfWorks || flags.asksIfForMe) return "DUVIDA_TRATAMENTO";
  if (flags.asksLegal || flags.asksChapado) return "DUVIDA_LEGAL";
  if (flags.saysExpensive || flags.saysCheaperElsewhere) return "OBJECAO_PRECO";
  if (flags.saysWillSee || flags.saysUnsure) return "INDECISO";
  return "CONVERSA";
}

/* ═══════════════════════════════════════════════════════════════════
   WEBHOOK MERCADO PAGO (preservado — envio Twilio condicional)
   ═══════════════════════════════════════════════════════════════════ */

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
      if (status === "approved") state.stage = "CONFIRMED";
      await saveUserState(phone, state);

      if (status === "approved") {
        // Tentar enviar via Twilio se disponível
        if (twilioClient) {
          const botFrom = state?.last_bot_from || null;
          if (botFrom && !botFrom.startsWith("api:")) {
            try {
              await twilioClient.messages.create({ to: `whatsapp:${phone}`, from: botFrom, body: afterPaidReply(state) });
            } catch {}
          }
        }
        // Nota: quando via n8n, o n8n deve ter um webhook/polling para confirmar pagamento
        // O estado já está salvo como CONFIRMED, então a próxima chamada ao /lia/respond retornará afterPaidReply
      }
    }
  } catch (err) { console.error("❌ MP webhook erro:", err); }
});

/* ═══════════════════════════════════════════════════════════════════
   HANDLER TWILIO /whatsapp (PRESERVADO — usa processLiaMessage)
   ═══════════════════════════════════════════════════════════════════ */

app.post("/whatsapp", async (req, res) => {
  // Se Twilio não está configurado, retornar erro
  if (!twilioClient || !twilio) {
    return res.status(200).type("text/xml").send("<Response></Response>");
  }

  const twiml = new twilio.twiml.MessagingResponse();
  res.type("text/xml").send(twiml.toString());

  (async () => {
    try {
      const lead = req.body.From || "";
      const bot = req.body.To || "";
      const phone = lead.replace("whatsapp:", "").trim();
      let incomingText = (req.body.Body || "").trim();

      // ── Mídia: transcrição de áudio ou fallback ──
      const hasMedia = Number(req.body.NumMedia || 0) > 0;
      if (hasMedia) {
        const mediaType = (req.body.MediaContentType0 || "").toLowerCase();
        const mediaUrl = req.body.MediaUrl0;

        if (mediaType.startsWith("audio/") && mediaUrl) {
          const transcribed = await transcribeWhatsAppAudio(mediaUrl);
          if (transcribed && transcribed.length >= 2) {
            incomingText = transcribed;
          } else {
            const state = initializeState(await getUserState(phone), bot);
            const fallback = state.nome
              ? `${state.nome}, não consegui entender bem o áudio 😅 Pode me mandar por texto?`
              : "Não consegui entender bem o áudio 😅 Pode me mandar por texto?";
            state.last_bot_reply = fallback;
            state.last_sent_at = Date.now();
            await saveUserState(phone, state);
            await sendWhatsApp(lead, bot, fallback, randInt(1, 2));
            return;
          }
        } else if (!incomingText || incomingText.length < 2) {
          const state = initializeState(await getUserState(phone), bot);
          const mediaReply = state.nome
            ? `${state.nome}, por enquanto eu só consigo ler mensagens de texto e áudio 😊 Me manda sua dúvida digitando que eu te ajudo.`
            : "Por enquanto eu só consigo ler mensagens de texto e áudio 😊 Me manda sua dúvida digitando que eu te ajudo.";
          state.last_bot_reply = mediaReply;
          state.last_sent_at = Date.now();
          await saveUserState(phone, state);
          await sendWhatsApp(lead, bot, mediaReply, randInt(1, 2));
          return;
        }
      }

      // Processar usando a lógica central
      const result = await processLiaMessage(phone, incomingText);

      // Atualizar last_bot_from para o bot Twilio
      const stateNow = await getUserState(phone);
      stateNow.last_bot_from = bot;
      await saveUserState(phone, stateNow);

      // Enviar via Twilio com delay humano
      const flags = detectIntent(incomingText);
      const delaySec = computeHumanDelay(flags, result.state);
      await sendWhatsApp(lead, bot, result.reply, delaySec);

    } catch (err) {
      console.error("❌ Erro no processamento Twilio:", err);
      try {
        const lead = req.body.From || "";
        const bot = req.body.To || "";
        await twilioClient.messages.create({
          to: lead, from: bot,
          body: "Tive uma instabilidade rápida aqui 😊 Me manda de novo em 1 frase: quer *agendar*, *tirar dúvida* ou *ver valores*?",
        });
      } catch {}
    }
  })();
});

/* ═══════════════════════════════════════════════════════════════════
   ENVIO MANUAL (preservado — Twilio condicional)
   ═══════════════════════════════════════════════════════════════════ */

app.post("/send-manual", async (req, res) => {
  const { to, message, secret } = req.body || {};

  if (!MANUAL_SEND_SECRET) return res.status(500).json({ ok: false, error: "MANUAL_SEND_SECRET não configurado no servidor" });
  if (secret !== MANUAL_SEND_SECRET) return res.status(401).json({ ok: false, error: "secret inválido" });
  if (!to || !message) return res.status(400).json({ ok: false, error: "campos 'to' e 'message' são obrigatórios" });
  if (!twilioClient) return res.status(500).json({ ok: false, error: "Twilio não configurado (modo API-only)" });

  let phone = String(to).replace(/\D/g, "");
  if (!phone || phone.length < 10) return res.status(400).json({ ok: false, error: "número inválido" });
  const toWhatsApp = `whatsapp:+${phone}`;

  const fromNumber = TWILIO_WHATSAPP_NUMBER || "";
  if (!fromNumber) return res.status(500).json({ ok: false, error: "TWILIO_WHATSAPP_NUMBER não configurado" });
  const fromWhatsApp = fromNumber.startsWith("whatsapp:") ? fromNumber : `whatsapp:${fromNumber}`;

  try {
    const sent = await twilioClient.messages.create({
      to: toWhatsApp,
      from: fromWhatsApp,
      body: message,
    });
    console.log(`📤 Manual → ${toWhatsApp}: "${message.slice(0, 80)}..." (sid: ${sent.sid})`);
    logMessage(fromWhatsApp, toWhatsApp, message, "outbound_manual");
    return res.status(200).json({ ok: true, sid: sent.sid, to: toWhatsApp });
  } catch (err) {
    console.error("❌ Erro envio manual:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ADMIN API (preservado)
   ═══════════════════════════════════════════════════════════════════ */

function adminAuth(req, res) {
  const secret = req.query.secret || req.headers["x-admin-secret"];
  if (!ADMIN_READ_SECRET) { res.status(500).json({ ok: false, error: "ADMIN_READ_SECRET não configurado" }); return false; }
  if (secret !== ADMIN_READ_SECRET) { res.status(401).json({ ok: false, error: "secret inválido" }); return false; }
  return true;
}

app.get("/admin/messages", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, from_number, to_number, body, direction, created_at FROM messages ORDER BY created_at DESC LIMIT 200`
    );
    return res.json({ ok: true, count: rows.length, messages: rows });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.get("/admin/conversations", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try {
    const botNum = TWILIO_WHATSAPP_NUMBER || "";
    const { rows } = await pool.query(`
      SELECT
        CASE WHEN from_number = $1 THEN to_number ELSE from_number END AS contact_number,
        MAX(body) FILTER (WHERE created_at = sub.last_at) AS last_message,
        MAX(created_at) AS last_message_at,
        COUNT(*)::int AS total_messages
      FROM messages,
        LATERAL (SELECT MAX(created_at) AS last_at FROM messages m2
          WHERE CASE WHEN m2.from_number = $1 THEN m2.to_number ELSE m2.from_number END
              = CASE WHEN messages.from_number = $1 THEN messages.to_number ELSE messages.from_number END
        ) sub
      GROUP BY contact_number
      ORDER BY last_message_at DESC
      LIMIT 100
    `, [botNum.startsWith("whatsapp:") ? botNum : `whatsapp:${botNum}`]);
    return res.json({ ok: true, count: rows.length, conversations: rows });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.get("/admin/messages/:phone", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try {
    const phone = String(req.params.phone).replace(/\D/g, "");
    if (!phone || phone.length < 10) return res.status(400).json({ ok: false, error: "número inválido" });
    const pattern = `%${phone}%`;
    const { rows } = await pool.query(
      `SELECT id, from_number, to_number, body, direction, created_at
       FROM messages WHERE from_number LIKE $1 OR to_number LIKE $1
       ORDER BY created_at ASC`,
      [pattern]
    );
    return res.json({ ok: true, count: rows.length, phone, messages: rows });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════
   SERVER
   ═══════════════════════════════════════════════════════════════════ */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 LIA V24.3 (n8n-ready) rodando na porta ${PORT}`));
