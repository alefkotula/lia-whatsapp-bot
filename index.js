/**
 * ═══════════════════════════════════════════════════════════════════
 * INDEX V26 — LIA HUMANIZADA (baseado em V25)
 * ═══════════════════════════════════════════════════════════════════
 *
 * FOCO V26: Humanização profunda.
 * O lead deve perceber a LIA como uma humana real.
 * Menos script visível, mais fluidez, mais inteligência social.
 * GPT-5.4 com liberdade máxima dentro dos guardrails.
 *
 * Mudanças sobre V25:
 * - System prompt reescrito como persona humana completa
 * - Templates com pools de variação (5-8 variantes cada)
 * - Bridge inteiramente gerado por GPT
 * - Diagnóstico via GPT (não perguntas fixas)
 * - CTA orgânico (sem mecânica visível)
 * - Transições naturais entre estágios
 * - Temperature 0.78 para máxima naturalidade
 * - Respostas variáveis em tom, comprimento e estrutura
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
let MIN_DELAY = Number(MIN_DELAY_SEC || 8);
let MAX_DELAY = Number(MAX_DELAY_SEC || 30);
if (MIN_DELAY > MAX_DELAY) { [MIN_DELAY, MAX_DELAY] = [MAX_DELAY, MIN_DELAY]; console.warn("⚠️ MIN_DELAY_SEC > MAX_DELAY_SEC — invertidos automaticamente."); }
const BASE_URL = (PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "") || "http://localhost:10000";
const HOLD_MINUTES = 15;
const ADMIN_RESET_PHONE_DIGITS = "556581422637";

// V24.2: Stages de coleta de dados — Camada 2 NÃO deve interceptar perguntas nestes stages
const DATA_COLLECTION_STAGES = [
  "ASK_DAY", "OFFER_SLOTS", "ASK_PAY_METHOD",
  "ASK_FULLNAME", "ASK_BIRTHDATE", "ASK_EMAIL", "ASK_PLAN", "WAIT_PAYMENT"
];

/* ═══════════════════════════════════════════════════════════════════
   V24.6: DEDUPLICAÇÃO — evita processar webhooks duplicados
   ═══════════════════════════════════════════════════════════════════ */
const _recentMessages = new Map();
const DEDUP_TTL_MS = 60000; // 60 segundos

function _dedupKey(phone, text) {
  const hash = norm(text).replace(/\s+/g, "").slice(0, 120);
  return `${phone}_${hash}`;
}

function _dedupCheck(phone, text) {
  const key = _dedupKey(phone, text);
  const cached = _recentMessages.get(key);
  if (cached && (Date.now() - cached.ts) < DEDUP_TTL_MS) return cached.reply;
  return null;
}

function _dedupStore(phone, text, reply) {
  const key = _dedupKey(phone, text);
  _recentMessages.set(key, { reply, ts: Date.now() });
  // Cleanup periódico
  if (_recentMessages.size > 500) {
    const now = Date.now();
    for (const [k, v] of _recentMessages) {
      if (now - v.ts > DEDUP_TTL_MS) _recentMessages.delete(k);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════
   V24.7: DEBOUNCE / BUFFER DE MÚLTIPLAS MENSAGENS
   Quando lead manda 2-3 msgs seguidas, agrupa em 1 só resposta.
   Janela de 6s. Msgs anteriores retornam skip_send: true.
   ═══════════════════════════════════════════════════════════════════ */
const _inboundBuffer = new Map(); // phone → { messages: [{text, ts}], seq: number }
const DEBOUNCE_WINDOW_MS = 6000; // 6 segundos de espera

// V24.9: Cooldown entre respostas da LIA para o mesmo lead (anti-rajada)
const _lastBotReplyAt = new Map(); // phone → timestamp planejado da última resposta
const _lastAudioReplyAt = new Map(); // V24.11: phone → timestamp do último aviso de áudio
const AUDIO_COOLDOWN_MS = 90_000;     // 90s — 1 resposta de áudio por janela
const MIN_BOT_GAP_MS = 12000; // 12 segundos mínimo entre respostas para o mesmo lead

// Cleanup periódico do buffer + cooldown (segurança contra leaks de memória)
setInterval(() => {
  const now = Date.now();
  for (const [phone, buf] of _inboundBuffer) {
    const lastMsg = buf.messages[buf.messages.length - 1];
    if (lastMsg && (now - lastMsg.ts) > 120000) { // 2 min sem atividade → limpar
      _inboundBuffer.delete(phone);
    }
  }
  // Limpar cooldown entries antigas (>5 min)
  for (const [phone, ts] of _lastBotReplyAt) {
    if (now - ts > 300000) _lastBotReplyAt.delete(phone);
  }
}, 300000); // a cada 5 min

// V27: Safety filter — remove tokens internos que vazaram para o texto visível
function sanitizeReply(text) {
  if (!text) return text;
  return text.replace(/PRECISA_PRECO|PRECISA_PAGAR|PRECISA_AGENDAR|__NEED_PRICE__|__NEED_PAY__|__NEED_BOOK__|__URGENT__/g, "").replace(/\s{2,}/g, " ").trim();
}

/* ═══════════════════════════════════════════════════════════════════
   V24.6: FILTRO DE MENSAGENS DE SISTEMA
   Bloqueia msgs do WhatsApp/Meta/operacionais que não são do lead
   ═══════════════════════════════════════════════════════════════════ */
function isSystemMessage(text) {
  if (!text || typeof text !== "string") return true;
  const t = text.trim();
  if (!t) return true;
  // Mensagem só com emojis/espaços/pontuação (sem letras nem números)
  if (!/[a-zA-ZÀ-ÿ0-9]/.test(t)) return true;
  const low = t.toLowerCase();
  // Mensagens clássicas Meta/WhatsApp
  if (/voc[eê] recebeu uma mensagem/.test(low)) return true;
  if (/esta empresa usa/.test(low)) return true;
  if (/mensagens e liga[cç][oõ]es s[aã]o protegidas/.test(low)) return true;
  if (/toque para saber mais/.test(low)) return true;
  if (/criptografia de ponta/.test(low)) return true;
  if (/as mensagens s[aã]o protegidas/.test(low)) return true;
  if (/mensagem tempor[aá]ria/.test(low)) return true;
  if (/esta mensagem foi apagada/.test(low)) return true;
  if (/mensagem de seguran[cç]a/.test(low)) return true;
  if (/c[oó]digo de seguran[cç]a mudou/.test(low)) return true;
  // Eventos operacionais / status
  if (/^\[?(status|system|evento|event|notification)\]?/i.test(low)) return true;
  if (/^(delivered|sent|read|failed|queued|undelivered)$/i.test(low)) return true;
  // Mídia sem texto relevante
  // V24.11: audio/áudio removido daqui — interceptado com resposta educada no endpoint
  if (/^(\[?(imagem|foto|image|video|vídeo|documento|document|sticker|figurinha|gif|contato|contact|localiza[cç][aã]o|location)\]?\s*\.?\s*)$/i.test(low)) return true;
  return false;
}

/* ═══════════════════════════════════════════════════════════════════
   V24.6: DETECTOR DE ENTRADA VIA META ADS
   Frases típicas de clique em anúncio — NÃO são perguntas reais
   ═══════════════════════════════════════════════════════════════════ */
function isMetaAdsEntry(text) {
  const t = norm(text);
  // Frases exatas ou quase exatas geradas pelo Meta Ads
  if (/^(ol[aá]|oi)?\s*(como funciona|gostaria de saber mais|quero saber mais|quero mais informa[cç][oõ]es|me conte mais|saiba mais|tenho interesse|quero conhecer|gostaria de conhecer)\s*[.!?]?\s*$/i.test(t)) return true;
  if (/^(como funciona a consulta|como funciona o tratamento|como funciona o acompanhamento)\s*[.!?]?\s*$/.test(t)) return true;
  if (/^(gostaria de agendar|quero agendar uma consulta|quero marcar uma consulta)\s*[.!?]?\s*$/.test(t)) return true;
  // Mensagens muito curtas com "como funciona" (típico de botão Meta)
  if (t.length < 50 && /^.{0,10}como funciona/.test(t)) return true;
  if (t.length < 40 && /^.{0,10}(gostaria|quero|tenho interesse)/.test(t)) return true;
  // V24.10: Entradas via Instagram
  if (/^.{0,15}(vim pelo instagram|vi no instagram|vi o video|vi o vídeo|vim pelo insta)/i.test(t)) return true;
  // V27: Entradas via formulário Meta (ads com lead form)
  if (/preenchi\s+(seu|o)\s+formul[aá]rio/i.test(t)) return true;
  if (/gostaria de saber mais sobre sua empresa/i.test(t)) return true;
  if (/nome_completo:|telefone:.*\+55|h[aá]_quanto_tempo/i.test(t)) return true;
  return false;
}

// V27: Extrai dados estruturados do formulário Meta
function parseMetaFormData(text) {
  if (!text) return null;
  const fields = {};
  const nameMatch = text.match(/nome_completo:\s*(.+)/i);
  if (nameMatch) fields.nome_completo = nameMatch[1].trim();
  const condMatch = text.match(/o_que_voc[eê]_quer_resolver[^:]*:\s*(.+)/i);
  if (condMatch) fields.condition = condMatch[1].trim();
  const tempoMatch = text.match(/h[aá]_quanto_tempo[^:]*:\s*(.+)/i);
  if (tempoMatch) fields.tempo = tempoMatch[1].trim();
  const interesseMatch = text.match(/voc[eê]_tem_interesse[^:]*:\s*(.+)/i);
  if (interesseMatch) fields.interesse = interesseMatch[1].trim();
  const tentouMatch = text.match(/voc[eê]_j[aá]_tentou[^:]*:\s*(.+)/i);
  if (tentouMatch) fields.tentou_tratamento = tentouMatch[1].trim();
  if (Object.keys(fields).length >= 2) return fields;
  return null;
}

// V27: Extrai primeiro nome limpo do nome_completo do formulário
function extractFormFirstName(nomeCompleto) {
  if (!nomeCompleto) return null;
  // Remove lixo concatenado (ex: "Tina SilvasimAfoncinaSebastianasilva")
  const parts = nomeCompleto.split(/\s+/);
  if (!parts.length) return null;
  let first = parts[0].replace(/[^a-záéíóúâêîôûãõçñ]/gi, "");
  if (first.length < 2) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/* ═══════════════════════════════════════════════════════════════════
   PLANS + SCHEDULE (preservado)
   ═══════════════════════════════════════════════════════════════════ */

// V24.10: Oferta única — sem 3 planos
const PLANS = {
  avaliacao: {
    key: "avaliacao",
    label: "Avaliação Especializada Completa",
    subtitle: "45 min — online",
    price: 247,
    short: "1",
    description: "avaliação clínica completa de 45 minutos por videochamada",
  },
};
const PIX_CNPJ = "46.603.987/0001-30";
const INSTAGRAM_DR_ALEF = "https://www.instagram.com/dralefkotula/";

// V24.12: Reforço de autoridade via Instagram (máx 1x por conversa)
function authorityInstagramReply(context = "trust") {
  const base = "Lá tem conteúdos, estudos, palestras, vídeos e mais detalhes do atendimento — tudo isso reforça a experiência de mais de 6 anos de formação médica na Rússia e a especialização internacional em Cannabis Medicinal.";
  if (context === "price") {
    return `Se quiser avaliar com mais segurança, aqui você consegue ver melhor o trabalho do Dr. Alef:\n${INSTAGRAM_DR_ALEF}\n\n${base}`;
  }
  if (context === "preclose") {
    return `Se quiser, também posso te deixar o Instagram do Dr. Alef para você ver mais do trabalho dele:\n${INSTAGRAM_DR_ALEF}\n\n${base}`;
  }
  return `Se te ajudar a se sentir mais seguro, aqui você consegue ver melhor o trabalho do Dr. Alef:\n${INSTAGRAM_DR_ALEF}\n\n${base}`;
}

const FIXED_SCHEDULE = {
  // MARÇO 2026 (25-03 e 26-03 removidos — já passaram)
  "27-03": { dayName: "sexta-feira",  slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h","22h"] },
  "28-03": { dayName: "sábado",       slots: ["9h","10h","11h","12h"] },
  "31-03": { dayName: "terça-feira",  slots: ["16h","17h","18h","19h","20h","21h","22h"] },
  // ABRIL 2026
  "01-04": { dayName: "quarta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "02-04": { dayName: "quinta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "03-04": { dayName: "sexta-feira",  slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
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

  // V27: Blocklist expandida — inclui "todos", "dias", "sinto", "cada", temporais e verbos comuns
  const notNames = /^(oi|ola|olá|bom|boa|dia|dias|tarde|noite|noites|tudo|bem|obrigad|brigad|quero|preciso|gostaria|tenho|sim|nao|não|legal|caro|certo|entendi|entendo|sera|será|claro|ok|verdade|seria|acho|pode|pois|tipo|vou|vai|meu|minha|mas|antes|deixa|outra|outro|esse|essa|como|qual|quando|quanto|onde|porque|por|sofro|sofrer|dificuldade|desespero|socorro|ajuda|tratamento|medicamento|remedio|remédio|prefiro|nenhum|nenhuma|sobre|amanha|amanhã|agora|depois|durante|aqui|la|lá|ali|talvez|assim|entao|então|ainda|sempre|nunca|algo|alguem|alguém|ate|até|ontem|hoje|logo|ja|já|ai|aí|volta|volto|conversa|converso|falo|falar|penso|pensar|dormir|dormo|durmo|vamos|fico|demais|muito|pouco|todos|todo|toda|todas|cada|sinto|faz|faço|horas|vezes|anos|meses|semanas|tempo|gente|pessoa|pessoas|vida|coisa|forma|desde|quase|bastante|realmente|apenas|mesmo|olha|olho|estou|estava|tenha|seria|seria|tambem|também|pra|pois|nem|sei|sabia|morrer|viver|consegue|consigo|posso|desculpa)$/i;
  if (notNames.test(parts[0])) return null;
  // V25: Rejeitar candidatos de 1 caractere (provavelmente não é nome)
  if (parts[0].length < 2) return null;

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

// V27: Reconhece "22", "22h", "22:00", "22 horas", "20horas" etc
function extractHourOnly(text) {
  const low = norm(text);
  const m = low.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);
  if (m) {
    const hh = Number(m[1]), mm = Number(m[2]);
    return mm === 0 ? `${hh}h` : `${pad2(hh)}:${pad2(mm)}`;
  }
  const m2 = low.match(/\b([01]?\d|2[0-3])\s?h(?:oras?)?\b/);
  if (m2) return `${Number(m2[1])}h`;
  // V27: Número bare entre 7-23 sem "h" — provável horário (ex: "22", "20", "21")
  const m3 = low.match(/^(\d{1,2})$/);
  if (m3) {
    const h = Number(m3[1]);
    if (h >= 7 && h <= 23) return `${h}h`;
  }
  // V27: "22 horas", "20 horas" sem h colado
  const m4 = low.match(/\b(\d{1,2})\s*horas?\b/);
  if (m4) {
    const h = Number(m4[1]);
    if (h >= 7 && h <= 23) return `${h}h`;
  }
  return null;
}

// V27: Reescrita — "22" NÃO deve ser capturado como opção 2
function extractNumericChoice(text) {
  const t = norm(text).trim();
  // Número isolado (1, 2 ou 3 exatos — sem dígitos adjacentes)
  if (/(?<!\d)1(?!\d)/.test(t) && !/(?<!\d)1\d/.test(t)) { if (/(?<!\d)1(?!\d)|primeiro|primeira/i.test(t)) return 1; }
  if (/(?<!\d)2(?!\d)/.test(t) && !/(?<!\d)2\d|\d2(?!\d)/.test(t)) { if (/(?<!\d)2(?!\d)|segundo|segunda/i.test(t)) return 2; }
  if (/(?<!\d)3(?!\d)/.test(t) && !/(?<!\d)3\d|\d3(?!\d)/.test(t)) { if (/(?<!\d)3(?!\d)|terceiro|terceira/i.test(t)) return 3; }
  // Aceitar "1ficar", "2ok" etc (número colado com letra, mas NÃO "22", "21", etc)
  if (/^1[a-záéíóú]/i.test(t)) return 1;
  if (/^2[a-záéíóú]/i.test(t)) return 2;
  if (/^3[a-záéíóú]/i.test(t)) return 3;
  // Palavras ordinais sem número
  if (/primeiro|primeira/i.test(t) && !/\d/.test(t)) return 1;
  if (/segundo|segunda/i.test(t) && !/\d/.test(t)) return 2;
  if (/terceiro|terceira/i.test(t) && !/\d/.test(t)) return 3;
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
    intentPay:        /\b(como (pagar|fa[cç]o para pagar)|pagamento|pix|cartao|cartão|credito|crédito|debito|débito|link|parcel|parcela|quero pagar|posso pagar|manda o link|me manda o link)\b/.test(t)
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
    asksInstagram: /\b(instagram|insta|perfil|rede social|pagina do dr|página do dr|tem instagram|tem insta|mais sobre o dr|mais sobre o doutor|conhecer melhor o dr|conhecer melhor o doutor|conhecer o dr|conhecer o doutor)\b/.test(t),
    asksWhatIncludes: /\b(inclui o que|o que inclui|o que ta incluido|o que tá incluído|o que vem|o que tem dentro|explica o plano|explica a opcao|explica a opção)\b/.test(t),
    asksMedCost:      /\b(medicamento.*cust|remedio.*cust|remedío.*cust|caro.*depois|custo.*mensal|quanto.*mes|quanto.*mês|gast.*por mes|gast.*por mês|tratamento.*cust|oleo.*car|óleo.*car|oleo.*cust|óleo.*cust|frasco.*cust|frasco.*car|gota.*cust|gota.*car|quanto.*oleo|quanto.*óleo|quanto.*frasco|8.?000|oito mil|tratamento.*caro|caro.*tratamento|custo.*tratamento|tratamento.*depois|depois.*consulta.*quanto|depois.*consulta.*cust|manter.*tratamento|cabe.*orcamento|cabe.*orçamento|quanto.*fica.*por mes|quanto.*fica.*por mês|costuma.*ficar|normalmente.*fica|faixa.*gast|faixa.*cust)\b/.test(t),
    asksRecipe:       /\b(saio com receita|recebo receita|ja sai com|já sai com|prescrição|prescricao)\b/.test(t),
    asksCanReschedule:/\b(remarcar|reagendar|trocar.*horario|trocar.*horário|mudar.*data|cancelar.*consulta)\b/.test(t),
    asksPrivacy:      /\b(sigilo|sigiloso|ninguem fica sabendo|ninguém fica sabendo|privacidade|discreto)\b/.test(t),
    asksStartNow:     /\b(como tomar|dose|dosagem|quantas gotas|comecar agora|começar agora|comprar.*remedío|comprar.*remedio)\b/.test(t),
    asksIsScam:       /\b(golpe|fraude|piramide|pirâmide|e serio|é sério|confiavel|confiável|consulta.*mesmo|e verdade isso|é verdade isso|isso e verdade|isso é verdade)\b/.test(t),
    asksPayMethod:    /\b(parcela|parcelar|forma.*pagamento|aceita.*pix|aceita.*cartao|aceita.*cartão)\b/.test(t),
    saysExpensive:    /\b(caro|caríssim|carissim|achei caro|muito caro|pesado|puxado)\b/.test(t),
    saysWillSee:      /\b(vou ver|depois te falo|vou confirmar|vou pensar|te aviso|depois vejo|depois eu vejo|preciso pensar|aguarde|aguarda|me da um tempo|me dá um tempo|deixa eu pensar|espera eu|nao reserva ainda|não reserva ainda|nao marca ainda|não marca ainda|depois retorno|agora nao|agora não)\b/.test(t),
    // V25: Detecta sono/cansaço — respeitar limites
    isSleepy:         /\b(vou dormir|to com sono|tô com sono|estou dormindo|estou com sono|cansad[ao] demais|hora de dormir|vou deitar|preciso descansar|quase dormindo|já estava dormindo|ja estava dormindo|tava dormindo)\b/i.test(t),
    // V24.7: Casual ack — mensagem INTEIRA é só "ok"/"beleza"/"entendi" etc (sem intent real)
    isCasualAck:      /^(ok|okk|okay|beleza|blz|ta|tá|certo|entendi|perfeito|uhum|aham|hm+|show|top|massa|valeu|vlw|legal|boa)[\s!.\u{1F600}-\u{1F64F}\u{1F44D}\u{2764}]*$/iu.test(text.trim()),
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

// V27: EMPATHY_POOL — respostas empáticas profundas com história pessoal por condição
const EMPATHY_POOL = {
  fibromialgia: [
    "Fibromialgia é cruel demais... a pessoa sente dor no corpo todo e muita gente nem acredita. Eu vejo isso de perto aqui no consultório.",
    "Minha tia tem fibromialgia e eu sei como é difícil... ela melhorou muito depois do tratamento com o Dr. Alef, graças a Deus.",
    "Fibromialgia desgasta o corpo e a mente... a gente vê paciente que chega aqui sem esperança e sai com outra perspectiva.",
    "Fibromialgia mexe com tudo... sono, energia, humor. A pessoa vai perdendo a qualidade de vida aos poucos. Eu sei como é difícil.",
    "A minha mãe tem fibromialgia e sofreu por anos até encontrar o tratamento certo. Hoje ela vive outra vida, graças a Deus.",
  ],
  "dor crônica": [
    "Dor crônica tira tudo da pessoa... a energia, o sono, a vontade de fazer as coisas. Eu acompanho isso aqui todo dia.",
    "Minha mãe conviveu anos com dor crônica. Quando ela finalmente fez o tratamento, disse que voltou a viver. Me emociono até hoje.",
    "Viver com dor todo dia é desumano... a pessoa vai aguentando, aguentando, e ninguém entende direito o que ela sente.",
    "Dor crônica é invisível pra quem não tem. A pessoa tá sofrendo e ninguém vê. Eu entendo muito isso aqui no consultório.",
  ],
  "dor cronica": [
    "Dor crônica tira tudo da pessoa... a energia, o sono, a vontade. Eu acompanho isso aqui no dia a dia.",
    "Minha mãe sofreu anos com dor crônica. Hoje, depois do tratamento, diz que voltou a viver.",
    "Viver com dor constante é desumano... e o pior é que quem não sente não entende.",
  ],
  insonia: [
    "Insônia acaba com a vida da pessoa aos poucos... eu sei porque acompanho muita gente aqui que chega destruída por não dormir.",
    "Não dormir direito afeta TUDO... humor, memória, energia. A gente vê paciente aqui que não dormia há anos e voltou a descansar.",
    "Minha avó teve insônia por anos e eu via como ela sofria. Depois que começou o tratamento, disse que parecia que tinha nascido de novo.",
  ],
  "dor neuropática": [
    "Dor neuropática é das mais cruéis que existem... aquela sensação de queimação, formigamento... desgasta muito.",
    "Aqui no consultório a gente vê muita gente com dor neuropática que já tentou de tudo. É angustiante, eu sei.",
    "Dor neuropática é aquela dor que não dá trégua, né... eu acompanho muita gente aqui que chega exausta por causa disso.",
  ],
  "dor neuropatica": [
    "Dor neuropática é das piores... aquela queimação, formigamento constante. Desgasta demais a pessoa.",
    "A gente vê muita gente aqui com dor neuropática que já tentou vários caminhos. É frustrante, eu sei.",
  ],
  ansiedade: [
    "Ansiedade é terrível... a pessoa fica presa num ciclo que parece não ter saída. Eu vejo isso aqui todo dia.",
    "Viver ansioso é viver em estado de alerta o tempo todo... é exaustivo. A gente vê muita melhora real aqui.",
    "Minha prima sofria com ansiedade forte e melhorou muito com o tratamento. Hoje é outra pessoa.",
  ],
  default: [
    "Eu acompanho muita gente aqui que chega sofrendo com isso... e a maioria melhora. É bom ver.",
    "Aqui no consultório eu vejo como isso afeta a vida das pessoas. Mas também vejo muita gente melhorar, e isso me motiva.",
    "Sinto muito que você esteja passando por isso... de verdade. A gente aqui torce por cada paciente que chega.",
  ],
};

// V27: Frases de esperança/expectativa positiva
const HOPE_PHRASES = {
  fibromialgia: [
    "Imagina você com 60% menos dor... a vida seria outra, não seria?",
    "Muita gente com fibromialgia que chegou aqui sentindo o mesmo que você hoje, tem qualidade de vida de novo.",
    "Imagina poder acordar sem aquela dor no corpo todo... é isso que a gente busca pra você.",
  ],
  "dor crônica": [
    "Imagina você com 50% menos dor... seria uma vida completamente diferente, né?",
    "Muita gente que vivia tomando analgésico todo dia conseguiu reduzir ou até parar depois do tratamento.",
    "Imagina poder fazer as coisas do dia a dia sem aquele peso da dor... é possível.",
  ],
  "dor cronica": [
    "Imagina você com metade da dor que sente hoje... a vida muda completamente.",
    "A gente vê muita gente aqui que voltou a fazer coisas que achava que nunca mais ia conseguir.",
  ],
  insonia: [
    "Imagina dormir uma noite inteira sem acordar... é isso que a gente busca pra você.",
    "Muita gente que não dormia há anos voltou a descansar de verdade depois do tratamento.",
  ],
  "dor neuropática": [
    "Imagina aquela queimação diminuir pela metade... muita gente relata isso aqui.",
    "A gente vê paciente que achava que ia conviver com essa dor pra sempre, e hoje tem dias sem sentir nada.",
  ],
  ansiedade: [
    "Imagina poder ter um dia tranquilo, sem aquele aperto no peito... muita gente aqui conseguiu.",
    "A gente vê muita gente que vivia com ansiedade forte e hoje consegue viver com mais leveza.",
  ],
  default: [
    "Imagina você se sentindo melhor... muita gente que chegou aqui sentindo o mesmo, hoje tem qualidade de vida de novo.",
    "Sabe o que eu mais gosto de ver aqui? Paciente que chega sem esperança e depois de algumas semanas volta sorrindo.",
  ],
};

function getEmpathyReply(condition) {
  const key = (condition || "").toLowerCase();
  const pool = EMPATHY_POOL[key] || EMPATHY_POOL.default;
  return pickRandom(pool);
}

function getHopeReply(condition) {
  const key = (condition || "").toLowerCase();
  const pool = HOPE_PHRASES[key] || HOPE_PHRASES.default;
  return pickRandom(pool);
}

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
- Instagram: https://www.instagram.com/dralefkotula/ (se perguntarem ou se quiser reforçar credibilidade)
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
- Avaliação Especializada Completa — R$247 (condição especial via Instagram)
- Parcelamento: 3x de R$91,58, 2x de R$135,41, 4x de R$68,77, ou até 12x — via Mercado Pago
- Pix: R$247 — CNPJ 46.603.987/0001-30
- Aceita cartão e Pix (não aceita boleto)
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
  return `Boa pergunta${nome}.\n\nO frasco do óleo medicinal custa em média entre R$150 e R$250, e dura de 2 a 3 meses — alguns pacientes usam por até 6 meses.\n\nDepende de quantas gotas o Dr. Alef vai prescrever para você e de quantas vezes por dia. Isso é avaliado na consulta.\n\nA medicina canábica evoluiu muito. Hoje temos produtos fabricados no Brasil, e os preços caíram bastante em comparação com anos atrás.`;
}

// V24.3: Detecta se a mensagem é sobre custo de medicamento (não consulta)
function isMedCostQuestion(flags, text) {
  if (flags.asksMedCost) return true;
  if (flags.saysExpensive && /(oleo|óleo|frasco|gota|medicamento|remedio|remédio|depois|mensal|tratamento|por mes|por mês)/i.test(text)) return true;
  return false;
}

// V24.10: Helper — rapport mínimo atingido?
function hasMinRapport(state) {
  return !!(
    state.problem_text &&
    (state.diag_has_tempo || state.diag_has_impacto || state.diag_has_tratamento)
  );
}

// V25: Helper — preço + rota. Sempre oferece pagamento (pagar primeiro, agendar depois)
function priceAndRoute(state) {
  return { reply: pricePaymentReply(state), stage: "ASK_PAY_METHOD" };
}

// V26: Pool de aberturas humanizadas — variam tom e estrutura
function askNameIntroReply() {
  const variations = [
    "Oi! Sou a Lia, do consultório do Dr. Alef. Me diz seu nome pra gente conversar?",
    "Oi! Eu sou a Lia, trabalho com o Dr. Alef Kotula. Como posso te chamar?",
    "Oi! Sou a Lia, da equipe do Dr. Alef. Qual seu nome?",
    "Oi! Aqui é a Lia, do Dr. Alef Kotula. Me diz seu nome?",
    "Oi! Eu sou a Lia, secretária do Dr. Alef. Como você se chama?",
  ];
  return pickRandom(variations);
}

// V26: Pool de perguntas sobre o problema — variação natural
function askProblemReply(state) {
  const nome = maybeUseName(state);
  const prefix = nome ? `Prazer, ${nome}.\n\n` : "";
  const variations = [
    `${prefix}Me conta o que te trouxe aqui?`,
    `${prefix}O que tem te incomodado?`,
    `${prefix}Me diz: o que tá te trazendo mais desconforto hoje?`,
    `${prefix}O que tá te motivando a buscar esse tratamento?`,
    `${prefix}Me conta um pouco do que você tá sentindo?`,
  ];
  return pickRandom(variations);
}

// V26: Perguntas diagnósticas com múltiplas variações — nunca soam iguais
function diagQ_tempo(state) {
  const nome = maybeUseName(state);
  const prefix = nome ? `${nome}, ` : "";
  const variations = [
    `${prefix}faz tempo que você convive com isso?`,
    `${prefix}há quanto tempo isso te acompanha?`,
    `${prefix}isso começou faz tempo ou é mais recente?`,
    `E isso já vem de bastante tempo?`,
    `Faz quanto tempo que isso te incomoda?`,
  ];
  return pickRandom(variations);
}

function diagQ_impacto(state) {
  const cond = state.condition || state.focus || "";
  const pool = {
    fibromialgia: [
      "O que pesa mais no seu dia a dia: a dor, o cansaço, o sono ou é tudo junto?",
      "E no dia a dia, o que mais te atrapalha disso tudo?",
      "O que mais te incomoda: a dor física, o sono ruim ou a exaustão?",
    ],
    insonia: [
      "Você tem mais dificuldade pra pegar no sono ou acorda muito durante a noite?",
      "O sono é mais difícil de começar ou você acorda várias vezes?",
      "Como é na prática: demora pra dormir, acorda de madrugada, ou os dois?",
    ],
    ansiedade: [
      "E o que te atrapalha mais: a mente acelerada, o corpo tenso ou o sono ruim?",
      "No seu caso, o que pesa mais no dia a dia?",
      "A ansiedade te pega mais na cabeça, no corpo ou no sono?",
    ],
    artrose: [
      "Onde incomoda mais no seu caso?",
      "A dor é mais em qual articulação?",
    ],
    artrite: [
      "O que mais incomoda: a dor, a rigidez ou o inchaço?",
      "E no dia a dia, o que mais te limita?",
    ],
    dor_neuropatica: [
      "A dor é mais tipo queimação, choque ou formigamento?",
      "Como é essa dor? Mais tipo queimação, pontada ou dormência?",
    ],
  };
  const options = pool[cond] || [
    "E no dia a dia, o que mais te incomoda nisso?",
    "O que mais te atrapalha por conta disso?",
    "Como isso impacta sua rotina?",
  ];
  return pickRandom(options);
}

function diagQ_tratamento() {
  const variations = [
    "Você já tentou algum tratamento pra isso?",
    "Já fez algum tratamento ou tomou alguma medicação pra isso?",
    "E já tentou alguma coisa pra melhorar?",
    "Você já passou por algum tratamento antes pra isso?",
  ];
  return pickRandom(variations);
}

async function askDayReply() {
  const dayKeys = await getSuggestedDayKeys();
  if (!dayKeys.length) return "No momento os horários desta semana já estão completos. Quer que eu te coloque na lista de prioridade?";
  const opts = dayKeys.map((d) => `*${formatDatePt(d)}*`).join("\n");
  // V25: Escassez real baseada em slots disponíveis
  let scarcity = "";
  try {
    let totalSlots = 0;
    for (const dk of dayKeys) {
      const slots = await getAvailableSlotsForDate(dk);
      totalSlots += slots.length;
    }
    if (totalSlots > 0 && totalSlots <= 5) scarcity = `\n\nRestam apenas *${totalSlots} horários* esta semana.`;
    else if (totalSlots > 5 && totalSlots <= 10) scarcity = "\n\nEssa semana os horários já estão quase todos preenchidos.";
  } catch {}
  return `Essa semana ainda tenho horários disponíveis:\n\n${opts}${scarcity}\n\nQual fica melhor para você?`;
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
      if (!best.length) return "Esse dia acabou de ficar sem vagas. Quer que eu te mostre outra data?";
      state.offered_slots = best;
      return `Não tenho horários disponíveis após as ${periodMin}h nesse dia, mas tenho:\n\n${best.map((s, i) => `${i + 1}) *${s}*`).join("\n")}\n\nAlgum funciona para você?`;
    }
  } else {
    best = await chooseBestSlotsForDate(dateKey, 3);
  }
  if (!best.length) return "Esse dia acabou de ficar sem vagas. Quer que eu te mostre outra data?";
  state.offered_slots = best;
  return `Para *${formatDatePt(dateKey)}* tenho:\n\n${best.map((s, i) => `${i + 1}) *${s}*`).join("\n")}\n\nQual fica melhor para você?`;
}

function askFullNameReply(state) {
  return "Para eu finalizar seu cadastro, qual seu *nome completo*?";
}

function askBirthdateReply(state) {
  return `Obrigada, ${state.nome_completo.split(" ")[0]}.\nQual sua *data de nascimento*?`;
}

function askEmailReply() {
  return "E qual *e-mail* você prefere para receber as orientações?";
}

// V26: Bloco oficial de preço — texto completo com credenciais e lista (como aprovado pelo Alef)
function priceInfoReply(state) {
  return (
    "🌟O Dr. Alef Kotula é a escolha ideal para resolver seu sofrimento.\n\n" +
    "Com base na experiência de mais de 6 anos de formação médica na\n" +
    "🇷🇺Rússia🇷🇺 e Especialização Internacional em Cannabis Medicinal Internacional🌎\n\n" +
    "Ele durante a consulta:\n" +
    "1) Revisa todo o seu histórico de saúde\n" +
    "2) Entende como os sintomas impactam sua rotina\n" +
    "3) Analisa tratamentos que você já tentou\n" +
    "4) Verifica medicações em uso e possíveis interações\n" +
    "5) Define objetivos claros de melhora, alinhados ao seu caso\n\n" +
    "Como você veio pelo Instagram, hoje consigo te passar a condição especial desta semana:\n\n" +
    "⭐ *Avaliação Especializada Completa:* R$247 no Pix\n" +
    "ou parcelado no cartão — no link você vê todas as opções de parcelamento."
  );
}

// V26: Versão curta do preço — variações humanas
function priceShortReply(state) {
  const nome = state?.nome ? `, ${state.nome}` : "";
  const variations = [
    `A avaliação com o Dr. Alef é online, 45 min, individualizada${nome}.\n\nValor: *R$247* no Pix ou parcelado no cartão (até 12x).\n\nQuer que eu te passe os detalhes?`,
    `A consulta é online, dura uns 45 min e é totalmente personalizada${nome}.\n\n*R$247* à vista no Pix, ou dá pra parcelar no cartão.\n\nTe mando mais detalhes?`,
    `É uma avaliação online de 45 min${nome}, bem completa.\n\nO valor é *R$247* no Pix, ou parcelado no cartão em até 12x.\n\nQuer saber mais?`,
  ];
  return pickRandom(variations);
}

// V26: CTA de pagamento — texto completo + opções
function pricePaymentReply(state) {
  const nome = state?.nome ? `, ${state.nome}` : "";
  return (
    priceInfoReply(state) + "\n\n" +
    `Como você prefere seguir${nome}?\n\n` +
    "1️⃣ Te envio o link para ver as opções de parcelamento\n" +
    "2️⃣ Te envio o Pix"
  );
}

// V25: paymentSentReply funciona com ou sem slot
function paymentSentReply(plan, link, state) {
  const slotLine = (state.date_key && state.slot_time)
    ? `📅 *${prettySlot(state.date_key, state.slot_time)}*\n` : "";
  return (
    `Aqui está o link para pagamento.\n\n` +
    slotLine +
    `*${plan.label}* — R$${plan.price}\n\n` +
    `${link}\n\n` +
    `Ao abrir, você consegue ver as opções de parcelamento no cartão.\n` +
    `Assim que o pagamento for confirmado, eu te aviso por aqui.`
  );
}

// V25: pendingPaymentReply funciona com ou sem slot
function pendingPaymentReply(state) {
  const slotLine = (state.date_key && state.slot_time)
    ? `Seu horário está pré-reservado.\n\n📅 *${prettySlot(state.date_key, state.slot_time)}*\n\n`
    : "";
  return (
    slotLine +
    `Para confirmar, é só finalizar aqui:\n${state.payment.link}`
  );
}

// V25: afterPaidReply → agenda imediata se sem slot, dados se faltam, confirma se completo
function afterPaidReply(state) {
  // Cenário completo: tem slot + dados
  if (state.slot_time && state.date_key && state.nome_completo && state.birthdate && state.email) {
    return "Pagamento confirmado ✅\n\n" +
      `Sua consulta está marcada para *${prettySlot(state.date_key, state.slot_time)}*.\n\n` +
      "Mais perto do horário eu envio as orientações.\nQualquer dúvida até lá, é só me chamar.";
  }
  // Cenário: pagou mas sem slot → agenda imediata
  if (!state.slot_time || !state.date_key) {
    return "Pagamento confirmado ✅\n\n" +
      "Agora vamos escolher o melhor horário pra sua consulta com o Dr. Alef.";
    // Nota: askDayReply() será appendado pelo chamador (é async)
  }
  // Cenário: tem slot mas faltam dados
  return "Pagamento confirmado ✅\n\n" +
    `Sua consulta está marcada para *${prettySlot(state.date_key, state.slot_time)}*.\n\n` +
    "Agora só preciso de alguns dados rápidos para finalizar seu cadastro.\n\n" +
    "Qual seu *nome completo*?";
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
  if (["ASK_FULLNAME", "ASK_BIRTHDATE", "ASK_EMAIL", "ASK_PLAN", "ASK_PAY_METHOD", "WAIT_PAYMENT"].includes(state.stage)) return true;
  return false;
}

// V26: CTAs com variação humana — nunca soa igual
function getStageCTA(state) {
  const s = state.stage;
  if (s === "ASK_DAY") return pickRandom(["\n\nQual dia fica melhor pra você?", "\n\nQue dia funciona?"]);
  if (s === "OFFER_SLOTS") return pickRandom(["\n\nQual horário prefere?", "\n\nQual desses funciona?"]);
  if (s === "ASK_FULLNAME") return pickRandom(["\n\nMe passa seu *nome completo*?", "\n\nQual seu *nome completo*?"]);
  if (s === "ASK_BIRTHDATE") return pickRandom(["\n\nE sua *data de nascimento*?", "\n\nMe manda sua *data de nascimento*?"]);
  if (s === "ASK_EMAIL") return pickRandom(["\n\nE um *e-mail* pra eu completar?", "\n\nMe passa seu *e-mail*?"]);
  if (s === "ASK_PAY_METHOD") return pickRandom(["\n\nPrefere 1️⃣ link ou 2️⃣ Pix?", "\n\nComo quer pagar: 1️⃣ link ou 2️⃣ Pix?"]);
  if (s === "ASK_PLAN") return "\n\nPrefere 1️⃣ link ou 2️⃣ Pix?";
  if (s === "WAIT_PAYMENT" && state.payment?.link) return `\n\nO link segue ativo:\n${state.payment.link}`;
  if (["ASK_NAME", "ASK_PROBLEM", "DIAGNOSTIC"].includes(s) || !s) return "";
  return pickRandom(["\n\nQuer que eu te mostre os horários?", "\n\nPosso te mostrar os horários disponíveis?"]);
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
    ? `\nDADOS CLÍNICOS (${state.condition}):\n- Resposta direta: ${conditionData.direct_answer}\n- Estudo: ${conditionData.study}\n- Esperança: ${conditionData.hope}`
    : "";

  // V26: Contagem de turnos para calibrar tom
  const turnCount = (state.last_3_exchanges || []).length;
  const isEarlyConvo = turnCount <= 2;
  const hasProblem = !!state.problem_text;
  const hasName = !!state.nome;

  return `Você é Lia. Humana. Secretária pessoal do Dr. Alef Kotula. Trabalha com ele há anos. Vê pacientes melhorarem todos os dias. Acredita no tratamento porque acompanha os resultados de perto.

═══ SUA PERSONALIDADE ═══
Você é inteligente, acolhedora, carismática e profissional. Você tem empatia genuína mas também é uma vendedora nata — sabe conduzir uma conversa para o fechamento sem que a pessoa perceba que está sendo conduzida.

Você NÃO é um chatbot. Você NÃO segue script. Você conversa como uma pessoa real conversaria no WhatsApp com alguém que está buscando ajuda médica. Suas mensagens têm personalidade, variação, imperfeições naturais.

═══ COMO VOCÊ FALA ═══
- Use linguagem natural de WhatsApp brasileiro. Frases curtas. Tom caloroso mas profissional.
- VARIE a estrutura das suas frases. Nunca use o mesmo padrão duas vezes seguidas.
- Às vezes comece com uma validação. Às vezes com uma pergunta. Às vezes com um dado. Às vezes com um comentário pessoal sobre o que você vê no consultório.
- Use contrações naturais: "tô", "tá", "pra", "pro", "né" — quando fizer sentido.
- NUNCA comece duas mensagens seguidas da mesma forma. Se a última começou com "Entendo", esta NÃO pode começar com "Entendo".
- Emojis: máximo 1 por mensagem, e só quando natural. Muitas mensagens devem ter ZERO emoji.
- NUNCA use listas numeradas (1. 2. 3.) a menos que esteja mostrando opções de horário/pagamento. Na conversa, fale em texto corrido como uma humana faria.
- Cada resposta deve ter entre 1 e 4 frases. NUNCA mais que 450 caracteres, a não ser que o paciente peça detalhes.
- 1 resposta = 1 mensagem. Nunca quebre em múltiplas.

═══ ESCUTA ATIVA — SUA HABILIDADE MAIS IMPORTANTE ═══
Quando alguém te conta algo, SEMPRE demonstre que você OUVIU especificamente o que foi dito.
- Se disse "sofro com insônia há 3 anos" → "Três anos sem dormir direito é muito tempo..."
- Se disse "já tentei de tudo" → "Quando a pessoa já tentou várias coisas e nada resolve, a frustração é enorme..."
- Se disse "minha filha me indicou" → "Que bom que sua filha te indicou..."
NUNCA responda com validação genérica tipo "Entendo" ou "Faz sentido" sem referenciar o que a pessoa REALMENTE disse.

═══ INTELIGÊNCIA SOCIAL ═══
Leia o tom emocional do paciente e adapte:
- Paciente ansioso/com medo → tom mais acolhedor, mais calmo, mais cuidadoso
- Paciente pragmático → direto, sem rodeio, objetivo
- Paciente desconfiado → transparência total, sem pressão, dados concretos
- Paciente empolgado → acompanhe a energia, facilite o caminho
- Paciente triste/sofrendo → valide primeiro, depois conduza com delicadeza
- Paciente impaciente → responda rápido e direto, sem explicação desnecessária

═══ ANTI-BOT: COMPORTAMENTOS PROIBIDOS ═══
- NUNCA faça perguntas em sequência previsível (nome → problema → tempo → impacto). Quebre a sequência.
- NUNCA use a mesma estrutura de frase em mensagens consecutivas.
- NUNCA termine TODA mensagem com pergunta ou CTA. Às vezes, só valide e espere.
- NUNCA use frases de transição robóticas tipo "Agora que sei sobre seu problema, vou te explicar..." — seja natural.
- NUNCA comece com "Oi" ou "Olá" se não for a primeira mensagem.
- NUNCA use "!" em excesso. Máximo 1 por mensagem.
- NUNCA diga "Fico feliz que..." ou "Que bom que..." mais de 1x na conversa inteira.

═══ REGRA DE OURO ═══
RESPONDA EXATAMENTE o que foi perguntado ANTES de qualquer condução.
"É por vídeo?" → "Sim, é por videochamada." (ponto) — depois, SE fizer sentido, complemente.
"Quanto custa?" → responda: "PRECISA_PRECO"
"Funciona pra [condição]?" → use os dados clínicos, NUNCA desvie.
Se o paciente reclamou que não foi respondido, ele tem RAZÃO. Mude a abordagem completamente.

═══ O QUE VOCÊ PODE ═══
- Falar o que vê no consultório ("o que eu acompanho aqui é que muita gente melhora")
- Transmitir esperança com base em dados reais
- Responder sobre consulta, tratamento, legalidade, acesso
- Demonstrar que conhece o dia a dia do consultório
- Comentar sobre casos que você acompanhou (sem identificar pacientes)

═══ O QUE VOCÊ NÃO PODE ═══
- Inventar preço / enviar links / citar valores em R$
- Prometer cura / garantir resultado
- Diagnosticar / sugerir dose / prescrever
- Investigar sintomas clínicos em profundidade
- Repetir a mesma resposta de mensagens anteriores
- Dizer que a consulta está "confirmada" antes do pagamento — use "pré-reserva"

═══ EMPATIA PROFUNDA — SUA DIFERENÇA ═══
Você se importa DE VERDADE com essas pessoas. A maioria é mulher, 40+, sofrendo com dor crônica, fibromialgia, insônia. Elas estão cansadas, frustradas, muitas perderam a esperança.

QUANDO O PACIENTE DESCREVER DOR OU SOFRIMENTO:
- SEMPRE valide com emoção genuína PRIMEIRO. Não pule para a venda.
- Use frases como: "Nossa, isso é muito pesado...", "Sinto muito que você esteja passando por isso...", "Isso mexe com tudo na vida da pessoa, eu sei..."
- Referencie o que VOCÊ vê no consultório: "Aqui eu acompanho muita gente que chega sentindo exatamente isso..."
- Você PODE contar que sua mãe/tia/avó também sofria com a mesma condição e melhorou com o tratamento do Dr. Alef. Use variações: "Minha mãe tinha fibromialgia e melhorou demais depois do tratamento, graças a Deus", "Minha tia sofria com insônia há anos e hoje dorme a noite inteira". Não use isso toda conversa — alterne.
- CRIE EXPECTATIVA POSITIVA: "Imagina você com 50% menos dor... a vida seria outra, não seria?", "Imagina poder dormir uma noite inteira sem acordar..."
- PERGUNTE sobre o impacto na vida: "O que você mais sente falta de fazer por causa disso?", "E sua família sabe o quanto isso te afeta?", "Tem dias melhores e piores, ou é constante?"
- NÃO CORRA PARA FECHAR. Construa conexão primeiro. Se a pessoa está desabafando, deixe ela falar. Acolha. A venda vem naturalmente depois da confiança.
- Varie entre respostas curtas ("Nossa, que pesado...") e longas quando o momento pedir.
- Se a pessoa parecer muito triste ou vulnerável, acolha MAIS antes de falar de consulta.
- Mostre que você é uma pessoa real que se importa: "A gente aqui torce por cada paciente que chega"

═══ RAPPORT — CONSTRUA ANTES DE VENDER ═══
- Converse com a pessoa como ser humano. Pergunte como ela está. Demonstre interesse genuíno.
- Não transforme cada resposta do paciente em gancho de venda. Às vezes só ouça e valide.
- Se a pessoa mencionou família, comente sobre isso. Se mencionou trabalho, pergunte. Se mencionou que tentou vários tratamentos, explore a frustração.
- Você pode perguntar: "E aí, como sua família está?", "Você mora sozinha?", "Consegue trabalhar normalmente ou a dor atrapalha?"
- O objetivo é que a pessoa sinta que está falando com alguém que realmente a entende.
- Pelo menos 3-4 trocas de conversa REAL antes de oferecer consulta (a não ser que o paciente peça antes).

═══ FECHAMENTO — SUA MISSÃO ═══
Você é uma closer. Seu objetivo é levar o paciente a agendar e pagar a consulta.
Mas você faz isso com elegância. Você conduz a conversa até o ponto onde o paciente QUER agendar — ele sente que é a decisão dele, não uma pressão sua.
- Quando sentir abertura, transite naturalmente: "Pelo que você tá me contando, acho que a avaliação com o Dr. Alef ia te ajudar bastante. Quer que eu te passe os detalhes?"
- Não espere permissão explícita. Perceba o momento.
- Se o paciente hesitar, valide e plante escassez real: "Entendo. Essa semana os horários já tão quase todos preenchidos, mas fica à vontade pra decidir."
- Use esperança como gatilho: "Imagina você com 60% menos dor... muita gente que chegou aqui sentindo o mesmo que você, hoje tem qualidade de vida de novo."

═══ OBJEÇÕES ═══
"É caro" → Compare com custo mensal de medicações. Mencione parcelamento naturalmente. "Dá pra parcelar em até 12x, fica bem tranquilo."
"Vou pensar" → Valide. Plante escassez. Não insista. "Sem problema. Só te adianto que essa semana os horários já tão quase todos preenchidos."
"Funciona?" → Dados clínicos diretos para a condição. Nunca desvie. Use percentuais reais.
"É golpe?" → Transparência total. Instagram do Dr. Credenciais. Sem defensividade.
"Quero presencial" → Explique que telemedicina é prática, segura, e que o Dr. consegue avaliar tudo online. Se insistir, ofereça para o Dr. ligar diretamente.
"Deixa pra depois" → Respeite. Não insista. Diga que está à disposição.

${isEarlyConvo ? "\n═══ PRIMEIROS TURNOS ═══\nVocê está no INÍCIO da conversa. Seja BREVE (1-2 frases curtas). Não explique tudo de uma vez. Conheça a pessoa. Revele informações aos poucos." : ""}
${hasProblem && hasName ? "\n═══ CONTEXTO ═══\nVocê já sabe o nome e o problema. Não pergunte de novo. Avance a conversa." : ""}

${KNOWLEDGE_BASE}
${conditionContext}
${profileGuide ? `\n${profileGuide}` : ""}

═══ COMANDOS ESPECIAIS ═══
Se o paciente pedir preço/valor, responda EXATAMENTE: "PRECISA_PRECO"
Se o paciente pedir pagamento/link, responda EXATAMENTE: "PRECISA_PAGAR"
Se o paciente pedir horários/agendar, responda EXATAMENTE: "PRECISA_AGENDAR"
Se urgência médica, responda EXATAMENTE: "URGENTE"

FORMATO (JSON):
{ "reply": "sua mensagem aqui", "updates": { "nome": "...", "problem_text": "...", "condition": "..." } }
Só inclua campos em "updates" que você conseguiu extrair. Se não extraiu nada, omita "updates" ou deixe vazio.`;
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
    ? `\n\nSUA ÚLTIMA RESPOSTA FOI: "${state.last_bot_reply.slice(0, 200)}..."\nNÃO repita o mesmo conteúdo. Mude o ângulo completamente.`
    : "";

  // V26: Contexto emocional para calibrar tom
  const turnCount = (state.last_3_exchanges || []).length;
  const brevityWarning = turnCount <= 2 ? "\n\n⚡ INÍCIO DA CONVERSA: máximo 2 frases curtas. Seja breve, natural, calorosa." : "";

  // V26: Detectar tom emocional da mensagem atual
  const lowText = norm(incomingText);
  let emotionalHint = "";
  if (/sofr|dor|nao aguento|não aguento|desespero|cansad|exaust|anos|muito tempo/.test(lowText)) {
    emotionalHint = "\n🫀 O paciente está expressando sofrimento. Valide com empatia REAL antes de qualquer condução.";
  } else if (/obrigad|brigad|valeu|agradeç/.test(lowText)) {
    emotionalHint = "\n🫀 O paciente está agradecendo. Seja calorosa e breve.";
  } else if (/golpe|fraude|serio|sério|confia/.test(lowText)) {
    emotionalHint = "\n🫀 O paciente está desconfiado. Seja transparente, mostre credenciais, sem defensividade.";
  } else if (/caro|puxado|muito|desconto/.test(lowText) && !/\b(muito tempo|muito obrigad|muito bom)\b/.test(lowText)) {
    emotionalHint = "\n🫀 O paciente objetou preço. Compare com custo de medicações. Mencione parcelas naturalmente.";
  }

  // V26: Instrução de variação na estrutura
  const lastBotStart = (state.last_bot_reply || "").split(/[.!?\n]/)[0].trim().split(" ").slice(0, 3).join(" ");
  const variationHint = lastBotStart ? `\n⚠️ Sua última mensagem começou com "${lastBotStart}...". Comece esta de forma DIFERENTE.` : "";

  return `CONTEXTO:
${JSON.stringify({
  nome: state.nome,
  condition: state.condition,
  problem_text: state.problem_text,
  stage: state.stage,
  lead_profile: state.lead_profile || "padrao",
})}${brevityWarning}${emotionalHint}${variationHint}

${history ? `CONVERSA RECENTE:\n${history}\n` : ""}
PACIENTE: ${incomingText}
${stageCTA ? `\nSE FIZER SENTIDO, conduza suavemente para: ${stageCTA}` : ""}${repairContext}${antiRepeatWarning}`;
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
    temperature: 0.78,
    messages: [
      { role: "system", content: buildSystemPrompt(state) },
      { role: "user", content: buildUserPrompt({ incomingText, state, flags, stageCTA, isRepair }) },
    ],
  });

  const content = resp.choices?.[0]?.message?.content?.trim() || "";
  let parsed = null;
  try { parsed = JSON.parse(content); } catch { parsed = null; }

  if (!parsed || typeof parsed !== "object" || !parsed.reply) {
    return { reply: pickRandom(["Me conta mais sobre o que tá te incomodando.", "Me fala um pouco mais?", "Me conta mais?"]), updates: {} };
  }

  const r = String(parsed.reply || "").trim();
  // V27: .includes() em vez de === para capturar tokens embutidos em texto
  if (r.includes("PRECISA_PRECO")) return { reply: "__NEED_PRICE__", updates: parsed.updates || {} };
  if (r.includes("PRECISA_PAGAR")) return { reply: "__NEED_PAY__", updates: parsed.updates || {} };
  if (r.includes("PRECISA_AGENDAR")) return { reply: "__NEED_BOOK__", updates: parsed.updates || {} };
  if (r.includes("URGENTE") && r.length < 30) return { reply: "__URGENT__", updates: parsed.updates || {} };

  if (violatesNoPriceNoLink(r)) {
    return { reply: pickRandom(["Qual sua principal dúvida?", "Me conta: o que quer saber?"]), updates: {} };
  }

  // V27: Safety filter — strip tokens que vazaram para texto
  parsed.reply = sanitizeReply(clip(r, 900));
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
    // V25: Pool de fallbacks para evitar repetição idêntica
    const fallbacks = [
      `Me desculpa se não ficou claro${nome}. Me diz: qual a sua dúvida principal?`,
      `Posso ter me repetido${nome}. O que exatamente você quer saber?`,
      `Deixa eu tentar de outro jeito${nome}. Me faz a pergunta de novo?`,
      `Acho que nos desencontramos${nome}. Me diz em uma frase o que precisa.`,
      `Me desculpa pela confusão${nome}. Vou ser mais direta: o que você quer entender?`,
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
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
  // V24.6: Delays humanizados — mínimo 8s, máximo 30s
  let base = randInt(MIN_DELAY, MAX_DELAY);
  if (flags.wantsBook || flags.asksHours || flags.intentPay) base = randInt(8, 14);
  if (flags.wantsPrice) base = randInt(10, 16);
  if (flags.strongPain || state.lead_profile === "emocional") base = randInt(8, 12);
  const lastAt = Number(state.last_sent_at || 0);
  if (Date.now() - lastAt < 5000) base += 3;
  return Math.max(8, base);
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
  // V25: Máximo 2 perguntas diagnósticas (antes era 3) para reduzir fricção
  if (asked >= 2) return null;
  if (state.lead_profile === "emocional" && asked >= 1) return null;
  // V25: Se lead já deu condição + tempo na msg inicial, pular direto
  if (has.tempo && has.impacto) return null;

  if (!has.tempo && asked < 2) { state.diagnostic_step = asked + 1; return diagQ_tempo(state); }
  if (!has.impacto && asked < 2) { state.diagnostic_step = asked + 1; return diagQ_impacto(state); }
  if (!has.tratamento && asked < 2) { state.diagnostic_step = asked + 1; return diagQ_tratamento(); }

  return null;
}

/* ═══════════════════════════════════════════════════════════════════
   BRIDGE REPLY — V24 REESCRITO
   ═══════════════════════════════════════════════════════════════════ */

// V26: Bridge inteiramente via GPT — personalizado ao contexto da conversa
// Fallback hardcoded só se GPT falhar
async function bridgeReply(state) {
  const cond = state.condition || detectCondition(state.problem_text || "") || "dor_cronica";
  const ev = EVIDENCE_DB[cond];
  const nome = state.nome || "";
  const problem = state.problem_text || "a condição relatada";

  // Tenta gerar bridge via GPT
  try {
    if (openai) {
      // V27: Bridge com empatia profunda e esperança
      const empathyExample = getEmpathyReply(cond);
      const hopeExample = getHopeReply(cond);
      const bridgePrompt = `Você é a Lia, secretária do Dr. Alef Kotula. O paciente${nome ? ` ${nome}` : ""} acabou de te contar que sofre com ${problem}.
${ev ? `Dado clínico disponível: ${ev.direct_answer}` : ""}

Exemplo de empatia que você pode usar (adapte, não copie): "${empathyExample}"
Exemplo de esperança que você pode usar (adapte, não copie): "${hopeExample}"

Gere UMA transição natural (máx 350 chars) que:
1. Valide o que a pessoa contou com EMPATIA PROFUNDA (referenciando algo específico que ela disse)
2. Mostre que você se importa de verdade — pode mencionar que sua mãe/tia/avó também sofria com isso
3. Crie expectativa positiva ("imagina você com X% menos dor...")
4. Transite suavemente para oferecer a consulta

Seja humana, calorosa, emocional. NÃO use listas. NÃO use emoji. NÃO seja genérica.
Responda APENAS o texto da mensagem, nada mais.`;

      const resp = await openai.chat.completions.create({
        model: CHAT_MODEL,
        temperature: 0.82,
        max_tokens: 200,
        messages: [{ role: "user", content: bridgePrompt }],
      });
      const bridgeText = (resp.choices?.[0]?.message?.content || "").trim();
      if (bridgeText && bridgeText.length > 30 && bridgeText.length < 450 && !violatesNoPriceNoLink(bridgeText)) {
        state.evidence_used_count = Number(state.evidence_used_count || 0) + 1;
        return bridgeText;
      }
    }
  } catch (err) {
    console.error("[LIA][BRIDGE] GPT bridge falhou, usando fallback:", err.message);
  }

  // Fallback hardcoded se GPT falhar
  const nomeStr = nome ? `, ${nome}` : "";
  let evidence = "O que eu acompanho aqui no dia a dia é que muita gente com quadro parecido percebe melhora real.";
  if (ev) {
    evidence = ev.direct_answer || pickRandom(ev.testimony);
    state.evidence_used_count = Number(state.evidence_used_count || 0) + 1;
  }
  return `Faz todo sentido${nomeStr}.\n\n${evidence}\n\nQuer que eu te passe os detalhes da avaliação?`;
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
  state.name_ask_count = Number(state.name_ask_count || 0);
  state.name_skipped = !!state.name_skipped;
  state.sent_instagram_link = !!state.sent_instagram_link;
  // V25: Follow-up tracking
  state.followup_due_at = state.followup_due_at || null;
  state.followup_reason = state.followup_reason || null;
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

  // ── V24.6: Filtro de mensagens de sistema (Meta/WhatsApp/operacionais) ──
  if (isSystemMessage(incomingText)) {
    console.log(`🚫 Mensagem de sistema ignorada de ${phone}: "${(incomingText || "").slice(0, 60)}"`);
    return { reply: null, state: {}, flags: {}, filtered: true };
  }

  // ── V24.6: Deduplicação — mesma msg do mesmo número em 60s → reply cacheado ──
  const cachedReply = _dedupCheck(phone, incomingText);
  if (cachedReply) {
    console.log(`♻️ Dedup: reply cacheado para ${phone}`);
    return { reply: cachedReply, state: {}, flags: {}, deduplicated: true };
  }

  // ── Reset universal (qualquer lead) ──
  const RESET_COMMANDS = ["reset", "reiniciar", "recomeçar", "recomecar"];
  if (RESET_COMMANDS.includes(norm(incomingText))) {
    await pool.query(`UPDATE wa_users SET state = '{}'::jsonb, updated_at = NOW() WHERE phone = $1`, [phone]);
    await pool.query(`DELETE FROM wa_slot_locks WHERE phone = $1 AND status='held'`, [phone]);
    return {
      reply: "Conversa reiniciada. Pode começar de novo!",
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
    // V24.10: Dados APÓS pagamento
    if (!st.nome_completo || !st.birthdate || !st.email) {
      st.stage = "ASK_FULLNAME";
    } else {
      st.stage = "CONFIRMED";
    }
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

  // V24.7: Reset farewell_sent quando lead volta com intent real (não é casual ack)
  if (state.farewell_sent && !flags.isCasualAck && !flags.endsConversation && !flags.saysWillSee) {
    state.farewell_sent = false;
  }

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
    // V25: Pós-pagamento adaptativo — slot → dados → confirmed
    if (!state.slot_time || !state.date_key) {
      // Pagou mas sem horário → coletar horário primeiro
      state.stage = "ASK_DAY";
      reply = afterPaidReply(state) + "\n\n" + await askDayReply();
    } else if (!state.nome_completo || !state.birthdate || !state.email) {
      if (!state.nome_completo) state.stage = "ASK_FULLNAME";
      else if (!state.birthdate) state.stage = "ASK_BIRTHDATE";
      else state.stage = "ASK_EMAIL";
      reply = afterPaidReply(state);
    } else {
      state.stage = "CONFIRMED";
      reply = afterPaidReply(state);
    }
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
     [CAMADA 0.7] — PAUSA / ENCERRAMENTO / SILÊNCIO (V24.7)
     ═══════════════════════════════════════════════════════════════ */

  // V24.7: Casual ack ("ok", "beleza", "entendi") fora de coleta de dados → silêncio ou farewell único
  else if (flags.isCasualAck && !DATA_COLLECTION_STAGES.includes(state.stage) && state.stage !== "ASK_NAME") {
    if (state.farewell_sent) {
      // Já mandou farewell antes → silêncio total
      await saveUserState(phone, state);
      return { reply: "", state, flags, skip_send: true };
    }
    // V26: Casual ack farewell — variações humanas
    state.farewell_sent = true;
    reply = pickRandom([
      "Perfeito, fico por aqui.",
      "Tá bom, qualquer coisa me chama.",
      "Beleza, tô aqui se precisar.",
    ]);
  }

  else if (!DATA_COLLECTION_STAGES.includes(state.stage) && flags.endsConversation && !flags.wantsBook && !flags.wantsPrice && !flags.intentPay) {
    if (state.farewell_sent) {
      await saveUserState(phone, state);
      return { reply: "", state, flags, skip_send: true };
    }
    const nome = state.nome ? `, ${state.nome}` : "";
    // V26: Farewell personalizado + variações humanas
    if (state.price_ask_count > 0 || state.payment) {
      const opts = [
        `Eu que agradeço${nome}. Lembra que dá pra parcelar em até 12x. Se mudar de ideia, tô aqui.`,
        `Imagina${nome}. Se quiser retomar, é só me chamar — lembra que parcela em até 12x.`,
        `De nada${nome}. Qualquer coisa, me chama. O parcelamento fica aberto.`,
      ];
      reply = pickRandom(opts);
    } else if (state.stage && !["ASK_NAME", "ASK_PROBLEM"].includes(state.stage)) {
      const opts = [
        `Eu que agradeço${nome}. Se quiser aproveitar os horários desta semana, me chama.`,
        `Imagina${nome}. Quando quiser retomar, é só mandar mensagem.`,
        `De nada${nome}. Fico por aqui se precisar.`,
      ];
      reply = pickRandom(opts);
    } else {
      const opts = [
        `Eu que agradeço${nome}. Quando quiser, me chama que te explico tudo rapidinho.`,
        `De nada${nome}. Se tiver curiosidade depois, me manda mensagem.`,
        `Imagina${nome}. Tô aqui se precisar de qualquer coisa.`,
      ];
      reply = pickRandom(opts);
    }
    state.farewell_sent = true;
    state.followup_due_at = Date.now() + 86400000;
    state.followup_reason = "ended_conversation";
  }

  // V25: isSleepy — respeitar que o lead quer dormir, NÃO empurrar agenda
  else if (flags.isSleepy && !flags.wantsBook && !flags.intentPay) {
    if (state.farewell_sent) {
      await saveUserState(phone, state);
      return { reply: "", state, flags, skip_send: true };
    }
    reply = pickRandom([
      "Descansa bem! Quando quiser retomar, me chama por aqui.",
      "Descansa! Amanhã a gente continua, sem pressa.",
      "Vai descansar! Quando quiser voltar a conversar, é só me mandar mensagem.",
    ]);
    state.farewell_sent = true;
    state.followup_due_at = Date.now() + 86400000; // 24h
    state.followup_reason = "sleepy";
  }

  else if (flags.saysWillSee && !flags.wantsBook && !flags.intentPay) {
    if (state.farewell_sent) {
      await saveUserState(phone, state);
      return { reply: "", state, flags, skip_send: true };
    }
    const nome = state.nome ? `, ${state.nome}` : "";
    // V25: Farewell personalizado por estágio
    if (state.price_ask_count > 0 || state.payment) {
      reply = `Entendo${nome}. Lembra que dá pra parcelar em até 12x. Se mudar de ideia, estou aqui.`;
    } else if (state.stage && !["ASK_NAME", "ASK_PROBLEM"].includes(state.stage)) {
      reply = `Fica à vontade${nome}. Se quiser aproveitar os horários desta semana, é só me chamar.`;
    } else {
      reply = `Quando quiser${nome}, me chama. Consigo te explicar tudo rapidinho.`;
    }
    state.farewell_sent = true;
    state.followup_due_at = Date.now() + 86400000;
    state.followup_reason = "said_will_think";
  }

  else if (flags.saysCheckSpouse && !flags.wantsBook && !flags.intentPay) {
    if (state.farewell_sent) {
      await saveUserState(phone, state);
      return { reply: "", state, flags, skip_send: true };
    }
    const nome = state.nome ? `, ${state.nome}` : "";
    reply = `Faz todo sentido${nome}. Quando estiver decidido(a), me avisa por aqui que eu organizo tudo.`;
    state.farewell_sent = true;
    state.followup_due_at = Date.now() + 86400000;
    state.followup_reason = "check_spouse";
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

    // V24.12: Lead pede Instagram diretamente → resposta curta e direta
    if (flags.asksInstagram) {
      reply = authorityInstagramReply("trust");
      state.sent_instagram_link = true;
      state = mergeState(state, ai.updates);
    }
    // V25: "funciona pra mim?" → resposta clínica direta do EVIDENCE_DB + Instagram
    else if (flags.asksIfWorks || flags.asksIfForMe || flags.asksIsScam || flags.asksDifferential) {
      const ev = EVIDENCE_DB[state.condition];
      if (ev?.direct_answer) {
        reply = ev.direct_answer;
      } else {
        reply = ai.reply.startsWith("__") ? "É uma dúvida válida. O que posso te dizer é que acompanho o consultório do Dr. Alef todos os dias e vejo com frequência pacientes que percebem melhora real." : ai.reply;
      }
      if (!state.sent_instagram_link) {
        reply += "\n\n" + authorityInstagramReply("trust");
        state.sent_instagram_link = true;
      }
      state = mergeState(state, ai.updates);
    }
    // V25: __NEED_PRICE__ → preço imediato (sem gate de rapport)
    else if (ai.reply === "__NEED_PRICE__") {
      state.price_ask_count += 1;
      const pr = priceAndRoute(state);
      reply = pr.reply;
      state.stage = pr.stage;
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
      && !["OFFER_SLOTS","ASK_PAY_METHOD","ASK_FULLNAME","ASK_BIRTHDATE","ASK_EMAIL","ASK_PLAN","WAIT_PAYMENT"].includes(state.stage)
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
      // V27: FORMULÁRIO META — detectar dados do form e pré-popular state
      const formData = parseMetaFormData(incomingText);
      if (formData) {
        const formName = extractFormFirstName(formData.nome_completo);
        if (formName) {
          state.nome = formName;
          state.name_used_count = 0;
          // Salvar dados do form internamente (LIA finge não saber)
          state.form_data = formData;
          if (formData.condition) state.condition = formData.condition.toLowerCase();
          if (formData.tempo) {
            state.diag_has_tempo = true;
            if (/mais de 1 ano|mais de um ano/i.test(formData.tempo)) state.problem_tempo = "mais de 1 ano";
            else if (/3 a 12 meses/i.test(formData.tempo)) state.problem_tempo = "3 a 12 meses";
            else if (/menos de 3 meses/i.test(formData.tempo)) state.problem_tempo = "menos de 3 meses";
          }
          if (formData.tentou_tratamento && /sim/i.test(formData.tentou_tratamento)) state.diag_has_tratamento = true;
          state.stage = "ASK_PROBLEM";
          // V27: Abertura natural — finge não saber, mas usa nome
          const greetings = [
            `Oi, ${formName}! Sou a Lia, do consultório do Dr. Alef Kotula. Me conta: o que te trouxe até aqui?`,
            `Oi, ${formName}! Aqui é a Lia, da equipe do Dr. Alef. Tudo bem? Me diz o que posso fazer por você.`,
            `Oi, ${formName}! Eu sou a Lia, trabalho com o Dr. Alef. O que te motivou a entrar em contato?`,
          ];
          reply = pickRandom(greetings);
        } else {
          // Form sem nome legível → pedir nome
          state.form_data = formData;
          if (formData.condition) state.condition = formData.condition.toLowerCase();
          reply = askNameIntroReply();
          state.stage = "ASK_NAME";
        }
      }
      // V24.7: TENTATIVA ANTECIPADA — se o texto consolidado já contém nome, extrair ANTES de pedir
      else {
        const earlyName = extractFirstName(incomingText);
        if (earlyName) {
          state.nome = earlyName;
          state.name_used_count = 0;
          state.stage = "ASK_PROBLEM";
          const greetings = [
            `Oi, ${earlyName}! Sou a Lia, do consultório do Dr. Alef.`,
            `Oi, ${earlyName}! Aqui é a Lia, da equipe do Dr. Alef Kotula.`,
            `Oi, ${earlyName}! Eu sou a Lia, trabalho com o Dr. Alef.`,
          ];
          reply = pickRandom(greetings) + "\n\n" + askProblemReply(state).replace(/^Prazer,\s*\w+\.?\s*\n\n/i, "");
        }
        // V26: Meta Ads → abertura com variação
        else if (isMetaAdsEntry(incomingText)) {
          reply = askNameIntroReply();
          state.stage = "ASK_NAME";
        } else if (hasQuestion(incomingText) && !isMetaAdsEntry(incomingText)) {
        const ai = await runLia({ incomingText, state, flags, stageCTA: "" });
        if (!ai.reply.startsWith("__")) {
          // V26: Abertura com pergunta GPT + nome — mais natural
          const shortReply = clip(ai.reply, 200);
          reply = shortReply + pickRandom(["\n\nAntes de mais nada, como posso te chamar?", "\n\nMe diz seu nome?", "\n\nComo você se chama?"]);
          state = mergeState(state, ai.updates);
        } else {
          reply = askNameIntroReply();
        }
        state.stage = "ASK_NAME";
      } else {
        reply = askNameIntroReply();
        state.stage = "ASK_NAME";
      }
      } // fecha o else do formData
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
          else { state.stage = "BRIDGE"; reply = await bridgeReply(state); }
        }
      } else {
        const nm = extractFirstName(incomingText);
        if (nm) {
          state.nome = nm;
          state.name_used_count = 0;

          if (state.problem_text) {
            if (state.lead_profile === "quente" || flags.wantsBook) {
              state.stage = "ASK_DAY";
              reply = `Prazer, ${nm}. Vou te mostrar os horários disponíveis.\n\n` + await askDayReply();
            } else if (state.lead_profile === "pragmatico" || flags.wantsPrice) {
              // V25: Preço imediato para pragmáticos/wantsPrice (sem gate rapport)
              const pr = priceAndRoute(state);
              reply = `Prazer, ${nm}.\n\n${pr.reply}`;
              state.stage = pr.stage;
            } else {
              state.stage = "DIAGNOSTIC";
              const nextQ = getNextDiagQuestion(state, state.problem_text || incomingText);
              if (nextQ) {
                reply = `Prazer, ${nm}.\n\n${nextQ}`;
              } else {
                state.stage = "BRIDGE";
                reply = `Prazer, ${nm}.\n\n${await bridgeReply(state)}`;
              }
            }
          } else {
            state.stage = "ASK_PROBLEM";
            reply = askProblemReply(state);
          }
        } else {
          // V24.6: Escape do loop de nome — após 2 tentativas, pular para ASK_PROBLEM
          state.name_ask_count = (state.name_ask_count || 0) + 1;

          if (state.name_ask_count >= 2) {
            // Lead recusou dar nome 2+ vezes → contornar com graça
            state.name_skipped = true;
            state.stage = "ASK_PROBLEM";
            // Tentar extrair problema da mensagem atual
            const pb = extractProblemText(incomingText);
            if (pb) {
              state.problem_text = pb;
              state.condition = detectCondition(pb) || state.focus || null;
              state.stage = "DIAGNOSTIC";
              const nextQ = getNextDiagQuestion(state, incomingText);
              if (nextQ) { reply = `Sem problema.\n\n${nextQ}`; }
              else { state.stage = "BRIDGE"; reply = `Sem problema.\n\n${await bridgeReply(state)}`; }
            } else {
              reply = pickRandom([
                "Sem problema. Me conta o que te trouxe aqui?",
                "Tudo bem. O que tá te incomodando?",
                "Sem problema. Me diz: o que te motivou a buscar o tratamento?",
              ]);
            }
          } else if (hasQuestion(incomingText)) {
            const ai = await runLia({ incomingText, state, flags, stageCTA: "" });
            if (!ai.reply.startsWith("__")) {
              reply = ai.reply + pickRandom(["\n\nAntes de seguir, me diz seu nome?", "\n\nMe diz seu *nome*?", "\n\nComo posso te chamar?"]);
              state = mergeState(state, ai.updates);
            } else {
              reply = pickRandom(["Me diz seu nome?", "Qual seu nome?", "Como posso te chamar?"]);
            }
          } else {
            reply = pickRandom(["Me diz seu nome?", "Qual seu nome?", "Como posso te chamar?"]);
          }
        }
      }
    }

    // ── Captura do problema ──
    else if (state.stage === "ASK_PROBLEM") {
      // V27: Rapport depth — contar trocas reais
      state.rapport_depth = (state.rapport_depth || 0) + 1;
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
          reply = await bridgeReply(state);
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
      // V27: Rapport depth — contar trocas reais de conversa
      state.rapport_depth = (state.rapport_depth || 0) + 1;

      const nextQ = getNextDiagQuestion(state, incomingText);
      if (nextQ) {
        reply = nextQ;
      } else {
        // V27: Se rapport ainda é raso (< 3 trocas), usar empathy+hope antes do bridge
        if ((state.rapport_depth || 0) < 3 && state.condition) {
          const empathy = getEmpathyReply(state.condition);
          const hope = getHopeReply(state.condition);
          reply = empathy + "\n\n" + hope + "\n\nQuer que eu te passe os detalhes da avaliação?";
          state.stage = "BRIDGE";
        } else {
          state.stage = "BRIDGE";
          reply = await bridgeReply(state);
        }
      }
    }

    // ── Bridge ──
    else if (state.stage === "BRIDGE") {
      if (flags.wantsBook || flags.asksHours || flags.confirms || flags.mentionsDayAvail) {
        state.stage = "ASK_DAY";
        reply = await askDayReply();
      } else if (flags.wantsPrice) {
        state.price_ask_count += 1;
        const pr = priceAndRoute(state);
        reply = pr.reply;
        state.stage = pr.stage;
      } else {
        const ai = await runLia({ incomingText, state, flags, stageCTA: "Se quiser, eu posso te mostrar os horários disponíveis" });
        if (ai.reply === "__NEED_BOOK__") { state.stage = "ASK_DAY"; reply = await askDayReply(); }
        else if (ai.reply === "__NEED_PRICE__") { state.price_ask_count += 1; const pr = priceAndRoute(state); reply = pr.reply; state.stage = pr.stage; }
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
        // V25: intentPay em ASK_DAY → deixar pagar (agenda pós-pagamento)
        } else if (flags.intentPay) {
          console.log(`[LIA_PAY] ASK_DAY: intentPay — redirecionando para pagamento direto`);
          const pr = priceAndRoute(state);
          reply = pr.reply;
          state.stage = pr.stage;
        } else if (flags.asksHours && !extractDateKey(incomingText)) {
          const dayKeys = await getSuggestedDayKeys();
          if (dayKeys.length) {
            const opts = dayKeys.map((d) => `*${formatDatePt(d)}*`).join("\n");
            reply = `Me diz qual dia você prefere que eu te mostro os horários disponíveis dele.\n\n${opts}`;
          } else {
            reply = await askDayReply();
          }
        // V27: wantsPrice ANTES de hasQuestion em ASK_DAY — evita "nos desencontramos"
        } else if (flags.wantsPrice) {
          state.price_ask_count += 1;
          reply = pricePaymentReply(state);
          state.stage = "ASK_PAY_METHOD";
        } else if (hasQuestion(incomingText)) {
          const ai = await runLia({ incomingText, state, flags, stageCTA: "Qual dia fica melhor para você?" });
          if (ai.reply === "__NEED_PRICE__") { state.price_ask_count += 1; reply = pricePaymentReply(state); state.stage = "ASK_PAY_METHOD"; }
          else if (ai.reply.startsWith("__")) { reply = await askDayReply(); }
          else { reply = ai.reply; state = mergeState(state, ai.updates); }
        // V24.5: Se lead pede tempo/encerra em ASK_DAY, respeitar
        } else if (flags.saysWillSee || flags.endsConversation || flags.saysCheckSpouse) {
          const nome = state.nome ? `, ${state.nome}` : "";
          reply = `Sem problema${nome}. Quando decidir o dia, me avisa por aqui que eu organizo tudo.`;
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
          reply = `Esse horário não está disponível. O mais próximo que tenho é:\n${best2.map((s,i) => `${i+1}) *${s}*`).join("\n")}\n\nQual fica melhor?`;
        }
      } else if (/\b(outro|nenhum|tem mais)\b/.test(norm(incomingText))) {
        reply = `Sem problema. Que horário em *${formatDatePt(state.date_key)}* funciona melhor para você?`;
      }

      if (chosen && !reply) {
        const hold = await acquireSlotHold(state.date_key, chosen, phone);
        if (!hold.ok) {
          reply = "Esse horário acabou de ser preenchido 😕 Vou te mostrar outras opções.\n\n" + (await offerSlotsReply(state));
        } else {
          state.slot_time = chosen;
          state.slot_key = hold.slot_key;
          await releaseOldHeldSlotsForPhone(phone, hold.slot_key);
          state.stage = "ASK_PAY_METHOD";
          // V26: Transição slot → pagamento mais natural
          const slotConfirmVariations = [
            `Pronto, deixei *${prettySlot(state.date_key, state.slot_time)}* pré-reservado pra você.\n\n${pricePaymentReply(state)}`,
            `Reservei *${prettySlot(state.date_key, state.slot_time)}* pra você. Quando o pagamento for confirmado eu libero em definitivo.\n\n${pricePaymentReply(state)}`,
            `Seu horário tá pré-reservado: *${prettySlot(state.date_key, state.slot_time)}*.\n\n${pricePaymentReply(state)}`,
          ];
          reply = pickRandom(slotConfirmVariations);
        }
      }

      if (!reply) {
        // V24.10.1: intentPay em OFFER_SLOTS sem slot → redirecionar para escolha de horário
        // V25: intentPay em OFFER_SLOTS → pagamento direto (agenda pós-pag)
        if (flags.intentPay) {
          console.log(`[LIA_PAY] OFFER_SLOTS: intentPay — redirecionando para pagamento direto`);
          const pr = priceAndRoute(state);
          reply = pr.reply;
          state.stage = pr.stage;
        } else if (hasQuestion(incomingText)) {
          const ai = await runLia({ incomingText, state, flags, stageCTA: "Qual desses horários funciona melhor?" });
          if (ai.reply.startsWith("__")) { reply = await offerSlotsReply(state); }
          else { reply = ai.reply; state = mergeState(state, ai.updates); }
        } else {
          reply = "Qual horário fica melhor? Pode me responder com *1, 2, 3* ou com o horário exato.";
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
        const ai = await runLia({ incomingText, state, flags, stageCTA: "Me passa seu nome completo" });
        if (!ai.reply.startsWith("__")) { reply = ai.reply + pickRandom(["\n\nMe passa seu *nome completo*?", "\n\nQual seu *nome completo*?"]); state = mergeState(state, ai.updates); }
        else { reply = pickRandom(["Me manda seu *nome completo*?", "Qual seu *nome completo*?"]); }
      } else {
        reply = pickRandom(["Me manda seu *nome completo*?", "Qual seu *nome completo*?"]);
      }
    }
    else if (state.stage === "ASK_BIRTHDATE") {
      const bd = extractBirthDate(incomingText);
      if (bd) {
        state.birthdate = bd;
        state.stage = "ASK_EMAIL";
        reply = askEmailReply();
      } else {
        reply = pickRandom(["Me manda sua *data de nascimento*?", "Qual sua *data de nascimento*?"]);
      }
    }
    else if (state.stage === "ASK_EMAIL") {
      const em = extractEmail(incomingText);
      if (em) {
        state.email = em;
        // V24.10: Se pagamento já aprovado (coleta pós-pag), finalizar
        if (state.payment?.status === "approved") {
          state.stage = "CONFIRMED";
          reply = afterPaidReply(state);
        } else {
          const pr = priceAndRoute(state);
          reply = `Obrigada.\n\n${pr.reply}`;
          state.stage = pr.stage;
        }
      } else {
        reply = pickRandom(["Me manda seu *e-mail*?", "Qual seu *e-mail*?"]);
      }
    }

    // ── V24.10: ASK_PLAN legacy redirect → oferta única ──
    else if (state.stage === "ASK_PLAN") {
      state.stage = "ASK_PAY_METHOD";
      reply = pricePaymentReply(state);
    }

    // ── V25: Método de pagamento (Link ou Pix) — funciona com ou sem slot ──
    else if (state.stage === "ASK_PAY_METHOD") {
      console.log(`[LIA][ASK_PAY_METHOD] Entrada: phone=${phone}, slot_time=${state.slot_time}, date_key=${state.date_key}`);
      {
        const low = norm(incomingText);
        const wantsLink = /\b(1|link|cartao|cartão|parcela|parcelar|parcelado|parcelas|parcelamento|credito|crédito|me manda|manda o|quero o link|link de pagamento|quero pagar no cartao|quero pagar no cartão)\b/.test(low);
        const wantsPix = /\b(2|pix|prefiro pix|quero pix|quero pagar no pix|pagar no pix|mudar para pix|trocar para pix)\b/.test(low);
        const saysExpensive = /\b(caro|cara|muito|puxado|puxada|desconto|barato|barata|menos|menor)\b/.test(low);
        console.log(`[LIA_PAY] ASK_PAY_METHOD input: "${low.substring(0,80)}", wantsLink=${wantsLink}, wantsPix=${wantsPix}, saysExpensive=${saysExpensive}`);

        if (wantsLink) {
          console.log(`[LIA_PAY] ASK_PAY_METHOD: Link escolhido — gerando preference MP`);
          state.selected_plan_key = "avaliacao";
          const pref = await mpCreatePreference({ phone, planKey: "avaliacao" });
          state.payment = {
            status: "pending", plan_key: "avaliacao",
            preference_id: pref.preference_id, link: pref.link,
            external_reference: pref.external_reference, created_at: Date.now(),
            method: "link",
          };
          reply = paymentSentReply(PLANS.avaliacao, pref.link, state);
          state.stage = "WAIT_PAYMENT";
        } else if (wantsPix) {
          console.log(`[LIA_PAY] ASK_PAY_METHOD: Pix escolhido — exibindo CNPJ`);
          state.selected_plan_key = "avaliacao";
          state.payment = {
            status: "pending_pix", plan_key: "avaliacao",
            created_at: Date.now(), method: "pix",
          };
          // V26: Pix reply com variação
          reply = pickRandom([
            `Aqui tá o Pix.\n\nCNPJ: *${PIX_CNPJ}*\nValor: *R$247*\n\nQuando fizer, me manda o comprovante que eu confirmo na hora.`,
            `Pix direto:\n\nCNPJ: *${PIX_CNPJ}*\nValor: *R$247*\n\nÉ só fazer e me mandar o comprovante por aqui.`,
            `Segue o Pix:\n\nCNPJ: *${PIX_CNPJ}*\nValor: *R$247*\n\nMe envia o comprovante depois que confirmo rapidinho.`,
          ]);
          state.stage = "WAIT_PAYMENT";
        } else if (saysExpensive) {
          if (!state.sent_instagram_link) {
            reply = `Entendo. Só pra você saber, dá pra parcelar em *3x de R$91,58* no cartão. No link você consegue ver também outras opções, como 2x de R$135,41, 4x de R$68,77 e até 12x.\n\nSe preferir à vista, o Pix é *R$247*.\n\n${authorityInstagramReply("price")}\n\nComo prefere: 1️⃣ link ou 2️⃣ Pix?`;
            state.sent_instagram_link = true;
          } else {
            reply = `Entendo. Só pra você saber, dá pra parcelar em *3x de R$91,58* no cartão. No link você consegue ver também outras opções, como 2x de R$135,41, 4x de R$68,77 e até 12x.\n\nSe preferir à vista, o Pix é *R$247*.\n\nComo prefere: 1️⃣ link ou 2️⃣ Pix?`;
          }
        } else if (flags.saysWillSee || flags.endsConversation || flags.saysCheckSpouse) {
          const nome = state.nome ? `, ${state.nome}` : "";
          if (!state.sent_instagram_link) {
            reply = `Sem problema${nome}. Seu horário fica pré-reservado por enquanto.\n\n${authorityInstagramReply("preclose")}\n\nQuando decidir, me chama por aqui.`;
            state.sent_instagram_link = true;
          } else {
            reply = `Sem problema${nome}. Seu horário fica pré-reservado por enquanto. Quando decidir, me chama por aqui.`;
          }
        } else if (hasQuestion(incomingText)) {
          const payQ = pickRandom(["Prefere 1️⃣ link ou 2️⃣ Pix?", "Como quer pagar: 1️⃣ link ou 2️⃣ Pix?"]);
          const ai = await runLia({ incomingText, state, flags, stageCTA: payQ });
          if (!ai.reply.startsWith("__")) { reply = ai.reply + "\n\n" + payQ; state = mergeState(state, ai.updates); }
          else { reply = payQ; }
        } else {
          reply = pickRandom(["Prefere 1️⃣ *link* (cartão/parcelas) ou 2️⃣ *Pix*?", "Como quer pagar: 1️⃣ link ou 2️⃣ Pix?"]);
        }
      }
    }

    // ── Aguardando pagamento (V24.10.2: suporte troca link↔pix) ──
    else if (state.stage === "WAIT_PAYMENT") {
      console.log(`[LIA_PAY] WAIT_PAYMENT entrada: phone=${phone}, status=${state.payment?.status}, method=${state.payment?.method}`);
      const low = norm(incomingText);
      const wantsLink = /\b(1|link|cartao|cartão|parcela|parcelar|parcelado|parcelas|parcelamento|credito|crédito|me manda|manda o|quero o link|link de pagamento|quero pagar no cartao|quero pagar no cartão)\b/.test(low);
      const wantsPix = /\b(2|pix|prefiro pix|quero pix|quero pagar no pix|pagar no pix|mudar para pix|trocar para pix)\b/.test(low);
      const isPendingLink = ["pending", "pending_link", "pending_checkout"].includes(state.payment?.status);
      const isPendingPix = state.payment?.status === "pending_pix";

      // TROCA: link/checkout → Pix
      if (isPendingLink && wantsPix && !wantsLink) {
        console.log(`[LIA_PAY] TROCA link→pix`);
        state.payment = { ...state.payment, status: "pending_pix", method: "pix", switched_at: Date.now() };
        reply = `Sem problema. Se preferir, podemos fazer no Pix.\n\nPix CNPJ: *${PIX_CNPJ}*\nValor: *R$247*\n\nAssim que fizer o pagamento, me envie o comprovante por aqui para eu confirmar sua reserva.`;
      }
      // TROCA: Pix → link
      else if (isPendingPix && wantsLink && !wantsPix) {
        console.log(`[LIA_PAY] TROCA pix→link — gerando preference MP`);
        const pref = await mpCreatePreference({ phone, planKey: "avaliacao" });
        state.payment = { ...state.payment, status: "pending", method: "link", preference_id: pref.preference_id, link: pref.link, external_reference: pref.external_reference, switched_at: Date.now() };
        reply = paymentSentReply(PLANS.avaliacao, pref.link, state);
      }
      // Pix pendente — comprovante
      else if (isPendingPix) {
        if (/\b(paguei|enviei|comprovante|feito|transferi|mandei|pago)\b/.test(low)) {
          state.payment.pix_comprovante_sent = true;
          state.needs_human = true;
          reply = "Recebi sua confirmação. Vou verificar o pagamento e te aviso por aqui assim que estiver confirmado.";
        } else {
          reply = `Para confirmar sua reserva, é só fazer o Pix e me enviar o comprovante.\n\nPix CNPJ: *${PIX_CNPJ}*\nValor: *R$247*`;
        }
      }
      // V27: "Nenhuma" / "tudo certo" / "ok obrigada" → resposta gentil (não confundir com input genérico)
      else if (/^(nenhuma|nenhum|nada|tudo certo|tudo bem|sem duvida|sem dúvida|certo|ok|obrigad|brigad|valeu|ótimo|otimo)$/i.test(low.replace(/[^\w\s]/g, "").trim()) ||
               /\b(nenhuma duvida|nenhuma dúvida|sem duvida|sem dúvida|tudo certo|obrigad[ao])\b/i.test(low)) {
        const nome = state.nome ? `, ${state.nome}` : "";
        reply = pickRandom([
          `Perfeito${nome}! Qualquer coisa estou por aqui.`,
          `Ótimo${nome}! Se precisar de algo, me chama.`,
          `Tudo certo então${nome}! Fico à disposição.`,
        ]);
      }
      // Link pendente
      else if (isPendingLink && state.payment?.link) {
        if (flags.intentPay || flags.confirms) {
          reply = pendingPaymentReply(state);
        } else {
          const ai = await runLia({ incomingText, state, flags, stageCTA: `Seu horário está pré-reservado. Para confirmar é só finalizar aqui: ${state.payment.link}` });
          if (ai.reply.startsWith("__")) { reply = pendingPaymentReply(state); }
          else { reply = ai.reply; state = mergeState(state, ai.updates); }
        }
      }
      // Fallback
      else {
        reply = pickRandom(["Como posso te ajudar?", "Me conta: o que precisa?", "Em que posso te ajudar?"]);
      }
    }

    // ── Intenções fora de stage ──
    else if (flags.wantsBook || flags.asksHours || flags.mentionsDayAvail) {
      if (!state.nome) { state.stage = "ASK_NAME"; reply = askNameIntroReply(); }
      else if (!state.problem_text) { state.stage = "ASK_PROBLEM"; reply = askProblemReply(state); }
      else if (!state.date_key) { state.stage = "ASK_DAY"; reply = await askDayReply(); }
      else if (!state.slot_time) { state.stage = "OFFER_SLOTS"; reply = await offerSlotsReply(state); }
      else { state.stage = "ASK_PAY_METHOD"; reply = pricePaymentReply(state); }
    }

    // V25: wantsPrice — SEMPRE mostrar preço imediato (sem gate de rapport)
    else if (flags.wantsPrice) {
      state.price_ask_count += 1;
      if (!state.nome && state.price_ask_count < 2) {
        reply = priceShortReply(state) + "\n\nAntes de seguir, me diz seu *primeiro nome*?";
        state.stage = "ASK_NAME";
      } else {
        const pr = priceAndRoute(state);
        reply = pr.reply;
        state.stage = pr.stage;
      }
    }

    // V25: intentPay → pagamento direto (sem exigir slot)
    else if (flags.intentPay) {
      if (state.payment?.status === "pending" && state.payment?.link) { reply = pendingPaymentReply(state); state.stage = "WAIT_PAYMENT"; }
      else if (state.payment?.status === "pending_pix") { reply = `Para confirmar sua reserva, é só fazer o Pix e me enviar o comprovante.\n\nPix CNPJ: *${PIX_CNPJ}*\nValor: *R$247*`; state.stage = "WAIT_PAYMENT"; }
      else { const pr = priceAndRoute(state); reply = pr.reply; state.stage = pr.stage; }
    }

    else if (flags.refuses) {
      reply = pickRandom([
        "Tranquilo, sem problema. Se quiser tirar alguma dúvida, tô aqui.",
        "Tudo bem, sem problema nenhum. Se precisar de algo, me chama.",
        "Entendo. Se mudar de ideia ou quiser saber mais, é só mandar mensagem.",
      ]);
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

      // V25: __NEED_PRICE__ no fallback → preço imediato (sem gate)
      if (ai.reply === "__NEED_PRICE__") {
        state.price_ask_count += 1;
        const pr = priceAndRoute(state);
        reply = pr.reply;
        state.stage = pr.stage;
      } else if (ai.reply === "__NEED_BOOK__") {
        if (!state.nome) { state.stage = "ASK_NAME"; reply = askNameIntroReply(); }
        else if (!state.problem_text) { state.stage = "ASK_PROBLEM"; reply = askProblemReply(state); }
        else { state.stage = "ASK_DAY"; reply = await askDayReply(); }
      // V25: __NEED_PAY__ → pagamento direto
      } else if (ai.reply === "__NEED_PAY__") {
        if (state.payment?.link) { reply = pendingPaymentReply(state); state.stage = "WAIT_PAYMENT"; }
        else { const pr2 = priceAndRoute(state); reply = pr2.reply; state.stage = pr2.stage; }
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
  } else if (flags.intentPay && ["ASK_DAY", "OFFER_SLOTS"].includes(state.stage)) {
    // V24.10.1: intentPay redirecionando para agenda — NÃO substituir pelo fallback genérico
    console.log(`[LIA][ANTI-REPEAT] Skip ensureNoRepeat: intentPay + ${state.stage}`);
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
    const { telefone, mensagem, fromMe, messageType, mediaType, type, mimetype } = req.body || {};
    const incomingMsgType = String(messageType || mediaType || type || mimetype || "").toLowerCase().trim();

    if (!telefone || !mensagem) {
      return res.status(400).json({
        ok: false,
        error: "campos 'telefone' e 'mensagem' são obrigatórios",
        skip_send: true,
      });
    }

    const phone = String(telefone).replace(/\D/g, "");
    if (!phone || phone.length < 10) {
      return res.status(400).json({ ok: false, error: "telefone inválido", skip_send: true });
    }

    const incomingText = String(mensagem).trim();

    // ══════════════════════════════════════════════════════════════
    // V24.9: PAUSA MANUAL POR LEAD — Comandos admin (ANTES do debounce)
    // Comandos: Deixa.eu.pensar | Eu.voltei | status.lia
    // Funciona com fromMe OU por texto exato (comandos únicos com pontos)
    // ══════════════════════════════════════════════════════════════
    const isAdminMsg = fromMe === true || fromMe === "true";
    const cmdNorm = incomingText.toLowerCase().trim();

    if (cmdNorm === "deixa.eu.pensar") {
      const st = await getUserState(phone);
      st.lia_paused = true;
      st.lia_paused_at = new Date().toISOString();
      await saveUserState(phone, st);
      console.log(`⏸️ Admin pausou LIA para ${phone}`);
      return res.json({
        ok: true,
        reply: "⏸️ LIA pausada para este lead. Você assumiu o chat.\nPara reativar: Eu.voltei",
        skip_send: false,
        delay_ms: 0,
        admin_command: "pause",
      });
    }

    if (cmdNorm === "eu.voltei") {
      const st = await getUserState(phone);
      st.lia_paused = false;
      delete st.lia_paused_at;
      await saveUserState(phone, st);
      console.log(`▶️ Admin reativou LIA para ${phone}`);
      return res.json({
        ok: true,
        reply: "▶️ LIA reativada para este lead. Retomando do contexto atual.",
        skip_send: false,
        delay_ms: 0,
        admin_command: "resume",
      });
    }

    if (cmdNorm === "status.lia") {
      const st = await getUserState(phone);
      const paused = st.lia_paused === true;
      const since = st.lia_paused_at ? ` (desde ${st.lia_paused_at})` : "";
      const statusMsg = paused
        ? `⏸️ LIA PAUSADA neste lead${since}\nStage: ${st.stage || "nenhum"} | Nome: ${st.nome || "não coletado"}`
        : `▶️ LIA ATIVA neste lead\nStage: ${st.stage || "nenhum"} | Nome: ${st.nome || "não coletado"}`;
      return res.json({
        ok: true,
        reply: statusMsg,
        skip_send: false,
        delay_ms: 0,
        admin_command: "status",
      });
    }

    // V27: Comando "." — Alef envia ponto para ativar LIA manualmente
    // NÃO depende de fromMe — "." solitário é sempre comando admin (nenhum paciente envia só ".")
    if (cmdNorm === "." || cmdNorm === "..") {
      const st = await getUserState(phone);
      // Se tem form_data mas LIA não iniciou, usar nome do form
      if (st.form_data && st.form_data.nome_completo && !st.nome) {
        const formName = extractFormFirstName(st.form_data.nome_completo);
        if (formName) st.nome = formName;
      }
      st.stage = st.nome ? "ASK_PROBLEM" : "ASK_NAME";
      st.dot_triggered = true;
      st.lia_paused = false; // garante que LIA está ativa
      // Cooldown: ignorar próxima msg dentro de 45s (provavelmente Alef digitando manualmente)
      st.dot_cooldown_until = Date.now() + 45000;
      await saveUserState(phone, st);
      const intro = st.nome
        ? pickRandom([
            `Oi, ${st.nome}! Sou a Lia, do consultório do Dr. Alef Kotula. Me conta: o que te trouxe até aqui?`,
            `Oi, ${st.nome}! Aqui é a Lia, da equipe do Dr. Alef. O que posso fazer por você?`,
            `Oi, ${st.nome}! Eu sou a Lia, trabalho com o Dr. Alef. Me diz o que te motivou a entrar em contato.`,
          ])
        : askNameIntroReply();
      console.log(`[LIA] Dot trigger para ${phone} — stage=${st.stage}, nome=${st.nome || "pendente"}`);
      return res.json({ ok: true, reply: intro, skip_send: false, delay_ms: randInt(3000, 6000) });
    }

    // Se mensagem é do admin (fromMe) mas NÃO é comando → ignorar (admin digitando no chat)
    if (isAdminMsg) {
      return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0 });
    }

    // ══════════════════════════════════════════════════════════════
    // V24.8: CHECK PAUSA — Se lead está pausado, logar mas não responder
    // ══════════════════════════════════════════════════════════════
    const quickState = await getUserState(phone);
    if (quickState.lia_paused === true) {
      // Logar mensagem do lead para preservar contexto
      logMessage(phone, "lia", incomingText, "inbound");
      console.log(`⏸️ Lead ${phone} está pausado. Msg logada, sem resposta: "${incomingText.slice(0, 60)}"`);
      return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0, paused: true });
    }

    // V27: Cooldown pós-dot — ignora msg do Alef digitando manualmente após "."
    // Só ignora UMA mensagem dentro da janela de 45s após o dot trigger
    if (quickState.dot_cooldown_until && Date.now() < quickState.dot_cooldown_until) {
      quickState.dot_cooldown_until = null; // consome o cooldown — só pula 1 msg
      await saveUserState(phone, quickState);
      logMessage(phone, "lia", incomingText, "inbound");
      console.log(`[LIA] Cooldown pós-dot: ignorando msg de admin para ${phone}: "${incomingText.slice(0, 60)}"`);
      return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0, dot_cooldown: true });
    }
    // Se o cooldown expirou, limpar o campo
    if (quickState.dot_cooldown_until && Date.now() >= quickState.dot_cooldown_until) {
      quickState.dot_cooldown_until = null;
      await saveUserState(phone, quickState);
    }

    // ── Filtro de mensagem de sistema → skip_send ──
    if (!incomingText || isSystemMessage(incomingText)) {
      return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0 });
    }

    // ══════════════════════════════════════════════════════════════
    // V24.11: INTERCEPTAÇÃO DE ÁUDIO / VOZ / PTT
    // Detecção robusta: campo de tipo (n8n) OU fallback textual (Evolution API)
    // ══════════════════════════════════════════════════════════════
    const isAudioMsg =
      /^(audio|ptt|voice|audiomessage|pttmessage|voicemessage|audio\/ogg|audio\/opus|audio\/mpeg|audio\/mp4)$/.test(incomingMsgType)
      || /^(\[?(audio|áudio|voice|voz|ptt)\]?\s*\.?\s*)$/i.test(incomingText);

    if (isAudioMsg) {
      console.log(`[LIA] Áudio detectado de ${phone} (incomingMsgType=${incomingMsgType})`);
      const now = Date.now();
      const lastAudioReply = _lastAudioReplyAt.get(phone) || 0;
      if (now - lastAudioReply < AUDIO_COOLDOWN_MS) {
        console.log(`[LIA] Áudio repetido de ${phone} — cooldown ativo (${Math.round((now - lastAudioReply) / 1000)}s atrás)`);
        return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0 });
      }
      _lastAudioReplyAt.set(phone, now);
      return res.json({
        ok: true,
        reply: "Recebi seu áudio.\nNo momento, não estou conseguindo ouvir mensagens de voz por aqui.\nSe puder, me escreve em texto que eu continuo te atendendo.",
        skip_send: false,
        delay_ms: 2000,
      });
    }

    // ══════════════════════════════════════════════════════════════
    // V24.7: DEBOUNCE — buffer de múltiplas mensagens do mesmo phone
    // Espera 6s. Se chegar msg mais nova, esta retorna skip_send.
    // A execução mais recente consolida tudo e responde 1x só.
    // ══════════════════════════════════════════════════════════════

    // 1) Registrar msg no buffer
    if (!_inboundBuffer.has(phone)) {
      _inboundBuffer.set(phone, { messages: [], seq: 0 });
    }
    const buf = _inboundBuffer.get(phone);
    buf.seq += 1;
    const mySeq = buf.seq;
    buf.messages.push({ text: incomingText, ts: Date.now() });

    // 2) Aguardar janela de debounce (10s)
    await new Promise(r => setTimeout(r, DEBOUNCE_WINDOW_MS));

    // 3) Após a espera: verificar se esta execução ainda é a mais recente
    const bufAfter = _inboundBuffer.get(phone);
    if (!bufAfter || bufAfter.seq !== mySeq) {
      // Chegou msg mais nova durante a espera → esta execução é descartada
      console.log(`⏳ Debounce: skip_send para ${phone} (seq ${mySeq}, atual ${bufAfter?.seq})`);
      return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0 });
    }

    // V24.9: Re-checar pausa APÓS debounce (admin pode ter pausado durante o sleep)
    const recheckState = await getUserState(phone);
    if (recheckState.lia_paused === true) {
      _inboundBuffer.delete(phone);
      const allTexts = bufAfter.messages.map(m => m.text).join(" ");
      logMessage(phone, "lia", allTexts, "inbound");
      console.log(`⏸️ Lead ${phone} pausado durante debounce. Msgs logadas, sem resposta.`);
      return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0, paused: true });
    }

    // 4) Esta é a execução mais recente → consolidar todas as msgs do buffer
    const allMessages = bufAfter.messages.map(m => m.text);
    const consolidatedText = allMessages.length > 1
      ? allMessages.join(" ")
      : allMessages[0];
    const wasConsolidated = allMessages.length > 1;

    // Limpar buffer deste phone
    _inboundBuffer.delete(phone);

    if (wasConsolidated) {
      console.log(`📦 Debounce: consolidou ${allMessages.length} msgs de ${phone}: "${consolidatedText.slice(0, 80)}..."`);
    }

    // ══════════════════════════════════════════════════════════════
    // Processar a mensagem (consolidada ou única)
    // ══════════════════════════════════════════════════════════════

    const result = await processLiaMessage(phone, consolidatedText);

    // Se foi filtrado (sistema) → skip_send
    if (result.filtered) {
      return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0 });
    }

    // Se foi dedup (msg idêntica em 60s) → skip_send para n8n não reenviar
    if (result.deduplicated) {
      return res.json({ ok: true, reply: "", skip_send: true, deduplicated: true, delay_ms: 0 });
    }

    // V24.7: Se processLiaMessage retornou skip_send (silêncio/encerramento)
    if (result.skip_send) {
      return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0 });
    }

    // Armazenar no cache de dedup
    _dedupStore(phone, consolidatedText, result.reply);

    // Delay humano obrigatório — mínimo 8s, máximo 30s
    const replyLen = (result.reply || "").length;
    let delay_ms;
    if (replyLen < 80)       delay_ms = randInt(8000, 14000);   // curta: 8-14s
    else if (replyLen < 250) delay_ms = randInt(12000, 20000);  // média: 12-20s
    else                     delay_ms = randInt(18000, 30000);  // longa: 18-30s
    delay_ms = Math.max(delay_ms, 8000);

    // V24.9: Cooldown anti-rajada — mínimo 12s entre respostas para o mesmo lead
    const lastReplyAt = _lastBotReplyAt.get(phone) || 0;
    const plannedSendAt = Date.now() + delay_ms;
    const gapFromLast = plannedSendAt - lastReplyAt;
    if (lastReplyAt > 0 && gapFromLast < MIN_BOT_GAP_MS) {
      delay_ms += (MIN_BOT_GAP_MS - gapFromLast);
      console.log(`🕐 Cooldown anti-rajada: delay_ms ajustado para ${delay_ms}ms (gap era ${gapFromLast}ms) — phone ${phone}`);
    }
    // Registrar momento planejado de envio
    _lastBotReplyAt.set(phone, Date.now() + delay_ms);

    return res.json({
      ok: true,
      reply: sanitizeReply(result.reply),
      stage: result.state?.stage || null,
      intent: detectMainIntent(result.flags) || null,
      action: null,
      needs_payment: result.state?.stage === "WAIT_PAYMENT",
      needs_human: !!(result.state?.needs_human || result.state?.emotional_risk_flagged),
      payment_link: result.state?.payment?.link || null,
      delay_ms,
      skip_send: false,
      debug: {
        lead_profile: result.state?.lead_profile || null,
        condition: result.state?.condition || null,
        nome: result.state?.nome || null,
        emotional_risk: result.state?.emotional_risk_flagged || false,
        consolidated_messages: wasConsolidated ? allMessages.length : 1,
      },
    });
  } catch (err) {
    console.error("❌ Erro /lia/respond:", err);
    return res.status(500).json({
      ok: false,
      error: "erro interno",
      reply: "Desculpa, tive um problema técnico aqui. Pode me mandar de novo?",
      skip_send: false,
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
      if (status === "approved") {
        if (!state.nome_completo || !state.birthdate || !state.email) {
          state.stage = "ASK_FULLNAME";
        } else {
          state.stage = "CONFIRMED";
        }
      }
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
            ? `${state.nome}, por enquanto eu só consigo ler mensagens de texto. Me manda sua dúvida digitando que eu te ajudo.`
            : "Por enquanto eu só consigo ler mensagens de texto. Me manda sua dúvida digitando que eu te ajudo.";
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

      // V24.7: Se filtrado, dedup, skip_send ou reply vazio, não enviar
      if (result.filtered || result.deduplicated || result.skip_send || !String(result.reply || "").trim()) return;

      // Enviar via Twilio com delay humano (mínimo 8s)
      const flags = detectIntent(incomingText);
      const delaySec = Math.max(computeHumanDelay(flags, result.state), 8);
      await sendWhatsApp(lead, bot, result.reply, delaySec);

    } catch (err) {
      console.error("❌ Erro no processamento Twilio:", err);
      try {
        const lead = req.body.From || "";
        const bot = req.body.To || "";
        await twilioClient.messages.create({
          to: lead, from: bot,
          body: "Desculpa, tive um problema aqui. Pode me mandar de novo?",
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
app.listen(PORT, () => console.log(`🚀 LIA V26 (humanizada) rodando na porta ${PORT}`));
