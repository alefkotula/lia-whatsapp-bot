/**
 * ═══════════════════════════════════════════════════════════════════
 * INDEX V30 — LIA CLOSER (campanha DOR NEUROPÁTICA / form-first)
 * ═══════════════════════════════════════════════════════════════════
 *
 * FOCO V30: conversão direta para leads pré-qualificados pelo formulário Meta.
 * Lead chega ao WhatsApp já tendo aceito R$249/7 dias e videochamada → cabe ao
 * bot encurtar o caminho até o link, reforçar confiança (anti-golpe) e fechar.
 *
 * FSM enxuta (7 estados):
 *   GREET → CONNECT → OFFER → PAY_WAIT → POST_PAY_DATA → SCHEDULE → CONFIRMED
 *
 * Mudanças sobre V29:
 * - Removidos DIAGNOSTIC, BRIDGE, ASK_NAME, ASK_PROBLEM, ASK_PAY_METHOD, ASK_PLAN
 * - hasMinRapport eliminado (form Meta já qualificou)
 * - Coleta pós-pagamento em 1 mensagem (parsePostPayData)
 * - Fast lane routeToOffer dispara preço/link assim que sinal aparece
 * - buildTrustBlock para "é golpe?" (CRM, Instagram, site, CNPJ)
 * - EVIDENCE_DB.dor_neuropatica expandido (mecanismo CB1/CB2, Anvisa, OMS)
 * - System prompt com bloco DOR NEUROPÁTICA + regra LEAD QUALIFICADO
 * - Preserva: persona humanizada, MP, Pix, Meta CAPI, slots, follow-ups
 *
 * ═══════════════════════════════════════════════════════════════════
 */

const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const OpenAI = require("openai");
const crypto = require("crypto");

let twilio, twilioClient;
try { twilio = require("twilio"); } catch (e) { twilio = null; }

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());
app.use("/mp", express.json({ type: ["application/json", "text/json", "*/*"] }));

/* ═══════════════════════════════════════════════════════════════════
   ENV + CLIENTS
   ═══════════════════════════════════════════════════════════════════ */

const {
  OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, DATABASE_URL,
  MODEL_CHAT, MIN_DELAY_SEC, MAX_DELAY_SEC, MP_ACCESS_TOKEN, PUBLIC_BASE_URL,
  LP_BASE_URL, TWILIO_WHATSAPP_NUMBER, MANUAL_SEND_SECRET, ADMIN_READ_SECRET,
  META_PIXEL_ID, META_ACCESS_TOKEN, META_TEST_EVENT_CODE,
} = process.env;

if (!OPENAI_API_KEY) console.error("❌ Falta OPENAI_API_KEY");
if (!DATABASE_URL) console.error("❌ Falta DATABASE_URL");
if (!MP_ACCESS_TOKEN) console.error("❌ Falta MP_ACCESS_TOKEN");
if (!PUBLIC_BASE_URL) console.warn("⚠️ PUBLIC_BASE_URL não definido.");

if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && twilio) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log("✅ Twilio configurado.");
} else {
  twilioClient = null;
  console.warn("⚠️ Twilio não configurado (modo API-only / n8n).");
}

let openai = null;
if (OPENAI_API_KEY) { openai = new OpenAI({ apiKey: OPENAI_API_KEY }); console.log("✅ OpenAI configurado."); }
else { console.warn("⚠️ OpenAI não configurado."); }

const CHAT_MODEL = MODEL_CHAT || "gpt-4.1";
let MIN_DELAY = Number(MIN_DELAY_SEC || 8);
let MAX_DELAY = Number(MAX_DELAY_SEC || 30);
if (MIN_DELAY > MAX_DELAY) [MIN_DELAY, MAX_DELAY] = [MAX_DELAY, MIN_DELAY];

const BASE_URL = (PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "") || "http://localhost:11000";
const SITE_URL = (LP_BASE_URL || "https://www.dralefkotula.com").trim().replace(/\/+$/, "");
const HOLD_MINUTES = 15;
const ADMIN_RESET_PHONE_DIGITS = "556581422637";

/* ═══════════════════════════════════════════════════════════════════
   PLANOS, PIX, AUTORIDADE
   ═══════════════════════════════════════════════════════════════════ */

const PLANS = {
  avaliacao: {
    key: "avaliacao",
    label: "Consulta médica online individual",
    subtitle: "Consulta online",
    price: 249,
    short: "1",
    description: "consulta médica online individual",
  },
};
const CONSULT_PRICE_LABEL = `R$${PLANS.avaliacao.price}`;
const PIX_CNPJ = "46.603.987/0001-30";
const INSTAGRAM_DR_ALEF = "https://www.instagram.com/dralefkotula/";

const FIXED_SCHEDULE = {
  "15-04": { dayName: "quarta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "16-04": { dayName: "quinta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "17-04": { dayName: "sexta-feira",  slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "18-04": { dayName: "sábado",       slots: ["9h","10h","11h","12h"] },
  "21-04": { dayName: "terça-feira",  slots: ["16h","17h","18h","19h","20h","21h","22h"] },
  "22-04": { dayName: "quarta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "23-04": { dayName: "quinta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "24-04": { dayName: "sexta-feira",  slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "25-04": { dayName: "sábado",       slots: ["9h","10h","11h","12h"] },
  "28-04": { dayName: "terça-feira",  slots: ["16h","17h","18h","19h","20h","21h","22h"] },
  "29-04": { dayName: "quarta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "30-04": { dayName: "quinta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
};

const PREMIUM_SLOT_PRIORITY = ["20h","21h","22h","19h","18h","17h","16h","15h","14h","13h","12h","11h","10h","9h"];
const WEEKDAY_PT = ["domingo","segunda-feira","terça-feira","quarta-feira","quinta-feira","sexta-feira","sábado"];

function getSlotPriority(dateKey) {
  const entry = FIXED_SCHEDULE[dateKey];
  if (!entry) return PREMIUM_SLOT_PRIORITY;
  const dn = norm(entry.dayName);
  if (dn.includes("sabado")) return ["9h","10h","11h","12h"];
  if (dn.includes("terca")) return ["20h","21h","22h","19h","18h","17h","16h"];
  return PREMIUM_SLOT_PRIORITY;
}

/* ═══════════════════════════════════════════════════════════════════
   UTILS BÁSICOS
   ═══════════════════════════════════════════════════════════════════ */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pad2(n) { return String(n).padStart(2, "0"); }
function currentYear() { return new Date().getFullYear(); }
function pickRandom(arr) { return Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : ""; }
function startOfToday() { const dt = new Date(); dt.setHours(0,0,0,0); return dt; }
function norm(s) { return (s || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim(); }
function clip(text, max = 900) { const t = (text || "").trim(); return t.length <= max ? t : t.slice(0, max).trim(); }
function similar(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  if (x.length > 60 && y.length > 60 && x.slice(0, 60) === y.slice(0, 60)) return true;
  return false;
}

function makeDateKey(day, month = 4) { return `${pad2(day)}-${pad2(month)}`; }
function parseDateKeyToDate(dateKey) {
  const [dd, mm] = dateKey.split("-").map(Number);
  return new Date(currentYear(), mm - 1, dd);
}
function isScheduleDateActive(dateKey) { return parseDateKeyToDate(dateKey) >= startOfToday(); }
function formatDatePt(dateKey) {
  const dt = parseDateKeyToDate(dateKey);
  return `${WEEKDAY_PT[dt.getDay()]} (${dateKey.replace("-", "/")})`;
}
function slotKey(dateKey, time) { return `${dateKey}|${time}`; }
function prettySlot(dateKey, time) { return `${formatDatePt(dateKey)} às ${time} (horário de Brasília)`; }

function sanitizeReply(text) {
  if (!text) return text;
  return text.replace(/PRECISA_PRECO|PRECISA_PAGAR|PRECISA_AGENDAR|__NEED_PRICE__|__NEED_PAY__|__NEED_BOOK__|__URGENT__|__NONE__/g, "")
    .replace(/\s{2,}/g, " ").trim();
}

/* ═══════════════════════════════════════════════════════════════════
   META CAPI (Purchase server-side)
   ═══════════════════════════════════════════════════════════════════ */

function sha256Hash(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");
}

async function sendMetaPurchaseServerSide({ paymentId, phone, email, value, planKey }) {
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) return false;
  const plan = PLANS[planKey] || PLANS.avaliacao || {};
  const eventData = {
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    event_id: String(paymentId),
    event_source_url: SITE_URL + "/obrigado-consulta/",
    action_source: "website",
    user_data: {},
    custom_data: {
      currency: "BRL",
      value: Number(value) || plan.price || 0,
      content_name: plan.label || "Consulta médica online individual",
      content_ids: [planKey || "avaliacao"],
      content_type: "product",
    },
  };
  if (phone) {
    const hPhone = sha256Hash(phone.replace(/\D/g, ""));
    eventData.user_data.ph = [hPhone];
    eventData.user_data.external_id = [hPhone];
  }
  if (email) eventData.user_data.em = [sha256Hash(email)];
  const payload = { data: [eventData] };
  if (META_TEST_EVENT_CODE) payload.test_event_code = META_TEST_EVENT_CODE;
  try {
    const url = `https://graph.facebook.com/v23.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`;
    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await resp.json();
    if (resp.ok) { console.log(`✅ Meta CAPI Purchase ${paymentId}`); return true; }
    console.error(`❌ Meta CAPI ${resp.status}:`, JSON.stringify(result));
    return false;
  } catch (err) { console.error("❌ Meta CAPI fetch erro:", err.message); return false; }
}

/* ═══════════════════════════════════════════════════════════════════
   DEDUP / DEBOUNCE / COOLDOWNS
   ═══════════════════════════════════════════════════════════════════ */

const _recentMessages = new Map();
const DEDUP_TTL_MS = 60000;
function _dedupKey(phone, text) { return `${phone}_${norm(text).replace(/\s+/g, "").slice(0, 120)}`; }
function _dedupCheck(phone, text) {
  const cached = _recentMessages.get(_dedupKey(phone, text));
  if (cached && (Date.now() - cached.ts) < DEDUP_TTL_MS) return cached.reply;
  return null;
}
function _dedupStore(phone, text, reply) {
  _recentMessages.set(_dedupKey(phone, text), { reply, ts: Date.now() });
  if (_recentMessages.size > 500) {
    const now = Date.now();
    for (const [k, v] of _recentMessages) if (now - v.ts > DEDUP_TTL_MS) _recentMessages.delete(k);
  }
}

const _inboundBuffer = new Map();
const DEBOUNCE_WINDOW_MS = 6000;
const _lastBotReplyAt = new Map();
const _lastAudioReplyAt = new Map();
const AUDIO_COOLDOWN_MS = 90_000;
const _lastMediaReplyAt = new Map();
const MEDIA_COOLDOWN_MS = 90_000;
const MIN_BOT_GAP_MS = 12000;

setInterval(() => {
  const now = Date.now();
  for (const [phone, buf] of _inboundBuffer) {
    const lastMsg = buf.messages[buf.messages.length - 1];
    if (lastMsg && (now - lastMsg.ts) > 120000) _inboundBuffer.delete(phone);
  }
  for (const [phone, ts] of _lastBotReplyAt) if (now - ts > 300000) _lastBotReplyAt.delete(phone);
}, 300000);

/* ═══════════════════════════════════════════════════════════════════
   MENSAGEM DE SISTEMA / META ADS
   ═══════════════════════════════════════════════════════════════════ */

function isSystemMessage(text) {
  if (!text || typeof text !== "string") return true;
  const t = text.trim();
  if (!t) return true;
  if (!/[a-zA-ZÀ-ÿ0-9]/.test(t)) return true;
  const low = t.toLowerCase();
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
  if (/^\[?(status|system|evento|event|notification)\]?/i.test(low)) return true;
  if (/^(delivered|sent|read|failed|queued|undelivered)$/i.test(low)) return true;
  if (/^(\[?(imagem|foto|image|video|vídeo|documento|document|sticker|figurinha|gif|contato|contact|localiza[cç][aã]o|location)\]?\s*\.?\s*)$/i.test(low)) return true;
  return false;
}

function isMetaAdsEntry(text) {
  const t = norm(text);
  if (/^(ol[aá]|oi)?\s*(como funciona|gostaria de saber mais|quero saber mais|quero mais informa[cç][oõ]es|me conte mais|saiba mais|tenho interesse|quero conhecer|gostaria de conhecer)\s*[.!?]?\s*$/i.test(t)) return true;
  if (/^(como funciona a consulta|como funciona o tratamento|como funciona o acompanhamento)\s*[.!?]?\s*$/.test(t)) return true;
  if (/^(gostaria de agendar|quero agendar uma consulta|quero marcar uma consulta)\s*[.!?]?\s*$/.test(t)) return true;
  if (t.length < 50 && /^.{0,10}como funciona/.test(t)) return true;
  if (t.length < 40 && /^.{0,10}(gostaria|quero|tenho interesse)/.test(t)) return true;
  if (/^.{0,15}(vim pelo instagram|vi no instagram|vi o video|vi o vídeo|vim pelo insta)/i.test(t)) return true;
  if (/preenchi\s+(seu|o)\s+formul[aá]rio/i.test(t)) return true;
  if (/gostaria de saber mais sobre sua empresa/i.test(t)) return true;
  if (/nome[_\s-]*completo\s*:|telefone\s*:.*\+?55|h[aá][_\s-]*quanto[_\s-]*tempo/i.test(t)) return true;
  // V30: campanha dor neuropática — palavras chave do form
  if (/dor[_\s-]*neuropatica|queimacao|choque[_\s-]*eletrico|gabapentina|amitriptilina|aceita[_\s-]*videochamada|aceita[_\s-]*r\$?[_\s-]*249/i.test(t)) return true;
  return false;
}

function stripDiacritics(text) { return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function normalizeLeadFieldKey(text) {
  return stripDiacritics(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
}
function extractMetaField(text, labelPattern) {
  if (!text) return null;
  const nextLabel = String.raw`(?=\n|(?:\s+(?:nome[_\s-]*completo|telefone|h[aá][_\s-]*quanto[_\s-]*tempo|o[_\s-]*que[_\s-]*voc[eê][_\s-]*quer[_\s-]*resolver|voc[eê][_\s-]*(?:j[aá][_\s-]*)?tentou|voc[eê][_\s-]*(?:tem|t[eê]m)[_\s-]*interesse|aceita[_\s-]*(?:r\$|videochamada|por\s+videochamada))\s*:)|$)`;
  const re = new RegExp(`${labelPattern}\\s*:\\s*([\\s\\S]*?)${nextLabel}`, "i");
  const match = String(text).match(re);
  return match?.[1]?.trim() || null;
}

/* V30: parser estendido — Q1..Q7 do formulário novo (DOR NEUROPÁTICA) */
function extendedFormParser(text) {
  if (!text) return null;
  const fields = {};
  const raw = String(text).replace(/\r/g, "");

  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const label = normalizeLeadFieldKey(line.slice(0, idx));
    const value = line.slice(idx + 1).trim();
    if (!value) continue;

    if (!fields.nome_completo && label.includes("nome_completo")) fields.nome_completo = value;
    else if (!fields.condition && (label.includes("o_que_voce_quer_resolver") || label.includes("tipo_de_caso") || label.includes("qual_e_a_sua_dor"))) fields.condition = value;
    else if (!fields.tempo && label.includes("ha_quanto_tempo")) fields.tempo = value;
    else if (!fields.impacto && (label.includes("impacto") || label.includes("atrapalha") || label.includes("rotina"))) fields.impacto = value;
    else if (!fields.tentou_tratamento && (label.includes("voce_ja_tentou") || label.includes("tratamentos") || label.includes("ja_tomou") || label.includes("ja_usou"))) fields.tentou_tratamento = value;
    else if (!fields.interesse && label.includes("voce_tem_interesse")) fields.interesse = value;
    else if (!fields.aceita_preco && (label.includes("aceita_r") || label.includes("249") || label.includes("aceita_pagar") || label.includes("aceita_o_valor"))) fields.aceita_preco = value;
    else if (!fields.aceita_videochamada && (label.includes("aceita_videochamada") || label.includes("aceita_por_videochamada") || label.includes("videoconsulta"))) fields.aceita_videochamada = value;
    else if (!fields.telefone && label.includes("telefone")) fields.telefone = value;
    // ── Roteiro 3 (REVISAR O TRATAMENTO — público já em cannabis) ──
    else if (!fields.ja_usa_cannabis && (label.includes("voce_usa_cannabis") || label.includes("usa_cannabis_medicinal"))) fields.ja_usa_cannabis = value;
    else if (!fields.dificuldades_tratamento && (label.includes("principal_dificuldade") || label.includes("dificuldade_no_seu_tratamento"))) fields.dificuldades_tratamento = value;
    else if (!fields.problema_tratado && (label.includes("qual_problema_voce_esta_tratando") || label.includes("problema_voce_esta_tratando") || label.includes("tentou_tratar"))) fields.problema_tratado = value;
    else if (!fields.gasto_mensal && (label.includes("quanto_voce_gasta_por_mes") || label.includes("gasta_por_mes") || label.includes("gasto_mensal"))) fields.gasto_mensal = value;
    else if (!fields.resolver_7dias && (label.includes("resolver_isso_nos_proximos_7_dias") || label.includes("proximos_7_dias") || label.includes("nos_proximos_7"))) fields.resolver_7dias = value;
  }

  // Fallbacks regex para layouts soltos
  if (!fields.nome_completo) fields.nome_completo = extractMetaField(raw, String.raw`nome[_\s-]*completo`) || null;
  if (!fields.condition) fields.condition = extractMetaField(raw, String.raw`o[_\s-]*que[_\s-]*voc[eê][_\s-]*quer[_\s-]*resolver[^:]*`) || extractMetaField(raw, String.raw`(?:tipo[_\s-]*de[_\s-]*caso|qual[_\s-]*[eé][_\s-]*a[_\s-]*sua[_\s-]*dor)[^:]*`) || null;
  if (!fields.tempo) fields.tempo = extractMetaField(raw, String.raw`h[aá][_\s-]*quanto[_\s-]*tempo[^:]*`) || null;
  if (!fields.impacto) fields.impacto = extractMetaField(raw, String.raw`(?:impacto|atrapalha|rotina)[^:]*`) || null;
  if (!fields.tentou_tratamento) fields.tentou_tratamento = extractMetaField(raw, String.raw`voc[eê][_\s-]*j[aá][_\s-]*tentou[^:]*`) || extractMetaField(raw, String.raw`(?:tratamentos|ja[_\s-]*tomou|ja[_\s-]*usou)[^:]*`) || null;
  if (!fields.interesse) fields.interesse = extractMetaField(raw, String.raw`voc[eê][_\s-]*(?:tem|t[eê]m)[_\s-]*interesse[^:]*`) || null;
  if (!fields.aceita_preco) fields.aceita_preco = extractMetaField(raw, String.raw`aceita[_\s-]*(?:r\$?[_\s-]*)?249[^:]*`) || extractMetaField(raw, String.raw`aceita[_\s-]*o[_\s-]*valor[^:]*`) || null;
  if (!fields.aceita_videochamada) fields.aceita_videochamada = extractMetaField(raw, String.raw`aceita[_\s-]*(?:por[_\s-]*)?videochamada[^:]*`) || extractMetaField(raw, String.raw`videoconsulta[^:]*`) || null;
  if (!fields.telefone) fields.telefone = extractMetaField(raw, String.raw`telefone`) || null;
  // Roteiro 3 fallbacks
  if (!fields.ja_usa_cannabis) fields.ja_usa_cannabis = extractMetaField(raw, String.raw`voc[eê][_\s-]*usa[_\s-]*cannabis[^:]*`) || null;
  if (!fields.dificuldades_tratamento) fields.dificuldades_tratamento = extractMetaField(raw, String.raw`principal[_\s-]*dificuldade[^:]*`) || extractMetaField(raw, String.raw`dificuldade[_\s-]*no[_\s-]*seu[_\s-]*tratamento[^:]*`) || null;
  if (!fields.problema_tratado) fields.problema_tratado = extractMetaField(raw, String.raw`qual[_\s-]*problema[_\s-]*voc[eê][_\s-]*est[aá][_\s-]*tratando[^:]*`) || extractMetaField(raw, String.raw`tentou[_\s-]*tratar[^:]*`) || null;
  if (!fields.gasto_mensal) fields.gasto_mensal = extractMetaField(raw, String.raw`quanto[_\s-]*voc[eê][_\s-]*gasta[_\s-]*por[_\s-]*m[eê]s[^:]*`) || extractMetaField(raw, String.raw`gasto[_\s-]*mensal[^:]*`) || null;
  if (!fields.resolver_7dias) fields.resolver_7dias = extractMetaField(raw, String.raw`resolver[_\s-]*isso[_\s-]*nos[_\s-]*pr[oó]ximos[_\s-]*7[_\s-]*dias[^:]*`) || extractMetaField(raw, String.raw`pr[oó]ximos[_\s-]*7[_\s-]*dias[^:]*`) || null;

  Object.keys(fields).forEach((key) => { if (!fields[key]) delete fields[key]; });
  return Object.keys(fields).length ? fields : null;
}

function parseMetaFormData(text) { return extendedFormParser(text); }

function extractFormFirstName(nomeCompleto) {
  if (!nomeCompleto) return null;
  const parts = nomeCompleto.split(/\s+/);
  if (!parts.length) return null;
  let first = parts[0].replace(/[^a-záéíóúâêîôûãõçñ]/gi, "");
  if (first.length < 2) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function isAffirmativeFormAnswer(value) {
  if (!value) return false;
  return /\b(sim|aceito|topo|ok|claro|com\s+certeza|positivo|posso|tudo\s+bem|por\s+favor|quero|aceitaria)\b/i.test(value);
}

/* V30: marca lead como qualificado se Q6 (preço) e Q7 (videochamada) afirmativos
   ou se o formulário traz dados suficientes (nome+condição) */
function markFormQualified(state) {
  const fd = state.form_data || {};
  const okPreco = isAffirmativeFormAnswer(fd.aceita_preco);
  const okVideo = isAffirmativeFormAnswer(fd.aceita_videochamada);
  const richEnoughR4 = !!(fd.nome_completo && fd.condition);
  const richEnoughR3 = !!(fd.nome_completo && (fd.ja_usa_cannabis || fd.dificuldades_tratamento || fd.gasto_mensal));
  state.form_qualified = (okPreco && okVideo) || richEnoughR4 || richEnoughR3 ? true : !!state.form_qualified;
  return state.form_qualified;
}

/* V30: detecta qual campanha o lead veio — Roteiro 3 (revisão de tratamento)
   ou Roteiro 4 (dor neuropática / primeira vez) ou outro. */
function detectFormTrack(formPayload, state) {
  const fd = formPayload || state?.form_data || {};
  const hasAnyR3Field = !!(fd.ja_usa_cannabis || fd.dificuldades_tratamento || fd.gasto_mensal || fd.resolver_7dias || fd.problema_tratado);
  const v = String(fd.ja_usa_cannabis || "").toLowerCase();

  // Detecta o sub-track pelo campo "você usa cannabis?"
  if (hasAnyR3Field) {
    // "Nunca usei" → primeira vez (NÃO perguntar sobre produto atual)
    if (/nunca\s+us[ei]/.test(v)) return "r3_primeira_vez";
    // "Sim, uso atualmente" → revisão
    if (/sim|uso\s+atualmente|uso\s+recentemente|atualmente|recentemente/.test(v)) return "r3_revisao";
    // "Já usei, mas parei" → retorno
    if (/j[aá]\s+usei.*parei|j[aá]\s+gastei.*parei|parei\s+de\s+usar|parei/.test(v)) return "r3_parou";
    // Sem ja_usa_cannabis explícito mas com outros sinais: olha o gasto
    const gasto = String(fd.gasto_mensal || "").toLowerCase();
    if (/nunca\s+us[ei]|n[aã]o\s+gasto|n[aã]o\s+uso/.test(gasto)) return "r3_primeira_vez";
    if (/parei|j[aá]\s+gastei.*parei/.test(gasto)) return "r3_parou";
    // Padrão: quem tem gasto/dificuldade mas não explicitou → revisão
    if (fd.gasto_mensal || fd.dificuldades_tratamento) return "r3_revisao";
  }
  if (fd.condition || fd.tentou_tratamento || fd.aceita_preco || fd.aceita_videochamada) return "r4_dor_neuro";
  return fd.nome_completo ? "generic" : null;
}

/* Parseia o texto livre de "dificuldades" do Roteiro 3 em flags estruturadas */
function parseDifficulties(raw) {
  const s = String(raw || "").toLowerCase();
  return {
    caro: /caro|custo|pre[cç]o|gasto|gastando/.test(s),
    pouco_efeito: /melhorou\s+pouco|pouco\s+efeito|n[aã]o\s+melhorou|sem\s+efeito|pouca\s+melhora/.test(s),
    efeito_ruim: /efeito\s+ruim|efeito\s+colateral|passou\s+mal|reac[cç][aã]o/.test(s),
    confuso: /confuso|confus[aã]o|perdido|n[aã]o\s+sei\s+(?:a\s+)?dose|dose|hor[aá]rio|produto/.test(s),
    sem_acompanhamento: /sem\s+acompanhamento|n[aã]o\s+senti\s+acompanhamento|sozinho|abandonado/.test(s),
  };
}

/* Classifica o gasto mensal em faixas pra usar no reframe */
function parseMonthlySpend(raw) {
  const s = String(raw || "").toLowerCase();
  if (/mais\s+de\s+r?\$?\s*1[.\s]?0{3}|acima.*1000|>\s*1000/.test(s)) return "mais_1000";
  if (/500.*1[.\s]?0{3}|500.*1000/.test(s)) return "500_1000";
  if (/250.*500/.test(s)) return "250_500";
  if (/at[eé]\s+r?\$?\s*250|at[eé]\s+250/.test(s)) return "ate_250";
  if (/j[aá]\s+gastei.*parei|parei/.test(s)) return "parei";
  if (/n[aã]o\s+gasto|zero|nada/.test(s)) return "nao_gasto";
  return null;
}

function getNested(obj, path) {
  return String(path || "").split(".").filter(Boolean).reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}
function firstNonEmpty(values = []) {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    return v;
  }
  return null;
}
function coerceInboundBoolean(value) {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const low = value.trim().toLowerCase();
    if (["true","1","yes","sim"].includes(low)) return true;
  }
  return false;
}
function cleanInboundText(value, { preserveNewlines = false } = {}) {
  if (value === undefined || value === null) return null;
  let text = String(value).replace(/\u0000/g, "").replace(/\\r/g, "").replace(/\r/g, "");
  if (preserveNewlines) {
    text = text.replace(/\\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return text || null;
  }
  text = text.replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
  return text || null;
}
function cleanInboundPhone(value) {
  const raw = cleanInboundText(value);
  if (!raw) return null;
  return raw.replace(/@s\.whatsapp\.net/gi, "").replace(/@g\.us/gi, "").replace(/\D/g, "");
}

function extractInboundEnvelope(body = {}) {
  const phoneValue = firstNonEmpty([
    body.telefone, body.phone, body.from, body.sender, body.number, body.remoteJid, body.jid,
    getNested(body, "data.phone"), getNested(body, "data.from"), getNested(body, "data.sender"),
    getNested(body, "data.key.remoteJid"), getNested(body, "key.remoteJid"),
    getNested(body, "event.data.phone"), getNested(body, "event.data.from"),
    getNested(body, "event.data.sender"), getNested(body, "event.data.key.remoteJid"),
  ]);
  const messageValue = firstNonEmpty([
    body.mensagem, body.message, body.text, body.body, body.caption,
    getNested(body, "data.body"), getNested(body, "data.text"),
    getNested(body, "data.message.conversation"), getNested(body, "data.message.extendedTextMessage.text"),
    getNested(body, "data.message.imageMessage.caption"), getNested(body, "data.message.videoMessage.caption"),
    getNested(body, "event.data.body"), getNested(body, "event.data.text"),
    getNested(body, "event.data.message.conversation"), getNested(body, "event.data.message.extendedTextMessage.text"),
  ]);
  const fromMeRaw = firstNonEmpty([
    body.fromMe, body.from_me, getNested(body, "data.fromMe"), getNested(body, "data.key.fromMe"),
    getNested(body, "key.fromMe"), getNested(body, "event.data.fromMe"), getNested(body, "event.data.key.fromMe"),
  ]);
  const messageTypeValue = firstNonEmpty([
    body.messageType, body.mediaType, body.type, body.mimetype,
    getNested(body, "data.messageType"), getNested(body, "data.mediaType"),
    getNested(body, "data.type"), getNested(body, "data.mimetype"),
    getNested(body, "event.data.messageType"), getNested(body, "event.data.mediaType"),
  ]);
  const contactNameValue = firstNonEmpty([
    body.nome, body.name, body.pushName,
    getNested(body, "data.nome"), getNested(body, "data.name"), getNested(body, "data.pushName"),
    getNested(body, "event.data.nome"), getNested(body, "event.data.name"), getNested(body, "event.data.pushName"),
  ]);
  return {
    phoneRaw: cleanInboundPhone(phoneValue),
    messageRaw: cleanInboundText(messageValue, { preserveNewlines: true }),
    fromMe: coerceInboundBoolean(fromMeRaw),
    incomingMsgType: String(cleanInboundText(messageTypeValue) || "").toLowerCase().trim(),
    contactName: extractFormFirstName(cleanInboundText(contactNameValue) || ""),
  };
}

/* ═══════════════════════════════════════════════════════════════════
   DATABASE
   ═══════════════════════════════════════════════════════════════════ */

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.on("error", (err) => console.error("❌ Postgres pool error:", err));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_users (
      phone TEXT PRIMARY KEY,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_slot_locks (
      slot_key TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'held',
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      from_number TEXT, to_number TEXT, body TEXT, direction TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkout_refs (
      ref TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);
  console.log("✅ Tabelas v30 prontas.");
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
    `INSERT INTO wa_users (phone, state, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (phone) DO UPDATE SET state=$2::jsonb, updated_at=NOW()`,
    [phone, JSON.stringify(newState)]
  );
}
function generateCheckoutRef() { return crypto.randomBytes(5).toString("hex"); }
async function saveCheckoutRef(ref, data) {
  await pool.query(
    `INSERT INTO checkout_refs (ref, data, created_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (ref) DO UPDATE SET data=$2::jsonb`,
    [ref, JSON.stringify(data)]
  );
}
async function getCheckoutRef(ref) {
  const { rows } = await pool.query("SELECT data FROM checkout_refs WHERE ref=$1", [ref]);
  return rows.length ? rows[0].data : null;
}
async function logMessage(from, to, body, direction) {
  try {
    await pool.query(`INSERT INTO messages (from_number, to_number, body, direction) VALUES ($1, $2, $3, $4)`,
      [from, to, (body || "").slice(0, 4000), direction]);
  } catch (err) { console.error("❌ logMessage:", err.message); }
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
   EXTRACTORS DE DOMÍNIO
   ═══════════════════════════════════════════════════════════════════ */

function extractFirstName(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const low = norm(t);
  if (/^(sim|ok|beleza|pode|claro|show|tanto faz|nao|não|\d+)$/.test(low)) return null;
  if (/^(dor|sono|ansiedade|fibromialgia|insônia|insonia|artrose|artrite|coluna|neuropatica|neuropática)$/.test(low)) return null;
  if (/^(sofro|sofrer|sofrimento|problema|mental|dificuldade|tristeza|depressao|depressão|angustia|angústia|desespero|ajuda|socorro|tratamento|medicamento|remedio|remédio|preciso|obrigad[oa]|brigad[oa])$/i.test(low.split(/\s+/)[0])) return null;

  const patterns = [
    /(?:pode\s+(?:me\s+)?chamar?\s+(?:de\s+)?)\s*(.+)/i,
    /(?:me\s+cham(?:a|o|e|ou|am)\s+(?:de\s+)?)\s*(.+)/i,
    /(?:(?:eu\s+)?sou\s+(?:o|a)\s+)\s*(.+)/i,
    /(?:(?:meu\s+)?nome\s+(?:e|é)\s+)\s*(.+)/i,
    /^(.+?)(?:\s+aqui)$/i,
  ];
  let candidate = null;
  for (const p of patterns) { const m = t.match(p); if (m && m[1]) { candidate = m[1].trim(); break; } }
  if (!candidate && t.includes("?")) return null;
  if (!candidate) candidate = t;
  candidate = candidate.split(/[\n.!?]/)[0].trim().replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!candidate) return null;
  const parts = candidate.split(" ").filter(Boolean);
  if (parts.length < 1 || parts.length > 5) return null;
  if (/^\d{1,4}$/.test(parts[0])) return null;
  const condWords = /^(dor|sono|ansiedade|fibromialgia|artrose|artrite|enxaqueca|coluna|insônia|insonia|lombar|neuropat|depressao|depressão|tristeza|sofrimento|problema|mental|angustia|angústia)/i;
  if (condWords.test(parts[0]) && parts.length <= 2) return null;
  const notNames = /^(oi|ola|olá|bom|boa|dia|dias|tarde|noite|noites|tudo|bem|obrigad|brigad|quero|preciso|gostaria|tenho|sim|nao|não|legal|caro|certo|entendi|entendo|sera|será|claro|ok|verdade|seria|acho|pode|pois|tipo|vou|vai|me|meu|minha|mas|antes|deixa|outra|outro|esse|essa|como|qual|quando|quanto|onde|porque|por|sofro|sofrer|dificuldade|desespero|socorro|ajuda|tratamento|medicamento|remedio|remédio|prefiro|nenhum|nenhuma|sobre|amanha|amanhã|agora|depois|durante|aqui|la|lá|ali|talvez|assim|entao|então|ainda|sempre|nunca|algo|alguem|alguém|ate|até|ontem|hoje|logo|ja|já|ai|aí|volta|volto|conversa|converso|falo|falar|penso|pensar|dormir|dormo|durmo|vamos|fico|demais|muito|pouco|todos|todo|toda|todas|cada|sinto|faz|faço|horas|vezes|anos|meses|semanas|tempo|gente|pessoa|pessoas|vida|coisa|forma|desde|quase|bastante|realmente|apenas|mesmo|olha|olho|estou|estava|tenha|seria|tambem|também|pra|pois|nem|sei|sabia|morrer|viver|consegue|consigo|posso|desculpa|conversamos|conversarmos|conversar|ir|indo|mando|bora|comecar|começar|eu)$/i;
  if (notNames.test(parts[0])) return null;
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
  for (const p of introPatterns) { const m = raw.match(p); if (m) { candidate = raw.slice(m.index + m[0].length).trim(); break; } }
  if (!candidate) candidate = raw;
  candidate = candidate.split(/[.!?\n]/)[0].trim().replace(/[^\p{L}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!candidate) return null;
  const stopWords = /^(claro|sim|ok|pode|certo|beleza|tudo|bem|obrigado|obrigada|é|e|o|a|meu|minha|com|certeza|bom|boa)$/i;
  let parts = candidate.split(" ").filter(Boolean);
  while (parts.length > 0 && stopWords.test(parts[0])) parts.shift();
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

/* V30: parsePostPayData — extrai nome completo + nascimento + email
   de uma única mensagem livre (ou parcial). */
function parsePostPayData(text) {
  if (!text) return { full: null, birth: null, email: null, missing: ["nome_completo","nascimento","email"] };
  const email = extractEmail(text);
  const birth = extractBirthDate(text);

  // remove email/data/dígitos do texto antes de procurar nome completo
  let cleanedForName = String(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, " ")
    .replace(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/g, " ");

  // tentar pegar nome completo de cada linha — escolhe a primeira que tem ≥2 palavras válidas
  let full = null;
  for (const line of cleanedForName.split(/\n|;|,/)) {
    const candidate = extractFullName(line);
    if (candidate) { full = candidate; break; }
  }
  if (!full) full = extractFullName(cleanedForName);

  const missing = [];
  if (!full) missing.push("nome_completo");
  if (!birth) missing.push("nascimento");
  if (!email) missing.push("email");
  return { full, birth, email, missing };
}

function extractDateKey(text) {
  const t = String(text || "");
  const validMonths = new Set(Object.keys(FIXED_SCHEDULE).map(k => Number(k.split("-")[1])));
  const m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})\b/);
  if (m) {
    const dd = Number(m[1]), mm = Number(m[2]);
    if (dd >= 1 && dd <= 31 && validMonths.has(mm)) {
      const key = makeDateKey(dd, mm);
      if (FIXED_SCHEDULE[key]) return key;
    }
  }
  const low = norm(t);
  const now = new Date();
  let bestKey = null, bestDiff = Infinity;
  for (const [key, val] of Object.entries(FIXED_SCHEDULE)) {
    if (!isScheduleDateActive(key)) continue;
    const dayNorm = norm(val.dayName);
    const abbrev = dayNorm.replace("-feira", "").replace("á", "a");
    if (low.includes(dayNorm) || low.includes(abbrev)) {
      const dt = parseDateKeyToDate(key);
      const diff = dt.getTime() - now.getTime();
      if (diff >= 0 && diff < bestDiff) { bestDiff = diff; bestKey = key; }
    }
  }
  return bestKey;
}

function validateDayDateConsistency(text, dateKey) {
  if (!dateKey || !FIXED_SCHEDULE[dateKey]) return { ok: true, dateKey };
  const low = norm(text);
  const dayNames = {
    segunda: "segunda-feira", terca: "terça-feira", terce: "terça-feira",
    quarta: "quarta-feira", quinta: "quinta-feira",
    sexta: "sexta-feira", sabado: "sábado", sab: "sábado",
  };
  let mentionedDay = null;
  for (const [abbr, full] of Object.entries(dayNames)) {
    if (low.includes(abbr)) { mentionedDay = full; break; }
  }
  if (!mentionedDay) return { ok: true, dateKey };
  const actualDay = FIXED_SCHEDULE[dateKey].dayName;
  if (norm(actualDay) !== norm(mentionedDay)) return { ok: false, dateKey, mentionedDay, actualDay };
  return { ok: true, dateKey };
}

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
  if (m) { const hh = Number(m[1]), mm = Number(m[2]); return mm === 0 ? `${hh}h` : `${pad2(hh)}:${pad2(mm)}`; }
  const m2 = low.match(/\b([01]?\d|2[0-3])\s?h(?:oras?)?\b/);
  if (m2) return `${Number(m2[1])}h`;
  const m3 = low.match(/^(\d{1,2})$/);
  if (m3) { const h = Number(m3[1]); if (h >= 7 && h <= 23) return `${h}h`; }
  const m4 = low.match(/\b(\d{1,2})\s*horas?\b/);
  if (m4) { const h = Number(m4[1]); if (h >= 7 && h <= 23) return `${h}h`; }
  return null;
}

function extractNumericChoice(text) {
  const t = norm(text).trim();
  if (/(?<!\d)1(?!\d)/.test(t) && !/(?<!\d)1\d/.test(t)) { if (/(?<!\d)1(?!\d)|primeiro|primeira/i.test(t)) return 1; }
  if (/(?<!\d)2(?!\d)/.test(t) && !/(?<!\d)2\d|\d2(?!\d)/.test(t)) { if (/(?<!\d)2(?!\d)|segundo|segunda/i.test(t)) return 2; }
  if (/(?<!\d)3(?!\d)/.test(t) && !/(?<!\d)3\d|\d3(?!\d)/.test(t)) { if (/(?<!\d)3(?!\d)|terceiro|terceira/i.test(t)) return 3; }
  if (/^1[a-záéíóú]/i.test(t)) return 1;
  if (/^2[a-záéíóú]/i.test(t)) return 2;
  if (/^3[a-záéíóú]/i.test(t)) return 3;
  if (/primeiro|primeira/i.test(t) && !/\d/.test(t)) return 1;
  if (/segundo|segunda/i.test(t) && !/\d/.test(t)) return 2;
  if (/terceiro|terceira/i.test(t) && !/\d/.test(t)) return 3;
  return null;
}

function isAffirmative(text) {
  if (!text) return false;
  const low = norm(text);
  if (/^(sim|simm|simmm|s|ok|okk|claro|com certeza|positivo|aceito|topo|aceitaria|pode ser|pode sim|isso|isso ai|isso aí|exatamente|perfeito|otimo|ótimo|certo|tudo bem|tudo certo|beleza|blz|bora|vamos|sigamos|sigamos em frente|sim quero|quero|tô dentro|to dentro|to|tô)$/i.test(low.replace(/[!.?,]/g, "").trim())) return true;
  if (/\b(sim|aceito|claro|com certeza|topo|pode mandar|manda|me manda|quero o link|quero pagar|bora pagar|bora|vamos)\b/.test(low)) return true;
  return false;
}

/* ═══════════════════════════════════════════════════════════════════
   CONDITION DETECTION
   ═══════════════════════════════════════════════════════════════════ */

function detectCondition(text) {
  const t = norm(text || "");
  if (!t) return null;
  // V30: dor neuropática primeiro (campanha alvo)
  if (/neuropat|queimacao|queimação|formigamento|choque eletrico|choque elétrico|dormencia|dormência|alfinetada|agulhada|polineuropat|nervo|neurit/.test(t)) return "dor_neuropatica";
  if (/fibromialgia|fm|dor (no )?corpo todo|todo o corpo doendo/.test(t)) return "fibromialgia";
  if (/insonia|insônia|nao consigo dormir|não consigo dormir|sono ruim|durmo mal|acordo de madrugada/.test(t)) return "insonia";
  if (/ansiedade|crise de panico|crise de pânico|sindrome do panico|síndrome do pânico|tag/.test(t)) return "ansiedade";
  if (/depress|tristeza profunda|nao tenho vontade|sem ânimo|sem animo/.test(t)) return "depressao";
  if (/enxaqueca|migrane|migrânea|dor de cabeca forte|dor de cabeça forte/.test(t)) return "enxaqueca";
  if (/artrose|artrite|reumat/.test(t)) return "artrose";
  if (/coluna|hernia de disco|hérnia de disco|lombar|cervic|ciatica|ciática/.test(t)) return "dor_lombar";
  if (/parkinson|tremor essencial/.test(t)) return "parkinson";
  if (/autismo|tea|espectro autista/.test(t)) return "autismo";
  if (/epilepsia|convuls/.test(t)) return "epilepsia";
  if (/cancer|câncer|quimio|onco/.test(t)) return "cancer";
  if (/dor cronica|dor crônica|cronicas|crônicas/.test(t)) return "dor_cronica";
  return null;
}

function extractProblemText(text) {
  const t = (text || "").trim();
  if (!t || t.length < 4) return null;
  if (/^(oi|ola|olá|bom dia|boa tarde|boa noite|tudo bem)$/i.test(norm(t))) return null;
  return t.slice(0, 400);
}

/* ═══════════════════════════════════════════════════════════════════
   INTENT DETECTION
   ═══════════════════════════════════════════════════════════════════ */

function detectIntent(text) {
  const t = norm(text);
  return {
    wantsPrice: /\b(quanto|preco|preço|custa|valor|valores|investimento|quanto fica|quanto custa|tabela|orcamento|orçamento|preço da consulta)\b/.test(t),
    intentPay:  /\b(pagar|paguei|pagamento|link de pagamento|link pra pagar|me manda o link|manda o link|quero o link|finalizar|fechar|fecha pra mim|cartao|cartão|parcelar|pix|gerar link|me passa o link|envia o link)\b/.test(t),
    wantsBook:  /\b(agendar|marcar|marca pra mim|agenda|agendamento|marcar consulta|marcar uma consulta|reservar)\b/.test(t),
    asksHours:  /\b(que horas|qual horario|qual horário|horarios|horários|tem hora|tem horario|tem horário|tem vaga|que dia tem vaga|disponibilidade|tem disponibilidade)\b/.test(t),
    mentionsDayAvail: /\b(amanha|amanhã|hoje|depois de amanha|depois de amanhã|essa semana|proxima semana|próxima semana|semana que vem|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado)\b/.test(t),
    confirms:   /\b(sim|claro|pode ser|pode sim|aceito|topo|tudo bem|isso|isso mesmo|ok|certo|perfeito)\b/.test(t),
    refuses:    /\b(nao quero|não quero|nao tenho interesse|não tenho interesse|sem interesse|nao agora|não agora)\b/.test(t),
    asksHowConsultWorks: /\b(como funciona|como e a consulta|como é a consulta|como sera|como será|o que tem na consulta|como funciona a consulta|tempo de consulta|duração|duracao)\b/.test(t),
    asksIfOnline: /\b(online|video|vídeo|videochamada|chamada de video|chamada de vídeo|presencial|tem que ir|preciso ir|google meet|zoom|whatsapp video)\b/.test(t),
    asksIfWorks:  /\b(funciona mesmo|funciona|tem resultado|adianta|vai resolver|melhora|tem cura|tem chance|alivia)\b/.test(t),
    asksIfForMe:  /\b(serve pra mim|é pra mim|serve no meu caso|adianta no meu caso|funciona pra mim)\b/.test(t),
    asksLegal:    /\b(legal|liberado|aprovado|anvisa|legalizado|permitido)\b/.test(t),
    asksChapado:  /\b(chapad|fica doido|pira|viciar|vicio|vício|dependência|dependencia|psicoativ)\b/.test(t),
    saysExpensive:/\b(caro|cara|muito|puxado|puxada|desconto|barato|barata|menos|menor|sem condicoes|sem condições|nao tenho dinheiro|não tenho dinheiro)\b/.test(t),
    saysCheaperElsewhere: /\b(mais barato|menos|outro medico mais barato|outro médico mais barato)\b/.test(t),
    saysWillSee:  /\b(vou pensar|deixa eu pensar|preciso ver|me organizo|depois te falo|te aviso depois|amanha eu volto|amanhã eu volto|deixa para depois|outra hora)\b/.test(t),
    saysUnsure:   /\b(nao sei|não sei|talvez|sei nao|sei não|tenho duvida|tenho dúvida|incerto)\b/.test(t),
    saysCheckSpouse: /\b(vou conversar com (meu|minha) (esposa|marido|esposo|companheiro|companheira)|preciso falar com (a familia|a família))\b/.test(t),
    isSleepy:    /\b(boa noite|to indo dormir|tô indo dormir|vou dormir|amanha continuamos|amanhã continuamos|amanha falamos|amanhã falamos)\b/.test(t),
    wantsLater:  /\b(amanha eu volto|amanhã eu volto|na segunda eu volto|outra hora a gente fala|outro dia)\b/.test(t),
    endsConversation: /\b(obrigad[ao] por enquanto|tchau|valeu|brigad[ao]|so isso por agora|só isso por agora)\b/.test(t),
    urgency: /\b(socorro|urgente|emergencia|emergência|pronto socorro|samu|192|nao aguento mais a dor|não aguento mais a dor|to passando mal|tô passando mal|infarto|avc|sangrando|desmaio|convuls)\b/.test(t),
    emotionalRisk: /\b(me matar|suicidio|suicídio|nao quero mais viver|não quero mais viver|por fim na vida|acabar com tudo|tirar a vida|acabar comigo)\b/.test(t),
    asksIsScam:  /\b(golpe|fraude|enganacao|enganação|suspeito|desconfiado|isso e serio|isso é sério|verdade mesmo|isso e real|isso é real|confiavel|confiável|seguro|enrolacao|enrolação|enganando|farsa)\b/.test(t),
    asksWho:     /\b(quem e voce|quem é você|quem fala|com quem (eu )?falo|voce e do consultorio|você é do consultório|voce e a secretaria|você é a secretária|voce e medica|você é médica|voce e robo|você é robô|voce e bot|você é bot|voce e humana|você é humana)\b/.test(t),
    asksWhereSP: /\b(onde fica|qual endereco|qual endereço|qual cidade|que cidade|consultorio onde|consultório onde)\b/.test(t),
    asksAboutDoctor: /\b(quem e o dr|quem é o dr|quem e o medico|quem é o médico|crm|formacao|formação|especialista|especialidade|onde se formou)\b/.test(t),
    hasQuestion: /\?/.test(text || ""),
    shortAffirm: isAffirmative(text),
    casualAck:   /^(blz|beleza|massa|legal|bacana|show|otimo|ótimo|perfeito|valeu|brigad[oa]|obrigad[oa])\.?$/i.test(t.trim()),

    /* V30.1 — flags novos pra evitar dump de template em pergunta substantiva */
    mentionsSeriousCondition: /\b(esclerose\s+m[uú]ltipla|esclerose|parkinson|alzheimer|c[aâ]ncer|cancer|leucemia|linfoma|epilepsia|epileps[ií]a|autism[oa]|tea|sindrome|s[ií]ndrome|avc|derrame|hiv|lupus|l[uú]pus|artrite\s+reumatoide|reumatoide|crohn|colite|demencia|dem[eê]ncia|parkinsonismo|par[aá]lise|hemiplegia|amputa[çc][aã]o|amputad|lesao\s+medular|les[aã]o\s+medular|necessidades\s+especiais|deficiente|deficiencia|defici[eê]ncia)\b/i.test(t),
    asksAboutPrescription: /\b(prescri[çc][aã]o|prescre(ve|vo|ver)|receita|laudo|importar|hc|flor\s+(seca|para\s+vaporiza[çc][aã]o)|vaporiza[çc][aã]o|vaporiz|\bthc\b|\bcbd\b|\bcbg\b|cbn|perfil\s+do\s+[oó]leo|concentra[çc][aã]o|mg|full\s+spectrum|broad\s+spectrum|isolado|isolada|espectro\s+completo|dose|posologia|dosagem)\b/.test(t),
    mentionsOwnMedication: /\b(tomo|uso\s+atualmente|estou\s+tomando|estou\s+usando|uso\s+\w+pentina|gabapentina|pregabalina|amitriptilina|tramadol|codeina|morfina|oxicodona|duloxetina|venlafaxina|sertralina|fluoxetina|escitalopram|clonazepam|rivotril|alprazolam|diazepam|quetiapina|olanzapina|risperidona|lamotrigina|carbamazepina|levetiracetam|topiramato|baclofeno|tizanidina|metilfenidato|ritalina|concerta|ancitalopram|citalopram)\b/.test(t),
    isSubstantiveMessage: (t.length >= 120) || ((text.match(/\?/g) || []).length >= 2) || ((t.match(/[.,]/g) || []).length >= 3 && t.length >= 60),
    hasMultipleAsks: (text.match(/\?/g) || []).length >= 2 || /\b(e|tamb[eé]m|al[eé]m|outra\s+coisa|outra\s+pergunta|segunda\s+pergunta|mais\s+uma)\b/.test(t) && /\?/.test(text || ""),
    sharesPersonalStory: t.length >= 100 && /\b(meu|minha|eu (tenho|sofro|sou|tive|fiz|uso|tomo|estou|estava|perdi|perdo|convivo)|sou\s+portador|portadora)\b/.test(t),

    /* V30.2 — compromisso com data específica (lead tá postergando pagamento com justificativa real) */
    schedulingCommitment: /\b(quarto\s+dia\s+[uú]til|quinto\s+dia\s+[uú]til|pr[oó]ximo\s+(dia|m[eê]s|final\s+de\s+semana)|dia\s+(0?[1-9]|[12][0-9]|3[01])\b|quando\s+(eu\s+)?receber|quando\s+cair\s+(o|meu)\s+sal[aá]rio|assim\s+que\s+receber|assim\s+que\s+cair|semana\s+que\s+vem|m[eê]s\s+que\s+vem|pr[oó]xima\s+semana|pr[oó]ximo\s+m[eê]s|no\s+final\s+do\s+m[eê]s|depois\s+do\s+dia|ap[oó]s\s+o\s+dia|vou\s+fazer\s+(a\s+)?consulta\s+(dia|em|no|depois)|farei\s+(a\s+)?consulta|farei\s+uma\s+consulta)\b/.test(t),
  };
}

function classifyLead(flags, text, state) {
  const t = norm(text || "");
  if (state?.lead_profile && state.lead_profile !== "padrao") return state.lead_profile;
  if (flags.urgency || flags.emotionalRisk) return "emocional";
  if (flags.asksIsScam || flags.asksWho) return "desconfiado";
  if (flags.intentPay || flags.wantsBook || flags.asksHours) return "quente";
  if (flags.saysExpensive || flags.saysCheaperElsewhere) return "comparador";
  if (flags.saysWillSee || flags.saysUnsure) return "cetico";
  if (flags.refuses) return "frio";
  if (/\b(quanto|preco|preço|custa|valor)\b/.test(t)) return "pragmatico";
  return "padrao";
}

function hasQuestion(text) { return /\?/.test(text || ""); }

/* ═══════════════════════════════════════════════════════════════════
   V30.3 — POSTPONEMENT DETECTION
   Detecta quando o lead marca um compromisso de retomar depois
   (financeiro, data específica, evento, decisional, vago) e extrai
   a referência temporal. Substitui o regex binário `schedulingCommitment`
   por classificação estruturada que permite resposta adaptativa.
   ═══════════════════════════════════════════════════════════════════ */

function _numFromPtWord(s) {
  const m = String(s || "").match(/\d+/);
  if (m) return parseInt(m[0], 10);
  const words = {
    primeiro:1, segundo:2, terceiro:3, quarto:4, quinto:5, sexto:6,
    setimo:7, "sétimo":7, oitavo:8, nono:9, decimo:10, "décimo":10,
    um:1, uma:1, dois:2, duas:2, tres:3, "três":3, quatro:4, cinco:5,
    seis:6, sete:7, oito:8, nove:9, dez:10, onze:11, doze:12,
    quinze:15, vinte:20, trinta:30
  };
  const low = String(s || "").toLowerCase();
  for (const w in words) if (new RegExp(`\\b${w}\\b`).test(low)) return words[w];
  return null;
}

function detectPostponement(text) {
  const t = (norm(text || "")).toLowerCase();
  if (!t) return { detected: false };

  // ─── FINANCIAL ─────────────────────────────────────────────────
  const mBusDay = t.match(/\b((?:primeiro|segundo|terceiro|quarto|quinto|sexto|s[eé]timo|oitavo|nono|d[eé]cimo|\d+)[º°o]?)\s*dia\s*[uú]til/);
  if (mBusDay) {
    const n = _numFromPtWord(mBusDay[1]) || 5;
    return { detected: true, type: "financial", timeRef: { kind: "business_days", value: n }, rawMatch: mBusDay[0] };
  }

  if (/\b(receber|cair|chegar|entrar|vir)\s+(o\s+|meu\s+|a\s+)?sal[aá]rio\b|\bdepois\s+do\s+pagamento\b|\bdia\s+do\s+(meu\s+)?sal[aá]rio\b|\bquando\s+cair\s+o\s+pg\b|\b(depois\s+que|quando)\s+(eu\s+)?receber\b(?!\s+(o\s+)?resultado|\s+(o\s+)?retorno|\s+(o\s+)?laudo|\s+(a\s+)?resposta)/.test(t)) {
    return { detected: true, type: "financial", timeRef: { kind: "salary" }, rawMatch: "salário" };
  }

  if (/\b(inss|aposentadoria|aposentar|benef[ií]cio|bpc|bolsa\s*fam[ií]lia|aux[ií]lio|pens[aã]o)\b/.test(t)) {
    return { detected: true, type: "financial", timeRef: { kind: "benefit" }, rawMatch: "benefício" };
  }

  if (/\b(13[º°o]?\b|d[eé]cimo\s*terceiro|decimo terceiro)\b/.test(t)) {
    return { detected: true, type: "financial", timeRef: { kind: "thirteenth" }, rawMatch: "13º" };
  }

  if (/\bquinzena\b/.test(t)) {
    return { detected: true, type: "financial", timeRef: { kind: "fortnight" }, rawMatch: "quinzena" };
  }

  if (/\b(virada\s+do\s+m[eê]s|fim\s+do\s+m[eê]s|final\s+do\s+m[eê]s|m[eê]s\s+que\s+vem|pr[oó]ximo\s+m[eê]s|outro\s+m[eê]s|m[eê]s\s+que\s+entra)\b/.test(t)) {
    return { detected: true, type: "financial", timeRef: { kind: "next_month" }, rawMatch: "próximo mês" };
  }

  if (/\b(quando\s+(eu\s+|a\s+gente\s+)?tiver\s+(o\s+|a\s+)?(dinheiro|grana|condi[cç][aã]o)|quando\s+juntar|quando\s+conseguir\s+(o\s+dinheiro|a\s+grana|juntar)|juntar\s+a\s+grana|assim\s+que\s+conseguir|quando\s+der\s+pra\s+pagar|sem\s+condi[cç][oõ]es\s+agora|t[oô]\s+sem\s+dinheiro)\b/.test(t)) {
    return { detected: true, type: "financial", timeRef: { kind: "when_possible" }, rawMatch: "quando conseguir" };
  }

  // ─── DATED ─────────────────────────────────────────────────────
  const mDay = t.match(/\b(?:dia|a partir do dia|depois do dia|ap[oó]s o dia|no dia)\s+(\d{1,2})(?!\s*[uú]til)/);
  if (mDay) {
    const d = parseInt(mDay[1], 10);
    if (d >= 1 && d <= 31) {
      return { detected: true, type: "dated", timeRef: { kind: "month_day", value: d }, rawMatch: mDay[0] };
    }
  }

  const mDate = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
  if (mDate) {
    return { detected: true, type: "dated", timeRef: { kind: "date_literal", value: mDate[0] }, rawMatch: mDate[0] };
  }

  const mAhead = t.match(/\bdaqui\s+(?:a\s+)?(\d+|uma?|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|quinze)\s*(dia|dias|semana|semanas|m[eê]s|m[eê]ses)\b/);
  if (mAhead) {
    const n = _numFromPtWord(mAhead[1]) || 1;
    const unit = /semana/.test(mAhead[2]) ? "weeks" : /m[eê]s/.test(mAhead[2]) ? "months" : "days";
    return { detected: true, type: "dated", timeRef: { kind: "ahead", unit, value: n }, rawMatch: mAhead[0] };
  }

  if (/\b(semana\s+que\s+vem|pr[oó]xima\s+semana|outra\s+semana|semana\s+que\s+entra)\b/.test(t)) {
    return { detected: true, type: "dated", timeRef: { kind: "nextweek" }, rawMatch: "semana que vem" };
  }

  const mWk = t.match(/\b(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)(?:-feira|\s+feira)?\b/);
  if (mWk && /\b(pr[oó]xim[ao]|que\s+vem|na\s+pr[oó]xima)\b/.test(t)) {
    return { detected: true, type: "dated", timeRef: { kind: "next_weekday", value: mWk[1] }, rawMatch: mWk[0] };
  }

  // ─── EVENT-BASED ───────────────────────────────────────────────
  if (/\b(depois\s+do\s+feriado|ap[oó]s\s+o\s+feriado|passando\s+o\s+feriado|passar\s+o\s+feriado)\b/.test(t)) {
    return { detected: true, type: "event", timeRef: { kind: "holiday" }, rawMatch: "feriado" };
  }

  const mEvt = t.match(/\b(cirurgia|opera[cç][aã]o|procedimento|exame|viagem|f[eé]rias|mudan[cç]a|reuni[aã]o|reabilita[cç][aã]o|interna[cç][aã]o|tratamento\s+(que\s+)?fa[cç]o)\b/);
  if (mEvt && /\b(depois|ap[oó]s|quando\s+(voltar|acabar|terminar|passar|melhorar))\b/.test(t)) {
    return { detected: true, type: "event", timeRef: { kind: "event_end", value: mEvt[1] }, rawMatch: mEvt[0] };
  }

  if (/\b(depois\s+do?\s+(resultado|retorno|laudo|resposta)|quando\s+(sair|chegar|vier|receber)\s+(o|a)\s+(resultado|retorno|laudo|resposta)|quando\s+(eu\s+)?receber\s+(o|a)\s+(resultado|retorno|laudo|resposta)|depois\s+que\s+(eu\s+)?receber\s+(o|a)\s+(resultado|retorno|laudo|resposta)|depois\s+que\s+o\s+(m[eé]dico|doutor)\s+(me\s+)?ver)\b/.test(t)) {
    return { detected: true, type: "event", timeRef: { kind: "medical_pending" }, rawMatch: "resultado/consulta médica" };
  }

  // ─── DECISIONAL ────────────────────────────────────────────────
  if (/\b(conversar|falar|ver|consultar|combinar|alinhar)\s+com\s+(m(eu|inha)|a|o|os|as)\s+(esposa|esposo|marido|mulher|companheir[ao]|fam[ií]lia|filh[oa]s?|m[aã]e|pai|irm[aã]o|irm[aã]|m[eé]dico|doutor[a]?|namorad[oa])/.test(t)) {
    return { detected: true, type: "decisional", timeRef: { kind: "consult_family" }, rawMatch: "conversar com família/médico" };
  }

  if (/\b(vou\s+(pensar|ver|analisar|avaliar|decidir)|preciso\s+(pensar|ver|analisar|avaliar|decidir|me\s+organizar)|deixa\s+eu\s+(pensar|ver)|ainda\s+estou\s+pensando|tenho\s+que\s+pensar)\b/.test(t)) {
    return { detected: true, type: "decisional", timeRef: { kind: "think" }, rawMatch: "pensar" };
  }

  // ─── VAGUE ─────────────────────────────────────────────────────
  if (/\b(mais\s+tarde|daqui\s+a\s+pouco|mais\s+pra\s+frente|depois\s+eu\s+volto|outra\s+hora|outro\s+dia|qualquer\s+hora|quando\s+puder|quando\s+der|agora\s+n[aã]o|n[aã]o\s+agora|mais\s+pra?\s+frente)\b/.test(t)) {
    return { detected: true, type: "vague", timeRef: { kind: "later" }, rawMatch: "mais tarde" };
  }

  return { detected: false };
}

function estimateCommitmentTimestamp(timeRef, nowMs = Date.now()) {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date(nowMs);
  if (!timeRef || !timeRef.kind) return nowMs + 3 * DAY;

  const addDaysTo = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x.getTime(); };
  const nthBusinessDay = (y, m, n) => {
    const d = new Date(y, m, 1);
    let counted = 0;
    while (counted < n) {
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) counted += 1;
      if (counted < n) d.setDate(d.getDate() + 1);
    }
    return d.getTime();
  };

  switch (timeRef.kind) {
    case "business_days": {
      const n = Math.max(1, Math.min(20, timeRef.value || 5));
      let ts = nthBusinessDay(now.getFullYear(), now.getMonth(), n);
      if (ts < nowMs - DAY) ts = nthBusinessDay(now.getFullYear(), now.getMonth() + 1, n);
      return ts + DAY; // followup 1 dia depois do compromisso
    }
    case "salary":         return addDaysTo(new Date(now.getFullYear(), now.getMonth() + 1, 5), 1);
    case "benefit":        return addDaysTo(new Date(now.getFullYear(), now.getMonth() + 1, 2), 1);
    case "thirteenth":     return new Date(now.getFullYear(), 11, 15).getTime();
    case "fortnight":      return nowMs + 15 * DAY;
    case "next_month":     return new Date(now.getFullYear(), now.getMonth() + 1, 3).getTime();
    case "when_possible":  return nowMs + 7 * DAY;
    case "month_day": {
      const d = Math.max(1, Math.min(31, timeRef.value || 1));
      const cand = new Date(now.getFullYear(), now.getMonth(), d).getTime();
      return (cand < nowMs ? new Date(now.getFullYear(), now.getMonth() + 1, d).getTime() : cand) + DAY;
    }
    case "date_literal":   return nowMs + 5 * DAY;
    case "ahead": {
      const v = timeRef.value || 1;
      if (timeRef.unit === "weeks")  return nowMs + v * 7 * DAY + DAY;
      if (timeRef.unit === "months") return nowMs + v * 30 * DAY;
      return nowMs + v * DAY + DAY;
    }
    case "nextweek":       return nowMs + 8 * DAY;
    case "next_weekday":   return nowMs + 7 * DAY;
    case "holiday":        return nowMs + 4 * DAY;
    case "event_end":      return nowMs + 7 * DAY;
    case "medical_pending":return nowMs + 10 * DAY;
    case "think":          return nowMs + 2 * DAY;
    case "consult_family": return nowMs + 2 * DAY;
    case "later":          return nowMs + 1 * DAY;
    default:               return nowMs + 3 * DAY;
  }
}

function _echoPostponement(timeRef) {
  if (!timeRef) return "quando fizer sentido pra você";
  switch (timeRef.kind) {
    case "business_days":  return `até o ${timeRef.value}º dia útil`;
    case "salary":         return "assim que o salário cair";
    case "benefit":        return "quando o benefício cair";
    case "thirteenth":     return "quando o 13º chegar";
    case "fortnight":      return "na próxima quinzena";
    case "next_month":     return "quando virar o mês";
    case "when_possible":  return "quando conseguir se organizar";
    case "month_day":      return `a partir do dia ${timeRef.value}`;
    case "date_literal":   return `na data que você combinou (${timeRef.value})`;
    case "ahead":          return "no prazo que você se programou";
    case "nextweek":       return "na próxima semana";
    case "next_weekday":   return `na ${timeRef.value} que vem`;
    case "holiday":        return "depois do feriado";
    case "event_end": {
      const evt = String(timeRef.value || "compromisso");
      const FEM = new Set(["cirurgia","operacao","operação","viagem","mudança","mudanca","reunião","reuniao","reabilitação","reabilitacao","internação","internacao","consulta"]);
      const art = FEM.has(evt) ? "dessa" : "desse";
      return `depois ${art} ${evt}`;
    }
    case "medical_pending":return "quando esse acompanhamento chegar num ponto certo";
    case "think":          return "quando tiver pensado com calma";
    case "consult_family": return "depois que conversar em casa";
    case "later":
    default:               return "quando fizer sentido pra você";
  }
}

/* ═══════════════════════════════════════════════════════════════════
   SLOT MANAGEMENT
   ═══════════════════════════════════════════════════════════════════ */

async function getAvailableSlotsForDate(dateKey) {
  const entry = FIXED_SCHEDULE[dateKey];
  if (!entry) return [];
  const all = entry.slots || [];
  const { rows } = await pool.query(
    `SELECT slot_key, status, expires_at FROM wa_slot_locks WHERE slot_key LIKE $1`,
    [`${dateKey}|%`]
  );
  const blocked = new Set();
  const now = Date.now();
  for (const row of rows) {
    if (row.status === "paid") blocked.add(row.slot_key);
    else if (row.status === "held" && row.expires_at && new Date(row.expires_at).getTime() > now) blocked.add(row.slot_key);
  }
  return all.filter((time) => !blocked.has(slotKey(dateKey, time)));
}

async function chooseBestSlotsForDate(dateKey, count = 3) {
  const avail = await getAvailableSlotsForDate(dateKey);
  if (!avail.length) return [];
  const priority = getSlotPriority(dateKey);
  const sorted = [...avail].sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
  return sorted.slice(0, count);
}

async function getSuggestedDayKeys() {
  const today = startOfToday();
  const keys = Object.keys(FIXED_SCHEDULE).filter((k) => parseDateKeyToDate(k) >= today).slice(0, 4);
  // só devolve se tiver pelo menos 1 slot livre
  const out = [];
  for (const k of keys) {
    const avail = await getAvailableSlotsForDate(k);
    if (avail.length) out.push(k);
    if (out.length >= 3) break;
  }
  return out;
}

async function findNearestAvailableDay(targetDateKey) {
  const target = parseDateKeyToDate(targetDateKey).getTime();
  const candidates = Object.keys(FIXED_SCHEDULE)
    .filter((k) => isScheduleDateActive(k))
    .map((k) => ({ key: k, diff: Math.abs(parseDateKeyToDate(k).getTime() - target) }))
    .sort((a, b) => a.diff - b.diff);
  for (const c of candidates) {
    const avail = await getAvailableSlotsForDate(c.key);
    if (avail.length) return c.key;
  }
  return null;
}

async function acquireSlotHold(dateKey, time, phone) {
  const key = slotKey(dateKey, time);
  const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);
  try {
    const { rows } = await pool.query(
      `INSERT INTO wa_slot_locks (slot_key, phone, status, expires_at)
       VALUES ($1, $2, 'held', $3)
       ON CONFLICT (slot_key) DO UPDATE SET
         phone = CASE WHEN wa_slot_locks.status = 'paid' THEN wa_slot_locks.phone
                      WHEN wa_slot_locks.expires_at < NOW() THEN EXCLUDED.phone
                      WHEN wa_slot_locks.phone = EXCLUDED.phone THEN EXCLUDED.phone
                      ELSE wa_slot_locks.phone END,
         status = CASE WHEN wa_slot_locks.status = 'paid' THEN 'paid'
                       WHEN wa_slot_locks.expires_at < NOW() THEN 'held'
                       WHEN wa_slot_locks.phone = EXCLUDED.phone THEN 'held'
                       ELSE wa_slot_locks.status END,
         expires_at = CASE WHEN wa_slot_locks.status = 'paid' THEN wa_slot_locks.expires_at
                           WHEN wa_slot_locks.expires_at < NOW() THEN EXCLUDED.expires_at
                           WHEN wa_slot_locks.phone = EXCLUDED.phone THEN EXCLUDED.expires_at
                           ELSE wa_slot_locks.expires_at END,
         updated_at = NOW()
       RETURNING slot_key, phone, status`,
      [key, phone, expiresAt]
    );
    const row = rows[0];
    if (row && row.phone === phone && row.status === "held") return { ok: true, slot_key: key };
    return { ok: false };
  } catch (err) { console.error("❌ acquireSlotHold:", err.message); return { ok: false }; }
}

async function markSlotPaid(slot_key, phone) {
  try {
    await pool.query(
      `UPDATE wa_slot_locks SET status='paid', paid_at=NOW(), updated_at=NOW(), expires_at=NULL
       WHERE slot_key=$1 AND phone=$2`,
      [slot_key, phone]
    );
  } catch (err) { console.error("❌ markSlotPaid:", err.message); }
}

async function releaseOldHeldSlotsForPhone(phone, exceptSlotKey) {
  try {
    await pool.query(
      `DELETE FROM wa_slot_locks WHERE phone=$1 AND status='held' AND slot_key <> $2`,
      [phone, exceptSlotKey]
    );
  } catch (err) { console.error("❌ releaseOldHeldSlotsForPhone:", err.message); }
}

/* ═══════════════════════════════════════════════════════════════════
   EVIDENCE_DB — bloco DOR NEUROPÁTICA expandido (v30)
   ═══════════════════════════════════════════════════════════════════ */

const EVIDENCE_DB = {
  dor_neuropatica: {
    direct_answer: "Sim. Estudos clínicos mostram redução de 30 a 50% na intensidade da dor neuropática com cannabis medicinal — especialmente nos casos em que gabapentina, pregabalina e amitriptilina não chegaram a aliviar de verdade.",
    empathy: [
      "Queimação nos pés de madrugada e choque elétrico que não para — é uma das dores mais desgastantes que existe.",
      "Formigamento, peso, choque elétrico — e ainda a sensação de que os remédios só deixam a pessoa grogue sem tirar a dor.",
      "É uma dor que cansa o corpo e a cabeça. Atrapalha o sono, atrapalha o ânimo, atrapalha tudo.",
      "Já vi muita gente chegar aqui depois de anos tomando gabapentina e amitriptilina sem alívio real — só efeito colateral.",
    ],
    testimony: "Tenho pacientes que chegaram tomando 4 comprimidos por dia de gabapentina e ainda assim acordavam de madrugada com dor. Depois de algumas semanas no tratamento certo conseguiram dormir a noite inteira.",
    mechanism: "A dor neuropática não vem do tecido inflamado — vem do próprio nervo disparando errado. Gabapentina e pregabalina tentam acalmar esse disparo agindo no GABA. Amitriptilina age na serotonina. Já o sistema endocanabinoide tem receptores CB1 e CB2 espalhados exatamente nos nervos periféricos e na medula — atua direto na origem do sinal.",
    study: "A Anvisa autoriza prescrição desde 2019 (RDC 327, atualizada pela RDC 660). A OMS reconhece o perfil de segurança favorável do CBD. Estudos publicados em revistas como o Journal of Pain mostram redução média de 30 a 50% na intensidade da dor neuropática.",
    hope: "Dor neuropática é difícil, mas não é caso perdido. Tem caminho.",
    bridge: "Faz sentido marcar a consulta com o Dr. Alef pra ele avaliar seu caso — ele entende muito disso e pode te dizer com clareza se tem indicação ou não.",
    future: "Imagina dormir uma noite inteira sem acordar com choque na perna. Isso é o tipo de mudança que as pessoas relatam quando o tratamento engata.",
    objections: {
      ja_tomo_gabapentina: "Faz total sentido — é o primeiro remédio que receitam pra dor neuropática. Só que ele atua num caminho lateral (GABA), e em muita gente o efeito vem mais como sonolência do que como alívio. O canabinoide age no nervo onde a dor está sendo gerada, num sistema diferente. Por isso muita gente sente diferença mesmo já tendo tentado gabapentina.",
      ja_tomo_amitriptilina: "Amitriptilina ajuda algumas pessoas com sono, mas pra dor neuropática em si o resultado costuma ser parcial. E o efeito de ressaca de manhã é pesado. O canabinoide age em outro receptor — não é mais do mesmo, é outro mecanismo.",
      tenho_medo_de_ficar_chapado: "Tranquilo, esse é o medo mais comum — e é justo. O CBD não causa o efeito de ficar 'chapado'. Quem pega esse efeito é o THC em dose alta. O Dr. trabalha com dose baixa, controlada, ajustada caso a caso. A maioria dos pacientes nem percebe que tomou.",
      e_legal: "É 100% legal. A Anvisa autoriza desde 2019 (RDC 327, depois RDC 660). A receita é emitida normalmente, você compra em farmácia autorizada com prescrição médica. Não tem nada de clandestino.",
      e_maconha: "É da mesma planta, mas é um medicamento — extrato padronizado, dose conhecida, sem combustão, sem efeito recreativo. É como aspirina ser feita de salgueiro: a planta é a origem, o medicamento é outra coisa.",
      vou_ficar_dependente: "CBD não causa dependência física. A OMS já se posicionou sobre isso. Não tem síndrome de abstinência se parar.",
      meu_filho_meu_marido_nao_aceita: "Entendo. Muita gente chega aqui depois que a família leu sobre o tratamento. O Dr. pode até te mandar material por escrito pra você mostrar em casa.",
    },
  },
  fibromialgia: {
    direct_answer: "Sim, tem evidência clínica relevante. Cannabis medicinal é hoje um dos caminhos com mais respaldo pra fibromialgia, especialmente quando o cansaço, sono ruim e dor difusa estão juntos.",
    empathy: ["Fibromialgia desgasta de um jeito que pouca gente entende — a dor está aí o tempo todo, e ainda tem o cansaço e o sono picado por cima."],
    mechanism: "Na fibromialgia há disfunção do sistema endocanabinoide endógeno — vários estudos mostram níveis baixos de anandamida. Suplementar com canabinoides exógenos faz sentido fisiológico.",
    study: "Anvisa autoriza desde 2019 (RDC 327/660). Estudos com CBD/THC mostram melhora de dor, sono e fadiga em proporções relevantes.",
    hope: "Tem caminho — a maioria dos pacientes nota diferença em poucas semanas.",
  },
  insonia: {
    direct_answer: "Sim. Pra insônia crônica, especialmente quando vem associada a dor ou ansiedade, cannabis medicinal tem ajudado bastante.",
    empathy: ["Noite mal dormida estraga o dia inteiro — e quando vira rotina, mexe com o humor, com a dor, com tudo."],
    mechanism: "O sistema endocanabinoide regula o ciclo sono-vigília. CBD em dose adequada ajuda a reduzir a latência do sono e melhorar a qualidade.",
    study: "Estudos clínicos mostram melhora de qualidade do sono em até 70% dos pacientes em poucas semanas.",
    hope: "Dormir bem de novo é possível.",
  },
  ansiedade: {
    direct_answer: "Sim. Pra quadros de ansiedade, especialmente os que não respondem bem a antidepressivo, o canabinoide tem mostrado bons resultados.",
    empathy: ["Ansiedade é cansativa — a cabeça não desliga, o corpo fica em alerta, é exaustivo."],
    mechanism: "CBD modula receptores de serotonina e o sistema endocanabinoide — efeito ansiolítico sem o embotamento dos benzodiazepínicos.",
    study: "Estudos mostram redução significativa em escalas de ansiedade já nas primeiras semanas.",
    hope: "Dá pra sair desse estado.",
  },
  depressao: {
    direct_answer: "Sim, há evidência de benefício, especialmente nos casos refratários a antidepressivos clássicos.",
    empathy: ["Depressão tira o ânimo até pra coisas pequenas — e os remédios convencionais às vezes deixam a pessoa anestesiada."],
    mechanism: "O sistema endocanabinoide está envolvido na regulação do humor; modulação adequada pode melhorar bem-estar sem embotar.",
  },
  enxaqueca: { direct_answer: "Sim. Cannabis medicinal tem ajudado em enxaquecas crônicas resistentes." },
  artrose:   { direct_answer: "Sim. CBD tem efeito anti-inflamatório e analgésico — útil em artrose e dor articular." },
  dor_lombar:{ direct_answer: "Sim. Dor lombar crônica responde bem, especialmente quando há componente neuropático associado." },
  parkinson: { direct_answer: "Sim. Há evidência de melhora de tremor, sono e qualidade de vida." },
  autismo:   { direct_answer: "Sim, com indicação médica. Estudos mostram melhora de irritabilidade, sono e crises sensoriais." },
  epilepsia: { direct_answer: "Sim — é uma das indicações com mais evidência, principalmente em crises refratárias." },
  cancer:    { direct_answer: "Sim, como suporte: ajuda em dor, náusea da quimio, apetite e sono." },
  dor_cronica: { direct_answer: "Sim. Cannabis medicinal tem evidência sólida para dor crônica refratária a tratamentos convencionais." },

  /* ── Roteiro 3: público já em cannabis, com dificuldades (custo alto, sem efeito, sem acompanhamento) ── */
  revisao_tratamento: {
    direct_answer: "A maioria dos casos em que a cannabis não funcionou bem não é problema da planta — é prescrição inadequada, produto errado, dose errada ou falta de ajuste ao longo do tempo.",
    empathy: [
      "Usar cannabis medicinal sem sentir resultado, ou sentindo que está gastando muito sem retorno — é frustrante. Faz a pessoa questionar se vale continuar.",
      "Sem acompanhamento médico de verdade, a pessoa acaba tocando o próprio tratamento no escuro. E quando não vem resultado, fica sem saber o que mudar.",
      "Tratamento caro que não melhora deixa a pessoa esgotada — financeiramente e emocionalmente.",
      "Muito paciente que chega aqui já usou cannabis, mas sem o produto certo pra condição dele ou sem ajuste de dose. É comum e tem solução.",
    ],
    // Diferencial do Dr. Alef pra esse público — ARGUMENTO PRINCIPAL: óleo de associação
    value_prop: "O Dr. Alef é médico pós-graduado internacionalmente em cannabis medicinal. Diferente de clínico geral, ele prescreve *óleo de associação* — que costuma custar mais de 50% a menos que o óleo comum de farmácia ou o importado. Além disso, revisa produto, dose e horário do seu tratamento atual.",
    cost_reframe: "O óleo de associação que o Dr. Alef trabalha é mais de 50% mais barato que o óleo de farmácia ou importado. Só isso já costuma reduzir pela metade (ou mais) o que você paga por mês.",
    accompaniment: "O Dr. Alef acompanha o caso do início ao fim: primeira consulta, ajuste de protocolo e retorno incluso. Você não fica mais sozinho no tratamento.",
    testimony: "Tenho pacientes que chegaram gastando R$500–R$800 por mês em óleo de farmácia. Com o óleo de associação prescrito pelo Dr., caiu pra R$180–R$250 o mesmo óleo (às vezes mais concentrado).",
    oil_argument: "Todo óleo de cannabis de farmácia ou importado é mais caro — mais de 50% mais caro. O Dr. Alef prescreve óleo de associação, que sai muito mais em conta. É a mesma cannabis medicinal, só que sem o preço inflado da farmácia.",
    mechanism: "Quando o tratamento não funciona, geralmente o problema está na combinação produto + concentração + dose + horário. Mudar só um desses fatores pode mudar completamente o resultado.",
    hope: "Se a cannabis não funcionou como esperado, o problema quase nunca é a cannabis. É a prescrição e o tipo de óleo.",
    bridge: "Faz sentido o Dr. Alef revisar seu protocolo atual — ele vai identificar o que ajustar e, provavelmente, trocar pra óleo de associação pra você gastar bem menos.",
    objections: {
      ja_gastei_muito_nao_quero_mais: "Entendo — mas é exatamente por isso que vale. O óleo de associação que o Dr. prescreve é mais de 50% mais barato que o óleo de farmácia. A R$249 da consulta se paga em 1–2 meses de economia no óleo.",
      nao_confio_mais: "Faz sentido desconfiar depois de uma experiência ruim. O Dr. Alef é pós-graduado em cannabis medicinal — não é clínico geral. Ele revisa o que foi feito e, se for o caso, troca pra óleo de associação pra reduzir o custo.",
      meu_medico_atual_prescreveu: "Nada contra o médico atual — mas a maioria prescreve óleo de farmácia ou importado, que é muito mais caro. O Dr. Alef trabalha com óleo de associação, que é a mesma cannabis só que bem mais em conta.",
      esta_funcionando_mas_caro: "Se está funcionando, o Dr. pode avaliar se dá pra chegar no mesmo resultado com óleo de associação — que costuma custar pela metade do que você paga hoje.",
      nunca_soube_a_dose_certa: "Dose errada muda completamente o resultado. E, junto com isso, o Dr. também ajusta o tipo de óleo — quase sempre troca pra óleo de associação pra baratear o tratamento.",
      tipo_oleo_pergunta: "Óleo de associação é um óleo de cannabis medicinal prescrito pelo médico, manipulado de forma específica. A diferença é que sai mais de 50% mais barato que o óleo de farmácia comum ou o importado — sem perder qualidade.",
    },
  },
};

function getEvidence(condition, key = "direct_answer") {
  const block = EVIDENCE_DB[condition] || EVIDENCE_DB.dor_cronica;
  const val = block[key];
  if (Array.isArray(val)) return pickRandom(val);
  return val || "";
}

/* ═══════════════════════════════════════════════════════════════════
   POOLS DE EMPATIA / VARIAÇÃO
   ═══════════════════════════════════════════════════════════════════ */

const EMPATHY_POOL = {
  generic: [
    "Entendo. Não é fácil mesmo.",
    "Sei que cansa. A gente vai com calma.",
    "Faz sentido o que você sente.",
  ],
  pain: [
    "Dor que persiste cansa demais — corpo, cabeça, ânimo, tudo.",
    "Quando a dor não para, ela tira mais coisa do que parece à primeira vista.",
  ],
  scared: [
    "Faz sentido ter receio — é uma decisão que pesa.",
    "Tudo bem desconfiar antes. Eu prefiro que você tenha clareza.",
  ],
};

/* ═══════════════════════════════════════════════════════════════════
   AUTORIDADE / TRUST BLOCK
   ═══════════════════════════════════════════════════════════════════ */

function authorityInstagramReply(context = "trust") {
  const base = "Lá tem conteúdos, estudos, palestras e detalhes do atendimento — reforça a experiência clínica do Dr. Alef.";
  if (context === "price") return `Se quiser avaliar com mais segurança, aqui dá pra ver o trabalho do Dr. Alef:\n${INSTAGRAM_DR_ALEF}\n\n${base}`;
  if (context === "preclose") return `Se quiser, deixo o Instagram do Dr. Alef pra você ver mais do trabalho dele:\n${INSTAGRAM_DR_ALEF}\n\n${base}`;
  return `Se ajudar a se sentir mais seguro(a), aqui dá pra ver melhor o trabalho do Dr. Alef:\n${INSTAGRAM_DR_ALEF}\n\n${base}`;
}

/* V30: buildTrustBlock — resposta a "é golpe?" / "quem é você?"
   throttle: máximo 1x a cada 15min */
const TRUST_THROTTLE_MS = 15 * 60 * 1000;
function buildTrustBlock(state) {
  const nome = state.nome ? `, ${state.nome}` : "";
  const now = Date.now();
  const last = state.trust_sent_at || 0;
  if (last && (now - last) < TRUST_THROTTLE_MS) {
    // versão curta se já mandou recentemente
    return `Pode checar antes${nome}, fico tranquila aqui. Tô disponível quando quiser seguir.`;
  }
  state.trust_sent_at = now;
  return [
    `Faz total sentido perguntar${nome} — golpe nessa área existe, então é certo desconfiar antes.`,
    ``,
    `O *Dr. Alef Kotula* é médico (CRM-SP), com formação na Rússia e especialização internacional em Cannabis Medicinal. O consultório fica em São Paulo.`,
    ``,
    `*Você pode conferir antes de decidir qualquer coisa:*`,
    `• Instagram: ${INSTAGRAM_DR_ALEF}`,
    `• Site oficial (com CNPJ e endereço): ${SITE_URL}`,
    `• O pagamento é feito *no próprio site oficial do Dr.*, com cartão (até 12x) ou Pix — nada de transferência pra conta pessoal.`,
    ``,
    `Confere com calma. Quando se sentir seguro(a), a gente segue.`,
  ].join("\n");
}

/* ═══════════════════════════════════════════════════════════════════
   MERCADO PAGO
   ═══════════════════════════════════════════════════════════════════ */

async function mpCreatePreference({ phone, planKey = "avaliacao" }) {
  const plan = PLANS[planKey] || PLANS.avaliacao;
  const externalReference = `lia-${phone}-${planKey}-${Date.now()}`;
  const body = {
    items: [{
      title: plan.label,
      description: plan.description,
      quantity: 1,
      unit_price: plan.price,
      currency_id: "BRL",
    }],
    external_reference: externalReference,
    metadata: { phone, plan_key: planKey },
    back_urls: {
      success: `${SITE_URL}/obrigado-consulta/`,
      pending: `${SITE_URL}/checkout-consulta/`,
      failure: `${SITE_URL}/checkout-consulta/`,
    },
    auto_return: "approved",
    notification_url: `${BASE_URL}/mp/webhook`,
    payment_methods: { installments: 12 },
  };
  const resp = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`MP preference falhou ${resp.status}: ${errTxt.slice(0, 200)}`);
  }
  const data = await resp.json();
  return {
    preference_id: data.id,
    link: data.init_point || data.sandbox_init_point,
    external_reference: externalReference,
  };
}

async function mpGetPayment(paymentId) {
  const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  if (!resp.ok) throw new Error(`MP getPayment ${resp.status}`);
  return resp.json();
}

function mpExtractPhoneFromPayment(payment) {
  const ext = payment.external_reference || "";
  const m = ext.match(/lia-(\d{10,15})-/);
  if (m) return m[1];
  return payment?.metadata?.phone || null;
}

async function buildSiteCheckoutLink({ paymentLink, phone, planKey, externalReference, state }) {
  const ref = generateCheckoutRef();
  const data = {
    phone,
    plan_key: planKey,
    mp_link: paymentLink,
    external_reference: externalReference,
    nome: state?.nome || null,
    nome_completo: state?.nome_completo || null,
    email: state?.email || null,
    created_at: Date.now(),
  };
  await saveCheckoutRef(ref, data);
  return {
    ref,
    url: `${BASE_URL}/checkout/${ref}`,
    public_url: `${SITE_URL}/checkout-consulta/?ref=${ref}`,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   REPLY TEMPLATES — V30
   ═══════════════════════════════════════════════════════════════════ */

function greetFromForm(state) {
  const nome = state.nome || (state.form_data?.nome_completo && extractFormFirstName(state.form_data.nome_completo)) || "";
  const cond = state.condition || detectCondition(state.form_data?.condition || "") || "dor_neuropatica";
  const condLabel = ({
    dor_neuropatica: "dor neuropática",
    fibromialgia: "fibromialgia",
    insonia: "insônia",
    ansiedade: "ansiedade",
    depressao: "depressão",
    enxaqueca: "enxaqueca",
    artrose: "artrose",
    dor_lombar: "dor na coluna",
  })[cond] || "o que você descreveu";

  const ola = nome ? `Oi, ${nome}.` : "Oi.";
  const empath = pickRandom(EVIDENCE_DB[cond]?.empathy || EMPATHY_POOL.pain);
  const tail = pickRandom([
    "Posso te explicar como funciona a consulta com o Dr. Alef?",
    "Quer que eu te explique como funciona a consulta?",
    "Posso te passar como é a consulta com o Dr. Alef?",
  ]);
  return `${ola} Aqui é a Lia, da equipe do Dr. Alef Kotula — vi que você preencheu o formulário sobre ${condLabel}.\n\n${empath}\n\n${tail}`;
}

/* ── R3 PRIMEIRA VEZ: nunca usou cannabis — NÃO perguntar sobre produto ── */
function greetPrimeiraVez(state) {
  const nome = state.nome || extractFormFirstName(state.form_data?.nome_completo || "") || "";
  const fd = state.form_data || {};
  const problema = String(fd.problema_tratado || fd.condition || "").trim();
  const gasto = parseMonthlySpend(fd.gasto_mensal || "");
  const difs = parseDifficulties(fd.dificuldades_tratamento || "");

  const ola = nome ? `Oi, ${nome}!` : "Oi!";

  // Linha 1: validação específica do problema marcado no form (NÃO "me conta o que te incomoda")
  let validation = "";
  if (/dor\s*cr[oô]nica|cr[oô]nica/i.test(problema)) validation = "Li aqui que você tá lidando com dor crônica. Imagino o desgaste de conviver com isso todo dia.";
  else if (/neurop[aá]tica|neuropatia/i.test(problema)) validation = "Vi que é dor neuropática — queimação, choque, formigamento. É uma das dores mais difíceis de tratar com remédio comum.";
  else if (/ins[oô]nia|sono/i.test(problema)) validation = "Li que é insônia/ansiedade. Noite mal dormida vira dia ruim, e vira ciclo.";
  else if (/ansiedade/i.test(problema)) validation = "Vi que é ansiedade. Quando ela aperta, ela rouba energia pra tudo.";
  else if (/fibromialgia/i.test(problema)) validation = "Vi que é fibromialgia. Dor difusa e cansaço pesam demais — é uma condição que muita gente subestima.";
  else if (/enxaqueca/i.test(problema)) validation = "Li que é enxaqueca. É um tipo de dor que paralisa o dia.";
  else if (/depress[aã]o/i.test(problema)) validation = "Vi que é depressão. Peso de viver assim é real — e tem caminho.";
  else if (/artrose|lombar|coluna|quadril/i.test(problema)) validation = "Vi que é dor articular/coluna. Tira liberdade de fazer coisa simples — levantar, caminhar, dormir bem.";
  else validation = "Li aqui o que você preencheu. Obrigada por se abrir logo no formulário.";

  // Linha 2: reflexo da frustração (dificuldade + gasto)
  let pain = "";
  if (difs.caro || gasto === "mais_1000" || gasto === "500_1000" || gasto === "250_500") {
    pain = "E vi também que o custo do tratamento tá pesando — isso é o que faz a maioria desistir.";
  } else if (gasto === "parei") {
    pain = "Vi que você já tentou gastar e parou — faz total sentido, tratamento caro não se sustenta.";
  } else {
    pain = "Nunca usou cannabis medicinal até agora — tranquilo, muita gente chega aqui pela primeira vez.";
  }

  // Linha 3: pergunta de CONEXÃO (não de diagnóstico robótico)
  const connect = pickRandom([
    "Me conta rapidinho: há quanto tempo você convive com isso, e como tá atrapalhando o seu dia?",
    "Antes de te explicar como o Dr. Alef pode te ajudar — me conta o quanto essa situação tá pesando no seu dia a dia?",
    "Em uma escala rápida — essa dor/sintoma tá no dia a dia ou vem em crises? E o que você já tentou até agora?",
  ]);

  return `${ola} Aqui é a *Lia*, da equipe do *Dr. Alef Kotula* — médico especialista em cannabis medicinal.\n\n${validation} ${pain}\n\n${connect}`;
}

/* ── R3 PAROU: já usou e parou — foco em "dá pra voltar mais barato" ── */
function greetParou(state) {
  const nome = state.nome || extractFormFirstName(state.form_data?.nome_completo || "") || "";
  const fd = state.form_data || {};
  const problema = String(fd.problema_tratado || fd.condition || "").trim();
  const ola = nome ? `Oi, ${nome}!` : "Oi!";

  const validation = problema
    ? `Li que você tentou tratar ${problema.toLowerCase()} e acabou parando.`
    : "Vi que você já usou cannabis medicinal e acabou parando em algum momento.";

  const frame = "A maioria que para é por causa do preço do óleo de farmácia ou importado — é caro demais pra manter por meses.";
  const hook = "O Dr. Alef trabalha com *óleo de associação*, que custa *mais de 50% a menos*. É a mesma cannabis medicinal, sem o preço inflado.";
  const connect = pickRandom([
    "Posso te perguntar: o que te fez parar — foi o preço, o efeito, ou outra coisa?",
    "Me conta rapidinho: quando você parou, era por causa do custo, ou também tinha algo do efeito que não funcionou?",
  ]);

  return `${ola} Aqui é a *Lia*, da equipe do *Dr. Alef Kotula*.\n\n${validation} ${frame}\n\n${connect}\n\n${hook}`;
}

/* ── R3: saudação para quem já usa cannabis e tem dificuldades ── */
function greetFromFormR3(state) {
  const nome = state.nome || extractFormFirstName(state.form_data?.nome_completo || "") || "";
  const fd = state.form_data || {};
  const difs = parseDifficulties(fd.dificuldades_tratamento || "");
  const gasto = parseMonthlySpend(fd.gasto_mensal || "");

  const ola = nome ? `Oi, ${nome}.` : "Oi.";

  // Linha de empatia personalizada pela dificuldade marcada
  let empathyLine = "";
  if (difs.caro && gasto && gasto !== "nao_gasto") {
    const gastoLabel = { "mais_1000": "mais de R$1.000 por mês", "500_1000": "entre R$500 e R$1.000 por mês", "250_500": "entre R$250 e R$500 por mês", "ate_250": "até R$250 por mês", "parei": "bastante antes de parar" }[gasto] || "bastante";
    empathyLine = `Vi que você está gastando ${gastoLabel} com o tratamento. Esse é um dos principais motivos que o Dr. Alef resolve — ele prescreve *óleo de associação*, que costuma custar *mais de 50% a menos* que o óleo comum de farmácia ou importado.`;
  } else if (difs.sem_acompanhamento) {
    empathyLine = pickRandom(["Vi que você sente que está tocando o tratamento meio que sozinho.", "Entendo — tratar sem um acompanhamento de verdade é difícil."]);
  } else if (difs.pouco_efeito) {
    empathyLine = pickRandom(["Vi que o tratamento melhorou pouco até agora.", "Usar cannabis e não sentir o efeito esperado é frustrante — e tem solução."]);
  } else if (difs.confuso) {
    empathyLine = "Vi que ficou confuso com produto, dose ou horário — isso é mais comum do que parece e dá pra resolver.";
  } else if (difs.efeito_ruim) {
    empathyLine = "Vi que teve efeito ruim em algum momento. Com a prescrição certa, isso costuma mudar.";
  } else {
    empathyLine = pickRandom(EVIDENCE_DB.revisao_tratamento.empathy);
  }

  const tail = pickRandom([
    "Posso te explicar como funciona a revisão de tratamento com o Dr. Alef?",
    "Quer entender como o Dr. Alef pode ajudar a melhorar isso?",
    "Me conta um pouco mais — o que incomoda mais no tratamento hoje?",
  ]);

  return `${ola} Aqui é a Lia, da equipe do *Dr. Alef Kotula* — médico pós-graduado em cannabis medicinal.\n\n${empathyLine}\n\n${tail}`;
}

/* ── R3 REVISÃO: pergunta de conexão para quem JÁ USA cannabis ── */
function connectQuestionR3(state) {
  const nome = state.nome ? `, ${state.nome}` : "";
  const track = state.form_track || "";
  const difs = parseDifficulties(state.form_data?.dificuldades_tratamento || "");

  // GUARDA CRÍTICA: se NÃO usa cannabis, nunca pergunta sobre produto
  if (track === "r3_primeira_vez") {
    return `Me conta um pouco mais${nome}: o que mais pesa hoje — a dor em si, o impacto no sono/energia, ou o custo com remédio que já tá tentando? Quero entender seu caso antes de te explicar.`;
  }
  if (track === "r3_parou") {
    return `Rapidinho${nome}: quando você parou, foi mais pelo custo, pelo efeito que não veio como esperava, ou por outro motivo? Isso me ajuda a te orientar melhor.`;
  }

  if (difs.caro) return `Antes de te explicar como funciona${nome}: qual produto você usa hoje e, se souber, em que concentração? Isso me ajuda a entender o que o Dr. pode revisar.`;
  if (difs.confuso) return `Pra te orientar melhor${nome}: o que mais te confunde — é o produto em si, a dose, o horário, ou não tem certeza se está sentindo efeito?`;
  if (difs.pouco_efeito) return `Pra entender o que aconteceu${nome}: você usa CBD puro, CBD com THC ou outro perfil? E usa há quanto tempo?`;
  if (difs.sem_acompanhamento) return `Me conta rapidinho${nome}: quem prescreveu o tratamento atual, e vocês têm tido retorno ou ficou sem contato depois da primeira receita?`;
  return `Me conta rapidinho${nome}: o que mais está te incomodando no tratamento hoje — é o custo, o efeito, ou falta de orientação?`;
}

/* ── R3: bloco de proposta de valor (diferencial do Dr. — argumento principal: óleo de associação) ── */
function buildValuePropR3(state) {
  const nome = state.nome ? `, ${state.nome}` : "";
  const fd = state.form_data || {};
  const gasto = parseMonthlySpend(fd.gasto_mensal || "");

  // Linha de custo personalizada com o número concreto quando disponível
  let costLine = "";
  if (gasto === "mais_1000") {
    costLine = `Se hoje você gasta mais de R$1.000 por mês, tem paciente que saiu disso pra faixa de R$300–R$450 só trocando pra óleo de associação. É um corte real, todo mês.`;
  } else if (gasto === "500_1000") {
    costLine = `Se hoje você gasta entre R$500 e R$1.000 por mês, com óleo de associação costuma cair pra metade ou menos — na faixa de R$180–R$350.`;
  } else if (gasto === "250_500") {
    costLine = `Mesmo quem gasta entre R$250 e R$500 costuma baixar bem: óleo de associação sai em torno de R$150–R$250, às vezes até mais concentrado.`;
  } else if (gasto === "parei") {
    costLine = `Muita gente que parou foi por causa do preço. Com óleo de associação, o mesmo tratamento fica mais de 50% mais barato — por isso vale revisar.`;
  } else if (gasto === "ate_250") {
    costLine = `Mesmo nessa faixa, com óleo de associação dá pra conseguir um óleo às vezes mais forte pelo mesmo valor ou menos.`;
  }

  return [
    `O Dr. Alef${nome} é especialista — pós-graduado internacionalmente em cannabis medicinal. Não é clínico geral.`,
    ``,
    `O principal diferencial: ele prescreve *óleo de associação*, que costuma custar *mais de 50% a menos* que o óleo comum de farmácia ou o importado. Mesma cannabis medicinal, sem o preço inflado.`,
    ``,
    `Além disso, ele revisa produto, dose e horário do seu tratamento — e *acompanha o caso*: a primeira consulta e o retorno estão incluídos.`,
    costLine ? `\n${costLine}` : "",
  ].filter(Boolean).join("\n");
}

/* ── R3: resposta à objeção "já gastei muito / não quero gastar mais R$249" ── */
function objectionHighSpendReply(state) {
  const nome = state.nome ? `${state.nome}, ` : "";
  const fd = state.form_data || {};
  const gasto = parseMonthlySpend(fd.gasto_mensal || "");

  if (gasto === "mais_1000") {
    return `${nome}entendo — e é justamente por isso que faz sentido. Você gasta *mais de R$1.000 por mês*. O Dr. Alef prescreve *óleo de associação*, que custa mais de 50% a menos que o óleo de farmácia ou importado. Tem paciente que caiu pra faixa de R$300–R$450 por mês. A consulta de R$249 se paga no primeiro mês só com a economia no óleo.`;
  }
  if (gasto === "500_1000") {
    return `${nome}entendo. Só que você já gasta *entre R$500 e R$1.000 por mês*. O óleo de associação que o Dr. Alef prescreve é mais de 50% mais barato que o óleo de farmácia — costuma cair pra faixa de R$180–R$350. A consulta de R$249 se paga em *um mês* de economia.`;
  }
  if (gasto === "250_500") {
    return `${nome}entendo. Com óleo de associação, muitos pacientes que gastavam R$250–R$500 caem pra faixa de R$150–R$250 — e às vezes com óleo mais concentrado. A consulta se paga em 1–2 meses.`;
  }
  if (gasto === "parei") {
    return `${nome}faz total sentido ter parado — óleo de farmácia ou importado é caro demais pra manter a longo prazo. O Dr. Alef prescreve *óleo de associação*, que custa mais de 50% menos. É outro patamar de preço. Por R$249 na consulta, o Dr. revisa seu caso e ajusta o tratamento pra algo sustentável.`;
  }
  return `${nome}entendo. A consulta é R$249 — e o principal motivo pra fazer é justamente economizar depois: o Dr. Alef prescreve *óleo de associação*, que custa mais de 50% a menos que o óleo de farmácia ou importado. A economia mensal no óleo paga a consulta rapidinho.`;
}

function connectQuestion(state) {
  const nome = state.nome ? `, ${state.nome}` : "";
  const cond = state.condition || "dor_neuropatica";
  const opts = {
    dor_neuropatica: pickRandom([
      `Antes de te explicar tudo${nome}, me conta rapidinho: a dor é mais de queimação, choque ou formigamento? E já tentou gabapentina ou amitriptilina?`,
      `Pra te dar a resposta mais certa${nome}: você descreveria mais como queimação, como choque elétrico, ou os dois? E que remédios já passaram pra você?`,
    ]),
    fibromialgia: `Antes de seguir${nome}: você sente mais a dor difusa pelo corpo, ou o que mais te incomoda é o cansaço e o sono ruim?`,
    insonia: `Pra te orientar melhor${nome}: você tem dificuldade pra pegar no sono, ou acorda muito de madrugada?`,
    ansiedade: `Antes de seguir${nome}: a ansiedade aparece mais como pensamento que não para, ou como sensação física (taquicardia, falta de ar)?`,
  };
  return opts[cond] || `Me conta rapidinho${nome} o que tem te incomodado mais — assim eu falo do que vai te servir.`;
}

function buildPriceLinkReply(state, checkoutUrl) {
  const nome = state.nome ? `, ${state.nome}` : "";
  const url = checkoutUrl || (state.payment?.public_url) || (state.payment?.link) || "";
  const main = [
    `A consulta completa com o Dr. Alef é *${CONSULT_PRICE_LABEL}*${nome} — videochamada de cerca de 40 min (WhatsApp ou Google Meet, o que for mais fácil).`,
    `Pagamento direto pelo *site oficial do Dr.* (www.dralefkotula.com): cartão em até *12x* ou Pix.`,
    ``,
    `Link seguro do checkout no site oficial:`,
    `${url}`,
  ].join("\n");
  // O follow-up curto sai como "second message" no caller (oferta combinada)
  return main;
}

function buildPriceLinkFollowup(state) {
  return `Depois que o pagamento for confirmado, te passo 2 ou 3 horários pra você escolher. Se nenhum servir, a gente remarca sem custo.`;
}

function priceShortReply(state) {
  const nome = state.nome ? `, ${state.nome}` : "";
  return `Consulta com o Dr. Alef${nome} é *${CONSULT_PRICE_LABEL}* — videochamada, cerca de 40 min, cartão em até 12x ou Pix.`;
}

function pendingPaymentReply(state) {
  const url = state.payment?.public_url || state.payment?.link || "";
  return `Tá quase, é só finalizar pelo site oficial (www.dralefkotula.com):\n\n${url}\n\nAssim que o pagamento for confirmado eu te aviso e a gente passa pros horários.`;
}

function objectionPriceReply(state) {
  const url = state.payment?.public_url || state.payment?.link || "";
  const linkPart = url ? `\n\nNo link do site oficial (www.dralefkotula.com) você vê todas as opções de parcelamento:\n${url}` : "";
  return `Entendo. No cartão dá pra parcelar em até *12x* — fica menos pesado no mês. Se for à vista no Pix é o mesmo valor: ${CONSULT_PRICE_LABEL}.${linkPart}\n\n${authorityInstagramReply("price")}`;
}

function askPostPayDataReply(state) {
  const nome = state.nome ? `, ${state.nome}` : "";
  return [
    `Pagamento confirmado${nome}! 🎉`,
    ``,
    `Pra finalizar seu cadastro e te mandar o link da videochamada, me manda *em uma mensagem só*:`,
    ``,
    `1) *Nome completo*`,
    `2) *Data de nascimento* (dd/mm/aaaa)`,
    `3) *E-mail*`,
    ``,
    `Pode mandar tudo junto que eu organizo aqui.`,
  ].join("\n");
}

function askPostPayDataPartial(state, missing) {
  const nome = state.nome ? `${state.nome}, ` : "";
  const labels = {
    nome_completo: "*nome completo*",
    nascimento: "*data de nascimento* (dd/mm/aaaa)",
    email: "*e-mail*",
  };
  const items = missing.map((k, i) => `${i + 1}) ${labels[k]}`).join("\n");
  if (missing.length === 1) {
    return `${nome}só falta ${labels[missing[0]].replace(/\*/g, "")}. Pode me mandar?`;
  }
  return `${nome}faltam só esses dados:\n\n${items}\n\nPode me mandar tudo junto.`;
}

function scheduleReply(state, suggested) {
  const nome = state.nome ? `, ${state.nome}` : "";
  const opts = (suggested || []).map((d) => `*${formatDatePt(d)}*`).join("\n");
  return [
    `Agora é só escolher o dia${nome}.`,
    ``,
    `As próximas datas com vaga:`,
    opts,
    ``,
    `Qual fica melhor pra você? (pode me dizer o dia ou só responder com a data)`,
  ].join("\n");
}

async function offerSlotsReply(state, periodMin = null) {
  let best = await chooseBestSlotsForDate(state.date_key, 6);
  if (periodMin !== null) best = best.filter((s) => Number(s.replace(/h.*/, "")) >= periodMin);
  best = best.slice(0, 3);
  state.offered_slots = best;
  if (!best.length) return `Não restou horário pra ${formatDatePt(state.date_key)}. Quer que eu te mostre outro dia?`;
  const list = best.map((s, i) => `${i + 1}) *${s}*`).join("\n");
  return `Pra ${formatDatePt(state.date_key)}, esses são os melhores horários:\n\n${list}\n\nQual fica melhor? (responde com 1, 2, 3 ou o horário exato)`;
}

function confirmedReply(state) {
  const nome = state.nome ? `, ${state.nome}` : "";
  const slot = (state.date_key && state.slot_time) ? prettySlot(state.date_key, state.slot_time) : "horário confirmado";
  return [
    `Tudo certo${nome}! ✅`,
    ``,
    `Sua consulta com o *Dr. Alef Kotula* está marcada pra:`,
    `*${slot}*`,
    ``,
    `O Dr. te chama no horário pelo WhatsApp ou Google Meet (te aviso aqui qual será).`,
    ``,
    `Se precisar reagendar, é só me chamar com antecedência.`,
  ].join("\n");
}

function afterPaidReply(state) {
  const nome = state.nome ? `, ${state.nome}` : "";
  return `Pagamento confirmado${nome}! Já tô organizando aqui. ${askPostPayDataReply(state).split("\n").slice(2).join("\n")}`;
}

function urgencyReply() {
  return "Pela sua mensagem, isso pode precisar de atendimento *agora*. Por favor procure um *pronto-socorro* ou ligue pro *SAMU (192)*. Quando estiver melhor, a gente continua por aqui.";
}

function cvvReply() {
  return "Eu sinto muito que você esteja passando por isso. Por favor, ligue agora pro *CVV — 188* (24h, gratuito, sigiloso). Se quiser, também procure um *pronto-socorro*. Você não está só.";
}

/* V30.3 — Resposta adaptativa ao compromisso futuro do lead
   Usa detectPostponement() (financial/dated/event/decisional/vague) + timeRef
   pra escolher tom, eco da referência temporal e seguir. Salva commitment
   em state pra followup contextualizado. */
function postponementReply(state, detection, incomingText) {
  const nome = state.nome || "";
  const nomeV = nome ? `, ${nome}` : "";
  const kind = detection?.timeRef?.kind || "later";
  const echo = _echoPostponement(detection?.timeRef);

  state.commitment = {
    type: detection?.type || "vague",
    timeRef: detection?.timeRef || { kind: "later" },
    estimated_at: estimateCommitmentTimestamp(detection?.timeRef || { kind: "later" }),
    raw_text: String(incomingText || "").slice(0, 240),
    saved_at: Date.now(),
  };
  state.followup_needed_at = state.commitment.estimated_at;
  state.scheduling_committed = true;

  switch (detection?.type) {
    case "financial":
      return pickRandom([
        `Entendi${nomeV}. Faz total sentido esperar ${echo} — não faz sentido comprometer o orçamento antes da hora. Fica combinado assim: quando chegar o dia, me avisa aqui que eu te mando o link atualizado. Qualquer dúvida sobre o tratamento nesse meio tempo, pode mandar.`,
        `Tranquilo${nomeV}. Então deixa combinado: ${echo}, você me chama aqui que eu te passo o link e seguimos. Se surgir alguma dúvida antes, tô por perto.`,
      ]);

    case "dated":
      return pickRandom([
        `Combinado${nomeV}. Te espero ${echo}. Quando chegar o dia, me manda uma mensagem aqui que eu te envio o link atualizado e a gente agenda o horário. Se tiver dúvida antes, me chama.`,
        `Então fica assim${nomeV}: ${echo}, você me avisa e a gente fecha. Tô por aqui até lá pra qualquer dúvida.`,
      ]);

    case "event":
      return pickRandom([
        `Sem problema${nomeV}. Faz sentido resolver isso primeiro. ${capitalizeFirst(echo)}, me chama aqui que a gente retoma sem atropelar nada. Enquanto isso, qualquer pergunta sobre o tratamento, manda.`,
        `Beleza${nomeV}. Prioriza o que é urgente agora, ${echo} a gente segue. Tô por aqui.`,
      ]);

    case "decisional":
      if (kind === "consult_family") {
        return pickRandom([
          `Claro${nomeV}, decisão assim é pra se conversar mesmo. Se quiser, posso te mandar um resumo curto do que o Dr. Alef prescreve e como funciona a consulta — aí fica mais fácil mostrar em casa. Quando tiverem alinhado, me avisa aqui.`,
          `Faz todo sentido${nomeV}. Se ajudar, te mando um material explicando o tratamento pra você ler junto com a família. Quando decidirem, é só voltar aqui.`,
        ]);
      }
      return pickRandom([
        `Tranquilo${nomeV}. Pensa com calma — decisão boa é a que a gente toma sem pressão. Se alguma dúvida ajudar a clarear, pode me mandar. Quando decidir, volta aqui que a gente segue.`,
        `Sem pressa${nomeV}. Pensa com cuidado. Se quiser tirar alguma dúvida antes de decidir, pode mandar à vontade.`,
      ]);

    case "vague":
    default:
      return pickRandom([
        `Tranquilo${nomeV}. Quando quiser retomar, me manda mensagem aqui que eu te passo o link atualizado. Tô por perto.`,
        `Beleza${nomeV}. Fica à vontade pra voltar quando fizer sentido. Tô por aqui.`,
      ]);
  }
}

function capitalizeFirst(s) { return String(s || "").replace(/^./, (c) => c.toUpperCase()); }

function farewellReply(state) {
  const nome = state.nome ? `, ${state.nome}` : "";
  return pickRandom([
    `Tranquilo${nome}, sem pressa. Quando quiser retomar, é só me mandar mensagem aqui.`,
    `Sem problema${nome}. Tô aqui — quando decidir ou tiver alguma dúvida, me chama.`,
    `Beleza${nome}. Fico à disposição. Quando se sentir pronto(a), me avisa.`,
  ]);
}

function casualAckReply(state) {
  const nome = state.nome ? `, ${state.nome}` : "";
  return pickRandom([
    `Tô por aqui${nome}, qualquer coisa me chama.`,
    `Beleza${nome}.`,
    `Tudo certo${nome}. Quando quiser seguir, me avisa.`,
  ]);
}

/* ═══════════════════════════════════════════════════════════════════
   GUIA DE TONAGEM POR PERFIL
   ═══════════════════════════════════════════════════════════════════ */

const PROFILE_GUIDES = {
  emocional: "Acolhedora, calma, sem pressa. Validação primeiro, informação depois.",
  desconfiado: "Direta, transparente, factual. Cite credenciais e ofereça verificação. Sem floreio.",
  quente: "Objetiva e rápida. Vá direto pro link. Sem rodeios.",
  comparador: "Reforce valor (parcelamento 12x, qualidade do médico, segurança do site oficial). Sem desconto.",
  cetico: "Paciente, sem empurrar. Forneça informação, deixe espaço.",
  frio: "Respeitosa, deixe a porta aberta sem insistir.",
  pragmatico: "Clara, com números. Preço, link, próximos passos.",
  padrao: "Equilibrada, humana, simples.",
};

/* ═══════════════════════════════════════════════════════════════════
   OPENAI / SYSTEM PROMPT (v30 — closer + dor neuropática + form-first)
   ═══════════════════════════════════════════════════════════════════ */

function buildSystemPrompt(state) {
  const nome = state.nome || "(não coletado)";
  const cond = state.condition || "(não detectada)";
  const profile = state.lead_profile || "padrao";
  const guide = PROFILE_GUIDES[profile] || PROFILE_GUIDES.padrao;
  const formQ = state.form_qualified ? "SIM" : "NÃO";
  const formTrack = state.form_track || "generic";
  const difs = parseDifficulties(state.form_data?.dificuldades_tratamento || "");
  const gasto = parseMonthlySpend(state.form_data?.gasto_mensal || "");
  const gastoLabel = { "mais_1000": "mais de R$1.000/mês", "500_1000": "R$500–R$1.000/mês", "250_500": "R$250–R$500/mês", "ate_250": "até R$250/mês", "parei": "parou de gastar", "nao_gasto": "não gasta" }[gasto] || "(não informado)";

  const r3Block = formTrack === "r3_revisao" ? `
▶ CAMPANHA: REVISÃO DE TRATAMENTO (Roteiro 3 — público JÁ em cannabis)
Este lead JÁ USA ou USOU cannabis medicinal. Ele não precisa ser convencido de que cannabis funciona — precisa ser convencido de que o Dr. Alef vai resolver o que não está certo no tratamento DELE.

PERFIL DO LEAD:
- Usa cannabis: ${state.form_data?.ja_usa_cannabis || "(não informado)"}
- Dificuldades: ${state.form_data?.dificuldades_tratamento || "(não informado)"}
- Condição tratada: ${state.form_data?.problema_tratado || cond}
- Gasto mensal atual: ${gastoLabel}
- Quer resolver em 7 dias: ${state.form_data?.resolver_7dias || "(não informado)"}

ESTRATÉGIA (obrigatória):
1. EMPATIA com a dificuldade específica marcada (caro / pouco efeito / sem acompanhamento / confuso / efeito ruim).
2. ARGUMENTO PRINCIPAL (usar sempre que lead tocar em custo, gasto, ou pouco efeito): *óleo de associação*. O Dr. Alef prescreve óleo de associação, que custa *mais de 50% a menos* que o óleo comum de farmácia ou o importado. É a mesma cannabis medicinal, só que muito mais barata. Esse é o diferencial mais concreto e deve ser mencionado com clareza.
3. DIFERENCIAL complementar: Dr. Alef é pós-graduado internacionalmente em cannabis medicinal (não é clínico geral). Revisa produto, concentração, dose, horário. Acompanha o caso — primeira consulta + retorno incluídos.
4. REFRAME de valor: se lead gasta muito, o argumento concreto é — "óleo de associação costuma cair pela metade (ou menos) vs farmácia. A consulta de R$249 se paga no primeiro mês só com a economia no óleo."
5. CALL TO ACTION: link da consulta R$249 assim que lead demonstrar interesse.

OBJEÇÕES DESTE PÚBLICO (use o argumento do óleo sempre que fizer sentido):
- "R$249 a mais é caro, já gasto muito" → "O óleo de associação que o Dr. prescreve é mais de 50% mais barato que o óleo de farmácia. A consulta se paga em 1–2 meses de economia no óleo."
- "Já usei e não funcionou" → Pode ser dose, produto ou tipo de óleo. O Dr. revisa — e se for o caso troca pra óleo de associação, que além de mais barato pode ter perfil mais adequado.
- "Meu médico já prescreveu" → A maioria prescreve óleo de farmácia ou importado (caro). O Dr. Alef trabalha com óleo de associação, que é a mesma cannabis medicinal só que bem mais em conta.
- "Está funcionando, só tá caro" → O Dr. pode manter o efeito com óleo de associação, que custa pela metade ou menos do que você paga hoje.

REGRA CRÍTICA: Use o argumento *óleo de associação* com naturalidade sempre que custo for o tema. Seja específica: "mais de 50% mais barato", "mesma cannabis medicinal", "sem o preço inflado da farmácia". NÃO dê reframe genérico tipo "com a prescrição certa reduz o custo" — isso é vago demais. Nomeie a coisa: óleo de associação.
` : "";

  const usaCannabis = String(state.form_data?.ja_usa_cannabis || "").toLowerCase();
  const neverUsed = /nunca\s+us[ei]/.test(usaCannabis);

  return `Você é a *Lia*, assistente de vendas humanizada do consultório do Dr. Alef Kotula (médico, cannabis medicinal). Você fala por WhatsApp. Seu papel não é só marcar consulta — é CONVERTER. O lead já passou por um formulário com múltiplas etapas, ele tá quente. Você é uma VENDEDORA consultiva: valida a dor, gera confiança, quebra objeções, e fecha.

▶ PERSONA (humana, não robótica)
- Você é uma pessoa real conversando com outra pessoa real.
- Tom: caloroso, claro, direto, sem floreio. NUNCA robótico. NUNCA começa com fórmula pronta tipo "me conta o que te incomodou mais" sem antes validar o que a pessoa JÁ TE CONTOU no formulário.
- Mensagens curtas (1–4 linhas em geral). Quando precisar explicar, vá em até 6 linhas.
- Use o nome da pessoa naturalmente, sem repetir em toda mensagem.
- Não invente. Não prometa cura. Não diagnostique. Não prescreva.
- NÃO use emojis em excesso. NUNCA assine como "Lia" ou "Att".

▶ REGRA #0 — LEIA E RESPONDA A MENSAGEM ANTES DE OFERECER (CRÍTICA)
Quando o lead escrever uma mensagem com PERGUNTAS ou compartilhar CONTEXTO CLÍNICO (condição, medicações, histórico, dúvidas específicas sobre prescrição/laudo/flor/vaporização/importação), VOCÊ PRECISA:
1) Ler TUDO que ele escreveu
2) Reconhecer a condição específica (esclerose múltipla, amputação, Parkinson, câncer, etc.) — demonstre que entendeu
3) RESPONDER cada pergunta concreta que ele fez — uma por uma, com informação útil
4) SÓ DEPOIS, se fizer sentido, mencionar o caminho pra consulta
NUNCA despeje link ou preço antes de responder. Se você fizer isso, o lead perde a confiança e some. É a falha que mais te faz perder venda.

▶ REGRA #0.5 — USE O FORMULÁRIO QUANDO HOUVER
Se o lead veio de formulário (ver CONTEXTO DO LEAD abaixo), use os dados para personalizar — valide a condição, cite o gasto, reconheça a dificuldade. NUNCA repita perguntas que o formulário já respondeu.

▶ CONHECIMENTO CLÍNICO DE PRESCRIÇÃO (Dr. Alef pode)
- Prescrever *óleo de cannabis medicinal* (full spectrum, broad spectrum ou isolado, conforme indicação e perfil).
- Prescrever *óleo de associação* (mais de 50% mais barato que farmácia/importado) — diferencial forte do Dr.
- Orientar uso de *flor seca pra vaporização* quando houver indicação clínica.
- Emitir *laudo médico* para importação de produtos (via HC ou Anvisa) quando necessário.
- Avaliar *dose, concentração, horário* — o protocolo é individualizado.
- Indicar *associação com outros tratamentos* (fisio, neurologia, psiquiatria) quando fizer sentido. Ele não substitui a equipe — complementa.
Evidências: Anvisa RDC 327/660, OMS reconhece segurança do CBD, literatura internacional robusta em dor crônica, neuropática, espasticidade em esclerose múltipla, epilepsia, ansiedade, insônia, Parkinson.
NÃO prometa cura. Diga "alívio", "redução", "bons resultados", "tem caminho".

${neverUsed ? `▶ BLOQUEIO CRÍTICO — LEAD MARCOU "NUNCA USEI" CANNABIS
Este lead NUNCA USOU cannabis medicinal. É PROIBIDO perguntar:
- "qual produto você usa hoje"
- "em que concentração"
- "qual perfil — CBD puro, CBD com THC"
- "quem prescreveu o tratamento atual"
- "qual óleo você toma"
Se você fizer QUALQUER uma dessas perguntas a este lead, você falhou. Em vez disso: valide a dor/condição marcada no form, explore IMPACTO NA VIDA, e depois apresente o Dr. Alef como primeiro tratamento.` : ""}

▶ HABILIDADES DE VENDEDORA
1. EXPLORAR DOR (física + emocional): "há quanto tempo convive com isso?", "como tá atrapalhando seu dia?", "o que você deixou de fazer por causa disso?"
2. GERAR CONFIANÇA: cite credenciais do Dr. Alef (médico CRM-SP, pós-graduado internacionalmente em cannabis medicinal, Instagram @dralefkotula, site oficial, consultório físico em SP). Ofereça verificação antes.
3. QUEBRAR OBJEÇÕES específicas de cada público. Nunca devolva objeção com frase genérica.
4. FECHAR com frases de fechamento consultivo:
   - "Até quando você pretende viver assim?"
   - "Quanto tempo de vida você tá abrindo mão por causa disso?"
   - "Se em 30 dias você tivesse redução real do sintoma, o que voltaria a fazer?"
   - "O tratamento certo não é custo — é o que te devolve a vida que você tá perdendo."
5. NUNCA empurrar. A dor é real, o argumento é real, a urgência é real — você só devolve o que o lead já sente.

▶ CONTEXTO DO LEAD
- Nome: ${nome}
- Condição detectada: ${cond}
- Perfil: ${profile} → ${guide}
- *LEAD_QUALIFICADO_PELO_FORM*: ${formQ}
- Campanha: ${formTrack === "r3_revisao" ? "REVISÃO DE TRATAMENTO (já usa cannabis)" : formTrack === "r4_dor_neuro" ? "DOR NEUROPÁTICA (primeiro tratamento)" : "ORGÂNICO"}
${r3Block}

▶ REGRA LEAD QUALIFICADO (CRÍTICA)
Se LEAD_QUALIFICADO_PELO_FORM = SIM:
- NÃO reinterrogue. O lead já passou por 7 perguntas no formulário Meta (tipo de caso, tempo, impacto, tratamentos prévios, intenção, aceite de R$249/7 dias, aceite de videochamada).
- NÃO faça "fase de descoberta". Cumprimente, valide a condição (1 frase de empatia + 1 dado clínico) e caminhe pra preço/link.
- Se o lead pedir preço ou link, MANDE NA HORA — sem ginástica.

▶ DOR NEUROPÁTICA (campanha alvo — dominar)
- Sintomas típicos: queimação (especialmente nos pés à noite), choque elétrico, formigamento, dormência, alfinetada/agulhada.
- Por que gabapentina/pregabalina/amitriptilina muitas vezes não resolvem: agem em receptores colaterais (GABA, serotonina). O efeito mais comum é sonolência/grogue, não alívio real da dor.
- Mecanismo do canabinoide: o sistema endocanabinoide tem receptores CB1 e CB2 espalhados nos nervos periféricos e na medula — atua direto onde a dor é gerada.
- Dados: Anvisa autoriza desde 2019 (RDC 327, atualizada pela RDC 660). OMS reconhece perfil de segurança favorável do CBD. Estudos mostram redução de 30–50% na intensidade.
- NÃO prometa cura. Diga "alívio relevante", "bons resultados", "tem caminho".

▶ OFERTA (única)
- Consulta médica online individual com o Dr. Alef Kotula.
- Valor: R$249 (à vista no Pix ou cartão em até 12x). NUNCA diga "sem juros".
- Duração: ~40 minutos por videochamada (WhatsApp ou Google Meet).
- Pagamento: pelo *site oficial* dralefkotula.com (NUNCA por transferência pra conta pessoal).
- Reagendamento: gratuito quando solicitado com antecedência.

▶ ANTI-GOLPE (use quando perguntarem "é confiável?", "é golpe?", "quem é você?")
Reforce: Dr. Alef Kotula é médico CRM-SP, formação na Rússia, especialização internacional em cannabis medicinal, consultório em SP. Instagram @dralefkotula, site oficial dralefkotula.com (com CNPJ e endereço). Pagamento sempre pelo site oficial.

▶ OBJEÇÕES (responder com naturalidade)
- "É caro" → No cartão dá pra parcelar em 12x. Pra ter qualidade desse nível, é justo.
- "Vou pensar" → Tudo bem, sem pressa. Quando quiser, tô aqui.
- "É legal/Anvisa permite?" → Sim, RDC 327/660 desde 2019.
- "Vou ficar chapado/dependente?" → CBD não causa dependência. Não tem efeito recreativo.
- "Já tentei tudo" → Provavelmente não tentou esse mecanismo. CB1/CB2 atua diferente.

▶ REGRAS DE OURO
1. Se o lead pedir LINK ou pagamento — MANDE. Não enrole.
2. Se o lead perguntar PREÇO — RESPONDA DIRETO + link.
3. Se o lead disser "é golpe?" — TRUST_BLOCK (credenciais + Instagram + site).
4. Se o lead estiver sofrendo emocionalmente — VALIDE primeiro, não venda.
5. Se houver risco de vida (suicídio/urgência) — INTERROMPA venda, encaminhe pra CVV/SAMU.
6. NUNCA invente preço, horário, slot, link, credencial.

▶ TOKENS DE FALLBACK (use quando precisar que o sistema tome controle)
- Quando o lead pedir explicitamente preço/link e você precisar do gerador → responda exatamente: __NEED_PRICE__
- Quando o lead pedir agendar → __NEED_BOOK__
- Quando o lead disser que pagou → __NEED_PAY__
- Em risco/urgência → __URGENT__

Responda sempre em PT-BR. Sem emojis em excesso. Mensagem curta e humana.`;
}

/* Fallback inteligente quando o GPT falha — evita cair em loop de "pera um instante"
   REGRA: NUNCA despejar link em cima de pergunta substantiva. */
function runLiaFallback({ state, flags, incomingText }) {
  const nome = state.nome ? `${state.nome}, ` : "";
  const hasLink = !!(state.payment?.public_url || state.payment?.link);
  const link = state.payment?.public_url || state.payment?.link || "";

  // Pergunta substantiva → reconhece e pede pro lead aguardar (sem dumpar link)
  const isComplex = flags?.isSubstantiveMessage || flags?.hasMultipleAsks || flags?.mentionsSeriousCondition || flags?.asksAboutPrescription || flags?.sharesPersonalStory;
  if (isComplex) {
    // Resposta humanizada que ACUSA a leitura sem responder o que não sabe
    return `${nome}deixa eu te responder direito aqui. Sobre o que você perguntou — prescrição, tipo de óleo, laudos — o Dr. Alef avalia caso a caso e, tendo indicação clínica, prescreve óleo, pode orientar flor pra vaporização e emitir laudo (inclusive pra importação via HC quando necessário).\n\nPosso te perguntar: sua dúvida principal é pra entender se o caso serve, ou é prática (como funciona a consulta, valor, etc.)?`;
  }

  // Pergunta específica sobre prescrição (fallback clínico)
  if (flags?.asksAboutPrescription) {
    return `${nome}respondendo o que você perguntou: o Dr. Alef prescreve *óleo de cannabis medicinal* (full spectrum ou outras composições, conforme o caso) e, quando há indicação, pode orientar *flor seca pra vaporização*. Ele também emite *laudo médico* pra importação via HC — sempre que houver indicação clínica.\n\nO que mais você quer saber?`;
  }

  // Pergunta muito específica tipo "é online?", "como funciona?" — cai no GPT em condição normal
  if (flags?.asksHowConsultWorks) {
    return `${nome}a consulta é 100% online, por videochamada (WhatsApp ou Google Meet, o que for melhor pra você). Dura cerca de 40 min. O Dr. escuta seu caso, tira suas dúvidas, e se houver indicação clínica já sai com a prescrição na hora. Retorno já incluso.`;
  }

  // Se lead pediu preço/link CURTO e já existe link → re-entrega
  if ((flags?.wantsPrice || flags?.intentPay || flags?.asksPayMethod) && incomingText && incomingText.trim().length <= 80) {
    if (hasLink) return pendingPaymentReply(state);
    return `Consulta com o Dr. Alef${state.nome ? ", " + state.nome : ""} é *${CONSULT_PRICE_LABEL}* — videochamada, cerca de 40 min, cartão em até 12x ou Pix.`;
  }

  // Golpe/desconfiança
  if (flags?.asksIsScam || flags?.asksWho) return buildTrustBlock(state);

  // Diz que tá caro
  if (flags?.saysExpensive) {
    return state.form_track === "r3_revisao" ? objectionHighSpendReply(state) : objectionPriceReply(state);
  }

  // Pergunta aberta (sem gatilho conhecido) — não dumpa link, pede esclarecimento humano
  return `${nome}me conta um pouco mais pra eu te responder direito — o que você quer entender agora? O caso clínico, como funciona a consulta, valor, ou outra coisa?`;
}

async function runLia({ incomingText, state, flags, stageCTA }) {
  if (!openai) {
    console.warn("[LIA] OpenAI client ausente — usando fallback");
    return { reply: runLiaFallback({ state, flags, incomingText }), updates: {}, fallback: true };
  }

  const messages = [
    { role: "system", content: buildSystemPrompt(state) },
  ];
  const hist = (state.conversation_history || []).slice(-12);
  for (const turn of hist) {
    if (turn.user) messages.push({ role: "user", content: clip(turn.user, 600) });
    if (turn.bot) messages.push({ role: "assistant", content: clip(turn.bot, 600) });
  }
  messages.push({ role: "user", content: clip(incomingText, 800) });
  if (stageCTA) {
    messages.push({ role: "system", content: `Direção desta mensagem: ${stageCTA}` });
  }

  // Timeout + retry (1 tentativa extra se primeira falhar)
  const callOnce = async (attempt) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 18000); // 18s hard timeout
    try {
      const completion = await openai.chat.completions.create({
        model: CHAT_MODEL,
        temperature: 0.78,
        messages,
        max_tokens: 350,
      }, { signal: controller.signal });
      clearTimeout(timeoutId);
      return (completion.choices?.[0]?.message?.content || "").trim();
    } catch (err) {
      clearTimeout(timeoutId);
      console.error(`❌ runLia attempt=${attempt} erro: ${err?.name || ""} ${err?.message || err}`);
      throw err;
    }
  };

  try {
    const reply = await callOnce(1);
    if (reply) return { reply, updates: {} };
    // reply vazio → retry uma vez
    const retry = await callOnce(2);
    if (retry) return { reply: retry, updates: {} };
    return { reply: runLiaFallback({ state, flags, incomingText }), updates: {}, fallback: true };
  } catch (err1) {
    try {
      await sleep(600);
      const reply = await callOnce(2);
      if (reply) return { reply, updates: {} };
    } catch (err2) {
      console.error("❌ runLia falhou após retry:", err2?.message || err2);
    }
    return { reply: runLiaFallback({ state, flags, incomingText }), updates: {}, fallback: true };
  }
}

function updateConversationHistory(state, userMsg, botMsg) {
  state.conversation_history = state.conversation_history || [];
  state.conversation_history.push({ user: userMsg, bot: botMsg, ts: Date.now() });
  if (state.conversation_history.length > 30) state.conversation_history = state.conversation_history.slice(-30);
}

/* V30.2 — anti-repeat hard guard: compara com as últimas 3 respostas do bot,
   diversifica progressivamente e, após 2 repetições, CEDE graciosamente. */
const DIVERSIFY_POOL = [
  (nome) => `${nome}fica à vontade pra me responder quando puder, sem pressa.`,
  (nome) => `${nome}tô por aqui quando quiser continuar. Qualquer dúvida, me chama.`,
  (nome) => `${nome}já vi sua resposta, obrigada. Se precisar, eu fico à disposição.`,
  (nome) => `${nome}combinado. Quando decidir seguir, me avisa.`,
  (nome) => `${nome}tranquilo. Tô aqui pra ajudar no que precisar.`,
];

async function ensureNoRepeat(reply, state, incomingText, flags) {
  if (!reply) return reply;
  const nome = state.nome ? `${state.nome}, ` : "";

  // Histórico das últimas 3 respostas do bot (de conversation_history + last_bot_reply)
  const hist = (state.conversation_history || []).slice(-4).map(t => t.bot || "").filter(Boolean);
  const last3 = [state.last_bot_reply || "", ...hist].filter(Boolean).slice(0, 3);

  let repeatCount = 0;
  for (const prev of last3) {
    if (similar(prev, reply)) repeatCount++;
  }

  if (repeatCount === 0) {
    // Reset contador se não repetiu
    state.repeat_strike = 0;
    return reply;
  }

  // Incrementa o "strike" de repetição
  state.repeat_strike = (state.repeat_strike || 0) + 1;

  // 1ª repetição: diversifica com item do pool que ainda não foi usado
  if (state.repeat_strike === 1) {
    const used = new Set((state.diversify_used || []));
    const available = DIVERSIFY_POOL.filter((_, i) => !used.has(i));
    const pool = available.length ? available : DIVERSIFY_POOL;
    const idx = Math.floor(Math.random() * pool.length);
    const picked = pool[idx];
    const globalIdx = DIVERSIFY_POOL.indexOf(picked);
    state.diversify_used = [...used, globalIdx];
    return picked(nome);
  }

  // 2ª+ repetição: fecha a conversa graciosamente e agenda followup de 24h
  state.followup_needed_at = Date.now() + 24 * 60 * 60 * 1000;
  state.repeat_strike = 0;
  return `${nome}acho que já te passei o essencial por enquanto. Quando você estiver pronto(a), é só me chamar aqui — tô à disposição.`;
}

function computeHumanDelay(flags, state) {
  if (flags?.urgency || flags?.emotionalRisk) return 4;
  return randInt(MIN_DELAY, MAX_DELAY);
}

async function sendWhatsApp(to, from, body, delaySec = 8) {
  if (!twilioClient) return;
  try {
    if (delaySec > 0) await sleep(delaySec * 1000);
    await twilioClient.messages.create({ to, from, body });
  } catch (err) { console.error("❌ sendWhatsApp:", err.message); }
}

/* ═══════════════════════════════════════════════════════════════════
   STATE INIT
   ═══════════════════════════════════════════════════════════════════ */

function initializeState(state, botFrom) {
  const s = state || {};
  s.stage = s.stage || "GREET";
  s.turn_count = Number(s.turn_count || 0);
  s.price_ask_count = Number(s.price_ask_count || 0);
  s.conversation_history = s.conversation_history || [];
  s.lead_profile = s.lead_profile || "padrao";
  s.form_data = s.form_data || null;
  s.form_qualified = s.form_qualified || false;
  s.last_bot_from = s.last_bot_from || botFrom || null;
  return s;
}

/* ═══════════════════════════════════════════════════════════════════
   FAST LANE — routeToOffer
   ═══════════════════════════════════════════════════════════════════ */

const PRE_PAY_STAGES = new Set(["GREET", "CONNECT", "OFFER"]);

function routeToOffer(state, flags, incomingText) {
  if (!PRE_PAY_STAGES.has(state.stage)) return false;

  /* V30.1 — BLOQUEIO: se lead escreveu uma mensagem substantiva com várias perguntas,
     doença séria, ou compartilhou história pessoal, NÃO pula pra oferta.
     Deixa o GPT responder as perguntas primeiro. */
  const isComplex = flags.isSubstantiveMessage || flags.hasMultipleAsks || flags.mentionsSeriousCondition || flags.asksAboutPrescription || flags.sharesPersonalStory;
  if (isComplex) return false;

  /* Só pula pra oferta em pedidos CURTOS e diretos */
  if (flags.intentPay || flags.wantsBook) return true;
  if (flags.wantsPrice && incomingText && incomingText.trim().length <= 60) return true;
  if (flags.asksPayMethod) return true;
  if (state.form_qualified && flags.shortAffirm) return true;
  if (state.lead_profile === "quente" && state.turn_count >= 3) return true;
  return false;
}

/* ═══════════════════════════════════════════════════════════════════
   PROCESS LIA MESSAGE — FSM v30
   ═══════════════════════════════════════════════════════════════════ */

async function processLiaMessage(phone, incomingText, meta = {}) {
  // dedup
  const dup = _dedupCheck(phone, incomingText);
  if (dup) return { reply: dup, deduplicated: true };

  if (isSystemMessage(incomingText)) return { filtered: true };

  // ADMIN reset
  if (phone === ADMIN_RESET_PHONE_DIGITS && /^reset\.lia$/i.test(incomingText.trim())) {
    await saveUserState(phone, {});
    return { reply: "🔄 Estado resetado.", state: {}, flags: {} };
  }

  let state = initializeState(await getUserState(phone), `api:${phone}`);

  // Form parsing → marca qualificado, popula nome/condition
  const formPayload = isMetaAdsEntry(incomingText) ? extendedFormParser(incomingText) : null;
  if (formPayload) {
    state.form_data = { ...(state.form_data || {}), ...formPayload };
    if (formPayload.nome_completo && !state.nome) {
      const fn = extractFormFirstName(formPayload.nome_completo);
      if (fn) state.nome = fn;
      if (!state.nome_completo) state.nome_completo = formPayload.nome_completo;
    }
    if (formPayload.condition && !state.condition) {
      const c = detectCondition(formPayload.condition);
      if (c) state.condition = c;
    }
    markFormQualified(state);
    // Detecta campanha de origem
    if (!state.form_track) state.form_track = detectFormTrack(formPayload, state);
    // Se R3 e não tem condition ainda, tenta extrair de problema_tratado
    if (state.form_track === "r3_revisao" && !state.condition && formPayload.problema_tratado) {
      const c = detectCondition(formPayload.problema_tratado);
      if (c) state.condition = c;
    }
    console.log(`[LIA v30] form parsed phone=${phone} qualified=${state.form_qualified} track=${state.form_track} cond=${state.condition}`);
  }

  // Se contactName veio do envelope e não temos nome
  if (meta.contactName && !state.nome) state.nome = meta.contactName;

  const flags = detectIntent(incomingText);
  state.lead_profile = classifyLead(flags, incomingText, state);
  state.turn_count = (state.turn_count || 0) + 1;

  let reply = "";

  /* ── GUARDS ORTOGONAIS (precedência alta) ─────────────────────── */

  // Já pago → fluxo pós-pagamento
  if (state.payment?.status === "approved") {
    return await handlePaidFlow(state, flags, incomingText, phone);
  }

  // Risco de vida
  if (flags.emotionalRisk) {
    state.emotional_risk_flagged = true;
    state.needs_human = true;
    reply = cvvReply();
    return await finalize(state, phone, incomingText, reply, flags);
  }

  // Urgência médica
  if (flags.urgency) {
    state.needs_human = true;
    reply = urgencyReply();
    return await finalize(state, phone, incomingText, reply, flags);
  }

  // Anti-golpe / quem é você
  if (flags.asksIsScam || flags.asksWho || flags.asksAboutDoctor) {
    reply = buildTrustBlock(state);
    return await finalize(state, phone, incomingText, reply, flags);
  }

  // V30.3 — Postponement estruturado (compromisso futuro: financeiro, data, evento, decisional, vago)
  // Rodar antes do catch-all de sleepy/wantsLater pra extrair referência temporal
  // e responder com eco específico + followup calculado.
  if (!["PAY_WAIT","POST_PAY_DATA","SCHEDULE","CONFIRMED"].includes(state.stage) && state.payment?.status !== "approved") {
    const postpone = detectPostponement(incomingText);
    if (postpone.detected) {
      reply = postponementReply(state, postpone, incomingText);
      return await finalize(state, phone, incomingText, reply, flags);
    }
  }

  // Sleepy / wantsLater / fim de papo (fallback quando nenhum compromisso estruturado foi detectado)
  if (flags.isSleepy || flags.wantsLater || flags.endsConversation) {
    state.followup_needed_at = Date.now() + 24 * 60 * 60 * 1000;
    reply = farewellReply(state);
    return await finalize(state, phone, incomingText, reply, flags);
  }

  // Casual ack curto
  if (flags.casualAck && !flags.wantsPrice && !flags.intentPay && state.stage !== "POST_PAY_DATA" && state.stage !== "SCHEDULE") {
    reply = casualAckReply(state);
    return await finalize(state, phone, incomingText, reply, flags);
  }

  /* ── FAST LANE → OFFER ───────────────────────────────────────── */

  if (routeToOffer(state, flags, incomingText)) {
    const offerOut = await openOffer(state, flags, incomingText, phone);
    return await finalize(state, phone, incomingText, offerOut.reply, flags, offerOut.followup);
  }

  /* ── STATE MACHINE ───────────────────────────────────────────── */

  switch (state.stage) {
    case "GREET":
      reply = await handleGreet(state, flags, incomingText, phone);
      break;
    case "CONNECT": {
      const connectOut = await handleConnect(state, flags, incomingText, phone);
      if (connectOut && typeof connectOut === "object" && "reply" in connectOut) {
        return await finalize(state, phone, incomingText, connectOut.reply, flags, connectOut.followup);
      }
      reply = connectOut;
      break;
    }
    case "OFFER": {
      const out = await handleOffer(state, flags, incomingText, phone);
      return await finalize(state, phone, incomingText, out.reply, flags, out.followup);
    }
    case "PAY_WAIT":
      reply = await handlePayWait(state, flags, incomingText, phone);
      break;
    case "POST_PAY_DATA":
      reply = await handlePostPayData(state, flags, incomingText, phone);
      break;
    case "SCHEDULE":
      reply = await handleSchedule(state, flags, incomingText, phone);
      break;
    case "CONFIRMED":
      reply = await handleConfirmed(state, flags, incomingText, phone);
      break;
    default:
      state.stage = "GREET";
      reply = await handleGreet(state, flags, incomingText, phone);
  }

  return await finalize(state, phone, incomingText, reply, flags);
}

/* ── Finalize: persist state, return ─────────────────────────── */

async function finalize(state, phone, incomingText, reply, flags, followup = null) {
  reply = await ensureNoRepeat(reply, state, incomingText, flags);
  reply = sanitizeReply(reply);

  updateConversationHistory(state, incomingText, reply);
  state.last_user_message = incomingText;
  state.last_bot_reply = reply;
  state.last_sent_at = Date.now();
  await saveUserState(phone, state);
  logMessage("lia", phone, reply, "outbound");

  return { reply, state, flags, followup };
}

/* ═══════════════════════════════════════════════════════════════════
   HANDLERS POR ESTADO
   ═══════════════════════════════════════════════════════════════════ */

async function handleGreet(state, flags, incomingText, phone) {
  // Se temos form qualificado e ainda não cumprimentamos
  if (state.form_qualified && !state.greeted_from_form) {
    state.greeted_from_form = true;
    state.stage = "CONNECT";
    state.followup_2h_at = Date.now() + 2 * 60 * 60 * 1000; // agenda re-engajamento se não responder em 2h
    // Roteia pelo track da campanha
    if (state.form_track === "r3_primeira_vez") return greetPrimeiraVez(state);
    if (state.form_track === "r3_parou") return greetParou(state);
    if (state.form_track === "r3_revisao") return greetFromFormR3(state);
    return greetFromForm(state);
  }

  /* V30.1 — Se a primeira mensagem (orgânica) já é substantiva com perguntas,
     DELEGA AO GPT. Não despejar saudação genérica em cima de quem escreveu uma carta. */
  const firstIsComplex = flags.isSubstantiveMessage || flags.hasMultipleAsks || flags.mentionsSeriousCondition || flags.asksAboutPrescription || flags.sharesPersonalStory;
  if (firstIsComplex) {
    state.stage = "CONNECT";
    state.followup_2h_at = Date.now() + 2 * 60 * 60 * 1000;
    const ai = await runLia({
      incomingText, state, flags,
      stageCTA: `PRIMEIRA mensagem do lead — ELA É SUBSTANTIVA. Ele compartilhou contexto ou fez múltiplas perguntas específicas. Sua tarefa: 1) cumprimente pelo nome (se souber), 2) VALIDE com empatia específica o que ele compartilhou (não genérica), 3) RESPONDA todas as perguntas que ele fez com clareza e informação concreta, 4) só DEPOIS mencione que a consulta com o Dr. Alef é R$249 (cartão em até 12x ou Pix, sem dizer "sem juros") e pergunte se ele quer o link. NÃO dumpe o link sem antes responder.`,
    });
    return ai.reply;
  }

  // Se chegou direto sem form (orgânico) sem nome
  if (!state.nome) {
    return `Oi! Aqui é a *Lia*, da equipe do *Dr. Alef Kotula* — médico especialista em cannabis medicinal.\n\nPra te ajudar melhor, me diz seu *primeiro nome* e o que tá te incomodando hoje — dor, insônia, ansiedade, outra coisa?`;
  }
  state.stage = "CONNECT";
  state.followup_2h_at = Date.now() + 2 * 60 * 60 * 1000;
  return `Oi, ${state.nome}! Aqui é a *Lia*, da equipe do *Dr. Alef Kotula* — médico especialista em cannabis medicinal.\n\nMe conta rapidinho o que tá te incomodando — o que tá afetando seu dia a dia? Assim eu te oriento direito sobre como o Dr. pode ajudar.`;
}

/* Frases de fechamento — usadas em 2º turno de CONNECT pra apertar a dor com empatia */
const CLOSER_PHRASES = [
  "Até quando você pretende viver assim? Porque dor/sintoma que não trata, só aumenta.",
  "Pensa comigo: quanto tempo de vida você tá abrindo mão por causa disso? Porque cada dia que passa sem tratar, é um dia que a gente não volta.",
  "Se em 30 dias você tivesse uma redução real no sintoma, o que você voltaria a fazer que hoje não consegue?",
  "O que tá te impedindo de tentar um tratamento que funcione? Porque o que você tá fazendo hoje claramente não tá resolvendo.",
  "O tratamento certo não é custo — é o que te devolve a vida que você tá perdendo.",
];

function pickCloser() { return pickRandom(CLOSER_PHRASES); }

async function handleConnect(state, flags, incomingText, phone) {
  // Se ainda não tem nome (lead orgânico) e a mensagem traz nome
  if (!state.nome) {
    const fn = extractFirstName(incomingText);
    if (fn) state.nome = fn;
  }
  // Se ainda não tem condição, tenta detectar do texto
  if (!state.condition) {
    const c = detectCondition(incomingText);
    if (c) state.condition = c;
    if (!state.problem_text) {
      const pt = extractProblemText(incomingText);
      if (pt) state.problem_text = pt;
    }
  }

  // Renova o follow-up de 2h a cada interação
  state.followup_2h_at = Date.now() + 2 * 60 * 60 * 1000;

  state.connect_turns = (state.connect_turns || 0) + 1;
  const track = state.form_track || "";

  /* V30.1 — Delega GPT se mensagem é substantiva (pergunta específica, doença séria, história pessoal) */
  const isComplex = flags.isSubstantiveMessage || flags.hasMultipleAsks || flags.mentionsSeriousCondition || flags.asksAboutPrescription || flags.sharesPersonalStory || flags.asksHowConsultWorks || flags.asksIfForMe || flags.asksIfWorks;
  if (isComplex) {
    const ai = await runLia({
      incomingText, state, flags,
      stageCTA: `O lead acabou de compartilhar algo complexo / fez uma pergunta substantiva / tem uma condição séria. RESPONDA o que ele perguntou, valide a dor com especificidade, e só no FINAL faça uma ponte natural para a consulta (sem despejar link). Se ele não perguntou preço, NÃO mencione preço ainda — termine com uma pergunta que aprofunde a conexão.`,
    });
    return ai.reply;
  }

  /* ═══ R3 PRIMEIRA VEZ: 2 turnos de exploração + closer + oferta ═══ */
  if (track === "r3_primeira_vez") {
    if (state.connect_turns === 1) {
      // Turno 1: validação emocional + closer + pergunta de impacto
      const cond = state.condition || "dor_cronica";
      const ev = EVIDENCE_DB[cond] || EVIDENCE_DB.dor_neuropatica || {};
      const empath = pickRandom(ev.empathy || EMPATHY_POOL.pain);
      const closer = pickCloser();
      return `${empath}\n\n${closer}\n\nMe conta: você já tentou remédio de tarja, fisioterapia, outros tratamentos? Como foi?`;
    }
    // Turno 2+: entrega evidência clínica + proposta de valor + oferta
    return await openOfferText(state, phone);
  }

  /* ═══ R3 PAROU: 1-2 turnos + argumento óleo associação + oferta ═══ */
  if (track === "r3_parou") {
    if (state.connect_turns === 1) {
      return `Entendi. O que a gente vê muito é: pessoa paga consulta cara, recebe prescrição de óleo de farmácia ou importado de R$400, R$600, R$800/mês — e em 2-3 meses não aguenta mais pagar.\n\nO Dr. Alef trabalha com *óleo de associação* que é *mais de 50% mais barato*, pra tratamento ser sustentável no longo prazo.\n\n${pickCloser()}`;
    }
    return await openOfferText(state, phone);
  }

  /* ═══ R3 REVISÃO: 1-2 turnos + proposta de valor ═══ */
  if (track === "r3_revisao") {
    if (state.connect_turns === 1) {
      return connectQuestionR3(state);
    }
    return await openOfferText(state, phone);
  }

  /* ═══ R4 / orgânico qualificado: 2 turnos de descoberta ═══ */
  if (state.form_qualified && state.connect_turns === 1) {
    const cond = state.condition || "dor_neuropatica";
    const ev = EVIDENCE_DB[cond] || EVIDENCE_DB.dor_cronica || {};
    const empath = pickRandom(ev.empathy || EMPATHY_POOL.pain);
    const dataLine = ev.direct_answer || "";
    return `${empath}\n\n${dataLine}\n\n${pickCloser()}`;
  }
  if (state.form_qualified && state.connect_turns >= 2) {
    return await openOfferText(state, phone);
  }

  /* ═══ Orgânico não qualificado: até 2 turnos antes da oferta ═══ */
  if (state.connect_turns >= 2) {
    return await openOfferText(state, phone);
  }

  // Validação + 1 dado clínico + closer (fluxos R4 e orgânico)
  const cond = state.condition || "dor_neuropatica";
  const ev = EVIDENCE_DB[cond] || EVIDENCE_DB.dor_cronica || {};
  const empath = pickRandom(ev.empathy || EMPATHY_POOL.pain);
  const dataLine = ev.direct_answer || "";
  return `${empath}\n\n${dataLine}\n\n${pickCloser()}`;
}

/* openOffer: cria preference MP + checkout curto, devolve reply + followup curto */
async function openOffer(state, flags, incomingText, phone) {
  state.stage = "OFFER";
  // Se já tem link pendente, reaproveita
  if (state.payment?.link && state.payment?.status === "pending") {
    state.stage = "PAY_WAIT";
    return { reply: pendingPaymentReply(state), followup: null };
  }
  try {
    const pref = await mpCreatePreference({ phone, planKey: "avaliacao" });
    const checkout = await buildSiteCheckoutLink({
      paymentLink: pref.link, phone, planKey: "avaliacao",
      externalReference: pref.external_reference, state,
    });
    state.payment = {
      status: "pending", plan_key: "avaliacao",
      preference_id: pref.preference_id, link: checkout.url, public_url: checkout.public_url, mp_link: pref.link,
      checkout_ref: checkout.ref, external_reference: pref.external_reference,
      created_at: Date.now(), method: "link",
    };
    state.stage = "PAY_WAIT";
    return {
      reply: buildPriceLinkReply(state, checkout.public_url),
      followup: buildPriceLinkFollowup(state),
    };
  } catch (err) {
    console.error("❌ openOffer MP erro:", err.message);
    return { reply: priceShortReply(state) + "\n\nMe dá um instante que eu gero o link.", followup: null };
  }
}

async function openOfferText(state, phone) {
  // R3: antes do link, entrega proposta de valor específica em msg separada
  if (state.form_track === "r3_revisao" && !state.r3_value_prop_sent) {
    state.r3_value_prop_sent = true;
    state.stage = "OFFER";
    const valueProp = buildValuePropR3(state);
    const out = await openOffer(state, {}, "", phone);
    // Retorna proposta de valor + link numa sequência (caller vai separar em 2 msgs via followup)
    return { reply: valueProp, followup: out.reply + (out.followup ? `\n\n${out.followup}` : "") };
  }
  const out = await openOffer(state, {}, "", phone);
  return out.reply + (out.followup ? `\n\n${out.followup}` : "");
}

async function handleOffer(state, flags, incomingText, phone) {
  // Em OFFER: qualquer coisa que cheire a "manda link" → openOffer
  if (flags.wantsPrice || flags.intentPay || flags.wantsBook || flags.shortAffirm) {
    return await openOffer(state, flags, incomingText, phone);
  }
  if (flags.saysExpensive) {
    // R3: reframe específico pra quem já gasta muito vs generic
    const expReply = state.form_track === "r3_revisao"
      ? objectionHighSpendReply(state)
      : objectionPriceReply(state);
    return { reply: expReply, followup: null };
  }
  // Caso o lead pergunte algo, GPT responde mantendo CTA
  const ai = await runLia({ incomingText, state, flags, stageCTA: "Mantenha curto. Responda a dúvida e termine reforçando que o link de pagamento já está disponível." });
  return { reply: ai.reply, followup: null };
}

async function handlePayWait(state, flags, incomingText, phone) {
  const low = norm(incomingText);

  // Diz que pagou → resposta curta de aguardar webhook
  if (/\b(paguei|pago|fiz o pagamento|finalizei|comprovante|enviei)\b/.test(low)) {
    return `Ótimo! Tô conferindo aqui. Assim que o sistema confirmar (geralmente em segundos), eu já te chamo pra próxima etapa.`;
  }

  // Quer Pix
  if (/\b(pix)\b/.test(low) && !/(cartao|cartão|link)/.test(low)) {
    state.payment.alt_pix_offered = true;
    return `Sem problema. Pode pagar por Pix:\n\nCNPJ: *${PIX_CNPJ}*\nValor: *${CONSULT_PRICE_LABEL}*\n\nDepois me manda o comprovante por aqui que eu confirmo na hora.`;
  }

  /* V30.1 — se o lead fez pergunta substantiva, NÃO dumpar link. Roteia GPT. */
  const isComplex = flags.isSubstantiveMessage || flags.hasMultipleAsks || flags.mentionsSeriousCondition || flags.asksAboutPrescription || flags.sharesPersonalStory || flags.asksHowConsultWorks || flags.asksIfForMe || flags.asksIfWorks;
  if (isComplex) {
    const linkPart = state.payment?.public_url || state.payment?.link || "";
    const ai = await runLia({
      incomingText, state, flags,
      stageCTA: `O lead JÁ RECEBEU o link de pagamento. Ele acabou de te fazer uma PERGUNTA substantiva ou compartilhou um contexto clínico. NÃO re-envie o link antes de RESPONDER a pergunta dele com clareza. Responda primeiro, com empatia e com informação concreta (o Dr. Alef é pós-graduado em cannabis medicinal, prescreve óleo, flor para vaporização quando indicado, e emite laudos inclusive para importação HC quando clinicamente necessário). Só no final, uma linha reforçando que o link segue ativo: ${linkPart}`,
    });
    return ai.reply;
  }

  // Re-pede link CURTO (só então re-envia o template)
  if ((flags.intentPay || flags.wantsPrice || flags.wantsBook || flags.asksPayMethod) && incomingText && incomingText.trim().length <= 80) {
    return pendingPaymentReply(state);
  }

  if (flags.saysExpensive) {
    return state.form_track === "r3_revisao" ? objectionHighSpendReply(state) : objectionPriceReply(state);
  }

  if (flags.asksIsScam || flags.asksWho) return buildTrustBlock(state);

  // Pergunta livre durante espera — GPT com fallback inteligente
  const ai = await runLia({ incomingText, state, flags, stageCTA: `O lead já recebeu o link. Tire a dúvida com clareza e termine reforçando que o link tá ativo: ${state.payment?.public_url || state.payment?.link || ""}` });
  return ai.reply;
}

async function handlePostPayData(state, flags, incomingText, phone) {
  // tenta extrair tudo da mensagem
  const parsed = parsePostPayData(incomingText);

  if (parsed.full && !state.nome_completo) state.nome_completo = parsed.full;
  if (parsed.birth && !state.birthdate) state.birthdate = parsed.birth;
  if (parsed.email && !state.email) state.email = parsed.email;

  const stillMissing = [];
  if (!state.nome_completo) stillMissing.push("nome_completo");
  if (!state.birthdate)     stillMissing.push("nascimento");
  if (!state.email)         stillMissing.push("email");

  if (stillMissing.length === 0) {
    // tudo coletado → SCHEDULE
    state.stage = "SCHEDULE";
    const sug = await getSuggestedDayKeys();
    state.suggested_days = sug;
    return `Anotado, obrigada! ${scheduleReply(state, sug)}`;
  }
  return askPostPayDataPartial(state, stillMissing);
}

async function handleSchedule(state, flags, incomingText, phone) {
  // Já tem date_key? então oferece slots
  if (state.date_key && !state.slot_time) {
    // tenta extrair horário direto
    const choiceNum = extractNumericChoice(incomingText);
    const requestedTime = extractHourOnly(incomingText);
    let chosen = null;

    const best = state.offered_slots?.length ? state.offered_slots : await chooseBestSlotsForDate(state.date_key, 3);
    if (choiceNum && best[choiceNum - 1]) chosen = best[choiceNum - 1];
    else if (requestedTime) {
      const avail = await getAvailableSlotsForDate(state.date_key);
      if (avail.includes(requestedTime)) chosen = requestedTime;
    }

    if (chosen) {
      const hold = await acquireSlotHold(state.date_key, chosen, phone);
      if (!hold.ok) return `Esse horário acabou de ser preenchido 😕 Vou te mostrar outras opções.\n\n` + (await offerSlotsReply(state));
      state.slot_time = chosen;
      state.slot_key = hold.slot_key;
      await releaseOldHeldSlotsForPhone(phone, hold.slot_key);
      // Como pagamento já aconteceu (post_pay), marca slot como pago
      await markSlotPaid(state.slot_key, phone);
      state.stage = "CONFIRMED";

      // Meta CAPI Purchase (caso ainda não tenha sido enviado)
      if (state.payment?.payment_id && state.payment.meta_purchase_sent_for !== String(state.payment.payment_id)) {
        sendMetaPurchaseServerSide({
          paymentId: String(state.payment.payment_id),
          phone, email: state.email, value: state.payment.amount || PLANS.avaliacao.price,
          planKey: state.payment.plan_key || "avaliacao",
        }).then((ok) => {
          if (ok) state.payment.meta_purchase_sent_for = String(state.payment.payment_id);
        }).catch(() => {});
      }
      return confirmedReply(state);
    }
    // não escolheu, mostra slots de novo
    return offerSlotsReply(state);
  }

  // Sem date_key — tenta extrair
  const explicitDate = extractDateKey(incomingText);
  if (explicitDate) {
    const dayCheck = validateDayDateConsistency(incomingText, explicitDate);
    if (!dayCheck.ok) {
      const [dd, mm] = explicitDate.split("-");
      return `Só pra confirmar: ${dd}/${mm} cai numa *${dayCheck.actualDay}*, não ${dayCheck.mentionedDay}. Quer seguir com *${formatDatePt(explicitDate)}*?`;
    }
    const avail = await getAvailableSlotsForDate(explicitDate);
    if (!avail.length) {
      const nearest = await findNearestAvailableDay(explicitDate);
      if (nearest) {
        state.date_key = nearest;
        return `Esse dia não tenho mais vaga. O mais próximo é *${formatDatePt(nearest)}*. Quer ver os horários?`;
      }
      return `Esse dia tá sem vagas. Quer outra data?`;
    }
    state.date_key = explicitDate;
    return offerSlotsReply(state);
  }

  // Escolha numérica entre dias sugeridos
  const sug = state.suggested_days?.length ? state.suggested_days : await getSuggestedDayKeys();
  state.suggested_days = sug;
  const dayChoice = extractNumericChoice(incomingText);
  if (dayChoice && sug[dayChoice - 1]) {
    state.date_key = sug[dayChoice - 1];
    return offerSlotsReply(state);
  }

  // Pediu pra mostrar opções
  return scheduleReply(state, sug);
}

async function handleConfirmed(state, flags, incomingText, phone) {
  // Reconfirma / responde dúvidas pós-agenda
  const low = norm(incomingText);
  if (/\b(remarcar|reagendar|trocar o dia|outro dia)\b/.test(low)) {
    state.date_key = null;
    state.slot_time = null;
    state.stage = "SCHEDULE";
    const sug = await getSuggestedDayKeys();
    state.suggested_days = sug;
    return `Sem problema, vamos remarcar.\n\n${scheduleReply(state, sug)}`;
  }
  if (/\b(cancelar|desmarcar)\b/.test(low)) {
    state.needs_human = true;
    return `Tudo bem. Pra cancelar e ver as opções de reembolso, me confirma e eu chamo o Dr. Alef pra você.`;
  }
  if (flags.asksHowConsultWorks || flags.asksIfOnline) {
    return `É videochamada com o Dr. Alef (WhatsApp ou Google Meet, o que for mais fácil), cerca de *40 minutos*. Ele avalia seu histórico, tira suas dúvidas e, se houver indicação, prescreve o tratamento — a receita digital sai na hora.`;
  }
  // Default
  const ai = await runLia({ incomingText, state, flags, stageCTA: "Consulta já está confirmada. Tire dúvidas e tranquilize." });
  return ai.reply;
}

/* Fluxo pós-pagamento (após webhook MP marcar approved) */
async function handlePaidFlow(state, flags, incomingText, phone) {
  // Faltam dados → pede
  if (!state.nome_completo || !state.birthdate || !state.email) {
    if (state.stage !== "POST_PAY_DATA") {
      state.stage = "POST_PAY_DATA";
      return await finalize(state, phone, incomingText, askPostPayDataReply(state), flags);
    }
    const reply = await handlePostPayData(state, flags, incomingText, phone);
    return await finalize(state, phone, incomingText, reply, flags);
  }
  // Tem dados, falta agendar
  if (!state.date_key || !state.slot_time) {
    if (state.stage !== "SCHEDULE") {
      state.stage = "SCHEDULE";
      const sug = await getSuggestedDayKeys();
      state.suggested_days = sug;
      return await finalize(state, phone, incomingText, scheduleReply(state, sug), flags);
    }
    const reply = await handleSchedule(state, flags, incomingText, phone);
    return await finalize(state, phone, incomingText, reply, flags);
  }
  // Tudo certo
  state.stage = "CONFIRMED";
  const reply = await handleConfirmed(state, flags, incomingText, phone);
  return await finalize(state, phone, incomingText, reply, flags);
}

/* ═══════════════════════════════════════════════════════════════════
   ROUTES
   ═══════════════════════════════════════════════════════════════════ */

app.get("/", (_req, res) => res.send("LIA v30 OK"));
app.get("/mp/thanks", (_req, res) => res.send("OK"));

// Checkout curto → redirect para LP com ?ref=
app.get("/checkout/:ref", async (req, res) => {
  try {
    const { ref } = req.params;
    const data = await getCheckoutRef(ref);
    if (!data) {
      console.warn(`[CHECKOUT] ref não encontrado: ${ref}`);
      return res.redirect(`${SITE_URL}/checkout-consulta/`);
    }
    return res.redirect(302, `${SITE_URL}/checkout-consulta/?ref=${ref}`);
  } catch (err) {
    console.error("[CHECKOUT] erro:", err);
    return res.redirect(`${SITE_URL}/checkout-consulta/`);
  }
});

const CORS_ORIGIN = SITE_URL || "https://www.dralefkotula.com";
app.options("/checkout-data/:ref", (_req, res) => {
  res.set("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age", "86400");
  return res.sendStatus(204);
});
app.get("/checkout-data/:ref", async (req, res) => {
  res.set("Access-Control-Allow-Origin", CORS_ORIGIN);
  try {
    const { ref } = req.params;
    const data = await getCheckoutRef(ref);
    if (!data) return res.status(404).json({ ok: false, error: "checkout_not_found" });
    const { phone, ...safe } = data;
    return res.json({ ok: true, ref, ...safe });
  } catch (err) {
    console.error("[CHECKOUT-DATA] erro:", err);
    return res.status(500).json({ ok: false, error: "erro interno" });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ENDPOINT PRINCIPAL — POST /lia/respond
   ═══════════════════════════════════════════════════════════════════ */

app.post("/lia/respond", async (req, res) => {
  try {
    const { phoneRaw, messageRaw, fromMe, incomingMsgType, contactName } = extractInboundEnvelope(req.body || {});

    if (!phoneRaw || !messageRaw) {
      return res.status(400).json({ ok: false, error: "campos 'telefone' e 'mensagem' são obrigatórios", skip_send: true });
    }
    const phone = String(phoneRaw).replace(/\D/g, "");
    if (!phone || phone.length < 10) {
      return res.status(400).json({ ok: false, error: "telefone inválido", skip_send: true });
    }
    const incomingText = String(messageRaw).trim();
    const cmdNorm = incomingText.toLowerCase().trim();

    /* ── COMANDOS ADMIN (antes do debounce) ─────────────────── */
    if (cmdNorm === "deixa.eu.pensar") {
      const st = await getUserState(phone);
      st.lia_paused = true;
      st.lia_paused_at = new Date().toISOString();
      await saveUserState(phone, st);
      return res.json({ ok: true, reply: "⏸️ LIA pausada para este lead. Para reativar: Eu.voltei", skip_send: false, delay_ms: 0, admin_command: "pause" });
    }
    if (cmdNorm === "eu.voltei") {
      const st = await getUserState(phone);
      st.lia_paused = false;
      delete st.lia_paused_at;
      await saveUserState(phone, st);
      return res.json({ ok: true, reply: "▶️ LIA reativada para este lead.", skip_send: false, delay_ms: 0, admin_command: "resume" });
    }
    if (cmdNorm === "status.lia") {
      const st = await getUserState(phone);
      const paused = st.lia_paused === true;
      return res.json({
        ok: true,
        reply: paused
          ? `⏸️ LIA PAUSADA neste lead. Stage: ${st.stage || "nenhum"} | Nome: ${st.nome || "—"}`
          : `▶️ LIA ATIVA neste lead. Stage: ${st.stage || "nenhum"} | Nome: ${st.nome || "—"}`,
        skip_send: false, delay_ms: 0, admin_command: "status",
      });
    }
    if (cmdNorm === "linklinklink") {
      try {
        const st = await getUserState(phone);
        const pref = await mpCreatePreference({ phone, planKey: "avaliacao" });
        const checkout = await buildSiteCheckoutLink({ paymentLink: pref.link, phone, planKey: "avaliacao", externalReference: pref.external_reference, state: st });
        st.payment = {
          status: "pending", plan_key: "avaliacao",
          preference_id: pref.preference_id, link: checkout.url, public_url: checkout.public_url, mp_link: pref.link,
          checkout_ref: checkout.ref, external_reference: pref.external_reference,
          created_at: Date.now(), method: "link",
        };
        st.stage = "PAY_WAIT";
        await saveUserState(phone, st);
        return res.json({ ok: true, reply: `Pra confirmar a consulta, toque no link do site oficial (www.dralefkotula.com):\n\n${checkout.public_url}`, skip_send: false, delay_ms: 1000 });
      } catch (err) { return res.json({ ok: true, reply: `Erro ao gerar link: ${err.message}`, skip_send: false, delay_ms: 500 }); }
    }
    if (cmdNorm === "." || cmdNorm === "..") {
      const st = await getUserState(phone);
      if (st.form_data?.nome_completo && !st.nome) {
        const fn = extractFormFirstName(st.form_data.nome_completo);
        if (fn) st.nome = fn;
      }
      st.stage = "GREET";
      st.dot_triggered = true;
      st.lia_paused = false;
      st.dot_cooldown_until = Date.now() + 45000;
      await saveUserState(phone, st);
      const intro = st.nome
        ? `Oi, ${st.nome}! Aqui é a Lia, da equipe do Dr. Alef. Em que posso te ajudar?`
        : `Oi! Aqui é a Lia, da equipe do Dr. Alef Kotula. Me diz seu primeiro nome e o que te trouxe aqui.`;
      return res.json({ ok: true, reply: intro, skip_send: false, delay_ms: randInt(3000, 6000) });
    }

    // Mensagem do admin (fromMe) que não é comando → ignorar
    if (fromMe) {
      return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0 });
    }

    // Pausa
    const quickState = await getUserState(phone);
    if (quickState.lia_paused === true) {
      logMessage(phone, "lia", incomingText, "inbound");
      return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0, paused: true });
    }
    // Cooldown pós-dot
    if (quickState.dot_cooldown_until && Date.now() < quickState.dot_cooldown_until) {
      quickState.dot_cooldown_until = null;
      await saveUserState(phone, quickState);
      logMessage(phone, "lia", incomingText, "inbound");
      return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0, dot_cooldown: true });
    }
    if (quickState.dot_cooldown_until && Date.now() >= quickState.dot_cooldown_until) {
      quickState.dot_cooldown_until = null;
      await saveUserState(phone, quickState);
    }

    // ÁUDIO (detecta antes do isSystemMessage pq o placeholder "[audio]" seria filtrado)
    const isAudioMsg =
      /^(audio|ptt|voice|audiomessage|pttmessage|voicemessage|audio\/ogg|audio\/opus|audio\/mpeg|audio\/mp4)$/.test(incomingMsgType || "")
      || /^(\[?(audio|áudio|voice|voz|ptt)\]?\s*\.?\s*)$/i.test(incomingText || "");
    if (isAudioMsg) {
      const now = Date.now();
      const lastAudio = _lastAudioReplyAt.get(phone) || 0;
      if (now - lastAudio < AUDIO_COOLDOWN_MS) return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0 });
      _lastAudioReplyAt.set(phone, now);
      return res.json({
        ok: true,
        reply: "Recebi seu áudio, mas no momento eu não consigo escutar áudio aqui. Pode me *escrever por texto* o que você quer me dizer? Assim eu continuo te atendendo direitinho.",
        skip_send: false, delay_ms: 2000,
      });
    }

    // IMAGEM / VÍDEO / DOCUMENTO / STICKER / LOCALIZAÇÃO / CONTATO
    const mediaKind = (() => {
      const t = String(incomingMsgType || "").toLowerCase();
      const raw = String(incomingText || "").toLowerCase().trim();
      if (/^(image|imagem|foto|photo|picture|imagemessage)/.test(t) || /^\[?(imagem|foto|image|picture)\]?\s*\.?\s*$/.test(raw)) return "imagem";
      if (/^(video|vídeo|videomessage|movie|video\/mp4)/.test(t) || /^\[?(video|vídeo)\]?\s*\.?\s*$/.test(raw)) return "vídeo";
      if (/^(document|documento|documentmessage|pdf|application\/)/.test(t) || /^\[?(documento|document|pdf|arquivo)\]?\s*\.?\s*$/.test(raw)) return "documento";
      if (/^(sticker|figurinha|stickermessage)/.test(t) || /^\[?(sticker|figurinha)\]?\s*\.?\s*$/.test(raw)) return "figurinha";
      if (/^(location|localiza[cç][aã]o|locationmessage)/.test(t) || /^\[?(localiza[cç][aã]o|location)\]?\s*\.?\s*$/.test(raw)) return "localização";
      if (/^(contact|contato|contactmessage|vcard)/.test(t) || /^\[?(contato|contact)\]?\s*\.?\s*$/.test(raw)) return "contato";
      if (/^(gif|gifmessage)/.test(t) || /^\[?(gif)\]?\s*\.?\s*$/.test(raw)) return "gif";
      return null;
    })();
    if (mediaKind) {
      const now = Date.now();
      const lastMedia = _lastMediaReplyAt.get(phone) || 0;
      if (now - lastMedia < MEDIA_COOLDOWN_MS) return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0 });
      _lastMediaReplyAt.set(phone, now);
      const reply = (mediaKind === "imagem" || mediaKind === "foto")
        ? "Recebi sua *imagem*, mas no momento eu não consigo abrir imagens aqui. Pode me *descrever em texto* o que você queria me mostrar? Assim eu continuo te ajudando."
        : mediaKind === "vídeo"
          ? "Recebi seu *vídeo*, mas no momento eu não consigo abrir vídeos aqui. Pode me *escrever em texto* o que está acontecendo? Assim eu te oriento direito."
          : mediaKind === "documento"
            ? "Recebi seu *documento*, mas aqui eu não consigo abrir arquivos. Se for algo importante, pode me *resumir por texto* que eu continuo te atendendo."
            : mediaKind === "figurinha" || mediaKind === "gif"
              ? `Recebi sua ${mediaKind}! Pode me escrever por texto o que você quer saber?`
              : mediaKind === "localização"
                ? "Recebi sua localização, obrigada. Mas pra te atender me escreve por texto o que você precisa."
                : "Recebi seu contato, obrigada. Pode me escrever por texto o que você precisa que eu continuo te ajudando.";
      return res.json({ ok: true, reply, skip_send: false, delay_ms: 2000 });
    }

    // Filtro de mensagem de sistema (APÓS detecção de mídia real)
    if (!incomingText || isSystemMessage(incomingText)) {
      return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0 });
    }

    // DEBOUNCE
    if (!_inboundBuffer.has(phone)) _inboundBuffer.set(phone, { messages: [], seq: 0 });
    const buf = _inboundBuffer.get(phone);
    buf.seq += 1;
    const mySeq = buf.seq;
    buf.messages.push({ text: incomingText, ts: Date.now() });

    await sleep(DEBOUNCE_WINDOW_MS);

    const bufAfter = _inboundBuffer.get(phone);
    if (!bufAfter || bufAfter.seq !== mySeq) {
      return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0 });
    }

    const recheckState = await getUserState(phone);
    if (recheckState.lia_paused === true) {
      _inboundBuffer.delete(phone);
      const allTxt = bufAfter.messages.map((m) => m.text).join(" ");
      logMessage(phone, "lia", allTxt, "inbound");
      return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0, paused: true });
    }

    const allMessages = bufAfter.messages.map((m) => m.text);
    const consolidatedText = allMessages.length > 1 ? allMessages.join(" ") : allMessages[0];
    const wasConsolidated = allMessages.length > 1;
    _inboundBuffer.delete(phone);

    const result = await processLiaMessage(phone, consolidatedText, { contactName });

    if (result.filtered) return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0 });
    if (result.deduplicated) return res.json({ ok: true, reply: "", skip_send: true, deduplicated: true, delay_ms: 0 });
    if (result.skip_send) return res.json({ ok: true, reply: "", skip_send: true, delay_ms: 0 });

    _dedupStore(phone, consolidatedText, result.reply);

    const replyLen = (result.reply || "").length;
    let delay_ms;
    if (replyLen < 80) delay_ms = randInt(8000, 14000);
    else if (replyLen < 250) delay_ms = randInt(12000, 20000);
    else delay_ms = randInt(18000, 30000);
    delay_ms = Math.max(delay_ms, 8000);

    const lastReplyAt = _lastBotReplyAt.get(phone) || 0;
    const plannedSendAt = Date.now() + delay_ms;
    if (lastReplyAt > 0 && plannedSendAt - lastReplyAt < MIN_BOT_GAP_MS) {
      delay_ms += MIN_BOT_GAP_MS - (plannedSendAt - lastReplyAt);
    }
    _lastBotReplyAt.set(phone, Date.now() + delay_ms);

    return res.json({
      ok: true,
      reply: sanitizeReply(result.reply),
      followup: result.followup ? sanitizeReply(result.followup) : null,
      stage: result.state?.stage || null,
      intent: detectMainIntent(result.flags) || null,
      action: null,
      needs_payment: ["PAY_WAIT"].includes(result.state?.stage),
      needs_human: !!(result.state?.needs_human || result.state?.emotional_risk_flagged),
      payment_link: result.state?.payment?.link || null,
      delay_ms,
      skip_send: false,
      debug: {
        lead_profile: result.state?.lead_profile || null,
        condition: result.state?.condition || null,
        nome: result.state?.nome || null,
        form_qualified: !!result.state?.form_qualified,
        consolidated_messages: wasConsolidated ? allMessages.length : 1,
      },
    });
  } catch (err) {
    console.error("❌ /lia/respond:", err);
    return res.status(500).json({
      ok: false, error: "erro interno",
      reply: "Desculpa, tive um problema técnico aqui. Pode me mandar de novo?",
      skip_send: false,
    });
  }
});

function detectMainIntent(flags) {
  if (!flags) return null;
  if (flags.urgency) return "URGENCIA";
  if (flags.emotionalRisk) return "RISCO_EMOCIONAL";
  if (flags.asksIsScam || flags.asksWho) return "ANTI_GOLPE";
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
   WEBHOOK MERCADO PAGO
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
      state.payment.plan_key = payment?.metadata?.plan_key || state.payment.plan_key || "avaliacao";

      if (status === "approved") {
        if (!state.nome_completo || !state.birthdate || !state.email) {
          state.stage = "POST_PAY_DATA";
        } else if (!state.date_key || !state.slot_time) {
          state.stage = "SCHEDULE";
        } else {
          state.stage = "CONFIRMED";
          if (state.slot_key) await markSlotPaid(state.slot_key, phone);
        }
      }
      await saveUserState(phone, state);

      if (status === "approved") {
        console.log(`[MP_WEBHOOK v30] approved payment_id=${paymentId} phone=${phone}`);
        if (state.payment?.meta_purchase_sent_for !== String(paymentId)) {
          sendMetaPurchaseServerSide({
            paymentId: String(paymentId), phone, email: state.email || null,
            value: payment.transaction_amount || null,
            planKey: state.payment.plan_key || "avaliacao",
          }).then(async (ok) => {
            if (ok) {
              try {
                const fresh = await getUserState(phone);
                fresh.payment = fresh.payment || {};
                fresh.payment.meta_purchase_sent_for = String(paymentId);
                fresh.payment.meta_purchase_sent_at = Date.now();
                await saveUserState(phone, fresh);
              } catch (e) { console.error("❌ Meta CAPI save state:", e.message); }
            }
          }).catch(() => {});
        }
        // Se Twilio direto, manda mensagem inicial pós-pagamento
        if (twilioClient) {
          const botFrom = state?.last_bot_from || null;
          if (botFrom && !botFrom.startsWith("api:")) {
            try {
              await twilioClient.messages.create({
                to: `whatsapp:${phone}`, from: botFrom,
                body: askPostPayDataReply(state),
              });
            } catch {}
          }
        }
      }
    }
  } catch (err) { console.error("❌ MP webhook erro:", err); }
});

/* ═══════════════════════════════════════════════════════════════════
   ENVIO MANUAL + ADMIN + CRON FOLLOWUPS
   ═══════════════════════════════════════════════════════════════════ */

app.post("/send-manual", async (req, res) => {
  const { to, message, secret } = req.body || {};
  if (!MANUAL_SEND_SECRET) return res.status(500).json({ ok: false, error: "MANUAL_SEND_SECRET não configurado" });
  if (secret !== MANUAL_SEND_SECRET) return res.status(401).json({ ok: false, error: "secret inválido" });
  if (!to || !message) return res.status(400).json({ ok: false, error: "campos 'to' e 'message' são obrigatórios" });
  if (!twilioClient) return res.status(500).json({ ok: false, error: "Twilio não configurado" });
  let phone = String(to).replace(/\D/g, "");
  if (!phone || phone.length < 10) return res.status(400).json({ ok: false, error: "número inválido" });
  const fromNumber = TWILIO_WHATSAPP_NUMBER || "";
  if (!fromNumber) return res.status(500).json({ ok: false, error: "TWILIO_WHATSAPP_NUMBER não configurado" });
  const fromW = fromNumber.startsWith("whatsapp:") ? fromNumber : `whatsapp:${fromNumber}`;
  try {
    const sent = await twilioClient.messages.create({ to: `whatsapp:+${phone}`, from: fromW, body: message });
    logMessage(fromW, `whatsapp:+${phone}`, message, "outbound_manual");
    return res.json({ ok: true, sid: sent.sid });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

function adminAuth(req, res) {
  const secret = req.query.secret || req.headers["x-admin-secret"];
  if (!ADMIN_READ_SECRET) { res.status(500).json({ ok: false, error: "ADMIN_READ_SECRET não configurado" }); return false; }
  if (secret !== ADMIN_READ_SECRET) { res.status(401).json({ ok: false, error: "secret inválido" }); return false; }
  return true;
}
app.get("/admin/messages", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try {
    const { rows } = await pool.query(`SELECT id, from_number, to_number, body, direction, created_at FROM messages ORDER BY created_at DESC LIMIT 200`);
    return res.json({ ok: true, count: rows.length, messages: rows });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});
app.get("/admin/state/:phone", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try {
    const phone = String(req.params.phone).replace(/\D/g, "");
    const st = await getUserState(phone);
    return res.json({ ok: true, phone, state: st });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});
app.get("/admin/metrics", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try {
    const { rows } = await pool.query(`SELECT state FROM wa_users WHERE updated_at > NOW() - INTERVAL '7 days'`);
    const m = { total: rows.length, by_stage: {}, qualified: 0, paid: 0, confirmed: 0 };
    for (const r of rows) {
      const s = r.state || {};
      m.by_stage[s.stage || "—"] = (m.by_stage[s.stage || "—"] || 0) + 1;
      if (s.form_qualified) m.qualified++;
      if (s.payment?.status === "approved") m.paid++;
      if (s.stage === "CONFIRMED") m.confirmed++;
    }
    return res.json({ ok: true, window: "7d", ...m });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

async function sendFollowupMessage(phone, message, state) {
  if (twilioClient) {
    const botFrom = state?.last_bot_from || TWILIO_WHATSAPP_NUMBER || "";
    if (botFrom && !botFrom.startsWith("api:")) {
      try {
        const from = botFrom.startsWith("whatsapp:") ? botFrom : `whatsapp:${botFrom}`;
        const to = phone.startsWith("whatsapp:") ? phone : `whatsapp:+${phone}`;
        await twilioClient.messages.create({ to, from, body: message });
        await logMessage(from, to, message, "outbound_followup");
        return true;
      } catch (err) { console.error("❌ Follow-up Twilio:", err.message); }
    }
  }
  return false;
}

/* V30.3 — Followup quando o compromisso do lead chega (ex: "quarto dia útil",
   "quando cair o salário", "semana que vem"). Usa state.commitment pra mandar
   mensagem contextualizada que referencia a razão que ele mesmo deu. */
function buildCommitmentFollowup(state) {
  const nome = state.nome ? `, ${state.nome}` : "";
  const c = state.commitment || {};
  const kind = c.timeRef?.kind || "later";

  if (c.type === "financial") {
    if (kind === "business_days") return `Oi${nome}. Hoje é o dia que combinamos — o ${c.timeRef.value}º dia útil chegou. Quer que eu te mande o link da consulta pra a gente fechar?`;
    if (kind === "salary")        return `Oi${nome}. Passei pra lembrar — quando você me escreveu, falou que ia dar conta quando o salário caísse. Se já caiu, posso te mandar o link da consulta.`;
    if (kind === "benefit")       return `Oi${nome}. Lembrei de te chamar — você tinha combinado de retomar quando o benefício caísse. Já entrou? Posso te mandar o link.`;
    if (kind === "fortnight")     return `Oi${nome}. Chegamos na quinzena que você tinha falado. Quer que eu te mande o link pra agendar?`;
    if (kind === "next_month")    return `Oi${nome}. Virou o mês — você tinha me pedido pra voltar nessa data. Quer seguir com a consulta?`;
    return `Oi${nome}. Tô voltando aqui conforme você me pediu. Quer que eu te mande o link da consulta?`;
  }

  if (c.type === "dated") {
    if (kind === "month_day")  return `Oi${nome}. Chegou o dia ${c.timeRef.value} — quando você me escreveu, falou que ia retomar a partir dessa data. Quer que eu te mande o link?`;
    if (kind === "nextweek")   return `Oi${nome}. Voltando aqui, como você tinha pedido na semana passada. Quer seguir com a consulta?`;
    return `Oi${nome}. Tô voltando como combinado. Quer que eu te mande o link da consulta pra a gente fechar?`;
  }

  if (c.type === "event") {
    if (kind === "holiday") return `Oi${nome}. Feriado passou — quer que a gente retome a consulta?`;
    return `Oi${nome}. Tô voltando aqui — espero que aquele compromisso já tenha sido resolvido. Quer seguir com a consulta?`;
  }

  if (c.type === "decisional") {
    if (kind === "consult_family") return `Oi${nome}. Só passando pra saber — conseguiu conversar em casa sobre a consulta? Qualquer dúvida que ficou, pode me mandar.`;
    return `Oi${nome}. Lembrei de você. Conseguiu pensar com calma? Se quiser seguir ou se ficou alguma dúvida, tô aqui.`;
  }

  return `Oi${nome}. Só passando pra saber se você ainda quer retomar a conversa sobre a consulta.`;
}

/* Gera mensagem de re-engajamento 2h pra lead que parou de responder ANTES de pagar.
   Varia pelo track da campanha e aperta a dor suavemente. */
function buildPrePay2hFollowup(state) {
  const nome = state.nome ? `, ${state.nome}` : "";
  const track = state.form_track || "";
  const options = [];

  if (track === "r3_primeira_vez") {
    options.push(
      `Oi${nome}. Me sumi aqui? Só queria te perguntar uma coisa: o que tá te fazendo adiar — é desconfiança, preço ou outra coisa? Fala a verdade que eu te ajudo.`,
      `Oi${nome}, tô voltando porque fiquei pensando no que você me contou. Até quando você pretende viver com essa dor? Só você pode decidir mudar isso.`,
    );
  } else if (track === "r3_parou") {
    options.push(
      `Oi${nome}. Você já parou uma vez por causa do preço — não deixa isso te impedir de voltar. O óleo de associação do Dr. Alef é mais de 50% mais barato que o que você pagava antes.`,
      `Oi${nome}. Só passando pra lembrar: não precisa gastar o que você gastava antes. O Dr. trabalha com óleo de associação justamente pra caber no bolso.`,
    );
  } else if (track === "r3_revisao") {
    options.push(
      `Oi${nome}. Fiquei pensando aqui no que você tá gastando todo mês com o óleo. Com óleo de associação costuma cair pela metade — vale a consulta só pela economia.`,
      `Oi${nome}, tô voltando aqui. Você já investe muito no tratamento todo mês — uma revisão do Dr. pode economizar bastante. Quer que eu te mande o link?`,
    );
  } else {
    options.push(
      `Oi${nome}. Só passando pra saber — consegue falar agora ou prefere mais tarde?`,
      `Oi${nome}, tô por aqui. Qualquer dúvida que tiver sobre a consulta, me chama.`,
    );
  }
  return pickRandom(options);
}

app.get("/cron/followups", async (_req, res) => {
  try {
    const now = Date.now();
    const TWO_H = 2*3600*1000, TWENTY_FOUR_H = 24*3600*1000, SEVENTY_TWO_H = 72*3600*1000;
    let sent = 0;

    /* ── TRILHA 1: Leads PRE-PAY (GREET / CONNECT / OFFER) que ficaram silenciosos ── */
    const prePay = await pool.query(
      `SELECT phone, state FROM wa_users
       WHERE state->>'stage' IN ('GREET','CONNECT','OFFER')
       AND (state->'payment'->>'status' IS NULL OR state->'payment'->>'status' NOT IN ('approved'))
       AND state->>'pre_pay_2h_sent' IS NULL`
    );
    for (const row of prePay.rows) {
      const state = row.state || {};
      const phone = row.phone;
      const lastSent = state.last_sent_at || 0;
      if (!lastSent) continue;
      const elapsed = now - lastSent;
      // Só dispara se passou 2h SEM o lead responder (last_user_message_at seria ideal; usamos last_sent_at como proxy)
      if (elapsed < TWO_H) continue;
      // Evita enviar de madrugada (22h–8h horário Brasília)
      const hour = new Date().getUTCHours() - 3; // BR = UTC-3
      const brHour = (hour + 24) % 24;
      if (brHour >= 22 || brHour < 8) continue;
      const msg = buildPrePay2hFollowup(state);
      const ok = await sendFollowupMessage(phone, msg, state);
      state.pre_pay_2h_sent = true;
      state.pre_pay_2h_at = now;
      await saveUserState(phone, state);
      if (ok) sent++;
    }

    /* ── TRILHA 2: Leads PAY_WAIT (pendente de pagamento) — followup clássico ── */
    const { rows } = await pool.query(
      `SELECT phone, state FROM wa_users
       WHERE state->>'stage' IN ('PAY_WAIT')
       AND state->'payment'->>'status' IN ('pending', 'pending_pix')`
    );
    for (const row of rows) {
      const state = row.state || {};
      const phone = row.phone;
      const created = state.payment?.created_at || 0;
      if (!created || state.followup_complete) continue;
      const elapsed = now - created;
      const nome = state.nome ? `, ${state.nome}` : "";
      const link = state.payment?.public_url || state.payment?.link || "";
      let message = null, flagKey = null;

      if (elapsed >= SEVENTY_TWO_H && !state.followup_3_sent) {
        message = `Oi${nome}. Só passando pra dizer que o link continua disponível: ${link}\n\nDesejo melhoras de verdade.`;
        flagKey = "followup_3_sent"; state.followup_complete = true;
      } else if (elapsed >= TWENTY_FOUR_H && !state.followup_2_sent) {
        message = `Oi${nome}, tudo bem? Se tiver qualquer dúvida sobre a consulta, tô aqui. O link continua ativo: ${link}`;
        flagKey = "followup_2_sent";
      } else if (elapsed >= TWO_H && !state.followup_1_sent) {
        message = `Oi${nome}. Vi que o link ficou pendente. Se travou algo no pagamento ou quiser outra forma, me chama aqui que eu te ajudo.\n\n${link}`;
        flagKey = "followup_1_sent";
      }
      if (message && flagKey) {
        const ok = await sendFollowupMessage(phone, message, state);
        state[flagKey] = true;
        state[flagKey.replace("_sent", "_at")] = now;
        await saveUserState(phone, state);
        if (ok) sent++;
      }
    }
    /* ── TRILHA 3: Leads com commitment (postponement) — dispara no dia que o lead combinou ── */
    const committed = await pool.query(
      `SELECT phone, state FROM wa_users
       WHERE state->'commitment' IS NOT NULL
       AND (state->>'commitment_followup_sent' IS NULL)
       AND (state->'payment'->>'status' IS NULL OR state->'payment'->>'status' NOT IN ('approved'))`
    );
    for (const row of committed.rows) {
      const state = row.state || {};
      const phone = row.phone;
      const c = state.commitment;
      if (!c?.estimated_at) continue;
      if (now < c.estimated_at) continue;
      // Janela diurna BR
      const brHour = ((new Date().getUTCHours() - 3) + 24) % 24;
      if (brHour >= 21 || brHour < 9) continue;
      const msg = buildCommitmentFollowup(state);
      const ok = await sendFollowupMessage(phone, msg, state);
      state.commitment_followup_sent = true;
      state.commitment_followup_at = now;
      await saveUserState(phone, state);
      if (ok) sent++;
    }

    return res.json({ ok: true, processed_prepay: prePay.rows.length, processed_paywait: rows.length, processed_commitment: committed.rows.length, sent });
  } catch (err) {
    console.error("❌ /cron/followups:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════════ */

const PORT = process.env.PORT || 11000;
app.listen(PORT, () => console.log(`🚀 LIA V30 (closer / dor neuropática) rodando na porta ${PORT}`));
