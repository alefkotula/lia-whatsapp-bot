/**
 * ═══════════════════════════════════════════════════════════════════
 * INDEX V17 — OPUS COM FECHAMENTO OPERACIONAL
 * ═══════════════════════════════════════════════════════════════════
 *
 * MUDANÇAS FUNDAMENTAIS vs V13:
 *
 * 1. QUESTION PRIORITY ENGINE — toda pergunta direta é respondida
 *    ANTES de qualquer lógica de stage. Nunca mais ignora o paciente./**
 * ═══════════════════════════════════════════════════════════════════
 * INDEX V17 — OPUS COM FECHAMENTO OPERACIONAL
 * ═══════════════════════════════════════════════════════════════════
 *
 * MUDANÇAS FUNDAMENTAIS vs V13:
 *
 * 1. QUESTION PRIORITY ENGINE — toda pergunta direta é respondida
 *    ANTES de qualquer lógica de stage. Nunca mais ignora o paciente.
 *
 * 2. FUNIL ABERTO NO FECHAMENTO — perguntas durante agendamento/
 *    pagamento são respondidas + CTA do stage na mesma mensagem.
 *
 * 3. TRIAGEM ADAPTATIVA — 0 a 3 perguntas, pula o que o paciente
 *    já contou. Nunca mais formulário rígido.
 *
 * 4. PERSUASÃO COM ESPERANÇA — testimony da secretária que vê
 *    resultados todos os dias. Dados confirmam, não lideram.
 *
 * 5. LEAD CLASSIFIER — detecta perfil (quente, pragmático,
 *    desconfiado, cético, comparador, frio, emocional) e adapta rota.
 *
 * 6. FOLLOW-UP — 3 tentativas de reengajamento para leads silenciosos.
 *
 * 7. EXTRAÇÃO DE NOME CORRIGIDA — nunca mais chama de "Pode".
 *
 * 8. RECONHECIMENTO ROBUSTO DE PLANO — matching flexível.
 *
 * 9. SYSTEM PROMPT COM CONVICÇÃO — GPT age como secretária que
 *    acredita no tratamento porque vê resultado real.
 *
 * 10. EVIDENCE DATABASE EXPANDIDA — empatia + testimony + study +
 *     hope + bridge + future por condição.
 *
 * PRESERVADO DA V13:
 * - Express/Twilio/Postgres/MercadoPago setup
 * - Slot lock/hold system
 * - PLANS e FIXED_SCHEDULE
 * - Funções utilitárias (sleep, randInt, pad2, etc.)
 * - Funções de agenda (getAvailableSlots, chooseBestSlots, etc.)
 * - Webhook MP e payment flow
 * - Human delay system
 *
 * ═══════════════════════════════════════════════════════════════════
 */

const IS_SIMULATOR_MODE = process.env.LIA_SIMULATOR_MODE === "1";

function createNoopApp() {
  return {
    use() {},
    get() {},
    post() {},
    listen() {},
  };
}

let express;
let bodyParser;
let twilio;
let Pool;
let OpenAI;
let app;

if (IS_SIMULATOR_MODE) {
  express = Object.assign(() => createNoopApp(), {
    json: () => (_req, _res, next) => (typeof next === "function" ? next() : undefined),
  });
  bodyParser = {
    urlencoded: () => (_req, _res, next) => (typeof next === "function" ? next() : undefined),
  };
  twilio = Object.assign(
    () => ({
      messages: { create: async () => ({ sid: "simulated" }) },
    }),
    {
      twiml: {
        MessagingResponse: class MessagingResponse {
          toString() {
            return "";
          }
        },
      },
    },
  );
  Pool = class PoolStub {
    on() {}
    async query() {
      return { rows: [] };
    }
  };
  OpenAI = class OpenAIStub {
    constructor() {
      this.chat = {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "" } }],
          }),
        },
      };
    }
  };
  app = createNoopApp();
} else {
  express = require("express");
  bodyParser = require("body-parser");
  twilio = require("twilio");
  ({ Pool } = require("pg"));
  OpenAI = require("openai");

  app = express();
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(express.json());
  app.use("/mp", express.json({ type: ["application/json", "text/json", "*/*"] }));
}

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

/* ═══════════════════════════════════════════════════════════════════
   PLANS + SCHEDULE (preservado da V13)
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

// ▸ COMENTÁRIO ESTRATÉGICO: Adicionei "description" a cada plano para que a LIA
//   possa explicar o que inclui sem precisar de texto hardcoded. Resolve o erro
//   do paciente 1 (Ana) que perguntou "o que inclui?" e não recebeu resposta.

const FIXED_SCHEDULE = {
  "11-03": { dayName: "quarta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "12-03": { dayName: "quinta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "13-03": { dayName: "sexta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
};

const PREMIUM_SLOT_PRIORITY = ["19h","18h","20h","17h","21h","16h","15h","14h","13h","12h","11h","10h","9h"];
const WEEKDAY_PT = ["domingo","segunda-feira","terça-feira","quarta-feira","quinta-feira","sexta-feira","sábado"];

/* ═══════════════════════════════════════════════════════════════════
   DATABASE (preservado da V13)
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
  console.log("✅ Tabelas prontas.");
}
if (!IS_SIMULATOR_MODE) {
  initDB().catch((e) => console.error("❌ initDB erro:", e));
}

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
   UTILITÁRIOS (preservado da V13)
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
  // ▸ V14: reduzi de 1100 para 900 para forçar mensagens menores no WhatsApp
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
   DATE/SCHEDULE UTILS (preservado da V13)
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
   EXTRACTORS — REESCRITOS PARA V14
   ═══════════════════════════════════════════════════════════════════ */

/**
 * ▸ MUDANÇA CRÍTICA: extractFirstName agora parseia corretamente:
 *   - "Pode me chamar de Carlos" → Carlos
 *   - "Me chama de Ana" → Ana
 *   - "Sou o Ricardo" → Ricardo
 *   - "É Juliana" → Juliana
 *   - "Paulo aqui" → Paulo
 *   - "Ana" → Ana
 *   Isso resolve o bug #1 que apareceu em 8 de 9 pacientes simulados.
 */
function extractFirstName(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const low = norm(t);

  // Rejeitar se for apenas confirmação/problema sem nome
  if (/^(sim|ok|beleza|pode|claro|show|tanto faz|nao|não)$/.test(low)) return null;
  if (/^(dor|sono|ansiedade|fibromialgia|insônia|insonia|artrose|artrite|coluna)$/.test(low)) return null;

  // Se a mensagem parece pergunta ou frase longa, não é nome
  if ((t.includes("?") || low.split(" ").length > 6)) return null;
  if (/\b(quanto|como|qual|onde|quando|porque|por que|isso|esse|essa|vocês|voces)\b/.test(low)) return null;

  // Padrões de introdução de nome — ORDEM IMPORTA
  const patterns = [
    /(?:pode\s+(?:me\s+)?chamar?\s+(?:de\s+)?)\s*(.+)/i,
    /(?:me\s+cham(?:a|o|e)\s+(?:de\s+)?)\s*(.+)/i,
    /(?:(?:eu\s+)?sou\s+(?:o|a)\s+)\s*(.+)/i,           // "sou o Carlos" (exige artigo)
    /(?:(?:meu\s+)?nome\s+(?:e|é)\s+)\s*(.+)/i,
    /^(.+?)(?:\s+aqui)$/i,                                // "Paulo aqui" (exige início de frase)
  ];

  let candidate = null;
  for (const p of patterns) {
    const m = t.match(p);
    if (m && m[1]) {
      candidate = m[1].trim();
      break;
    }
  }

  // Se nenhum padrão casou, usar texto inteiro como candidato
  if (!candidate) candidate = t;

  // Limpar pontuação
  candidate = candidate.replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!candidate) return null;

  const parts = candidate.split(" ").filter(Boolean);
  if (parts.length < 1 || parts.length > 5) return null;
  if (/^\d+$/.test(candidate)) return null;

  // Rejeitar se parecer nome de condição médica
  const condWords = /^(dor|sono|ansiedade|fibromialgia|artrose|artrite|enxaqueca|coluna|insônia|insonia|lombar|neuropat)/i;
  if (condWords.test(parts[0]) && parts.length <= 2) return null;

  // Rejeitar palavras comuns que não são nomes
  const notNames = /^(oi|ola|olá|bom|boa|dia|tarde|noite|tudo|bem|obrigad|brigad|quero|preciso|gostaria|tenho|sim|nao|não|legal|caro|certo|entendi|entendo|sera|será|claro|ok|verdade|seria|acho|pode|pois|tipo|vou|vai|meu|minha)$/i;
  if (notNames.test(parts[0])) return null;

  // Retornar primeiro nome capitalizado
  return parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
}

function extractFullName(text) {
  const cleaned = (text || "").replace(/[^\p{L}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length < 2) return null;
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
  // ▸ V14 FIX: Derivar meses válidos do FIXED_SCHEDULE (em vez de hardcode mês 3)
  const validMonths = new Set(Object.keys(FIXED_SCHEDULE).map(k => Number(k.split("-")[1])));
  const m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})\b/);
  if (m) {
    const dd = Number(m[1]), mm = Number(m[2]);
    if (dd >= 1 && dd <= 31 && validMonths.has(mm)) return makeDateKey(dd, mm);
  }
  // ▸ V14 FIX: Gerar mapeamento de dia da semana dinâmico do FIXED_SCHEDULE
  const dayNameMap = {};
  for (const [key, val] of Object.entries(FIXED_SCHEDULE)) {
    const dayNorm = norm(val.dayName);
    dayNameMap[dayNorm] = key;
  }
  const low = norm(t);
  for (const [dayNorm, dateKey] of Object.entries(dayNameMap)) {
    if (low.includes(dayNorm)) return dateKey;
  }
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

/**
 * ▸ MUDANÇA CRÍTICA: extractPlanChoice agora usa matching flexível.
 *   "acho que a opção 2 faz mais sentido pra mim" → basic (antes falhava)
 *   "prefiro a avaliação" → basic
 *   "quero o acompanhamento" → full
 *   Resolve o bug do paciente 2 (Carlos) onde a escolha não foi reconhecida.
 */
function extractPlanChoice(text) {
  const t = norm(text);

  // Match direto por número (flexível, não precisa ser exato)
  if (/\b1\b/.test(t) && !/\b2\b/.test(t) && !/\b3\b/.test(t)) return "full";
  if (/\b2\b/.test(t) && !/\b1\b/.test(t) && !/\b3\b/.test(t)) return "basic";
  if (/\b3\b/.test(t) && !/\b1\b/.test(t) && !/\b2\b/.test(t)) return "retorno";

  // Match por palavras-chave do plano
  if (/(acompanhamento|com retorno|retorno em 30|retorno incluso|primeira opcao|primeira opção|opcao 1|opção 1)/.test(t)) return "full";
  if (/(avaliacao|avaliação|so a consulta|só a consulta|consulta inicial|segunda opcao|segunda opção|opcao 2|opção 2)/.test(t)) return "basic";
  if (/(retorno avulso|consulta de ajuste|ajuste|terceira opcao|terceira opção|opcao 3|opção 3|apenas retorno)/.test(t)) return "retorno";

  // Match por contexto (exige mais palavras juntas para evitar falso positivo)
  if (/(prefiro a avaliacao|prefiro a avaliação|quero a avaliacao|quero a avaliação|so a avaliacao|só a avaliação|comecar com a avaliacao|começar com a avaliação)/.test(t)) return "basic";
  if (/(quero o acompanhamento|prefiro o acompanhamento|quero o pacote|pacote completo)/.test(t)) return "full";

  return null;
}

/* ═══════════════════════════════════════════════════════════════════
   CONDITION DETECTION (expandido na V14)
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
   INTENT DETECTION — V14 EXPANDIDO
   ═══════════════════════════════════════════════════════════════════
   ▸ MUDANÇA: Adicionadas novas flags para detectar perguntas que
   antes eram ignoradas: asksWhatIncludes, asksMedCost, asksIfForMe,
   asksDifferential, asksCanReschedule, asksPrivacy, asksRecipe
   ═══════════════════════════════════════════════════════════════════ */

function detectIntent(text) {
  const t = norm(text);

  return {
    // Intenções comerciais
    wantsPrice:       /\b(preco|preço|valor|quanto custa|investimento|custa|valores|quanto e|quanto é)\b/.test(t),
    intentPay:        /\b(como (pagar|fa[cç]o para pagar)|pagamento|pix|cartao|cartão|credito|crédito|debito|débito|boleto|link|parcel|parcela|quero pagar|posso pagar|manda o link|me manda o link)\b/.test(t)
                      && !/\b(nao tenho condicao de pagar|não tenho condição de pagar|nao consigo pagar|não consigo pagar|caro demais para pagar|muito caro para pagar)\b/.test(t),
    // ▸ V14 FIX: Removido "marcar", "agendar", "agenda" standalone (falso positivo: "antes de marcar consulta")
    //   Agora exige verbo de intenção: quero/vou/posso/queria/gostaria/preciso + marcar/agendar
    wantsBook:        /\b(quero marcar|quero agendar|vou marcar|vou agendar|queria marcar|queria agendar|gostaria de (marcar|agendar)|posso (marcar|agendar)|preciso (marcar|agendar)|bora (marcar|agendar)|confirmar consulta|quero consulta|quero uma vaga|me agenda|tem horario|tem horário)\b/.test(t),
    asksHours:        /\b(horarios|horário|horario|que horas|vagas|disponibilidade)\b/.test(t),

    // Confirmação / Recusa
    confirms:         /\b(sim|ok|beleza|confirmo|fechado|vamos|pode ser|confirmar|bora|vamos la|vamos lá|com certeza|claro que sim)\b/.test(t),
    refuses:          /\b(nao quero|não quero|pare|para|chega|desisto|cancela)\b/.test(t),

    // Perguntas diretas (Question Priority Engine)
    asksHowConsultWorks: /\b(como funciona|como e a consulta|como é a consulta|o que acontece na consulta)\b/.test(t),
    asksIfOnline:     /\b(e online|é online|online mesmo|presencial|precisa ir|tem que ir|por video|por vídeo)\b/.test(t),
    asksLegal:        /\b(legal no brasil|e legal|é legal|precisa de receita|receita|anvisa|legalizado|regularizado)\b/.test(t),
    asksChapado:      /\b(chapado|chapar|maconha mesmo|isso e maconha|isso é maconha|droga|fico alterado|ficar alterado)\b/.test(t),
    asksWho:          /\b(quem e|quem eh|quem é|quem e o dr|quem é o dr|quem e o doutor|quem é o doutor)\b/.test(t),
    // ▸ V14 FIX: Expandido para cobrir "costuma ajudar", "realmente ajuda", "faz diferença", etc.
    asksIfWorks:      /\b(funciona|vale a pena|ajuda mesmo|ajuda pra|ajuda para|costuma ajudar|costuma funcionar|costuma melhorar|realmente ajuda|realmente funciona|melhora mesmo|tem resultado|faz efeito|faz diferenca|faz diferença|resolve mesmo|e eficaz|é eficaz|tem eficacia|tem eficácia|da resultado|dá resultado|funciona mesmo|funciona de verdade)\b/.test(t),
    // ▸ V14 FIX: Expandido para cobrir "casos como o meu", "no meu caso", "pra quem tem [cond]"
    asksIfForMe:      /\b(serve pra mim|serve para mim|é só para|e so para|é pra caso grave|serve pra quem|funciona pra quem|ajuda quem tem|ajudar quem tem|precisa ter diagnostico|precisa ter diagnóstico|mesmo sem diagnostico|mesmo sem diagnóstico|no meu caso|meu caso|casos como o meu|como o meu|indicado pra|indicado para|pra quem tem)\b/.test(t),
    asksDifferential: /\b(diferença|diferenca|diferencial|por que o dr|por que o doutor|o que muda|o que diferencia|comparando)\b/.test(t),
    asksWhatIncludes: /\b(inclui o que|o que inclui|o que ta incluido|o que tá incluído|o que vem|o que tem dentro|explica o plano|explica a opcao|explica a opção)\b/.test(t),
    asksMedCost:      /\b(medicamento.*cust|remedio.*cust|remedío.*cust|caro.*depois|custo.*mensal|quanto.*mes|quanto.*mês|gast.*por mes|gast.*por mês|tratamento.*cust)\b/.test(t),
    asksRecipe:       /\b(saio com receita|recebo receita|ja sai com|já sai com|prescrição|prescricao)\b/.test(t),
    asksCanReschedule:/\b(remarcar|reagendar|trocar.*horario|trocar.*horário|mudar.*data|cancelar.*consulta)\b/.test(t),
    asksPrivacy:      /\b(sigilo|sigiloso|ninguem fica sabendo|ninguém fica sabendo|privacidade|discreto)\b/.test(t),
    asksStartNow:     /\b(como tomar|dose|dosagem|quantas gotas|comecar agora|começar agora|comprar.*remedío|comprar.*remedio)\b/.test(t),
    // ▸ V14 FIX: Removido "verdade" (falso positivo com "é verdade que funciona?"). Adicionado "e verdade" como frase
    asksIsScam:       /\b(golpe|fraude|piramide|pirâmide|e serio|é sério|confiavel|confiável|consulta.*mesmo|e verdade isso|é verdade isso|isso e verdade|isso é verdade)\b/.test(t),
    asksPayMethod:    /\b(parcela|parcelar|forma.*pagamento|aceita.*pix|aceita.*cartao|aceita.*cartão)\b/.test(t),

    // Objeções
    saysExpensive:    /\b(caro|caríssim|carissim|achei caro|muito caro|pesado|puxado)\b/.test(t),
    saysWillSee:      /\b(vou ver|depois te falo|vou confirmar|vou pensar|te aviso|depois vejo|preciso pensar)\b/.test(t),
    saysUnsure:       /\b(nao tenho certeza|não tenho certeza|nao sei|não sei|sera|será|to na duvida|tô na dúvida|duvida|dúvida)\b/.test(t),
    saysCheaperElsewhere: /\b(mais barato|medico.*barato|médico.*barato|outro.*medico|outro.*médico|pesquisando)\b/.test(t),
    // ▸ V14 FIX: Exigir contexto de 1ª pessoa para evitar falso positivo ("minha mulher tem fibro")
    saysCheckSpouse:  /\b(minha?\s+(esposa|marido|mulher)|falar com\s+(esposa|marido|mulher)|vou ver com\s+(esposa|marido|mulher|familia|família)|conversar\s+(com\s+)?(esposa|marido|mulher|familia|família)\s+antes|combinar\s+com)\b/.test(t),
    saysIndecisive:   /\b(tanto faz|qual voce acha|qual você acha|nao sei qual|não sei qual|me indica|me recomenda)\b/.test(t),

    // Urgência
    urgency:          /\b(dor no peito|falta de ar|desmaio|avc|convuls|paralisia|confusao|confusão)\b/.test(t),

    // Emoção forte
    strongPain:       /\b(nao aguento|não aguento|to sofrendo|tô sofrendo|muito ruim|muito dificil|muito difícil|desespero|nao consigo mais|não consigo mais|ajuda|socorro)\b/.test(t),

    // Focus (condição detectada no texto)
    focus: detectCondition(text),
  };
}

/* ═══════════════════════════════════════════════════════════════════
   LEAD CLASSIFIER — NOVO NA V14
   ═══════════════════════════════════════════════════════════════════
   ▸ Detecta o perfil do lead logo nas primeiras interações para
   adaptar a rota. Salvo no state como lead_profile.
   ═══════════════════════════════════════════════════════════════════ */

function classifyLead(flags, text, state) {
  // Se já classificado, manter (pode ser reclassificado em casos fortes)
  const t = norm(text);

  if (flags.strongPain) return "emocional";
  // ▸ V14 FIX: Removido "verdade" (falso positivo com "é verdade que funciona?")
  if (flags.asksIsScam || /\b(golpe|fraude|serio|sério)\b/.test(t)) return "desconfiado";
  // ▸ V14 FIX: Usa flags (já corrigido) em vez de regex extra com "quero marcar" (redundante)
  if (flags.wantsBook || flags.asksHours) return "quente";
  if (flags.wantsPrice && !state.problem_text) return "pragmatico";
  if (flags.asksDifferential || flags.saysCheaperElsewhere || /\b(pesquisando|comparando)\b/.test(t)) return "comparador";
  if (flags.asksIfForMe || /\b(serve pra mim|caso grave|sem diagnostico|sem diagnóstico)\b/.test(t)) return "frio";
  if (flags.asksIfWorks && /\b(promessa|tentei tudo|nada funciona|cansado)\b/.test(t)) return "cetico";
  if (flags.asksIfWorks) return "cetico";

  return state.lead_profile || "padrao";
}

/* ═══════════════════════════════════════════════════════════════════
   SLOT MANAGEMENT (preservado da V13)
   ═══════════════════════════════════════════════════════════════════ */

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
   EVIDENCE DATABASE — V14 EXPANDIDA
   ═══════════════════════════════════════════════════════════════════
   ▸ Nova estrutura: empathy + testimony + study + hope + bridge + future
   ▸ "testimony" é a perspectiva da secretária que vê resultados reais.
   ▸ "future" é a visualização de futuro melhor que ajuda o paciente
     a acreditar no tratamento (adesão terapêutica).
   ═══════════════════════════════════════════════════════════════════ */

const EVIDENCE_DB = {
  fibromialgia: {
    empathy: [
      "Fibromialgia desgasta o corpo e a mente. Quem tem sabe que não é só dor — é exaustão, sono ruim, o corpo nunca descansa.",
      "Fibromialgia é muito mais do que dor. É acordar cansada, é o corpo pesado, é a sensação de que nada resolve de verdade.",
    ],
    testimony: [
      "O que eu vejo aqui no dia a dia é que muita gente com fibromialgia que começa o acompanhamento com o Dr. Alef volta no retorno relatando que a dor diminuiu bastante e que conseguiu dormir melhor pela primeira vez em anos.",
      "Acompanho esse consultório todos os dias, e o que eu posso te dizer é que muita gente que chega com esse mesmo quadro percebe melhora real depois de algumas semanas.",
    ],
    study: "Estudos clínicos mostram redução de até *60% na intensidade da dor* em pacientes com fibromialgia.",
    hope: "Não prometo nada porque cada caso é diferente, mas posso te dizer que existe um caminho real para quem está nessa situação.",
    bridge: "A avaliação serve justamente para entender se esse caminho faz sentido para você.",
    future: [
      "Imagina voltar a dormir a noite inteira e acordar com menos dor. Muita gente aqui conseguiu isso.",
      "Muita gente me diz que quando a dor diminui e o sono melhora, parece que a vida volta.",
    ],
  },
  dor_cronica: {
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
    future: [
      "Poder sentar, dirigir, trabalhar sem aquela dor travando tudo — muita gente aqui conseguiu.",
    ],
  },
  dor_neuropatica: {
    empathy: [
      "Dor neuropática é uma das dores mais difíceis de tratar. Queimação, choque, formigamento — incomoda demais.",
    ],
    testimony: [
      "Pacientes com dor neuropática que acompanham aqui costumam relatar melhora significativa, principalmente na intensidade das crises.",
    ],
    study: "Estudos mostram melhora de *30–50%* em parte dos pacientes com dor neuropática.",
    hope: "Dor neuropática é difícil, mas não é sem saída.",
    bridge: "O Dr. Alef avalia com cuidado o tipo de dor e o que faz sentido no seu caso.",
    future: ["Muita gente relata que as crises ficam mais espaçadas e bem menos intensas."],
  },
  ansiedade: {
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
    future: [
      "Muita gente me diz que a sensação de conseguir relaxar de verdade pela primeira vez é indescritível.",
    ],
  },
  insonia: {
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
    empathy: [
      "Artrose limita movimento, causa dor constante e atrapalha até as tarefas mais simples.",
    ],
    testimony: [
      "Muita gente com artrose que chega aqui, especialmente quem já fez infiltração sem resultado duradouro, volta relatando que conseguiu voltar a se movimentar com menos dor.",
    ],
    study: "Estudos indicam redução de dor e melhora funcional na faixa de *30–50%* em parte dos pacientes.",
    hope: "Para quem está limitado pela artrose, existe uma possibilidade real de melhora.",
    bridge: "A avaliação leva em conta seu histórico e a articulação afetada para definir o melhor caminho.",
    future: ["Poder caminhar sem aquela dor constante — muita gente aqui conseguiu isso."],
  },
  artrite: {
    empathy: ["Artrite causa dor, rigidez e inflamação que atrapalham bastante o dia a dia."],
    testimony: ["Pacientes com artrite que acompanham aqui costumam relatar melhora na dor articular e na rigidez."],
    study: "Estudos mostram melhora de dor e inflamação em parte dos pacientes com artrite.",
    hope: "Existe caminho para aliviar esses sintomas com segurança.",
    bridge: "Isso precisa ser avaliado considerando suas medicações e histórico.",
    future: ["Menos dor e mais liberdade de movimento — é o que muita gente relata."],
  },
  enxaqueca: {
    empathy: ["Enxaqueca pode ser extremamente incapacitante. Uma crise pode parar o dia inteiro."],
    testimony: ["Muita gente com enxaqueca que acompanha aqui relata que as crises ficaram menos frequentes e menos intensas."],
    study: "Estudos indicam redução da frequência e intensidade das crises em parte dos pacientes.",
    hope: "Ter menos crises e crises mais leves — isso é possível.",
    bridge: "A avaliação analisa frequência, gatilhos e histórico para definir a melhor abordagem.",
    future: ["Ter semanas sem crise, e quando vem, ser mais leve — muita gente aqui relata isso."],
  },
};

function buildEvidenceMessage(condition, options = {}) {
  const ev = EVIDENCE_DB[condition];
  if (!ev) return null;

  const empathy = pickRandom(ev.empathy);
  const testimony = pickRandom(ev.testimony);
  const future = options.includeFuture ? `\n\n${pickRandom(ev.future)}` : "";

  return `${empathy}\n\n${testimony}\n\n${ev.study}\n\n${ev.hope}${future}\n\n${ev.bridge}`;
}

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
   REPLY TEMPLATES — V14 REESCRITOS
   ═══════════════════════════════════════════════════════════════════ */

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

// ▸ V14: perguntas diagnósticas separadas, para uso condicional

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

/**
 * ▸ Bridge: momento mais persuasivo da conversa.
 *   VERSÃO CONDENSADA para WhatsApp: testimony + dado + consult + CTA.
 *   Sem empathy (já foi expressada), sem future (reservado para objeções).
 */
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

  // ▸ V14 FIX: Lead emocional recebe future no bridge (spec 6.2: "Testimony + future no bridge")
  let future = "";
  if (state.lead_profile === "emocional" && ev?.future) {
    future = `\n\n${pickRandom(ev.future)}`;
  }

  const consult = "A avaliação é *100% online*, dura em média *45 minutos* e é individualizada para o seu caso.";
  const cta = "Se quiser, eu posso te mostrar os horários disponíveis 😊";

  return `${intro}\n\n${testimony}${study}${future}\n\n${consult}\n\n${cta}`;
}

async function askDayReply() {
  const dayKeys = await getSuggestedDayKeys();
  if (!dayKeys.length) return "No momento os horários desta semana já estão completos. Quer que eu te coloque na lista de prioridade? 😊";
  const opts = dayKeys.map((d, i) => `${i + 1}) *${formatDatePt(d)}*`).join("\n");
  return `Perfeito 😊\n\nEssa semana ainda tenho horários disponíveis:\n\n${opts}\n\nQual fica melhor para você?`;
}

async function offerSlotsReply(state) {
  const dateKey = state.date_key;
  const best = await chooseBestSlotsForDate(dateKey, 3);
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

function askCadastreBundleReply(state) {
  return (
    `Perfeito. Vou reservar *${prettySlot(state.date_key, state.slot_time)}* para você 😊\n\n` +
    "Para te mandar o link e deixar tudo certinho, me envia nesta ordem:\n" +
    "1. *nome completo*\n" +
    "2. *data de nascimento*\n" +
    "3. *e-mail*"
  );
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
    `Perfeito, reserva confirmada ✅\n\n` +
    `📅 *${prettySlot(state.date_key, state.slot_time)}*\n\n` +
    `Plano: *${plan.label}* — R$${plan.price}\n\n` +
    `Para confirmar sua consulta, é só finalizar aqui:\n${link}\n\n` +
    `Assim que o pagamento entrar, eu confirmo tudo por aqui 😊\n\n` +
    `Se tiver qualquer dificuldade, me avisa que eu te ajudo.`
  );
}

function pendingPaymentReply(state) {
  return (
    `Seu horário continua reservado 😊\n\n` +
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

function isRepairSignal(text) {
  const t = norm(text);
  return /\b(voce nao respondeu|você não respondeu|nao respondeu|não respondeu|acho que estamos nos desencontrando|estamos nos desencontrando|isso parece automatico|isso parece automático|isso esta parecendo automatico|isso está parecendo automático|parece roteiro|eu fiz uma pergunta especifica|eu fiz uma pergunta específica|minha pergunta principal|voce esta desviando|você está desviando|responde isso primeiro|antes de pagar.*responde)\b/.test(t);
}

function hasBeforePaymentFrame(text) {
  const t = norm(text);
  return /\b(antes de pagar|antes do pagamento|antes de finalizar|antes de fechar|antes de concluir)\b/.test(t);
}

function extractReferencedQuestion(text, state = {}) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const colonMatch = raw.match(/:\s*(.+)$/s);
  if (colonMatch?.[1] && colonMatch[1].trim().length >= 12) {
    return colonMatch[1].trim();
  }

  const domainPattern = /\b(legal|legalidade|acesso|anvisa|receita|prescri[cç][aã]o|farmacia|farmácia|importa[cç][aã]o|droga|tratamento|thc|cbd|funcionalidade|prova cientifica|prova científica|crit[eé]rio m[eé]dico|valor real|custo|familia|família|marido|esposa)\b/;
  const ownDomainSignal = domainPattern.test(norm(raw));
  if (ownDomainSignal && raw.length >= 20) {
    return raw;
  }

  if (!/\?/.test(raw)) {
    const latestConcreteUserSignal = String(state.last_user_message || "").trim();
    if (latestConcreteUserSignal && domainPattern.test(norm(latestConcreteUserSignal))) {
      return latestConcreteUserSignal;
    }
    const fallback = state.last_prepayment_question || state.last_important_question || latestConcreteUserSignal || "";
    if (fallback && norm(fallback) !== norm(raw)) return String(fallback).trim();
  }

  return raw;
}

function shouldTrackImportantQuestion(text, flags) {
  const t = norm(text);
  if (isRepairSignal(text)) return false;

  return (
    text.includes("?") ||
    /\b(sem rodeio|resposta direta|resposta objetiva|crit[eé]rio m[eé]dico|prova cientifica|prova científica|legalidade e acesso|parte legal|droga ou tratamento|lado pratico|lado prático|valor real|familia vai pensar|família vai pensar|nao sobre agendamento|não sobre agendamento)\b/.test(t) ||
    flags.asksIsScam || flags.asksLegal || flags.asksChapado || flags.asksWho || flags.asksIfOnline ||
    flags.asksHowConsultWorks || flags.asksRecipe || flags.asksMedCost || flags.asksCanReschedule ||
    flags.asksPrivacy || flags.asksStartNow || flags.asksPayMethod || flags.asksIfForMe ||
    flags.asksDifferential || flags.asksWhatIncludes || flags.wantsBook || flags.asksHours ||
    flags.asksIfWorks || flags.saysExpensive || flags.saysCheckSpouse
  );
}

function isFinalClarificationQuestion(text, flags, state = {}) {
  const resolved = extractReferencedQuestion(text, state);
  const resolvedFlags = detectIntent(resolved);
  const practicalPattern = /\b(vou sair com|saio com|vou sair entendendo|vou sair sabendo|vou ficar perdido|vou ficar perdida|orientacao clara|orientação clara|o que eu recebo|o que acontece na consulta|prescricao quando houver indicacao|prescrição quando houver indicação|caminho real de acesso|caminho pratico|caminho prático|seguranca|segurança|efeitos|efeito colateral|interacao|interação|acesso a medicacao|acesso à medicação|proximo passo real|próximo passo real|proximo passo claro|próximo passo claro)\b/;
  const hasOperationalQuestion =
    isOperationalAccessQuestion(resolved, resolvedFlags) ||
    isOperationalAfterConsultQuestion(resolved) ||
    isOperationalNextStepQuestion(resolved) ||
    isOperationalPaymentQuestion(resolved, resolvedFlags) ||
    resolvedFlags.asksHowConsultWorks ||
    resolvedFlags.asksRecipe ||
    resolvedFlags.asksLegal ||
    practicalPattern.test(norm(resolved));

  return !!(
    state?.payment?.link &&
    (hasBeforePaymentFrame(text) || hasBeforePaymentFrame(resolved) || isRepairSignal(text) || hasOperationalQuestion)
  );
}

function buildRepairAcknowledgement(text, state = {}) {
  const t = norm(text);
  if (!isRepairSignal(text)) return "";
  if (/\b(automatico|automático|roteiro)\b/.test(t)) {
    return "Você está certo(a) em me sinalizar isso. Não quero te responder no automático.";
  }
  if (/\b(desencontrando|desviando|minha pergunta principal)\b/.test(t)) {
    return state.payment?.link
      ? "Você tem razão. Deixa eu alinhar isso de forma direta antes de falar de pagamento."
      : "Você tem razão. Deixa eu alinhar isso de forma direta antes de continuar.";
  }
  return state.payment?.link
    ? "Você tem razão em me cobrar isso antes do pagamento. Vou te responder de forma objetiva."
    : "Você tem razão em me cobrar isso. Vou te responder de forma objetiva.";
}

function buildPaymentResumeReply(state) {
  if (state.payment?.link) {
    return (
      "Se isso te deixar mais seguro(a), seu horário segue reservado e o link continua aqui para quando você quiser concluir:\n" +
      state.payment.link
    );
  }
  return getStageCTA(state).trim();
}

function buildRepairResumeReply(state) {
  if (state.payment?.link) {
    return "Se isso ficou claro para você, eu retomo o fechamento daqui por aqui mesmo.";
  }
  if (["ASK_DAY", "OFFER_SLOTS", "ASK_FULLNAME", "ASK_BIRTHDATE", "ASK_EMAIL", "ASK_PLAN"].includes(state.stage)) {
    return "Se isso fez sentido, eu continuo daqui sem te fazer repetir tudo.";
  }
  if (["BRIDGE", "DIAGNOSTIC", "ASK_PROBLEM", "ASK_NAME"].includes(state.stage)) {
    return "Se isso fez sentido, eu sigo daqui com você sem pular etapa.";
  }
  return "";
}

function buildPrePaymentClarificationAnswer(text, flags) {
  const resolved = extractReferencedQuestion(text);
  const t = norm(resolved);
  const resolvedFlags = { ...flags, ...detectIntent(resolved) };
  const parts = [];

  if (
    isOperationalAccessQuestion(resolved, resolvedFlags) ||
    resolvedFlags.asksLegal ||
    resolvedFlags.asksRecipe ||
    /\b(anvisa|receita|prescricao|prescrição|prescreve|farmacia|farmácia|importacao|importação|acesso|medicacao|medicação)\b/.test(t)
  ) {
    parts.push(QUESTION_ANSWERS.prePaymentPrescriptionAccess);
  }

  if (
    isOperationalAfterConsultQuestion(resolved) ||
    isOperationalNextStepQuestion(resolved) ||
    /\b(vou sair com|saio com|vou sair entendendo|vou sair sabendo|vou ficar perdido|vou ficar perdida|orientacao clara|orientação clara|o que eu recebo|proximo passo|próximo passo)\b/.test(t)
  ) {
    parts.push(QUESTION_ANSWERS.prePaymentConsultOutcome);
  }

  if (
    resolvedFlags.asksHowConsultWorks ||
    /\b(o que acontece na consulta|como funciona a consulta|na consulta ele avalia|minha seguranca|minha segurança|interacao|interação|efeito colateral|efeitos)\b/.test(t)
  ) {
    parts.push(QUESTION_ANSWERS.prePaymentSafetyAndEvaluation);
  }

  if (
    isOperationalPaymentQuestion(resolved, resolvedFlags) ||
    /\b(quando entra o link|quando manda o link|como fecha|como paga|como eu pago)\b/.test(t)
  ) {
    parts.push(QUESTION_ANSWERS.prePaymentPaymentFlow);
  }

  if (!parts.length) {
    parts.push(QUESTION_ANSWERS.prePaymentGeneral);
  }

  return removeDuplicates(parts).slice(0, 2).join("\n\n");
}

function maybeHandlePrePaymentClarification(state, flags, text) {
  if (!isFinalClarificationQuestion(text, flags, state)) return null;

  const resolvedQuestion = extractReferencedQuestion(text, state);
  state.last_prepayment_question = resolvedQuestion;

  const ack = buildRepairAcknowledgement(text, state);
  const answer = buildPrePaymentClarificationAnswer(resolvedQuestion, flags);
  const resume = buildPaymentResumeReply(state);

  return [ack, answer, resume].filter(Boolean).join("\n\n");
}

/* ═══════════════════════════════════════════════════════════════════
   QUESTION ANSWERS BANK — NOVO NA V14
   ═══════════════════════════════════════════════════════════════════
   ▸ Respostas prontas para perguntas diretas. Cada uma retorna
   a resposta SEM CTA (o CTA é adicionado pelo caller baseado no stage).
   ═══════════════════════════════════════════════════════════════════ */

const QUESTION_ANSWERS = {
  howConsultWorks: "A avaliação com o Dr. Alef é *100% online, por videochamada*, dura em média *45 minutos* e é totalmente individualizada. Ele entende seu histórico, o que mais te incomoda hoje, o que você já tentou, quais medicações usa e avalia com cuidado se esse tratamento faz sentido no seu caso.",

  howConsultWorksOperational: "Funciona assim: a consulta é *100% online*, dura em média *45 minutos* e o Dr. Alef avalia seu histórico, sintomas, remédios em uso e objetivo com o tratamento. Se houver indicação, ele já explica o caminho mais seguro e o próximo passo prático.",

  scheduleHours: "Consigo te passar os horários por aqui mesmo. O próximo passo é escolher o dia para eu abrir as vagas disponíveis e já avançar sua reserva.",

  isOnline: "Sim 😊 A consulta é *100% online*, por videochamada. Você faz de onde estiver, sem precisar se deslocar.",

  isLegal: "Sim 😊 O uso medicinal de canabinoides é legal no Brasil quando existe avaliação e prescrição médica, seguindo as normas da Anvisa. Na prática, funciona assim: consulta, definição do produto, prescrição se houver indicação e orientação do caminho de acesso por farmácia ou importação.",

  legalPathOperational: "Na prática funciona assim: se o tratamento fizer sentido para você, o próprio Dr. Alef faz a prescrição e orienta qual é o caminho de acesso mais adequado, seja farmácia no Brasil ou importação regularizada. Você não precisa descobrir isso sozinho(a).",

  chapado: "Essa é uma das dúvidas mais comuns 😊 No tratamento medicinal, o objetivo não é deixar ninguém alterado. São formulações específicas, com dose controlada e acompanhamento médico. Quando o foco é CBD, a proposta é aliviar sintomas com segurança e preservar sua rotina.",

  whoIsDrAlef: "Essa é uma dúvida muito justa, porque realmente existe muita gente despreparada nessa área. No caso do Dr. Alef Kotula, ele se formou em medicina em uma das melhores faculdades da Rússia, viveu seis anos na Europa e ainda tem pós-graduação internacional em cannabis medicinal. Então não se trata de alguém que entrou nisso por modinha, mas de um médico com formação sólida e preparo específico para avaliar esse tipo de tratamento.",

  isScam: "Essa é uma dúvida muito justa, porque realmente existe muita gente despreparada nessa área. No caso do Dr. Alef Kotula, ele se formou em medicina em uma das melhores faculdades da Rússia, viveu seis anos na Europa e ainda tem pós-graduação internacional em cannabis medicinal. Então não se trata de alguém que entrou nisso por modinha, mas de um médico com formação sólida e preparo específico para avaliar esse tipo de tratamento.",

  recipe: "Se o Dr. Alef entender que faz sentido para o seu caso, sim — ele faz a prescrição na própria consulta e já orienta o próximo passo de acesso 😊",

  prescriberOperational: "Quem prescreve é o próprio Dr. Alef, caso ele veja indicação médica real no seu caso. A consulta serve justamente para avaliar isso com critério e já deixar claro qual é o próximo passo.",

  medCost: "O custo do tratamento pode variar conforme o tipo de produto e a dose. Na consulta, o Dr. Alef avalia o seu caso pensando também no que é viável para você e explica qual caminho costuma fazer mais sentido em termos de segurança, acesso e custo recorrente 😊",

  canReschedule: "Pode sim 😊 É só me avisar com antecedência que a gente reorganiza.",

  privacy: "Total sigilo 😊 A consulta é individual, por telemedicina, e tudo segue as normas de sigilo médico.",

  startNow: "Entendo sua vontade de começar 😊 Por segurança, eu não consigo orientar dose ou forma de uso por aqui — isso depende da avaliação médica. Mas a boa notícia é que na consulta o Dr. Alef já orienta os próximos passos.",

  payMethod: "Depois que eu reservo seu horário e fecho o cadastro básico, eu envio o link por aqui mesmo. Aceita cartão, Pix e boleto 😊",

  nextStepOperational: "O próximo passo é simples: eu reservo seu horário, peço os dados básicos para cadastro e, com isso certo, envio o link de pagamento aqui mesmo. Assim que o pagamento entra, eu confirmo a consulta no mesmo chat.",

  paymentFlowOperational: "O link entra depois que o horário fica reservado e o cadastro básico está ok. Eu mando aqui mesmo, e assim que o pagamento entra a consulta fica confirmada por aqui.",

  prePaymentGeneral: "Sim. A ideia da consulta é justamente te deixar com clareza prática, não perdido(a). Se houver indicação, você sai entendendo se faz sentido prescrever, qual é o próximo passo e como funciona o acesso na prática.",

  prePaymentConsultOutcome: "De forma objetiva: se houver indicação, você sai da consulta com orientação clara sobre o caso, entende o próximo passo e sabe como seguir sem ficar tentando descobrir tudo sozinho(a).",

  prePaymentPrescriptionAccess: "Se houver indicação, o próprio Dr. Alef explica na consulta a prescrição, quando ela faz sentido, e qual caminho de acesso costuma ser o mais adequado para o seu caso, seja farmácia no Brasil ou importação regularizada. Você não sai perdido(a) nessa parte.",

  prePaymentSafetyAndEvaluation: "Na consulta ele avalia seu histórico, sintomas, remédios em uso, risco de interação e segurança antes de falar em qualquer prescrição. O objetivo é te orientar com critério, não te empurrar um passo sem responder sua dúvida central.",

  prePaymentPaymentFlow: "O pagamento só confirma o horário reservado. A função da consulta é te dar a parte médica e prática: se houver indicação, ele orienta receita, acesso e próximo passo com clareza.",

  drugVsTreatment: "Respondendo sem rodeio: aqui estamos falando de *tratamento médico*, não de uso recreativo. A diferença é que existe avaliação clínica, objetivo terapêutico, prescrição quando houver indicação, dose definida e acompanhamento. Se não houver indicação real, isso também fica claro.",

  stigmaFunctionality: "Quando há indicação, a lógica é justamente preservar funcionalidade e evitar exposição desnecessária a THC. O Dr. Alef avalia se faz sentido priorizar formulações mais funcionais, em que dose e em que horário, para controlar sintomas sem te deixar 'alterado(a)' ou estigmatizado(a) na rotina.",

  scientificCriteria: "Se eu responder de forma técnica, o critério médico real passa por quatro pontos: sintomas e impacto na rotina, o que você já tentou, remédios em uso e risco de interação, e objetivo terapêutico. A evidência científica entra junto disso. Não é entusiasmo nem promessa; é avaliação individual com base clínica e segurança.",

  familyResistance: "Essa preocupação é comum. O ponto central é mostrar que não se trata de uso recreativo, e sim de uma consulta médica para avaliar indicação real, segurança, prescrição quando fizer sentido e acesso legal. Se quiser, eu te resumo isso de um jeito simples para conversar com a família sem parecer improviso.",

  legalityAccessNoDetour: "Respondendo direto à parte legal: o tratamento é legal quando existe avaliação médica, prescrição quando houver indicação e acesso regular por farmácia no Brasil ou importação autorizada. Quem define e orienta esse caminho é o próprio Dr. Alef na consulta, sem te deixar perdido(a) nisso.",

  practicalValueElderly: "O valor real da consulta, nesse cenário, é evitar tentativa no escuro. Em pessoa idosa, o Dr. Alef avalia segurança, remédios em uso, risco de interação, viabilidade de custo e qual caminho de acesso faz sentido antes de indicar qualquer coisa. Isso evita perder tempo e dinheiro com um caminho inadequado.",

  isForMe: "Muita gente que chega aqui tem exatamente esse perfil 😊 Não precisa ter diagnóstico fechado nem ser caso grave. A avaliação serve justamente para entender se esse tratamento faz sentido para o seu caso, com segurança.",

  differential: "O que costuma diferenciar aqui é que o Dr. Alef faz uma avaliação bem individualizada, revisa com cuidado suas medicações e interações, e não trabalha com protocolo pronto. Muita gente procura justamente depois de já ter passado por abordagens mais genéricas.",

  consultEvaluation: "Na consulta, o Dr. Alef costuma começar entendendo seu histórico, os sintomas que mais te incomodam, o que você já tentou, quais remédios usa hoje e se existe algum risco de interação. A partir disso, ele avalia se a cannabis faz sentido para o seu caso e qual seria o caminho mais seguro.",

  dependence: "Essa preocupação faz sentido. O ponto importante é que a proposta aqui não é trocar seu problema por outra dependência. O CBD não tem o mesmo perfil de dependência de opioides ou benzodiazepínicos, e quando alguma formulação exige mais cuidado isso é decidido com dose controlada e acompanhamento médico.",

  interaction: "Essa preocupação é importante e faz sentido. Existem remédios que exigem mais atenção, e por isso a consulta é essencial: o Dr. Alef analisa exatamente o que você usa hoje e verifica se há risco de interação, além de avaliar se dá para conduzir isso com segurança.",

  scientificProof: "Entendo esse ceticismo, porque existe muito conteúdo ruim prometendo milagre. Mas cannabis medicinal não é só opinião ou modinha: existem estudos e uso médico sério em vários contextos. A consulta serve justamente para separar promessa vazia de indicação real para o seu caso.",

  timeToEffect: "Os efeitos podem aparecer já desde o início em alguns pacientes, mas isso depende da dose, da formulação e da resposta de cada organismo. Em alguns casos a melhora é percebida cedo; em outros, é preciso ajustar até encontrar a dose ideal, sem prometer resultado instantâneo.",

  importProcess: "Hoje existem caminhos tanto por farmácia no Brasil quanto por importação, e o paciente não precisa descobrir isso sozinho. Na consulta, o Dr. Alef define o caminho mais adequado, orienta o passo a passo e explica o que depende de prescrição, farmácia ou Anvisa.",

  accessPathOperational: "Depois da consulta, se houver indicação, você já sai sabendo quem prescreve, qual é o caminho de acesso e se faz mais sentido farmácia no Brasil ou importação. A ideia é justamente evitar enrolação e deixar o processo prático.",

  afterConsultOperational: "Depois da consulta, se houver indicação, o Dr. Alef já orienta o produto, a prescrição e o caminho de acesso. Ou seja: você não fica perdido(a) tentando entender sozinho(a) o que fazer depois.",

  brainSafety: "Não é correto resumir isso como algo que 'mata neurônios'. O que existe é diferença entre uso recreativo, formulação, dose e contexto clínico. No uso medicinal, com produto adequado e acompanhamento, o foco é segurança e controle de sintomas, não exposição irresponsável.",

  stigma: "Entendo sua resistência. Aqui não estamos falando de uso recreativo, e sim de formulações médicas, como óleo sublingual, com dose controlada e acompanhamento. O objetivo não é 'usar droga', e sim avaliar um tratamento de forma séria, legal e segura.",

  fibro: "É verdade que fibromialgia não tem cura. A proposta da cannabis medicinal não é prometer cura, e sim tentar melhorar sintomas importantes do quadro, como dor, sono e ansiedade. O foco é qualidade de vida e controle de sintomas, com critério.",

  driveWork: "Isso precisa ser considerado com cuidado, e por isso a consulta é importante. Quando a proposta envolve formulações mais funcionais, a ideia é preservar sua lucidez e sua rotina. Se você dirige ou depende do trabalho com atenção total, isso entra na decisão do produto e do horário de uso.",

  insurance: "Hoje a consulta é particular. Se o seu plano trabalha com reembolso, vale conferir as regras diretamente com o convênio. Se quiser, eu te explico as modalidades da consulta para você ver o que faz mais sentido.",

  triedEverything: "Eu entendo esse cansaço, porque muita gente chega aqui exatamente depois de já ter tentado vários caminhos sem resultado. A diferença é que a consulta serve para avaliar com honestidade se existe um raciocínio médico consistente para o seu caso, em vez de repetir tentativa no escuro.",

  elderlySafety: "Na pessoa idosa, o cuidado precisa ser ainda mais criterioso, e é exatamente por isso que a avaliação médica faz diferença. O Dr. Alef analisa idade, doenças associadas, remédios em uso e risco de interação antes de definir se existe indicação e qual formulação seria mais segura.",

  cbdVsThc: "CBD e THC não são a mesma coisa. O CBD costuma ser a parte mais ligada a controle de sintomas e funcionalidade, enquanto o THC exige mais critério por causa de efeito psicoativo em algumas formulações. Na prática, o que importa é a combinação certa para o seu caso, com dose e objetivo definidos por médico.",

  priceDifference: "A diferença não está em consulta rápida ou prescrição automática. Aqui o Dr. Alef dedica em média *45 minutos* ao caso, revisa histórico, medicações, risco de interação e caminho de acesso. O foco é te dar uma avaliação mais completa e objetiva, para você não perder tempo nem dinheiro em tentativa no escuro.",

  notMarketing: "Essa preocupação é justa. O ponto aqui não é empurrar tratamento, e sim separar o que é promessa vazia do que tem indicação médica real. Se fizer sentido, o Dr. Alef explica o caminho prático; se não fizer, ele também deixa isso claro.",

  notWasteTime: "A consulta é justamente para você não perder tempo no escuro. Ela responde três coisas objetivas: se existe indicação real para o seu caso, qual seria o caminho mais seguro e como funciona o acesso na prática. Se não fizer sentido, isso também fica claro.",

  whatIncludes_full: `Nesse acompanhamento de R$${PLANS.full.price} você faz a consulta com o Dr. Alef agora e já fica com um retorno incluído em ~30 dias. Esse retorno serve para revisar como você está, ajustar o tratamento se necessário e acompanhar o início com mais segurança. É o que a maioria escolhe justamente por ter essa tranquilidade 😊`,

  whatIncludes_basic: `A avaliação de R$${PLANS.basic.price} é a consulta inicial completa, de 45 minutos. O Dr. Alef analisa seu caso com profundidade e define os próximos passos com segurança 😊`,
};

function getPriorityTrustAnswer(state, text) {
  const t = norm(text);

  if (/\b(droga ou tratamento|isso e droga ou tratamento|isso é droga ou tratamento|qual e a diferenca entre droga e tratamento|qual é a diferença entre droga e tratamento)\b/.test(t)) {
    return QUESTION_ANSWERS.drugVsTreatment;
  }

  if (/\b(thc demais|estigma|perda de funcionalidade|perder funcionalidade|ficar alterado na rotina|como evita thc)\b/.test(t)) {
    return QUESTION_ANSWERS.stigmaFunctionality;
  }

  if (/\b(prova cientifica ou criterio medico|prova científica ou critério médico|criterio medico real|critério médico real|nao entusiasmo|não entusiasmo)\b/.test(t)) {
    return QUESTION_ANSWERS.scientificCriteria;
  }

  if (/\b(familia vai pensar|família vai pensar|marido nao aprova|marido não aprova|esposa nao aprova|esposa não aprova|familia nao aprova|família não aprova)\b/.test(t)) {
    return QUESTION_ANSWERS.familyResistance;
  }

  if (/\b(legalidade e acesso|parte legal|nao sobre agendamento|não sobre agendamento|voce nao respondeu a parte legal|você não respondeu a parte legal)\b/.test(t)) {
    return QUESTION_ANSWERS.legalityAccessNoDetour;
  }

  if (/\b(lado pratico|lado prático|valor real|consulta de r\\$347|custo de tratamento e acesso)\b/.test(t) && /\b(idosa|idoso|dor lombar|acesso|custo)\b/.test(t)) {
    return QUESTION_ANSWERS.practicalValueElderly;
  }

  if (/\b(como sei que (esse )?(medico|médico|dr|doutor) e serio|como sei que .*e sério|charlatao|charlatão|medico.*instagram|m[eé]dico.*instagram|marketing|isso e serio|isso é sério)\b/.test(t)) {
    return QUESTION_ANSWERS.isScam;
  }

  if (/\b(o que voce costuma avaliar primeiro na consulta|o que você costuma avaliar primeiro na consulta|o que voce avalia primeiro|o que você avalia primeiro|como o dr avalia|como ele avalia meu caso)\b/.test(t)) {
    return QUESTION_ANSWERS.consultEvaluation;
  }

  if (/\b(vicia|viciante|dependencia|dependência|ficar dependente|gera dependencia|gera dependência)\b/.test(t)) {
    return QUESTION_ANSWERS.dependence;
  }

  if (/\b(interage|interacao|interação|misturar|junto com meus remedios|junto com meus remédios|antidepressivo|ansiolitico|ansiolítico)\b/.test(t)) {
    return QUESTION_ANSWERS.interaction;
  }

  if (/\b(comprovacao|comprovação|prova cientifica|prova científica|evidencia|evidência|placebo|modinha|estudo cientifico|estudo científico)\b/.test(t)) {
    return QUESTION_ANSWERS.scientificProof;
  }

  if (/\b(demora.*fazer efeito|quanto tempo.*fazer efeito|quanto tempo.*resultado|quando.*resultado)\b/.test(t)) {
    return QUESTION_ANSWERS.timeToEffect;
  }

  if (/\b(importacao|importação|importar|burocratico|burocrático|burocracia|por onde comecar|por onde começar|como conseguir)\b/.test(t)) {
    return QUESTION_ANSWERS.importProcess;
  }

  if (/\b(como fica legalidade|caminho de acesso|quem prescreve|quem receita|como consigo a medicacao|como consigo a medicação|o que acontece depois da consulta|depois da consulta)\b/.test(t)) {
    return QUESTION_ANSWERS.accessPathOperational;
  }

  if (/\b(quais horarios voce tem|quais horários você tem|tem horario essa semana|tem horário essa semana|como fecha o agendamento)\b/.test(t)) {
    return QUESTION_ANSWERS.scheduleHours;
  }

  if (/\b(quando entra o link|quando manda o link|link de pagamento|como fecha o pagamento|como eu pago)\b/.test(t)) {
    return QUESTION_ANSWERS.paymentFlowOperational;
  }

  if (/\b(mata neuronios|mata neurônios|faz mal para o cerebro|faz mal para o cérebro)\b/.test(t)) {
    return QUESTION_ANSWERS.brainSafety;
  }

  if (/\b(isso e maconha|isso é maconha|nao quero usar droga|não quero usar droga)\b/.test(t)) {
    return QUESTION_ANSWERS.stigma;
  }

  if (/\bfibromialgia\b/.test(t) && /\b(cura|ajudar|melhorar)\b/.test(t)) {
    return QUESTION_ANSWERS.fibro;
  }

  if (/\b(dirigir|trabalhar|trabalho|exame toxicologico|exame toxicológico)\b/.test(t)) {
    return QUESTION_ANSWERS.driveWork;
  }

  if (/\b(idoso|idosa|minha idade|na minha idade|seguro na minha idade)\b/.test(t)) {
    return QUESTION_ANSWERS.elderlySafety;
  }

  if (/\b(cbd e thc|cbd.*thc|thc.*cbd|diferenca entre cbd e thc|diferença entre cbd e thc)\b/.test(t)) {
    return QUESTION_ANSWERS.cbdVsThc;
  }

  if (/\b(convenio|convênio|reembolso|plano cobre)\b/.test(t)) {
    return QUESTION_ANSWERS.insurance;
  }

  if (/\b(ja tentei de tudo|já tentei de tudo|nada funciona|nada funcionou|perda de tempo|mais uma tentativa|mais uma perda de tempo)\b/.test(t)) {
    return QUESTION_ANSWERS.triedEverything;
  }

  if ((/\b(muito caro|caro|nao tenho condicao|não tenho condição|consulta e cara|consulta é cara)\b/.test(t) && !/\b(preco|preço|valor|quanto custa)\b/.test(t))) {
    return "Eu entendo você. Quando a pessoa já gastou com remédios, consultas e tratamentos que não trouxeram o resultado esperado, qualquer novo investimento pesa mesmo. Mas a proposta aqui é justamente fazer uma avaliação médica mais direcionada, para entender seu caso com profundidade e ver se esse caminho realmente faz sentido para você, em vez de continuar tentando coisas no escuro.";
  }

  if (/\b(funciona mesmo|vale a pena|resolve mesmo|oleo vai ajudar|óleo vai ajudar|nao encontro informacao clara|não encontro informação clara|promessa de milagre)\b/.test(t)) {
    return QUESTION_ANSWERS.scientificProof;
  }

  if (/\b(marketing|propaganda|instagram|modinha)\b/.test(t) && /\b(como sei|nao e so|não é só|so marketing|só marketing)\b/.test(t)) {
    return QUESTION_ANSWERS.notMarketing;
  }

  if (/\b(perder tempo|perda de tempo|nao vou perder tempo|não vou perder tempo)\b/.test(t)) {
    return QUESTION_ANSWERS.notWasteTime;
  }

  if (/\b(150|200|347)\b/.test(t) && /\b(diferenca pratica|diferença prática|por que sua consulta custa mais|consulta custa mais|mercado fala de consultas)\b/.test(t)) {
    return QUESTION_ANSWERS.priceDifference;
  }

  return null;
}

/* ═══════════════════════════════════════════════════════════════════
   OBJECTION HANDLERS — NOVO NA V14
   ═══════════════════════════════════════════════════════════════════ */

function handleExpensive(state) {
  const cond = state.condition || "dor_cronica";
  const ev = EVIDENCE_DB[cond];
  const future = ev?.future ? `\n\n${pickRandom(ev.future)}` : "";
  // ▸ V14 FIX: CTA dinâmico por stage (antes era hardcoded "te explico a diferença")
  return `Entendo você pensar nisso.\n\nMas aqui não é uma consulta rápida. O Dr. Alef dedica em média *45 minutos* ao seu caso, revisa tudo o que você já tentou e monta um plano individualizado. A maioria dos pacientes me diz que foi a consulta mais completa que já fizeram.${future}` + getStageCTA(state);
}

function handleWillSee(state) {
  if (state?.date_key && state?.slot_time) {
    return `Claro, sem problema 😊 Se quiser, eu consigo manter *${prettySlot(state.date_key, state.slot_time)}* reservado por mais alguns minutos enquanto você decide. Assim não corre risco de perder a vaga.`;
  }
  return "Claro, sem problema 😊 Se quiser, eu posso te mostrar os horários disponíveis e você decide com calma.";
}

function handleUnsure(state, text) {
  const cond = detectCondition(text) || state.condition || null;
  const ev = cond && Number(state.evidence_used_count || 0) < 2 ? EVIDENCE_DB[cond] : null;
  let msg = "É super normal ter essa dúvida 😊 A avaliação serve justamente para entender com profundidade se esse tratamento faz sentido para você, sem compromisso de seguir se não fizer.";
  if (ev) {
    msg += `\n\n${pickRandom(ev.testimony)}`;
  }
  // ▸ V14 FIX: Reconectar ao stage com CTA (spec 4.2: toda objeção termina com CTA do stage)
  return msg + getStageCTA(state);
}

function handleCheaperElsewhere(state) {
  // ▸ V14 FIX: Adicionado state param + CTA dinâmico por stage
  return "Entendo 😊 Muita gente compara antes de decidir, e está certo.\n\nO que costuma diferenciar aqui é a avaliação individualizada e o cuidado com segurança e ajustes. O Dr. Alef não trabalha com protocolo pronto — cada caso é avaliado com profundidade.\n\nMuita gente chega aqui justamente depois de abordagens mais genéricas." + getStageCTA(state);
}

function handleCheckSpouse() {
  return "Faz total sentido 😊 Se quiser, eu posso te resumir como funciona e os valores — fica mais fácil de conversar. E se decidirem seguir, eu consigo encaixar um horário nessa semana ainda.";
}

/* ═══════════════════════════════════════════════════════════════════
   GPT — SYSTEM PROMPT V14
   ═══════════════════════════════════════════════════════════════════
   ▸ MUDANÇA CRÍTICA: Prompt com convicção, esperança, limites claros
   de profundidade clínica e obrigação de micro-CTA.
   ═══════════════════════════════════════════════════════════════════ */

function buildSystemPrompt(stageCTA = "") {
  return `Você é "Lia", secretária pessoal do Dr. Alef Kotula. Você trabalha ao lado dele todos os dias e já viu centenas de pacientes.

QUEM VOCÊ É:
- Humana, acolhedora, clara, com convicção
- Você acredita no tratamento porque vê resultado real
- Você já viu gente sem esperança voltar melhor
- Você transmite esperança fundamentada, nunca promessa vazia

PODE:
- Dizer "o que eu vejo aqui com frequência é que os pacientes melhoram"
- Transmitir esperança e ajudar o paciente a enxergar futuro melhor
- Falar que muita gente melhora, que pacientes voltam relatando melhora
- Usar dados de estudos para confirmar a experiência

NÃO PODE:
- Inventar preço / enviar links / citar R$
- Prometer cura / garantir resultado
- Diagnosticar / sugerir dose / prescrever
- Fazer mais de 1 pergunta por mensagem
- Investigar sintomas clínicos em profundidade (irradiação, formigamento, etc.)
- Ultrapassar 5 linhas de texto

REGRAS:
- Responda primeiro a pergunta do paciente
- Se o paciente estiver perto do pagamento e fizer uma dúvida final prática, responda essa dúvida com objetividade antes de retomar link, reserva ou CTA
- Se o paciente disser que você não respondeu, reconheça o desencontro, repare a resposta e só depois retome o fechamento
- Depois conduza com suavidade
- Sempre termine com direção suave${stageCTA ? `: "${stageCTA}"` : ""}
- Se o paciente está sofrendo, intensifique acolhimento e esperança
- Máximo 5 linhas

COMANDOS:
- Pediu preço: "PRECISA_PRECO"
- Pediu pagamento/link: "PRECISA_PAGAR"
- Pediu horários/agendar: "PRECISA_AGENDAR"
- Urgência médica: "URGENTE"

FORMATO JSON:
{ "reply": "mensagem", "updates": { "nome": "...", "problem_text": "...", "condition": "..." } }`;
}

function buildUserPrompt({ incomingText, state, flags }) {
  return `MEMÓRIA:
${JSON.stringify({
  nome: state.nome, focus: state.focus, condition: state.condition,
  problem_text: state.problem_text, stage: state.stage,
  date_key: state.date_key, slot_time: state.slot_time,
  evidence_used: state.evidence_used_count || 0,
  lead_profile: state.lead_profile || "padrao",
})}

MENSAGEM: ${incomingText}

SINAIS: ${JSON.stringify({
  wantsPrice: flags.wantsPrice, wantsBook: flags.wantsBook,
  asksIfWorks: flags.asksIfWorks, saysExpensive: flags.saysExpensive,
  strongPain: flags.strongPain, confirms: flags.confirms,
})}`;
}

function violatesNoPriceNoLink(text) {
  if (!text) return false;
  if (/\bhttps?:\/\//i.test(text)) return true;
  if (/R\$\s?\d/i.test(text)) return true;
  if (/\b(200|347|447)\b/.test(text)) return true;
  return false;
}

async function runLia({ incomingText, state, flags, stageCTA = "" }) {
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.5,
    messages: [
      { role: "system", content: buildSystemPrompt(stageCTA) },
      { role: "user", content: buildUserPrompt({ incomingText, state, flags }) },
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
   MERCADO PAGO (preservado da V13)
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
   HUMAN DELAY (preservado da V13, ajustado)
   ═══════════════════════════════════════════════════════════════════ */

function computeHumanDelay(flags, state) {
  let base = randInt(MIN_DELAY, MAX_DELAY);
  if (flags.wantsBook || flags.asksHours || flags.intentPay) base = randInt(1, 3);
  if (flags.wantsPrice) base = randInt(2, 4);
  // ▸ V14 FIX: Delay reduzido para todo o ciclo de vida do lead emocional (spec 6.2)
  if (flags.strongPain || state.lead_profile === "emocional") base = randInt(1, 2);
  const lastAt = Number(state.last_sent_at || 0);
  if (Date.now() - lastAt < 2000) base += 1;
  return Math.max(1, base);
}

async function sendWhatsApp(to, from, body, delaySec) {
  await sleep(delaySec * 1000);
  await twilioClient.messages.create({ to, from, body });
}

/* ═══════════════════════════════════════════════════════════════════
   CONTEXT CTAs — NOVO NA V14
   ═══════════════════════════════════════════════════════════════════
   ▸ Retorna o CTA adequado ao stage atual do funil. Usado pelo
   Question Priority Engine para reconectar ao fechamento.
   ═══════════════════════════════════════════════════════════════════ */

function getStageCTA(state) {
  const s = state.stage;
  if (s === "ASK_DAY") return "\n\nQual dia fica melhor para você? 😊";
  if (s === "OFFER_SLOTS") return "\n\nQual desses horários funciona melhor? 😊";
  if (s === "ASK_FULLNAME") return "\n\nMe passa seu *nome completo* para eu finalizar a reserva 😊";
  if (s === "ASK_BIRTHDATE") return "\n\nMe manda sua *data de nascimento* para eu prosseguir 😊";
  if (s === "ASK_EMAIL") return "\n\nMe passa seu *e-mail* para eu completar o cadastro 😊";
  if (s === "ASK_PLAN") return "\n\nQual dessas opções faz mais sentido? Me responde com *1, 2 ou 3* 😊";
  if (s === "WAIT_PAYMENT" && state.payment?.link) return `\n\nSeu horário continua reservado e o link segue ativo: ${state.payment.link} 😊`;
  return "\n\nSe quiser, eu posso te mostrar os horários disponíveis 😊";
}

function isOperationalScheduleQuestion(text, flags) {
  const t = norm(text);
  return (
    flags.wantsBook ||
    flags.asksHours ||
    /\b(quais horarios voce tem|quais horários você tem|quais horarios tem|tem horario essa semana|tem horário essa semana|como faco para agendar|como faço para agendar|como fecha o agendamento|como funciona o agendamento)\b/.test(t)
  );
}

function isOperationalAccessQuestion(text, flags) {
  const t = norm(text);
  return (
    flags.asksLegal ||
    flags.asksRecipe ||
    /\b(caminho de acesso|acesso pratico|acesso prático|como consigo a medicacao|como consigo a medicação|como conseguir o tratamento|como funciona o acesso|farmacia|farmácia|importacao|importação|quem prescreve|quem receita)\b/.test(t)
  );
}

function isOperationalAfterConsultQuestion(text) {
  const t = norm(text);
  return /\b(depois da consulta|o que acontece depois da consulta|o que acontece depois)\b/.test(t);
}

function isOperationalNextStepQuestion(text) {
  const t = norm(text);
  return /\b(proximo passo|próximo passo|se eu seguir|como fecha|como eu fecho|o que eu faco agora|o que eu faço agora)\b/.test(t);
}

function isOperationalPaymentQuestion(text, flags) {
  const t = norm(text);
  return (
    flags.intentPay ||
    flags.asksPayMethod ||
    /\b(quando entra o link|quando manda o link|me manda o link|manda o link|como pago|como fecha o pagamento|link de pagamento)\b/.test(t)
  );
}

async function maybeHandleOperationalClose(state, flags, text) {
  const wantsSchedule = isOperationalScheduleQuestion(text, flags);
  const asksConsultFlow = flags.asksHowConsultWorks || /\b(como funciona a consulta|como e a consulta|como é a consulta)\b/.test(norm(text));
  const asksAccess = isOperationalAccessQuestion(text, flags);
  const asksAfterConsult = isOperationalAfterConsultQuestion(text);
  const asksNextStep = isOperationalNextStepQuestion(text);
  const asksPayment = isOperationalPaymentQuestion(text, flags);

  if (!wantsSchedule && !asksConsultFlow && !asksAccess && !asksAfterConsult && !asksNextStep && !asksPayment) {
    return null;
  }

  const parts = [];

  if (wantsSchedule) parts.push(QUESTION_ANSWERS.scheduleHours);
  if (asksConsultFlow) parts.push(QUESTION_ANSWERS.howConsultWorksOperational);
  if (asksAccess) parts.push(QUESTION_ANSWERS.accessPathOperational);
  if (asksAfterConsult) parts.push(QUESTION_ANSWERS.afterConsultOperational);
  if (asksNextStep) parts.push(QUESTION_ANSWERS.nextStepOperational);
  if (asksPayment) parts.push(QUESTION_ANSWERS.paymentFlowOperational);

  const intro = removeDuplicates(parts).slice(0, 2).join("\n\n").trim();

  if (state.payment?.link) {
    return [intro, pendingPaymentReply(state)].filter(Boolean).join("\n\n");
  }

  if (state.date_key && !state.slot_time && (wantsSchedule || asksNextStep)) {
    return [intro, await offerSlotsReply(state)].filter(Boolean).join("\n\n");
  }

  if (!state.date_key && (wantsSchedule || asksConsultFlow || asksNextStep)) {
    return [intro, await askDayReply()].filter(Boolean).join("\n\n");
  }

  if (state.date_key && state.slot_time && !state.nome_completo && (asksNextStep || asksPayment)) {
    return [intro, askCadastreBundleReply(state)].filter(Boolean).join("\n\n");
  }

  if (state.date_key && state.slot_time && state.nome_completo && state.birthdate && !state.email && (asksNextStep || asksPayment)) {
    return [intro, askEmailReply()].filter(Boolean).join("\n\n");
  }

  if (state.date_key && state.slot_time && state.nome_completo && state.birthdate && state.email && !state.payment?.link && (asksNextStep || asksPayment)) {
    return [intro, priceReply()].filter(Boolean).join("\n\n");
  }

  if (intro) return intro + getStageCTA(state);
  return null;
}

/**
 * ▸ QUESTION PRIORITY ENGINE
 * Verifica se o paciente fez pergunta direta e retorna a resposta
 * + CTA do stage atual. Retorna null se nenhuma pergunta detectada.
 */
function getDirectAnswerOnly(flags, state, text) {
  const priorityAnswer = getPriorityTrustAnswer(state, text);
  if (priorityAnswer) return priorityAnswer;
  let answer = null;

  if (flags.asksIsScam) answer = QUESTION_ANSWERS.isScam;
  else if (flags.asksLegal) answer = QUESTION_ANSWERS.isLegal;
  else if (flags.asksChapado) answer = QUESTION_ANSWERS.chapado;
  else if (flags.asksWho) answer = QUESTION_ANSWERS.whoIsDrAlef;
  else if (flags.asksIfOnline) answer = QUESTION_ANSWERS.isOnline;
  else if (flags.asksHowConsultWorks) answer = QUESTION_ANSWERS.howConsultWorks;
  else if (flags.asksRecipe) answer = QUESTION_ANSWERS.recipe;
  else if (flags.asksMedCost) answer = QUESTION_ANSWERS.medCost;
  else if (flags.asksCanReschedule) answer = QUESTION_ANSWERS.canReschedule;
  else if (flags.asksPrivacy) answer = QUESTION_ANSWERS.privacy;
  else if (flags.asksStartNow) answer = QUESTION_ANSWERS.startNow;
  else if (flags.asksPayMethod) answer = QUESTION_ANSWERS.payMethod;
  else if (flags.asksIfForMe) answer = QUESTION_ANSWERS.isForMe;
  else if (flags.asksDifferential) answer = QUESTION_ANSWERS.differential;
  else if (flags.asksWhatIncludes) {
    // Se já tem plano selecionado ou contexto de acompanhamento
    const t = norm(text);
    if (/(447|acompanhamento|opcao 1|opção 1|primeira)/.test(t)) answer = QUESTION_ANSWERS.whatIncludes_full;
    else if (/(347|avaliacao|avaliação|opcao 2|opção 2|segunda)/.test(t)) answer = QUESTION_ANSWERS.whatIncludes_basic;
    else answer = QUESTION_ANSWERS.whatIncludes_full; // default: explicar o mais popular
  }

  if (answer) return answer;
  return null;
}

function handleDirectQuestion(flags, state, text) {
  const cta = getStageCTA(state);
  const answer = getDirectAnswerOnly(flags, state, text);
  if (answer) return answer + cta;
  return null;
}

function maybeHandleContextRepair(state, text) {
  if (!isRepairSignal(text) || state.payment?.link) return null;

  const resolvedQuestion = extractReferencedQuestion(text, state);
  const resolvedFlags = detectIntent(resolvedQuestion);
  const answer = getDirectAnswerOnly(resolvedFlags, state, resolvedQuestion);
  if (!answer) return null;

  state.last_important_question = resolvedQuestion;
  return [
    buildRepairAcknowledgement(text, state),
    answer,
    buildRepairResumeReply(state),
  ].filter(Boolean).join("\n\n");
}

/**
 * ▸ OBJECTION HANDLER
 * Verifica se o paciente expressou objeção e retorna tratamento.
 * Retorna null se nenhuma objeção detectada.
 */
function handleObjection(flags, state, text) {
  const priorityAnswer = getPriorityTrustAnswer(state, text);
  if (priorityAnswer) return priorityAnswer + getStageCTA(state);
  if (flags.saysExpensive) return handleExpensive(state);
  if (flags.saysWillSee) return handleWillSee(state);
  if (flags.saysUnsure) return handleUnsure(state, text);
  if (flags.saysCheaperElsewhere) return handleCheaperElsewhere(state);
  if (flags.saysCheckSpouse) return handleCheckSpouse();
  if (flags.saysIndecisive) {
    // ▸ Recomendar a opção mais popular com justificativa
    if (state.stage === "ASK_PLAN") {
      return `A maioria dos pacientes escolhe o *Acompanhamento* (opção 1) porque já inclui o retorno em ~30 dias — dá mais segurança para acompanhar o início do tratamento 😊\n\nMas se preferir começar só com a avaliação inicial, a opção 2 também funciona bem. Quer seguir com a 1 ou a 2?`;
    }
    if (state.stage === "OFFER_SLOTS" || state.stage === "ASK_DAY") {
      return `Os horários que os pacientes costumam preferir são no final da tarde/início da noite 😊 Se quiser, eu sugiro o melhor disponível.`;
    }
    return "Sem problema 😊 Me diz o que te deixa em dúvida que eu te ajudo a decidir.";
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════
   TRIAGEM ADAPTATIVA — NOVO NA V14
   ═══════════════════════════════════════════════════════════════════
   ▸ Decide quantas perguntas diagnósticas ainda são necessárias.
   ▸ Se o paciente já contou tudo, pode ser 0.
   ═══════════════════════════════════════════════════════════════════ */

function getNextDiagQuestion(state, text) {
  const has = {
    tempo: !!(state.diag_has_tempo),
    impacto: !!(state.diag_has_impacto),
    tratamento: !!(state.diag_has_tratamento),
  };

  // Detectar se o texto atual já contém respostas
  const low = norm(text);
  if (/(ha |há |faz |anos|meses|tempo|começo|comecou|começou)/.test(low)) has.tempo = true;
  if (/(rotina|dia a dia|trabalho|sono|atrapalha|incomoda|impacto|cansaço|cansaco)/.test(low)) has.impacto = true;
  if (/(ja tomei|já tomei|ja tentei|já tentei|remedio|remédio|anti.?inflamat|fisioterapia|medicacao|medicação|pregabalina|duloxetina|amitriptilina|gabapentina|infiltracao|infiltração)/.test(low)) has.tratamento = true;

  // Salvar o que já tem
  state.diag_has_tempo = has.tempo;
  state.diag_has_impacto = has.impacto;
  state.diag_has_tratamento = has.tratamento;

  // Decidir próxima pergunta
  const asked = Number(state.diagnostic_step || 0);
  if (asked >= 3) return null; // Limite absoluto
  // ▸ V14 FIX: Lead emocional → max 1 pergunta (spec 6.2: "Triagem mínima, 1 pergunta máx")
  if (state.lead_profile === "emocional" && asked >= 1) return null;

  if (!has.tempo && asked < 3) { state.diagnostic_step = asked + 1; return diagQ_tempo(state); }
  if (!has.impacto && asked < 3) { state.diagnostic_step = asked + 1; return diagQ_impacto(state); }
  if (!has.tratamento && asked < 3) { state.diagnostic_step = asked + 1; return diagQ_tratamento(); }

  return null; // Tudo já coletado
}

/* ═══════════════════════════════════════════════════════════════════
   STATE INITIALIZATION
   ═══════════════════════════════════════════════════════════════════ */

function initializeState(state, bot) {
  // ▸ V14 FIX: Migrar stages da V13 que não existem na V14
  // V13 usava DIAG_Q1, DIAG_Q2, DIAG_Q3 separados; V14 consolida em DIAGNOSTIC
  if (state.stage && /^DIAG_Q[123]$/.test(state.stage)) {
    const qNum = Number(state.stage.replace("DIAG_Q", "")) || 0;
    state.stage = "DIAGNOSTIC";
    state.diagnostic_step = Math.max(Number(state.diagnostic_step || 0), qNum);
  }
  // V13 usava AFTER_DIAGNOSTIC; V14 usa BRIDGE
  if (state.stage === "AFTER_DIAGNOSTIC") {
    state.stage = "BRIDGE";
  }

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
  state.last_bot_from = bot;
  return state;
}

/* ═══════════════════════════════════════════════════════════════════
   ROUTES
   ═══════════════════════════════════════════════════════════════════ */

if (!IS_SIMULATOR_MODE) {
  app.get("/", (req, res) => res.send("OK"));
  app.get("/mp/thanks", (req, res) => res.send("OK"));

  // Webhook Mercado Pago (preservado da V13)
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
        // ▸ V14 FIX: Setar stage CONFIRMED para consistência com spec 8.2
        if (status === "approved") state.stage = "CONFIRMED";
        await saveUserState(phone, state);

        if (status === "approved") {
          const botFrom = state?.last_bot_from || null;
          if (botFrom) {
            try {
              await twilioClient.messages.create({ to: `whatsapp:${phone}`, from: botFrom, body: afterPaidReply(state) });
            } catch {}
          }
        }
      }
    } catch (err) { console.error("❌ MP webhook erro:", err); }
  });

/* ═══════════════════════════════════════════════════════════════════
   ███████████████████████████████████████████████████████████████████
   MAIN HANDLER — LÓGICA DE DECISÃO V14
   ███████████████████████████████████████████████████████████████████

   ARQUITETURA:
   [0] Proteções (pagamento aprovado, urgência, admin)
   [1] Question Priority Engine (pergunta direta → resposta + CTA)
   [2] Objection Handler (objeção → tratamento + CTA)
   [3] State Machine (fluxo normal do funil)
   [4] Fallback GPT (prompt restrito com convicção)

   ═══════════════════════════════════════════════════════════════════ */

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

      // ── Admin reset ──
      if (norm(incomingText) === "reset" && phoneDigits === ADMIN_RESET_PHONE_DIGITS) {
        await pool.query(`UPDATE wa_users SET state = '{}'::jsonb, updated_at = NOW() WHERE regexp_replace(phone, '\\D', '', 'g') = $1`, [phoneDigits]);
        await pool.query(`DELETE FROM wa_slot_locks WHERE phone = $1 AND status='held'`, [phone]);
        await sendWhatsApp(`whatsapp:+${phoneDigits}`, bot, "🔄 Memória resetada. Pode testar do zero.", 0);
        return;
      }

      // ── Admin simular pagamento ──
      if (["simular pagamento","paguei_teste","simular_pagamento","aprovar_teste"].includes(norm(incomingText)) && phoneDigits === ADMIN_RESET_PHONE_DIGITS) {
        const st = await getUserState(phone);
        st.payment = st.payment || {};
        st.payment.status = "approved";
        st.payment.simulated = true;
        if (st.slot_key) await markSlotPaid(st.slot_key, phone);
        await saveUserState(phone, st);
        await sendWhatsApp(lead, bot, afterPaidReply(st), 0);
        return;
      }

      // ── Load state ──
      let state = initializeState(await getUserState(phone), bot);

      // ▸ FIX: Tratar mensagens sem texto (áudio, imagem, sticker, figurinha)
      const hasMedia = Number(req.body.NumMedia || 0) > 0;
      if ((!incomingText || incomingText.length < 2) && hasMedia) {
        const mediaReply = state.nome
          ? `${state.nome}, por enquanto eu só consigo ler mensagens de texto 😊 Me manda sua dúvida digitando que eu te ajudo.`
          : "Por enquanto eu só consigo ler mensagens de texto 😊 Me manda sua dúvida digitando que eu te ajudo.";
        state.last_bot_reply = mediaReply;
        state.last_sent_at = Date.now();
        await saveUserState(phone, state);
        await sendWhatsApp(lead, bot, mediaReply, randInt(1, 2));
        return;
      }

      const flags = detectIntent(incomingText);
      if (shouldTrackImportantQuestion(incomingText, flags)) {
        state.last_important_question = extractReferencedQuestion(incomingText, state);
      }

      // Atualizar focus/condition passivamente
      if (flags.focus && !state.focus) state.focus = flags.focus;
      const detCond = detectCondition(incomingText);
      if (detCond && !state.condition) state.condition = detCond;
      const detProb = extractProblemText(incomingText);
      if (detProb && !state.problem_text) state.problem_text = detProb;

      // Classificar lead (se ainda não classificado ou sinal forte)
      const lp = classifyLead(flags, incomingText, state);
      if (!state.lead_profile || ["emocional","desconfiado","quente"].includes(lp)) state.lead_profile = lp;

      let reply = "";
      let skipAntiRepeat = false;

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
         [CAMADA 1] — QUESTION PRIORITY ENGINE
         ▸ Se o paciente fez pergunta direta, responder ANTES de
         qualquer lógica de stage. A resposta inclui CTA do stage.
         ▸ Não avança o stage (funil aberto).
         ▸ Exceção: se pedir preço e nunca viu preço → transiciona.
         ═══════════════════════════════════════════════════════════════ */

      else if (state.stage) { // Só ativa se já entrou no funil

        // ▸ FIX: Durante DIAGNOSTIC e ASK_PROBLEM, Camada 1 só intercepta
        //   perguntas inequívocas (contêm "?" ou são flags de alta confiança).
        //   Evita que "melhora um pouco" seja interpretado como "funciona?".
        const isDiagStage = (state.stage === "DIAGNOSTIC" || state.stage === "ASK_PROBLEM");
        const hasQuestionMark = incomingText.includes("?");
        const highConfidenceQuestion = flags.asksIsScam || flags.asksLegal || flags.asksChapado
          || flags.asksWho || flags.asksHowConsultWorks || flags.asksIfOnline
          || flags.asksRecipe || flags.asksMedCost || flags.asksCanReschedule
          || flags.asksPrivacy || flags.asksStartNow || flags.asksPayMethod
          || flags.asksWhatIncludes || flags.asksIfForMe || flags.asksDifferential
          || flags.wantsBook || flags.asksHours || flags.intentPay;

        const shouldRunCamada1 = !isDiagStage || hasQuestionMark || highConfidenceQuestion;

        const prePaymentClarificationReply = shouldRunCamada1 ? maybeHandlePrePaymentClarification(state, flags, incomingText) : null;
        if (prePaymentClarificationReply) {
          reply = prePaymentClarificationReply;
          skipAntiRepeat = true;
          // Não muda stage — responde primeiro e só depois reconecta ao fechamento
        }

        const contextRepairReply = !reply && shouldRunCamada1 ? maybeHandleContextRepair(state, incomingText) : null;
        if (contextRepairReply) {
          reply = contextRepairReply;
          skipAntiRepeat = true;
        }

        const operationalCloseReply = !reply && shouldRunCamada1 ? await maybeHandleOperationalClose(state, flags, incomingText) : null;
        if (operationalCloseReply) {
          reply = operationalCloseReply;
          // Não muda stage — reconecta ao ponto atual
        }

        const directAnswer = !reply && shouldRunCamada1 ? handleDirectQuestion(flags, state, incomingText) : null;
        if (directAnswer) {
          reply = directAnswer;
          // Não muda stage — reconecta ao ponto atual
        }

        // Preço: se pediu e tem stage ativo
        else if (flags.wantsPrice && state.stage !== "ASK_PLAN" && state.stage !== "WAIT_PAYMENT") {
          state.price_ask_count += 1;
          if (state.price_ask_count >= 2 || state.lead_profile === "pragmatico") {
            reply = priceReply();
            state.stage = "ASK_PLAN";
          } else {
            reply = `Claro 😊 Hoje trabalhamos com opções a partir de R$${PLANS.basic.price}. Depois te explico certinho as diferenças.` + getStageCTA(state);
          }
        }

        // AsksIfWorks: responder com testimony + CTA (só fora de triagem)
        else if (flags.asksIfWorks && !isDiagStage && !reply) {
          const cond = detectCondition(incomingText) || state.condition || "dor_cronica";
          const ev = EVIDENCE_DB[cond];
          if (ev) {
            state.evidence_used_count = Number(state.evidence_used_count || 0) + 1;
            reply = `${pickRandom(ev.testimony)}\n\n${ev.study}\n\n${ev.hope}` + getStageCTA(state);
          }
        }

      /* ═══════════════════════════════════════════════════════════════
         [CAMADA 2] — OBJECTION HANDLER
         ═══════════════════════════════════════════════════════════════ */

        if (!reply) {
          const objReply = handleObjection(flags, state, incomingText);
          if (objReply) reply = objReply;
        }
      }

      /* ═══════════════════════════════════════════════════════════════
         [CAMADA 3] — STATE MACHINE
         ═══════════════════════════════════════════════════════════════ */

      if (!reply) {

        // ── Abertura: sem stage e sem nome ──
        if (!state.stage && !state.nome) {
          // Verificar se a primeira mensagem já tem pergunta importante
          const firstQ = handleDirectQuestion(flags, state, incomingText);
          if (firstQ && !flags.wantsPrice) {
            // Responder a pergunta + pedir nome
            reply = firstQ.replace(/\n\nSe quiser.*$/, "") + "\n\nAntes de mais nada, qual é o seu *primeiro nome*? 😊";
          } else {
            reply = askNameIntroReply();
          }
          state.stage = "ASK_NAME";
        }

        // ── Captura do nome ──
        else if (state.stage === "ASK_NAME") {
          const nm = extractFirstName(incomingText);
          if (nm) {
            state.nome = nm;
            state.name_used_count = 0;

            // Se já temos problema detectado passivamente
            if (state.problem_text) {
              // ▸ Lead quente ou emocional: encurtar
              if (state.lead_profile === "quente" || flags.wantsBook) {
                state.stage = "ASK_DAY";
                reply = `Prazer, ${nm} 😊 Vou te mostrar os horários disponíveis.`;
                reply += "\n\n" + await askDayReply();
              }
              // ▸ Lead pragmático: acknowledger rápido + preço
              else if (state.lead_profile === "pragmatico" || flags.wantsPrice) {
                state.stage = "ASK_PLAN";
                const condLabel = state.condition ? { fibromialgia:"a fibromialgia", dor_cronica:"a dor", dor_lombar:"a dor na coluna", ansiedade:"a ansiedade", insonia:"o sono", artrose:"a artrose", artrite:"a artrite", enxaqueca:"a enxaqueca", dor_neuropatica:"a dor" }[state.condition] || "o que você mencionou" : "o que você mencionou";
                reply = `Prazer, ${nm} 😊 Entendi sobre ${condLabel}.\n\n${priceReply()}`;
              }
              // ▸ Outros: triagem adaptativa
              else {
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
            // Não conseguiu extrair nome — pode ser pergunta
            const directQ = handleDirectQuestion(flags, state, incomingText);
            if (directQ) {
              reply = directQ.replace(/\n\n(Se quiser|Qual|Me responde|Me passa|Seu horário).*$/, "") + "\n\nAntes de seguir, me diz seu *primeiro nome* 😊";
            } else {
              reply = "Antes de tudo, me diz seu *primeiro nome* 😊";
            }
          }
        }

        // ── Captura do problema ──
        else if (state.stage === "ASK_PROBLEM") {
          const pb = extractProblemText(incomingText);
          if (pb) {
            state.problem_text = pb;
            state.condition = state.condition || detectCondition(pb) || state.focus || null;

            // Triagem adaptativa
            state.stage = "DIAGNOSTIC";
            const nextQ = getNextDiagQuestion(state, incomingText);
            if (nextQ) {
              reply = nextQ;
            } else {
              // Paciente já contou tudo → bridge direto
              state.stage = "BRIDGE";
              reply = bridgeReply(state);
            }
          } else {
            // Texto não parece problema — GPT tenta extrair
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
          // Atualizar dados com a resposta
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

        // ── Bridge: pós-triagem, esperando confirmação para agenda ──
        else if (state.stage === "BRIDGE") {
          if (flags.wantsBook || flags.asksHours || flags.confirms) {
            state.stage = "ASK_DAY";
            reply = await askDayReply();
          } else if (flags.wantsPrice) {
            state.price_ask_count += 1;
            reply = priceReply();
            state.stage = "ASK_PLAN";
          } else {
            // GPT para conversa aberta pós-bridge
            const ai = await runLia({ incomingText, state, flags, stageCTA: "Se quiser, eu posso te mostrar os horários disponíveis" });
            if (ai.reply === "__NEED_BOOK__") { state.stage = "ASK_DAY"; reply = await askDayReply(); }
            else if (ai.reply === "__NEED_PRICE__") { state.price_ask_count += 1; reply = priceReply(); state.stage = "ASK_PLAN"; }
            else { reply = ai.reply; state = mergeState(state, ai.updates); }
          }
        }

        // ── Escolher dia ──
        else if (state.stage === "ASK_DAY") {
          const dayChoice = extractNumericChoice(incomingText);
          const explicitDate = extractDateKey(incomingText);
          const suggested = await getSuggestedDayKeys();

          if (dayChoice && suggested[dayChoice - 1]) {
            state.date_key = suggested[dayChoice - 1];
            state.stage = "OFFER_SLOTS";
            reply = await offerSlotsReply(state);
          } else if (explicitDate) {
            const avail = await getAvailableSlotsForDate(explicitDate);
            if (!avail.length) { reply = "Esse dia está sem vagas no momento 😕 Quer que eu te mostre outra data?"; }
            else { state.date_key = explicitDate; state.stage = "OFFER_SLOTS"; reply = await offerSlotsReply(state); }
          } else if (flags.confirms && suggested.length) {
            // "pode ser", "tanto faz" → sugerir o primeiro
            state.date_key = suggested[0];
            state.stage = "OFFER_SLOTS";
            reply = await offerSlotsReply(state);
          } else {
            // ▸ V14 FIX: Se a mensagem é longa (>40 chars) ou tem "?", provavelmente é pergunta, não escolha de dia.
            //   Usar GPT para responder naturalmente + CTA do stage, em vez de repetir "qual dia".
            if (incomingText.length > 40 || incomingText.includes("?")) {
              const ai = await runLia({ incomingText, state, flags, stageCTA: "Qual dia fica melhor para você?" });
              if (ai.reply === "__NEED_PRICE__") { state.price_ask_count += 1; reply = priceReply(); state.stage = "ASK_PLAN"; }
              else if (ai.reply === "__NEED_BOOK__") { reply = await askDayReply(); }
              else if (ai.reply.startsWith("__")) { reply = await askDayReply(); }
              else { reply = ai.reply; state = mergeState(state, ai.updates); }
            } else {
              reply = "Qual dia fica melhor para você? Pode me responder com o número ou com o dia, por exemplo *quinta-feira* 😊";
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
            // ▸ V14 FIX: Fallback GPT para mensagens longas/perguntas em OFFER_SLOTS
            if (incomingText.length > 40 || incomingText.includes("?")) {
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
            // ▸ V14: NÃO repetir explicação da consulta aqui (paciente já ouviu no bridge)
            reply = `Obrigada 😊\n\nHorário reservado: *${prettySlot(state.date_key, state.slot_time)}*.\n\n${priceReply()}`;
          } else {
            reply = "Me manda seu *e-mail* certinho, por favor.";
          }
        }

        // ── Escolha do plano ──
        else if (state.stage === "ASK_PLAN") {
          const planKey = extractPlanChoice(incomingText);

          if (planKey) {
            state.selected_plan_key = planKey;
            // Gerar pagamento
            const holdCheck = state.date_key && state.slot_time ? await acquireSlotHold(state.date_key, state.slot_time, phone) : { ok: true };
            if (state.date_key && !holdCheck.ok) {
              state.slot_time = null;
              state.slot_key = null;
              state.stage = "OFFER_SLOTS";
              reply = "Esse horário acabou de ser preenchido 😕 Vou te mostrar outras opções.\n\n" + (await offerSlotsReply(state));
            } else {
              if (holdCheck.slot_key) state.slot_key = holdCheck.slot_key;

              // Se ainda faltam dados, coletar
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
                // Tudo pronto → gerar pagamento
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
          }
          // ▸ Se paciente não escolheu plano e Camada 1/2 não respondeu
          else if (!reply) {
            // Tentar GPT para entender o que o paciente disse
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
              // Pergunta ou objeção já tratada na Camada 1/2.
              // Se chegou aqui, mensagem não é nem pergunta nem objeção.
              // GPT responde com naturalidade + reconecta ao link.
              const ai = await runLia({ incomingText, state, flags, stageCTA: `Seu horário continua reservado. Para confirmar é só finalizar aqui: ${state.payment.link}` });
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

        // ── Intenção de agendar (fora de stage) ──
        else if (flags.wantsBook || flags.asksHours) {
          if (!state.nome) { state.stage = "ASK_NAME"; reply = askNameIntroReply(); }
          else if (!state.problem_text) { state.stage = "ASK_PROBLEM"; reply = askProblemReply(state); }
          else if (!state.date_key) { state.stage = "ASK_DAY"; reply = await askDayReply(); }
          else if (!state.slot_time) { state.stage = "OFFER_SLOTS"; reply = await offerSlotsReply(state); }
          else { state.stage = "ASK_PLAN"; reply = priceReply(); }
        }

        // ── Intenção de preço (fora de stage) ──
        else if (flags.wantsPrice) {
          state.price_ask_count += 1;
          if (!state.nome) {
            if (state.price_ask_count >= 2) {
              state.stage = "ASK_PLAN";
              reply = priceReply();
            } else {
              state.stage = "ASK_NAME";
              reply = "Claro, vou te passar as opções 😊 Antes, me diz seu *primeiro nome*?";
            }
          } else {
            reply = priceReply();
            state.stage = "ASK_PLAN";
          }
        }

        // ── Intenção de pagar (fora de stage) ──
        else if (flags.intentPay) {
          if (state.payment?.status === "pending" && state.payment?.link) {
            reply = pendingPaymentReply(state);
            state.stage = "WAIT_PAYMENT";
          } else if (!state.date_key) {
            state.stage = "ASK_DAY";
            reply = `Perfeito 😊 Antes do pagamento, vou reservar seu horário.\n\n${await askDayReply()}`;
          } else {
            state.stage = "ASK_PLAN";
            reply = priceReply();
          }
        }

        // ── Recusa ──
        else if (flags.refuses) {
          reply = "Tranquilo, sem problema 😊 Se quiser tirar qualquer dúvida ou entender melhor como funciona, estou aqui.";
        }

      /* ═══════════════════════════════════════════════════════════════
         [CAMADA 4] — FALLBACK GPT
         ═══════════════════════════════════════════════════════════════ */

        else {
          const cta = getStageCTA(state);
          const ai = await runLia({ incomingText, state, flags, stageCTA: cta.trim() });

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
         ANTI-REPETIÇÃO + ENVIO
         ═══════════════════════════════════════════════════════════════ */

      // ▸ V14: Anti-repetição melhorado — nunca manda a mesma coisa
      // ▸ V14 FIX: Pular anti-repetição quando pagamento aprovado (repetir confirmação é esperado)
      if (state.payment?.status === "approved") {
        // OK — repetir afterPaidReply é comportamento correto
      } else if (!skipAntiRepeat && similar(reply, state.last_bot_reply)) {
        // Tentar avançar para próximo passo lógico
        if (!state.nome) reply = askNameIntroReply();
        else if (!state.problem_text) reply = askProblemReply(state);
        else if (!state.date_key) reply = await askDayReply();
        else if (!state.slot_time && state.date_key) reply = await offerSlotsReply(state);
        else if (!state.nome_completo) reply = askFullNameReply(state);
        else if (!state.birthdate) reply = askBirthdateReply(state);
        else if (!state.email) reply = askEmailReply();
        else if (state.payment?.link) reply = pendingPaymentReply(state);
        else reply = "Me conta: como posso te ajudar agora? 😊";
      }

      // Contar uso do nome
      if (state.nome && reply.includes(state.nome)) {
        state.name_used_count = Number(state.name_used_count || 0) + 1;
      }

      const delaySec = computeHumanDelay(flags, state);
      state.last_bot_reply = reply;
      state.last_user_message = incomingText;
      state.last_sent_at = Date.now();

      await saveUserState(phone, state);
      await sendWhatsApp(lead, bot, reply, delaySec);

    } catch (err) {
      console.error("❌ Erro no processamento:", err);
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
}

/* ═══════════════════════════════════════════════════════════════════
   SERVER
   ═══════════════════════════════════════════════════════════════════ */

const PORT = process.env.PORT || 10000;
if (!IS_SIMULATOR_MODE) {
  app.listen(PORT, () => console.log(`🚀 LIA V17 rodando na porta ${PORT}`));
}

// =========================================
// ADAPTER PARA SIMULADOR
// =========================================

async function responderLIA_simulador(mensagem, contexto = {}) {
  const persona = contexto.persona || {};
  const historico = Array.isArray(contexto.historico) ? contexto.historico : [];
  const effectiveHistorico =
    historico.length > 0 &&
    historico[historico.length - 1]?.speaker === "patient" &&
    norm(historico[historico.length - 1]?.text || "") === norm(mensagem)
      ? historico.slice(0, -1)
      : historico;
  const flags = detectIntent(mensagem);
  const personaCondition = detectCondition(persona.condicao_principal || "");
  const messageCondition = detectCondition(mensagem);
  const firstName = typeof persona.nome_ficticio === "string" ? persona.nome_ficticio.split(" ")[0] : null;
  const normalizedMessage = norm(mensagem);

  const state = {
    nome: firstName,
    condition: messageCondition || personaCondition || null,
    focus: messageCondition || personaCondition || null,
    problem_text: extractProblemText(mensagem) || persona.condicao_principal || null,
    stage: null,
    evidence_used_count: 0,
    lead_profile: classifyLead(flags, mensagem, { problem_text: extractProblemText(mensagem) || persona.condicao_principal || null }),
    date_key: null,
    slot_time: null,
    nome_completo: null,
    birthdate: null,
    email: null,
    selected_plan_key: "basic",
    payment: null,
    last_user_message: null,
    last_bot_reply: null,
    last_important_question: null,
    last_prepayment_question: null,
  };

  for (const item of effectiveHistorico) {
    const text = String(item.text || "");
    const low = norm(text);

    if (item.speaker === "lia") {
      state.last_bot_reply = text;
      if (
        text.includes("Essa semana ainda tenho horários disponíveis") ||
        low.includes("horarios disponiveis desta semana") ||
        low.includes("qual dia costuma ficar melhor") ||
        low.includes("qual dia fica melhor para voce") ||
        low.includes("qual dia fica melhor para você")
      ) {
        state.stage = "ASK_DAY";
      } else if (text.startsWith("Para *") && text.includes("Qual fica melhor")) {
        state.stage = "OFFER_SLOTS";
      } else if (low.includes("nome completo") && low.includes("data de nascimento") && (low.includes("e-mail") || low.includes("email"))) {
        state.stage = "ASK_CADASTRE";
      } else if (low.includes("nome completo")) {
        state.stage = "ASK_FULLNAME";
      } else if (low.includes("data de nascimento")) {
        state.stage = "ASK_BIRTHDATE";
      } else if (low.includes("e-mail") || low.includes("email")) {
        state.stage = "ASK_EMAIL";
      } else if (low.includes("hoje trabalhamos com estas opcoes") || low.includes("duas modalidades principais")) {
        state.stage = "ASK_PLAN";
      } else if (low.includes("para confirmar sua consulta, e so finalizar aqui") || low.includes("para confirmar, e so finalizar aqui")) {
        const linkMatch = text.match(/https?:\/\/\S+/i);
        state.payment = {
          status: "pending",
          link: linkMatch ? linkMatch[0] : "https://pagamento.teste/lia",
        };
        state.stage = "WAIT_PAYMENT";
      } else if (low.includes("pagamento confirmado") || low.includes("consulta esta marcada") || low.includes("consulta está marcada")) {
        state.payment = state.payment || { link: "https://pagamento.teste/lia" };
        state.payment.status = "approved";
        state.stage = "CONFIRMED";
      }
      continue;
    }

    if (!state.date_key) {
      const extractedDateKey = extractDateKey(text);
      if (extractedDateKey) state.date_key = extractedDateKey;
    }

    state.last_user_message = text;
    if (shouldTrackImportantQuestion(text, detectIntent(text))) {
      state.last_important_question = extractReferencedQuestion(text, state);
    }
    if (state.payment?.link && isFinalClarificationQuestion(text, detectIntent(text), state)) {
      state.last_prepayment_question = extractReferencedQuestion(text, state);
    }

    if (!state.slot_time) {
      const extractedTime = extractHourOnly(text);
      if (extractedTime) state.slot_time = extractedTime;
    }

    if (!state.nome_completo) {
      const fullName = extractFullName(text);
      if (fullName) state.nome_completo = fullName;
    }

    if (!state.birthdate) {
      const extractedBirthdate = extractBirthDate(text);
      if (extractedBirthdate) state.birthdate = extractedBirthdate;
    }

    if (!state.email) {
      const extractedEmail = extractEmail(text);
      if (extractedEmail) state.email = extractedEmail;
    }

    if (norm(text) === "aprovar_teste") {
      state.payment = state.payment || { link: "https://pagamento.teste/lia" };
      state.payment.status = "approved";
      state.stage = "CONFIRMED";
    }
  }

  const paymentWasRequested =
    state.payment?.link ||
    effectiveHistorico.some(
      (item) =>
        item.speaker === "lia" &&
        (norm(item.text || "").includes("para confirmar sua consulta, e so finalizar aqui") ||
          norm(item.text || "").includes("para confirmar, e so finalizar aqui") ||
          /https?:\/\/\S+/i.test(String(item.text || ""))),
    );

  if ((state.stage === "WAIT_PAYMENT" || paymentWasRequested) && normalizedMessage === "aprovar_teste") {
    state.payment = state.payment || { link: "https://pagamento.teste/lia" };
    state.payment.status = "approved";
    return afterPaidReply({
      ...state,
      date_key: state.date_key || "13-03",
      slot_time: state.slot_time || "19h",
    });
  }

  const prePaymentClarificationReply = maybeHandlePrePaymentClarification(state, flags, mensagem);
  if (prePaymentClarificationReply) return prePaymentClarificationReply;

  if (shouldTrackImportantQuestion(mensagem, flags)) {
    state.last_important_question = extractReferencedQuestion(mensagem, state);
  }

  const contextRepairReply = maybeHandleContextRepair(state, mensagem);
  if (contextRepairReply) return contextRepairReply;

  if (state.stage === "ASK_DAY") {
    let dateKey = extractDateKey(mensagem);
    if (!dateKey) {
      const numericChoice = extractNumericChoice(mensagem);
      const suggested = await getSuggestedDayKeys();
      if (numericChoice && suggested[numericChoice - 1]) dateKey = suggested[numericChoice - 1];
    }

    if (dateKey) {
      state.date_key = dateKey;
      return offerSlotsReply(state);
    }

    return await askDayReply();
  }

  if (state.stage === "OFFER_SLOTS") {
    let slotTime = extractHourOnly(mensagem);

    if (!slotTime) {
      const numericChoice = extractNumericChoice(mensagem);
      const best = await chooseBestSlotsForDate(state.date_key || "13-03", 3);
      if (numericChoice && best[numericChoice - 1]) slotTime = best[numericChoice - 1];
    }

    if (slotTime) {
      state.slot_time = slotTime;
      return askCadastreBundleReply({
        ...state,
        date_key: state.date_key || "13-03",
        slot_time: state.slot_time,
      });
    }

    return offerSlotsReply({
      ...state,
      date_key: state.date_key || "13-03",
    });
  }

  if (state.stage === "ASK_CADASTRE") {
    const fullName = extractFullName(mensagem);
    const birthdate = extractBirthDate(mensagem);
    const email = extractEmail(mensagem);

    if (fullName && birthdate && email) {
      state.nome_completo = fullName;
      state.birthdate = birthdate;
      state.email = email;
      const plan = PLANS[state.selected_plan_key || "basic"];
      const fakeLink = `https://pagamento.teste/${persona.id || "lead"}-${state.date_key || "13-03"}-${state.slot_time || "19h"}`;
      return paymentSentReply(plan, fakeLink, {
        ...state,
        date_key: state.date_key || "13-03",
        slot_time: state.slot_time || "19h",
      });
    }

    return askCadastreBundleReply({
      ...state,
      date_key: state.date_key || "13-03",
      slot_time: state.slot_time || "19h",
    });
  }

  if (state.stage === "ASK_FULLNAME") {
    const fullName = extractFullName(mensagem);
    if (fullName) {
      state.nome_completo = fullName;
      return askBirthdateReply({
        ...state,
        nome_completo: fullName,
      });
    }
    return "Me manda seu *nome completo* certinho, por favor.";
  }

  if (state.stage === "ASK_BIRTHDATE") {
    const birthdate = extractBirthDate(mensagem);
    if (birthdate) {
      state.birthdate = birthdate;
      return askEmailReply();
    }
    return "Me manda sua *data de nascimento* no formato *dd/mm/aaaa*.";
  }

  if (state.stage === "ASK_EMAIL") {
    const email = extractEmail(mensagem);
    if (email) {
      state.email = email;
      const plan = PLANS[state.selected_plan_key || "basic"];
      const fakeLink = `https://pagamento.teste/${persona.id || "lead"}-${state.date_key || "13-03"}-${state.slot_time || "19h"}`;
      return paymentSentReply(plan, fakeLink, {
        ...state,
        date_key: state.date_key || "13-03",
        slot_time: state.slot_time || "19h",
      });
    }
    return askEmailReply();
  }

  if (state.stage === "WAIT_PAYMENT" && state.payment?.link) {
    if (flags.intentPay || flags.asksPayMethod || normalizedMessage.includes("link")) {
      return pendingPaymentReply({
        ...state,
        date_key: state.date_key || "13-03",
        slot_time: state.slot_time || "19h",
      });
    }
  }

  const operationalCloseReply = await maybeHandleOperationalClose(state, flags, mensagem);
  if (operationalCloseReply) return operationalCloseReply;

  const priorityAnswer = getPriorityTrustAnswer(state, mensagem);
  if (priorityAnswer) return priorityAnswer + getStageCTA(state);

  if (flags.wantsPrice) {
    return "Hoje a consulta com o Dr. Alef tem duas modalidades principais: avaliação inicial por R$347 e acompanhamento com retorno por R$447. Se quiser, eu te explico rapidinho qual costuma fazer mais sentido para cada caso 😊";
  }

  const directAnswer = handleDirectQuestion(flags, state, mensagem);
  if (directAnswer) return directAnswer;

  const objectionAnswer = handleObjection(flags, state, mensagem);
  if (objectionAnswer) return objectionAnswer;

  if (flags.wantsBook || flags.asksHours || flags.confirms) {
    return "Consigo sim 😊 A consulta é 100% online e eu posso te mostrar os horários disponíveis desta semana. Qual dia costuma ficar melhor para você?";
  }

  if (flags.asksIfWorks) {
    return "Essa é uma dúvida muito comum. Muita gente procura o Dr. Alef justamente depois de já ter tentado outros caminhos. A consulta serve para avaliar com honestidade se existe indicação real para o seu caso, com segurança e sem promessa vazia.\n\nSe fizer sentido, eu posso te explicar como funciona a avaliação 😊";
  }

  if (state.problem_text || state.condition || persona.condicao_principal) {
    return bridgeReply(state);
  }

  return `Entendi, ${state.nome || "tudo bem"} 😊 Antes de te orientar melhor, me conta rapidinho o que mais tem te incomodado hoje?`;
}

module.exports = { responderLIA_simulador };
 *
 * 2. FUNIL ABERTO NO FECHAMENTO — perguntas durante agendamento/
 *    pagamento são respondidas + CTA do stage na mesma mensagem.
 *
 * 3. TRIAGEM ADAPTATIVA — 0 a 3 perguntas, pula o que o paciente
 *    já contou. Nunca mais formulário rígido.
 *
 * 4. PERSUASÃO COM ESPERANÇA — testimony da secretária que vê
 *    resultados todos os dias. Dados confirmam, não lideram.
 *
 * 5. LEAD CLASSIFIER — detecta perfil (quente, pragmático,
 *    desconfiado, cético, comparador, frio, emocional) e adapta rota.
 *
 * 6. FOLLOW-UP — 3 tentativas de reengajamento para leads silenciosos.
 *
 * 7. EXTRAÇÃO DE NOME CORRIGIDA — nunca mais chama de "Pode".
 *
 * 8. RECONHECIMENTO ROBUSTO DE PLANO — matching flexível.
 *
 * 9. SYSTEM PROMPT COM CONVICÇÃO — GPT age como secretária que
 *    acredita no tratamento porque vê resultado real.
 *
 * 10. EVIDENCE DATABASE EXPANDIDA — empatia + testimony + study +
 *     hope + bridge + future por condição.
 *
 * PRESERVADO DA V13:
 * - Express/Twilio/Postgres/MercadoPago setup
 * - Slot lock/hold system
 * - PLANS e FIXED_SCHEDULE
 * - Funções utilitárias (sleep, randInt, pad2, etc.)
 * - Funções de agenda (getAvailableSlots, chooseBestSlots, etc.)
 * - Webhook MP e payment flow
 * - Human delay system
 *
 * ═══════════════════════════════════════════════════════════════════
 */

const IS_SIMULATOR_MODE = process.env.LIA_SIMULATOR_MODE === "1";

function createNoopApp() {
  return {
    use() {},
    get() {},
    post() {},
    listen() {},
  };
}

let express;
let bodyParser;
let twilio;
let Pool;
let OpenAI;
let app;

if (IS_SIMULATOR_MODE) {
  express = Object.assign(() => createNoopApp(), {
    json: () => (_req, _res, next) => (typeof next === "function" ? next() : undefined),
  });
  bodyParser = {
    urlencoded: () => (_req, _res, next) => (typeof next === "function" ? next() : undefined),
  };
  twilio = Object.assign(
    () => ({
      messages: { create: async () => ({ sid: "simulated" }) },
    }),
    {
      twiml: {
        MessagingResponse: class MessagingResponse {
          toString() {
            return "";
          }
        },
      },
    },
  );
  Pool = class PoolStub {
    on() {}
    async query() {
      return { rows: [] };
    }
  };
  OpenAI = class OpenAIStub {
    constructor() {
      this.chat = {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "" } }],
          }),
        },
      };
    }
  };
  app = createNoopApp();
} else {
  express = require("express");
  bodyParser = require("body-parser");
  twilio = require("twilio");
  ({ Pool } = require("pg"));
  OpenAI = require("openai");

  app = express();
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(express.json());
  app.use("/mp", express.json({ type: ["application/json", "text/json", "*/*"] }));
}

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

/* ═══════════════════════════════════════════════════════════════════
   PLANS + SCHEDULE (preservado da V13)
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

// ▸ COMENTÁRIO ESTRATÉGICO: Adicionei "description" a cada plano para que a LIA
//   possa explicar o que inclui sem precisar de texto hardcoded. Resolve o erro
//   do paciente 1 (Ana) que perguntou "o que inclui?" e não recebeu resposta.

const FIXED_SCHEDULE = {
  "11-03": { dayName: "quarta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "12-03": { dayName: "quinta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
  "13-03": { dayName: "sexta-feira", slots: ["9h","10h","11h","12h","13h","14h","15h","16h","17h","18h","19h","20h","21h"] },
};

const PREMIUM_SLOT_PRIORITY = ["19h","18h","20h","17h","21h","16h","15h","14h","13h","12h","11h","10h","9h"];
const WEEKDAY_PT = ["domingo","segunda-feira","terça-feira","quarta-feira","quinta-feira","sexta-feira","sábado"];

/* ═══════════════════════════════════════════════════════════════════
   DATABASE (preservado da V13)
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
  console.log("✅ Tabelas prontas.");
}
if (!IS_SIMULATOR_MODE) {
  initDB().catch((e) => console.error("❌ initDB erro:", e));
}

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
   UTILITÁRIOS (preservado da V13)
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
  // ▸ V14: reduzi de 1100 para 900 para forçar mensagens menores no WhatsApp
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
   DATE/SCHEDULE UTILS (preservado da V13)
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
   EXTRACTORS — REESCRITOS PARA V14
   ═══════════════════════════════════════════════════════════════════ */

/**
 * ▸ MUDANÇA CRÍTICA: extractFirstName agora parseia corretamente:
 *   - "Pode me chamar de Carlos" → Carlos
 *   - "Me chama de Ana" → Ana
 *   - "Sou o Ricardo" → Ricardo
 *   - "É Juliana" → Juliana
 *   - "Paulo aqui" → Paulo
 *   - "Ana" → Ana
 *   Isso resolve o bug #1 que apareceu em 8 de 9 pacientes simulados.
 */
function extractFirstName(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const low = norm(t);

  // Rejeitar se for apenas confirmação/problema sem nome
  if (/^(sim|ok|beleza|pode|claro|show|tanto faz|nao|não)$/.test(low)) return null;
  if (/^(dor|sono|ansiedade|fibromialgia|insônia|insonia|artrose|artrite|coluna)$/.test(low)) return null;

  // Se a mensagem parece pergunta ou frase longa, não é nome
  if ((t.includes("?") || low.split(" ").length > 6)) return null;
  if (/\b(quanto|como|qual|onde|quando|porque|por que|isso|esse|essa|vocês|voces)\b/.test(low)) return null;

  // Padrões de introdução de nome — ORDEM IMPORTA
  const patterns = [
    /(?:pode\s+(?:me\s+)?chamar?\s+(?:de\s+)?)\s*(.+)/i,
    /(?:me\s+cham(?:a|o|e)\s+(?:de\s+)?)\s*(.+)/i,
    /(?:(?:eu\s+)?sou\s+(?:o|a)\s+)\s*(.+)/i,           // "sou o Carlos" (exige artigo)
    /(?:(?:meu\s+)?nome\s+(?:e|é)\s+)\s*(.+)/i,
    /^(.+?)(?:\s+aqui)$/i,                                // "Paulo aqui" (exige início de frase)
  ];

  let candidate = null;
  for (const p of patterns) {
    const m = t.match(p);
    if (m && m[1]) {
      candidate = m[1].trim();
      break;
    }
  }

  // Se nenhum padrão casou, usar texto inteiro como candidato
  if (!candidate) candidate = t;

  // Limpar pontuação
  candidate = candidate.replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!candidate) return null;

  const parts = candidate.split(" ").filter(Boolean);
  if (parts.length < 1 || parts.length > 5) return null;
  if (/^\d+$/.test(candidate)) return null;

  // Rejeitar se parecer nome de condição médica
  const condWords = /^(dor|sono|ansiedade|fibromialgia|artrose|artrite|enxaqueca|coluna|insônia|insonia|lombar|neuropat)/i;
  if (condWords.test(parts[0]) && parts.length <= 2) return null;

  // Rejeitar palavras comuns que não são nomes
  const notNames = /^(oi|ola|olá|bom|boa|dia|tarde|noite|tudo|bem|obrigad|brigad|quero|preciso|gostaria|tenho|sim|nao|não|legal|caro|certo|entendi|entendo|sera|será|claro|ok|verdade|seria|acho|pode|pois|tipo|vou|vai|meu|minha)$/i;
  if (notNames.test(parts[0])) return null;

  // Retornar primeiro nome capitalizado
  return parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
}

function extractFullName(text) {
  const cleaned = (text || "").replace(/[^\p{L}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length < 2) return null;
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
  // ▸ V14 FIX: Derivar meses válidos do FIXED_SCHEDULE (em vez de hardcode mês 3)
  const validMonths = new Set(Object.keys(FIXED_SCHEDULE).map(k => Number(k.split("-")[1])));
  const m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})\b/);
  if (m) {
    const dd = Number(m[1]), mm = Number(m[2]);
    if (dd >= 1 && dd <= 31 && validMonths.has(mm)) return makeDateKey(dd, mm);
  }
  // ▸ V14 FIX: Gerar mapeamento de dia da semana dinâmico do FIXED_SCHEDULE
  const dayNameMap = {};
  for (const [key, val] of Object.entries(FIXED_SCHEDULE)) {
    const dayNorm = norm(val.dayName);
    dayNameMap[dayNorm] = key;
  }
  const low = norm(t);
  for (const [dayNorm, dateKey] of Object.entries(dayNameMap)) {
    if (low.includes(dayNorm)) return dateKey;
  }
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

/**
 * ▸ MUDANÇA CRÍTICA: extractPlanChoice agora usa matching flexível.
 *   "acho que a opção 2 faz mais sentido pra mim" → basic (antes falhava)
 *   "prefiro a avaliação" → basic
 *   "quero o acompanhamento" → full
 *   Resolve o bug do paciente 2 (Carlos) onde a escolha não foi reconhecida.
 */
function extractPlanChoice(text) {
  const t = norm(text);

  // Match direto por número (flexível, não precisa ser exato)
  if (/\b1\b/.test(t) && !/\b2\b/.test(t) && !/\b3\b/.test(t)) return "full";
  if (/\b2\b/.test(t) && !/\b1\b/.test(t) && !/\b3\b/.test(t)) return "basic";
  if (/\b3\b/.test(t) && !/\b1\b/.test(t) && !/\b2\b/.test(t)) return "retorno";

  // Match por palavras-chave do plano
  if (/(acompanhamento|com retorno|retorno em 30|retorno incluso|primeira opcao|primeira opção|opcao 1|opção 1)/.test(t)) return "full";
  if (/(avaliacao|avaliação|so a consulta|só a consulta|consulta inicial|segunda opcao|segunda opção|opcao 2|opção 2)/.test(t)) return "basic";
  if (/(retorno avulso|consulta de ajuste|ajuste|terceira opcao|terceira opção|opcao 3|opção 3|apenas retorno)/.test(t)) return "retorno";

  // Match por contexto (exige mais palavras juntas para evitar falso positivo)
  if (/(prefiro a avaliacao|prefiro a avaliação|quero a avaliacao|quero a avaliação|so a avaliacao|só a avaliação|comecar com a avaliacao|começar com a avaliação)/.test(t)) return "basic";
  if (/(quero o acompanhamento|prefiro o acompanhamento|quero o pacote|pacote completo)/.test(t)) return "full";

  return null;
}

/* ═══════════════════════════════════════════════════════════════════
   CONDITION DETECTION (expandido na V14)
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
   INTENT DETECTION — V14 EXPANDIDO
   ═══════════════════════════════════════════════════════════════════
   ▸ MUDANÇA: Adicionadas novas flags para detectar perguntas que
   antes eram ignoradas: asksWhatIncludes, asksMedCost, asksIfForMe,
   asksDifferential, asksCanReschedule, asksPrivacy, asksRecipe
   ═══════════════════════════════════════════════════════════════════ */

function detectIntent(text) {
  const t = norm(text);

  return {
    // Intenções comerciais
    wantsPrice:       /\b(preco|preço|valor|quanto custa|investimento|custa|valores|quanto e|quanto é)\b/.test(t),
    intentPay:        /\b(como (pagar|fa[cç]o para pagar)|pagar|pagamento|pix|cartao|cartão|credito|crédito|debito|débito|boleto|link|parcel|parcela|quero pagar)\b/.test(t),
    // ▸ V14 FIX: Removido "marcar", "agendar", "agenda" standalone (falso positivo: "antes de marcar consulta")
    //   Agora exige verbo de intenção: quero/vou/posso/queria/gostaria/preciso + marcar/agendar
    wantsBook:        /\b(quero marcar|quero agendar|vou marcar|vou agendar|queria marcar|queria agendar|gostaria de (marcar|agendar)|posso (marcar|agendar)|preciso (marcar|agendar)|bora (marcar|agendar)|confirmar consulta|quero consulta|quero uma vaga|me agenda|tem horario|tem horário)\b/.test(t),
    asksHours:        /\b(horarios|horário|horario|que horas|vagas|disponibilidade)\b/.test(t),

    // Confirmação / Recusa
    confirms:         /\b(sim|ok|beleza|confirmo|fechado|vamos|pode ser|confirmar|bora|vamos la|vamos lá|com certeza|claro que sim)\b/.test(t),
    refuses:          /\b(nao quero|não quero|pare|para|chega|desisto|cancela)\b/.test(t),

    // Perguntas diretas (Question Priority Engine)
    asksHowConsultWorks: /\b(como funciona|como e a consulta|como é a consulta|o que acontece na consulta)\b/.test(t),
    asksIfOnline:     /\b(e online|é online|online mesmo|presencial|precisa ir|tem que ir|por video|por vídeo)\b/.test(t),
    asksLegal:        /\b(legal no brasil|e legal|é legal|precisa de receita|receita|anvisa|legalizado|regularizado)\b/.test(t),
    asksChapado:      /\b(chapado|chapar|maconha mesmo|isso e maconha|isso é maconha|droga|fico alterado|ficar alterado)\b/.test(t),
    asksWho:          /\b(quem e|quem eh|quem é|quem e o dr|quem é o dr|quem e o doutor|quem é o doutor)\b/.test(t),
    // ▸ V14 FIX: Expandido para cobrir "costuma ajudar", "realmente ajuda", "faz diferença", etc.
    asksIfWorks:      /\b(funciona|vale a pena|ajuda mesmo|ajuda pra|ajuda para|costuma ajudar|costuma funcionar|costuma melhorar|realmente ajuda|realmente funciona|melhora mesmo|tem resultado|faz efeito|faz diferenca|faz diferença|resolve mesmo|e eficaz|é eficaz|tem eficacia|tem eficácia|da resultado|dá resultado|funciona mesmo|funciona de verdade)\b/.test(t),
    // ▸ V14 FIX: Expandido para cobrir "casos como o meu", "no meu caso", "pra quem tem [cond]"
    asksIfForMe:      /\b(serve pra mim|serve para mim|é só para|e so para|é pra caso grave|serve pra quem|funciona pra quem|ajuda quem tem|ajudar quem tem|precisa ter diagnostico|precisa ter diagnóstico|mesmo sem diagnostico|mesmo sem diagnóstico|no meu caso|meu caso|casos como o meu|como o meu|indicado pra|indicado para|pra quem tem)\b/.test(t),
    asksDifferential: /\b(diferença|diferenca|diferencial|por que o dr|por que o doutor|o que muda|o que diferencia|comparando)\b/.test(t),
    asksWhatIncludes: /\b(inclui o que|o que inclui|o que ta incluido|o que tá incluído|o que vem|o que tem dentro|explica o plano|explica a opcao|explica a opção)\b/.test(t),
    asksMedCost:      /\b(medicamento.*cust|remedio.*cust|remedío.*cust|caro.*depois|custo.*mensal|quanto.*mes|quanto.*mês|gast.*por mes|gast.*por mês|tratamento.*cust)\b/.test(t),
    asksRecipe:       /\b(saio com receita|recebo receita|ja sai com|já sai com|prescrição|prescricao)\b/.test(t),
    asksCanReschedule:/\b(remarcar|reagendar|trocar.*horario|trocar.*horário|mudar.*data|cancelar.*consulta)\b/.test(t),
    asksPrivacy:      /\b(sigilo|sigiloso|ninguem fica sabendo|ninguém fica sabendo|privacidade|discreto)\b/.test(t),
    asksStartNow:     /\b(como tomar|dose|dosagem|quantas gotas|comecar agora|começar agora|comprar.*remedío|comprar.*remedio)\b/.test(t),
    // ▸ V14 FIX: Removido "verdade" (falso positivo com "é verdade que funciona?"). Adicionado "e verdade" como frase
    asksIsScam:       /\b(golpe|fraude|piramide|pirâmide|e serio|é sério|confiavel|confiável|consulta.*mesmo|e verdade isso|é verdade isso|isso e verdade|isso é verdade)\b/.test(t),
    asksPayMethod:    /\b(parcela|parcelar|forma.*pagamento|aceita.*pix|aceita.*cartao|aceita.*cartão)\b/.test(t),

    // Objeções
    saysExpensive:    /\b(caro|caríssim|carissim|achei caro|muito caro|pesado|puxado)\b/.test(t),
    saysWillSee:      /\b(vou ver|depois te falo|vou confirmar|vou pensar|te aviso|depois vejo|preciso pensar)\b/.test(t),
    saysUnsure:       /\b(nao tenho certeza|não tenho certeza|nao sei|não sei|sera|será|to na duvida|tô na dúvida|duvida|dúvida)\b/.test(t),
    saysCheaperElsewhere: /\b(mais barato|medico.*barato|médico.*barato|outro.*medico|outro.*médico|pesquisando)\b/.test(t),
    // ▸ V14 FIX: Exigir contexto de 1ª pessoa para evitar falso positivo ("minha mulher tem fibro")
    saysCheckSpouse:  /\b(minha?\s+(esposa|marido|mulher)|falar com\s+(esposa|marido|mulher)|vou ver com\s+(esposa|marido|mulher|familia|família)|conversar\s+(com\s+)?(esposa|marido|mulher|familia|família)\s+antes|combinar\s+com)\b/.test(t),
    saysIndecisive:   /\b(tanto faz|qual voce acha|qual você acha|nao sei qual|não sei qual|me indica|me recomenda)\b/.test(t),

    // Urgência
    urgency:          /\b(dor no peito|falta de ar|desmaio|avc|convuls|paralisia|confusao|confusão)\b/.test(t),

    // Emoção forte
    strongPain:       /\b(nao aguento|não aguento|to sofrendo|tô sofrendo|muito ruim|muito dificil|muito difícil|desespero|nao consigo mais|não consigo mais|ajuda|socorro)\b/.test(t),

    // Focus (condição detectada no texto)
    focus: detectCondition(text),
  };
}

/* ═══════════════════════════════════════════════════════════════════
   LEAD CLASSIFIER — NOVO NA V14
   ═══════════════════════════════════════════════════════════════════
   ▸ Detecta o perfil do lead logo nas primeiras interações para
   adaptar a rota. Salvo no state como lead_profile.
   ═══════════════════════════════════════════════════════════════════ */

function classifyLead(flags, text, state) {
  // Se já classificado, manter (pode ser reclassificado em casos fortes)
  const t = norm(text);

  if (flags.strongPain) return "emocional";
  // ▸ V14 FIX: Removido "verdade" (falso positivo com "é verdade que funciona?")
  if (flags.asksIsScam || /\b(golpe|fraude|serio|sério)\b/.test(t)) return "desconfiado";
  // ▸ V14 FIX: Usa flags (já corrigido) em vez de regex extra com "quero marcar" (redundante)
  if (flags.wantsBook || flags.asksHours) return "quente";
  if (flags.wantsPrice && !state.problem_text) return "pragmatico";
  if (flags.asksDifferential || flags.saysCheaperElsewhere || /\b(pesquisando|comparando)\b/.test(t)) return "comparador";
  if (flags.asksIfForMe || /\b(serve pra mim|caso grave|sem diagnostico|sem diagnóstico)\b/.test(t)) return "frio";
  if (flags.asksIfWorks && /\b(promessa|tentei tudo|nada funciona|cansado)\b/.test(t)) return "cetico";
  if (flags.asksIfWorks) return "cetico";

  return state.lead_profile || "padrao";
}

/* ═══════════════════════════════════════════════════════════════════
   SLOT MANAGEMENT (preservado da V13)
   ═══════════════════════════════════════════════════════════════════ */

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
   EVIDENCE DATABASE — V14 EXPANDIDA
   ═══════════════════════════════════════════════════════════════════
   ▸ Nova estrutura: empathy + testimony + study + hope + bridge + future
   ▸ "testimony" é a perspectiva da secretária que vê resultados reais.
   ▸ "future" é a visualização de futuro melhor que ajuda o paciente
     a acreditar no tratamento (adesão terapêutica).
   ═══════════════════════════════════════════════════════════════════ */

const EVIDENCE_DB = {
  fibromialgia: {
    empathy: [
      "Fibromialgia desgasta o corpo e a mente. Quem tem sabe que não é só dor — é exaustão, sono ruim, o corpo nunca descansa.",
      "Fibromialgia é muito mais do que dor. É acordar cansada, é o corpo pesado, é a sensação de que nada resolve de verdade.",
    ],
    testimony: [
      "O que eu vejo aqui no dia a dia é que muita gente com fibromialgia que começa o acompanhamento com o Dr. Alef volta no retorno relatando que a dor diminuiu bastante e que conseguiu dormir melhor pela primeira vez em anos.",
      "Acompanho esse consultório todos os dias, e o que eu posso te dizer é que muita gente que chega com esse mesmo quadro percebe melhora real depois de algumas semanas.",
    ],
    study: "Estudos clínicos mostram redução de até *60% na intensidade da dor* em pacientes com fibromialgia.",
    hope: "Não prometo nada porque cada caso é diferente, mas posso te dizer que existe um caminho real para quem está nessa situação.",
    bridge: "A avaliação serve justamente para entender se esse caminho faz sentido para você.",
    future: [
      "Imagina voltar a dormir a noite inteira e acordar com menos dor. Muita gente aqui conseguiu isso.",
      "Muita gente me diz que quando a dor diminui e o sono melhora, parece que a vida volta.",
    ],
  },
  dor_cronica: {
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
    future: [
      "Poder sentar, dirigir, trabalhar sem aquela dor travando tudo — muita gente aqui conseguiu.",
    ],
  },
  dor_neuropatica: {
    empathy: [
      "Dor neuropática é uma das dores mais difíceis de tratar. Queimação, choque, formigamento — incomoda demais.",
    ],
    testimony: [
      "Pacientes com dor neuropática que acompanham aqui costumam relatar melhora significativa, principalmente na intensidade das crises.",
    ],
    study: "Estudos mostram melhora de *30–50%* em parte dos pacientes com dor neuropática.",
    hope: "Dor neuropática é difícil, mas não é sem saída.",
    bridge: "O Dr. Alef avalia com cuidado o tipo de dor e o que faz sentido no seu caso.",
    future: ["Muita gente relata que as crises ficam mais espaçadas e bem menos intensas."],
  },
  ansiedade: {
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
    future: [
      "Muita gente me diz que a sensação de conseguir relaxar de verdade pela primeira vez é indescritível.",
    ],
  },
  insonia: {
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
    empathy: [
      "Artrose limita movimento, causa dor constante e atrapalha até as tarefas mais simples.",
    ],
    testimony: [
      "Muita gente com artrose que chega aqui, especialmente quem já fez infiltração sem resultado duradouro, volta relatando que conseguiu voltar a se movimentar com menos dor.",
    ],
    study: "Estudos indicam redução de dor e melhora funcional na faixa de *30–50%* em parte dos pacientes.",
    hope: "Para quem está limitado pela artrose, existe uma possibilidade real de melhora.",
    bridge: "A avaliação leva em conta seu histórico e a articulação afetada para definir o melhor caminho.",
    future: ["Poder caminhar sem aquela dor constante — muita gente aqui conseguiu isso."],
  },
  artrite: {
    empathy: ["Artrite causa dor, rigidez e inflamação que atrapalham bastante o dia a dia."],
    testimony: ["Pacientes com artrite que acompanham aqui costumam relatar melhora na dor articular e na rigidez."],
    study: "Estudos mostram melhora de dor e inflamação em parte dos pacientes com artrite.",
    hope: "Existe caminho para aliviar esses sintomas com segurança.",
    bridge: "Isso precisa ser avaliado considerando suas medicações e histórico.",
    future: ["Menos dor e mais liberdade de movimento — é o que muita gente relata."],
  },
  enxaqueca: {
    empathy: ["Enxaqueca pode ser extremamente incapacitante. Uma crise pode parar o dia inteiro."],
    testimony: ["Muita gente com enxaqueca que acompanha aqui relata que as crises ficaram menos frequentes e menos intensas."],
    study: "Estudos indicam redução da frequência e intensidade das crises em parte dos pacientes.",
    hope: "Ter menos crises e crises mais leves — isso é possível.",
    bridge: "A avaliação analisa frequência, gatilhos e histórico para definir a melhor abordagem.",
    future: ["Ter semanas sem crise, e quando vem, ser mais leve — muita gente aqui relata isso."],
  },
};

function buildEvidenceMessage(condition, options = {}) {
  const ev = EVIDENCE_DB[condition];
  if (!ev) return null;

  const empathy = pickRandom(ev.empathy);
  const testimony = pickRandom(ev.testimony);
  const future = options.includeFuture ? `\n\n${pickRandom(ev.future)}` : "";

  return `${empathy}\n\n${testimony}\n\n${ev.study}\n\n${ev.hope}${future}\n\n${ev.bridge}`;
}

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
   REPLY TEMPLATES — V14 REESCRITOS
   ═══════════════════════════════════════════════════════════════════ */

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

// ▸ V14: perguntas diagnósticas separadas, para uso condicional

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

/**
 * ▸ Bridge: momento mais persuasivo da conversa.
 *   VERSÃO CONDENSADA para WhatsApp: testimony + dado + consult + CTA.
 *   Sem empathy (já foi expressada), sem future (reservado para objeções).
 */
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

  // ▸ V14 FIX: Lead emocional recebe future no bridge (spec 6.2: "Testimony + future no bridge")
  let future = "";
  if (state.lead_profile === "emocional" && ev?.future) {
    future = `\n\n${pickRandom(ev.future)}`;
  }

  const consult = "A avaliação é *100% online*, dura em média *45 minutos* e é individualizada para o seu caso.";
  const cta = "Se quiser, eu posso te mostrar os horários disponíveis 😊";

  return `${intro}\n\n${testimony}${study}${future}\n\n${consult}\n\n${cta}`;
}

async function askDayReply() {
  const dayKeys = await getSuggestedDayKeys();
  if (!dayKeys.length) return "No momento os horários desta semana já estão completos. Quer que eu te coloque na lista de prioridade? 😊";
  const opts = dayKeys.map((d, i) => `${i + 1}) *${formatDatePt(d)}*`).join("\n");
  return `Perfeito 😊\n\nEssa semana ainda tenho horários disponíveis:\n\n${opts}\n\nQual fica melhor para você?`;
}

async function offerSlotsReply(state) {
  const dateKey = state.date_key;
  const best = await chooseBestSlotsForDate(dateKey, 3);
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

function askCadastreBundleReply(state) {
  return (
    `Perfeito. Vou reservar *${prettySlot(state.date_key, state.slot_time)}* para você 😊\n\n` +
    "Para te mandar o link e deixar tudo certinho, me envia nesta ordem:\n" +
    "1. *nome completo*\n" +
    "2. *data de nascimento*\n" +
    "3. *e-mail*"
  );
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
    `Perfeito, reserva confirmada ✅\n\n` +
    `📅 *${prettySlot(state.date_key, state.slot_time)}*\n\n` +
    `Plano: *${plan.label}* — R$${plan.price}\n\n` +
    `Para confirmar sua consulta, é só finalizar aqui:\n${link}\n\n` +
    `Assim que o pagamento entrar, eu confirmo tudo por aqui 😊\n\n` +
    `Se tiver qualquer dificuldade, me avisa que eu te ajudo.`
  );
}

function pendingPaymentReply(state) {
  return (
    `Seu horário continua reservado 😊\n\n` +
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
   QUESTION ANSWERS BANK — NOVO NA V14
   ═══════════════════════════════════════════════════════════════════
   ▸ Respostas prontas para perguntas diretas. Cada uma retorna
   a resposta SEM CTA (o CTA é adicionado pelo caller baseado no stage).
   ═══════════════════════════════════════════════════════════════════ */

const QUESTION_ANSWERS = {
  howConsultWorks: "A avaliação com o Dr. Alef é *100% online, por videochamada*, dura em média *45 minutos* e é totalmente individualizada. Ele entende seu histórico, o que mais te incomoda hoje, o que você já tentou, quais medicações usa e avalia com cuidado se esse tratamento faz sentido no seu caso.",

  howConsultWorksOperational: "Funciona assim: a consulta é *100% online*, dura em média *45 minutos* e o Dr. Alef avalia seu histórico, sintomas, remédios em uso e objetivo com o tratamento. Se houver indicação, ele já explica o caminho mais seguro e o próximo passo prático.",

  scheduleHours: "Consigo te passar os horários por aqui mesmo. O próximo passo é escolher o dia para eu abrir as vagas disponíveis e já avançar sua reserva.",

  isOnline: "Sim 😊 A consulta é *100% online*, por videochamada. Você faz de onde estiver, sem precisar se deslocar.",

  isLegal: "Sim 😊 O uso medicinal de canabinoides é legal no Brasil quando existe avaliação e prescrição médica, seguindo as normas da Anvisa. Na prática, funciona assim: consulta, definição do produto, prescrição se houver indicação e orientação do caminho de acesso por farmácia ou importação.",

  legalPathOperational: "Na prática funciona assim: se o tratamento fizer sentido para você, o próprio Dr. Alef faz a prescrição e orienta qual é o caminho de acesso mais adequado, seja farmácia no Brasil ou importação regularizada. Você não precisa descobrir isso sozinho(a).",

  chapado: "Essa é uma das dúvidas mais comuns 😊 No tratamento medicinal, o objetivo não é deixar ninguém alterado. São formulações específicas, com dose controlada e acompanhamento médico. Quando o foco é CBD, a proposta é aliviar sintomas com segurança e preservar sua rotina.",

  whoIsDrAlef: "Essa é uma dúvida muito justa, porque realmente existe muita gente despreparada nessa área. No caso do Dr. Alef Kotula, ele se formou em medicina em uma das melhores faculdades da Rússia, viveu seis anos na Europa e ainda tem pós-graduação internacional em cannabis medicinal. Então não se trata de alguém que entrou nisso por modinha, mas de um médico com formação sólida e preparo específico para avaliar esse tipo de tratamento.",

  isScam: "Essa é uma dúvida muito justa, porque realmente existe muita gente despreparada nessa área. No caso do Dr. Alef Kotula, ele se formou em medicina em uma das melhores faculdades da Rússia, viveu seis anos na Europa e ainda tem pós-graduação internacional em cannabis medicinal. Então não se trata de alguém que entrou nisso por modinha, mas de um médico com formação sólida e preparo específico para avaliar esse tipo de tratamento.",

  recipe: "Se o Dr. Alef entender que faz sentido para o seu caso, sim — ele faz a prescrição na própria consulta e já orienta o próximo passo de acesso 😊",

  prescriberOperational: "Quem prescreve é o próprio Dr. Alef, caso ele veja indicação médica real no seu caso. A consulta serve justamente para avaliar isso com critério e já deixar claro qual é o próximo passo.",

  medCost: "O custo do tratamento pode variar conforme o tipo de produto e a dose. Na consulta, o Dr. Alef avalia o seu caso pensando também no que é viável para você e explica qual caminho costuma fazer mais sentido em termos de segurança, acesso e custo recorrente 😊",

  canReschedule: "Pode sim 😊 É só me avisar com antecedência que a gente reorganiza.",

  privacy: "Total sigilo 😊 A consulta é individual, por telemedicina, e tudo segue as normas de sigilo médico.",

  startNow: "Entendo sua vontade de começar 😊 Por segurança, eu não consigo orientar dose ou forma de uso por aqui — isso depende da avaliação médica. Mas a boa notícia é que na consulta o Dr. Alef já orienta os próximos passos.",

  payMethod: "Depois que eu reservo seu horário e fecho o cadastro básico, eu envio o link por aqui mesmo. Aceita cartão, Pix e boleto 😊",

  nextStepOperational: "O próximo passo é simples: eu reservo seu horário, peço os dados básicos para cadastro e, com isso certo, envio o link de pagamento aqui mesmo. Assim que o pagamento entra, eu confirmo a consulta no mesmo chat.",

  paymentFlowOperational: "O link entra depois que o horário fica reservado e o cadastro básico está ok. Eu mando aqui mesmo, e assim que o pagamento entra a consulta fica confirmada por aqui.",

  isForMe: "Muita gente que chega aqui tem exatamente esse perfil 😊 Não precisa ter diagnóstico fechado nem ser caso grave. A avaliação serve justamente para entender se esse tratamento faz sentido para o seu caso, com segurança.",

  differential: "O que costuma diferenciar aqui é que o Dr. Alef faz uma avaliação bem individualizada, revisa com cuidado suas medicações e interações, e não trabalha com protocolo pronto. Muita gente procura justamente depois de já ter passado por abordagens mais genéricas.",

  consultEvaluation: "Na consulta, o Dr. Alef costuma começar entendendo seu histórico, os sintomas que mais te incomodam, o que você já tentou, quais remédios usa hoje e se existe algum risco de interação. A partir disso, ele avalia se a cannabis faz sentido para o seu caso e qual seria o caminho mais seguro.",

  dependence: "Essa preocupação faz sentido. O ponto importante é que a proposta aqui não é trocar seu problema por outra dependência. O CBD não tem o mesmo perfil de dependência de opioides ou benzodiazepínicos, e quando alguma formulação exige mais cuidado isso é decidido com dose controlada e acompanhamento médico.",

  interaction: "Essa preocupação é importante e faz sentido. Existem remédios que exigem mais atenção, e por isso a consulta é essencial: o Dr. Alef analisa exatamente o que você usa hoje e verifica se há risco de interação, além de avaliar se dá para conduzir isso com segurança.",

  scientificProof: "Entendo esse ceticismo, porque existe muito conteúdo ruim prometendo milagre. Mas cannabis medicinal não é só opinião ou modinha: existem estudos e uso médico sério em vários contextos. A consulta serve justamente para separar promessa vazia de indicação real para o seu caso.",

  timeToEffect: "Os efeitos podem aparecer já desde o início em alguns pacientes, mas isso depende da dose, da formulação e da resposta de cada organismo. Em alguns casos a melhora é percebida cedo; em outros, é preciso ajustar até encontrar a dose ideal, sem prometer resultado instantâneo.",

  importProcess: "Hoje existem caminhos tanto por farmácia no Brasil quanto por importação, e o paciente não precisa descobrir isso sozinho. Na consulta, o Dr. Alef define o caminho mais adequado, orienta o passo a passo e explica o que depende de prescrição, farmácia ou Anvisa.",

  accessPathOperational: "Depois da consulta, se houver indicação, você já sai sabendo quem prescreve, qual é o caminho de acesso e se faz mais sentido farmácia no Brasil ou importação. A ideia é justamente evitar enrolação e deixar o processo prático.",

  afterConsultOperational: "Depois da consulta, se houver indicação, o Dr. Alef já orienta o produto, a prescrição e o caminho de acesso. Ou seja: você não fica perdido(a) tentando entender sozinho(a) o que fazer depois.",

  brainSafety: "Não é correto resumir isso como algo que 'mata neurônios'. O que existe é diferença entre uso recreativo, formulação, dose e contexto clínico. No uso medicinal, com produto adequado e acompanhamento, o foco é segurança e controle de sintomas, não exposição irresponsável.",

  stigma: "Entendo sua resistência. Aqui não estamos falando de uso recreativo, e sim de formulações médicas, como óleo sublingual, com dose controlada e acompanhamento. O objetivo não é 'usar droga', e sim avaliar um tratamento de forma séria, legal e segura.",

  fibro: "É verdade que fibromialgia não tem cura. A proposta da cannabis medicinal não é prometer cura, e sim tentar melhorar sintomas importantes do quadro, como dor, sono e ansiedade. O foco é qualidade de vida e controle de sintomas, com critério.",

  driveWork: "Isso precisa ser considerado com cuidado, e por isso a consulta é importante. Quando a proposta envolve formulações mais funcionais, a ideia é preservar sua lucidez e sua rotina. Se você dirige ou depende do trabalho com atenção total, isso entra na decisão do produto e do horário de uso.",

  insurance: "Hoje a consulta é particular. Se o seu plano trabalha com reembolso, vale conferir as regras diretamente com o convênio. Se quiser, eu te explico as modalidades da consulta para você ver o que faz mais sentido.",

  triedEverything: "Eu entendo esse cansaço, porque muita gente chega aqui exatamente depois de já ter tentado vários caminhos sem resultado. A diferença é que a consulta serve para avaliar com honestidade se existe um raciocínio médico consistente para o seu caso, em vez de repetir tentativa no escuro.",

  elderlySafety: "Na pessoa idosa, o cuidado precisa ser ainda mais criterioso, e é exatamente por isso que a avaliação médica faz diferença. O Dr. Alef analisa idade, doenças associadas, remédios em uso e risco de interação antes de definir se existe indicação e qual formulação seria mais segura.",

  cbdVsThc: "CBD e THC não são a mesma coisa. O CBD costuma ser a parte mais ligada a controle de sintomas e funcionalidade, enquanto o THC exige mais critério por causa de efeito psicoativo em algumas formulações. Na prática, o que importa é a combinação certa para o seu caso, com dose e objetivo definidos por médico.",

  priceDifference: "A diferença não está em consulta rápida ou prescrição automática. Aqui o Dr. Alef dedica em média *45 minutos* ao caso, revisa histórico, medicações, risco de interação e caminho de acesso. O foco é te dar uma avaliação mais completa e objetiva, para você não perder tempo nem dinheiro em tentativa no escuro.",

  notMarketing: "Essa preocupação é justa. O ponto aqui não é empurrar tratamento, e sim separar o que é promessa vazia do que tem indicação médica real. Se fizer sentido, o Dr. Alef explica o caminho prático; se não fizer, ele também deixa isso claro.",

  notWasteTime: "A consulta é justamente para você não perder tempo no escuro. Ela responde três coisas objetivas: se existe indicação real para o seu caso, qual seria o caminho mais seguro e como funciona o acesso na prática. Se não fizer sentido, isso também fica claro.",

  whatIncludes_full: `Nesse acompanhamento de R$${PLANS.full.price} você faz a consulta com o Dr. Alef agora e já fica com um retorno incluído em ~30 dias. Esse retorno serve para revisar como você está, ajustar o tratamento se necessário e acompanhar o início com mais segurança. É o que a maioria escolhe justamente por ter essa tranquilidade 😊`,

  whatIncludes_basic: `A avaliação de R$${PLANS.basic.price} é a consulta inicial completa, de 45 minutos. O Dr. Alef analisa seu caso com profundidade e define os próximos passos com segurança 😊`,
};

function getPriorityTrustAnswer(state, text) {
  const t = norm(text);

  if (/\b(como sei que (esse )?(medico|médico|dr|doutor) e serio|como sei que .*e sério|charlatao|charlatão|medico.*instagram|m[eé]dico.*instagram|marketing|isso e serio|isso é sério)\b/.test(t)) {
    return QUESTION_ANSWERS.isScam;
  }

  if (/\b(o que voce costuma avaliar primeiro na consulta|o que você costuma avaliar primeiro na consulta|o que voce avalia primeiro|o que você avalia primeiro|como o dr avalia|como ele avalia meu caso)\b/.test(t)) {
    return QUESTION_ANSWERS.consultEvaluation;
  }

  if (/\b(vicia|viciante|dependencia|dependência|ficar dependente|gera dependencia|gera dependência)\b/.test(t)) {
    return QUESTION_ANSWERS.dependence;
  }

  if (/\b(interage|interacao|interação|misturar|junto com meus remedios|junto com meus remédios|antidepressivo|ansiolitico|ansiolítico)\b/.test(t)) {
    return QUESTION_ANSWERS.interaction;
  }

  if (/\b(comprovacao|comprovação|prova cientifica|prova científica|evidencia|evidência|placebo|modinha|estudo cientifico|estudo científico)\b/.test(t)) {
    return QUESTION_ANSWERS.scientificProof;
  }

  if (/\b(demora.*fazer efeito|quanto tempo.*fazer efeito|quanto tempo.*resultado|quando.*resultado)\b/.test(t)) {
    return QUESTION_ANSWERS.timeToEffect;
  }

  if (/\b(importacao|importação|importar|burocratico|burocrático|burocracia|por onde comecar|por onde começar|como conseguir)\b/.test(t)) {
    return QUESTION_ANSWERS.importProcess;
  }

  if (/\b(como fica legalidade|caminho de acesso|quem prescreve|quem receita|como consigo a medicacao|como consigo a medicação|o que acontece depois da consulta|depois da consulta)\b/.test(t)) {
    return QUESTION_ANSWERS.accessPathOperational;
  }

  if (/\b(quais horarios voce tem|quais horários você tem|tem horario essa semana|tem horário essa semana|como fecha o agendamento)\b/.test(t)) {
    return QUESTION_ANSWERS.scheduleHours;
  }

  if (/\b(quando entra o link|quando manda o link|link de pagamento|como fecha o pagamento|como eu pago)\b/.test(t)) {
    return QUESTION_ANSWERS.paymentFlowOperational;
  }

  if (/\b(mata neuronios|mata neurônios|faz mal para o cerebro|faz mal para o cérebro)\b/.test(t)) {
    return QUESTION_ANSWERS.brainSafety;
  }

  if (/\b(isso e maconha|isso é maconha|nao quero usar droga|não quero usar droga)\b/.test(t)) {
    return QUESTION_ANSWERS.stigma;
  }

  if (/\bfibromialgia\b/.test(t) && /\b(cura|ajudar|melhorar)\b/.test(t)) {
    return QUESTION_ANSWERS.fibro;
  }

  if (/\b(dirigir|trabalhar|trabalho|exame toxicologico|exame toxicológico)\b/.test(t)) {
    return QUESTION_ANSWERS.driveWork;
  }

  if (/\b(idoso|idosa|minha idade|na minha idade|seguro na minha idade)\b/.test(t)) {
    return QUESTION_ANSWERS.elderlySafety;
  }

  if (/\b(cbd e thc|cbd.*thc|thc.*cbd|diferenca entre cbd e thc|diferença entre cbd e thc)\b/.test(t)) {
    return QUESTION_ANSWERS.cbdVsThc;
  }

  if (/\b(convenio|convênio|reembolso|plano cobre)\b/.test(t)) {
    return QUESTION_ANSWERS.insurance;
  }

  if (/\b(ja tentei de tudo|já tentei de tudo|nada funciona|nada funcionou|perda de tempo|mais uma tentativa|mais uma perda de tempo)\b/.test(t)) {
    return QUESTION_ANSWERS.triedEverything;
  }

  if ((/\b(muito caro|caro|nao tenho condicao|não tenho condição|consulta e cara|consulta é cara)\b/.test(t) && !/\b(preco|preço|valor|quanto custa)\b/.test(t))) {
    return "Eu entendo você. Quando a pessoa já gastou com remédios, consultas e tratamentos que não trouxeram o resultado esperado, qualquer novo investimento pesa mesmo. Mas a proposta aqui é justamente fazer uma avaliação médica mais direcionada, para entender seu caso com profundidade e ver se esse caminho realmente faz sentido para você, em vez de continuar tentando coisas no escuro.";
  }

  if (/\b(funciona mesmo|vale a pena|resolve mesmo|oleo vai ajudar|óleo vai ajudar|nao encontro informacao clara|não encontro informação clara|promessa de milagre)\b/.test(t)) {
    return QUESTION_ANSWERS.scientificProof;
  }

  if (/\b(marketing|propaganda|instagram|modinha)\b/.test(t) && /\b(como sei|nao e so|não é só|so marketing|só marketing)\b/.test(t)) {
    return QUESTION_ANSWERS.notMarketing;
  }

  if (/\b(perder tempo|perda de tempo|nao vou perder tempo|não vou perder tempo)\b/.test(t)) {
    return QUESTION_ANSWERS.notWasteTime;
  }

  if (/\b(150|200|347)\b/.test(t) && /\b(diferenca pratica|diferença prática|por que sua consulta custa mais|consulta custa mais|mercado fala de consultas)\b/.test(t)) {
    return QUESTION_ANSWERS.priceDifference;
  }

  return null;
}

/* ═══════════════════════════════════════════════════════════════════
   OBJECTION HANDLERS — NOVO NA V14
   ═══════════════════════════════════════════════════════════════════ */

function handleExpensive(state) {
  const cond = state.condition || "dor_cronica";
  const ev = EVIDENCE_DB[cond];
  const future = ev?.future ? `\n\n${pickRandom(ev.future)}` : "";
  // ▸ V14 FIX: CTA dinâmico por stage (antes era hardcoded "te explico a diferença")
  return `Entendo você pensar nisso.\n\nMas aqui não é uma consulta rápida. O Dr. Alef dedica em média *45 minutos* ao seu caso, revisa tudo o que você já tentou e monta um plano individualizado. A maioria dos pacientes me diz que foi a consulta mais completa que já fizeram.${future}` + getStageCTA(state);
}

function handleWillSee(state) {
  if (state?.date_key && state?.slot_time) {
    return `Claro, sem problema 😊 Se quiser, eu consigo manter *${prettySlot(state.date_key, state.slot_time)}* reservado por mais alguns minutos enquanto você decide. Assim não corre risco de perder a vaga.`;
  }
  return "Claro, sem problema 😊 Se quiser, eu posso te mostrar os horários disponíveis e você decide com calma.";
}

function handleUnsure(state, text) {
  const cond = detectCondition(text) || state.condition || null;
  const ev = cond && Number(state.evidence_used_count || 0) < 2 ? EVIDENCE_DB[cond] : null;
  let msg = "É super normal ter essa dúvida 😊 A avaliação serve justamente para entender com profundidade se esse tratamento faz sentido para você, sem compromisso de seguir se não fizer.";
  if (ev) {
    msg += `\n\n${pickRandom(ev.testimony)}`;
  }
  // ▸ V14 FIX: Reconectar ao stage com CTA (spec 4.2: toda objeção termina com CTA do stage)
  return msg + getStageCTA(state);
}

function handleCheaperElsewhere(state) {
  // ▸ V14 FIX: Adicionado state param + CTA dinâmico por stage
  return "Entendo 😊 Muita gente compara antes de decidir, e está certo.\n\nO que costuma diferenciar aqui é a avaliação individualizada e o cuidado com segurança e ajustes. O Dr. Alef não trabalha com protocolo pronto — cada caso é avaliado com profundidade.\n\nMuita gente chega aqui justamente depois de abordagens mais genéricas." + getStageCTA(state);
}

function handleCheckSpouse() {
  return "Faz total sentido 😊 Se quiser, eu posso te resumir como funciona e os valores — fica mais fácil de conversar. E se decidirem seguir, eu consigo encaixar um horário nessa semana ainda.";
}

/* ═══════════════════════════════════════════════════════════════════
   GPT — SYSTEM PROMPT V14
   ═══════════════════════════════════════════════════════════════════
   ▸ MUDANÇA CRÍTICA: Prompt com convicção, esperança, limites claros
   de profundidade clínica e obrigação de micro-CTA.
   ═══════════════════════════════════════════════════════════════════ */

function buildSystemPrompt(stageCTA = "") {
  return `Você é "Lia", secretária pessoal do Dr. Alef Kotula. Você trabalha ao lado dele todos os dias e já viu centenas de pacientes.

QUEM VOCÊ É:
- Humana, acolhedora, clara, com convicção
- Você acredita no tratamento porque vê resultado real
- Você já viu gente sem esperança voltar melhor
- Você transmite esperança fundamentada, nunca promessa vazia

PODE:
- Dizer "o que eu vejo aqui com frequência é que os pacientes melhoram"
- Transmitir esperança e ajudar o paciente a enxergar futuro melhor
- Falar que muita gente melhora, que pacientes voltam relatando melhora
- Usar dados de estudos para confirmar a experiência

NÃO PODE:
- Inventar preço / enviar links / citar R$
- Prometer cura / garantir resultado
- Diagnosticar / sugerir dose / prescrever
- Fazer mais de 1 pergunta por mensagem
- Investigar sintomas clínicos em profundidade (irradiação, formigamento, etc.)
- Ultrapassar 5 linhas de texto

REGRAS:
- Responda primeiro a pergunta do paciente
- Depois conduza com suavidade
- Sempre termine com direção suave${stageCTA ? `: "${stageCTA}"` : ""}
- Se o paciente está sofrendo, intensifique acolhimento e esperança
- Máximo 5 linhas

COMANDOS:
- Pediu preço: "PRECISA_PRECO"
- Pediu pagamento/link: "PRECISA_PAGAR"
- Pediu horários/agendar: "PRECISA_AGENDAR"
- Urgência médica: "URGENTE"

FORMATO JSON:
{ "reply": "mensagem", "updates": { "nome": "...", "problem_text": "...", "condition": "..." } }`;
}

function buildUserPrompt({ incomingText, state, flags }) {
  return `MEMÓRIA:
${JSON.stringify({
  nome: state.nome, focus: state.focus, condition: state.condition,
  problem_text: state.problem_text, stage: state.stage,
  date_key: state.date_key, slot_time: state.slot_time,
  evidence_used: state.evidence_used_count || 0,
  lead_profile: state.lead_profile || "padrao",
})}

MENSAGEM: ${incomingText}

SINAIS: ${JSON.stringify({
  wantsPrice: flags.wantsPrice, wantsBook: flags.wantsBook,
  asksIfWorks: flags.asksIfWorks, saysExpensive: flags.saysExpensive,
  strongPain: flags.strongPain, confirms: flags.confirms,
})}`;
}

function violatesNoPriceNoLink(text) {
  if (!text) return false;
  if (/\bhttps?:\/\//i.test(text)) return true;
  if (/R\$\s?\d/i.test(text)) return true;
  if (/\b(200|347|447)\b/.test(text)) return true;
  return false;
}

async function runLia({ incomingText, state, flags, stageCTA = "" }) {
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.5,
    messages: [
      { role: "system", content: buildSystemPrompt(stageCTA) },
      { role: "user", content: buildUserPrompt({ incomingText, state, flags }) },
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
   MERCADO PAGO (preservado da V13)
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
   HUMAN DELAY (preservado da V13, ajustado)
   ═══════════════════════════════════════════════════════════════════ */

function computeHumanDelay(flags, state) {
  let base = randInt(MIN_DELAY, MAX_DELAY);
  if (flags.wantsBook || flags.asksHours || flags.intentPay) base = randInt(1, 3);
  if (flags.wantsPrice) base = randInt(2, 4);
  // ▸ V14 FIX: Delay reduzido para todo o ciclo de vida do lead emocional (spec 6.2)
  if (flags.strongPain || state.lead_profile === "emocional") base = randInt(1, 2);
  const lastAt = Number(state.last_sent_at || 0);
  if (Date.now() - lastAt < 2000) base += 1;
  return Math.max(1, base);
}

async function sendWhatsApp(to, from, body, delaySec) {
  await sleep(delaySec * 1000);
  await twilioClient.messages.create({ to, from, body });
}

/* ═══════════════════════════════════════════════════════════════════
   CONTEXT CTAs — NOVO NA V14
   ═══════════════════════════════════════════════════════════════════
   ▸ Retorna o CTA adequado ao stage atual do funil. Usado pelo
   Question Priority Engine para reconectar ao fechamento.
   ═══════════════════════════════════════════════════════════════════ */

function getStageCTA(state) {
  const s = state.stage;
  if (s === "ASK_DAY") return "\n\nQual dia fica melhor para você? 😊";
  if (s === "OFFER_SLOTS") return "\n\nQual desses horários funciona melhor? 😊";
  if (s === "ASK_FULLNAME") return "\n\nMe passa seu *nome completo* para eu finalizar a reserva 😊";
  if (s === "ASK_BIRTHDATE") return "\n\nMe manda sua *data de nascimento* para eu prosseguir 😊";
  if (s === "ASK_EMAIL") return "\n\nMe passa seu *e-mail* para eu completar o cadastro 😊";
  if (s === "ASK_PLAN") return "\n\nQual dessas opções faz mais sentido? Me responde com *1, 2 ou 3* 😊";
  if (s === "WAIT_PAYMENT" && state.payment?.link) return `\n\nSeu horário continua reservado e o link segue ativo: ${state.payment.link} 😊`;
  return "\n\nSe quiser, eu posso te mostrar os horários disponíveis 😊";
}

function isOperationalScheduleQuestion(text, flags) {
  const t = norm(text);
  return (
    flags.wantsBook ||
    flags.asksHours ||
    /\b(quais horarios voce tem|quais horários você tem|quais horarios tem|tem horario essa semana|tem horário essa semana|como faco para agendar|como faço para agendar|como fecha o agendamento|como funciona o agendamento)\b/.test(t)
  );
}

function isOperationalAccessQuestion(text, flags) {
  const t = norm(text);
  return (
    flags.asksLegal ||
    flags.asksRecipe ||
    /\b(caminho de acesso|acesso pratico|acesso prático|como consigo a medicacao|como consigo a medicação|como conseguir o tratamento|como funciona o acesso|farmacia|farmácia|importacao|importação|quem prescreve|quem receita)\b/.test(t)
  );
}

function isOperationalAfterConsultQuestion(text) {
  const t = norm(text);
  return /\b(depois da consulta|o que acontece depois da consulta|o que acontece depois)\b/.test(t);
}

function isOperationalNextStepQuestion(text) {
  const t = norm(text);
  return /\b(proximo passo|próximo passo|se eu seguir|como fecha|como eu fecho|o que eu faco agora|o que eu faço agora)\b/.test(t);
}

function isOperationalPaymentQuestion(text, flags) {
  const t = norm(text);
  return (
    flags.intentPay ||
    flags.asksPayMethod ||
    /\b(quando entra o link|quando manda o link|me manda o link|manda o link|como pago|como fecha o pagamento|link de pagamento)\b/.test(t)
  );
}

async function maybeHandleOperationalClose(state, flags, text) {
  const wantsSchedule = isOperationalScheduleQuestion(text, flags);
  const asksConsultFlow = flags.asksHowConsultWorks || /\b(como funciona a consulta|como e a consulta|como é a consulta)\b/.test(norm(text));
  const asksAccess = isOperationalAccessQuestion(text, flags);
  const asksAfterConsult = isOperationalAfterConsultQuestion(text);
  const asksNextStep = isOperationalNextStepQuestion(text);
  const asksPayment = isOperationalPaymentQuestion(text, flags);

  if (!wantsSchedule && !asksConsultFlow && !asksAccess && !asksAfterConsult && !asksNextStep && !asksPayment) {
    return null;
  }

  const parts = [];

  if (wantsSchedule) parts.push(QUESTION_ANSWERS.scheduleHours);
  if (asksConsultFlow) parts.push(QUESTION_ANSWERS.howConsultWorksOperational);
  if (asksAccess) parts.push(QUESTION_ANSWERS.accessPathOperational);
  if (asksAfterConsult) parts.push(QUESTION_ANSWERS.afterConsultOperational);
  if (asksNextStep) parts.push(QUESTION_ANSWERS.nextStepOperational);
  if (asksPayment) parts.push(QUESTION_ANSWERS.paymentFlowOperational);

  const intro = removeDuplicates(parts).slice(0, 2).join("\n\n").trim();

  if (state.payment?.link) {
    return [intro, pendingPaymentReply(state)].filter(Boolean).join("\n\n");
  }

  if (state.date_key && !state.slot_time && (wantsSchedule || asksNextStep)) {
    return [intro, await offerSlotsReply(state)].filter(Boolean).join("\n\n");
  }

  if (!state.date_key && (wantsSchedule || asksConsultFlow || asksNextStep)) {
    return [intro, await askDayReply()].filter(Boolean).join("\n\n");
  }

  if (state.date_key && state.slot_time && !state.nome_completo && (asksNextStep || asksPayment)) {
    return [intro, askCadastreBundleReply(state)].filter(Boolean).join("\n\n");
  }

  if (state.date_key && state.slot_time && state.nome_completo && state.birthdate && !state.email && (asksNextStep || asksPayment)) {
    return [intro, askEmailReply()].filter(Boolean).join("\n\n");
  }

  if (state.date_key && state.slot_time && state.nome_completo && state.birthdate && state.email && !state.payment?.link && (asksNextStep || asksPayment)) {
    return [intro, priceReply()].filter(Boolean).join("\n\n");
  }

  if (intro) return intro + getStageCTA(state);
  return null;
}

/**
 * ▸ QUESTION PRIORITY ENGINE
 * Verifica se o paciente fez uma pergunta direta e retorna a resposta
 * + CTA do stage atual. Retorna null se nenhuma pergunta detectada.
 */
function handleDirectQuestion(flags, state, text) {
  const cta = getStageCTA(state);
  const priorityAnswer = getPriorityTrustAnswer(state, text);
  if (priorityAnswer) return priorityAnswer + cta;
  let answer = null;

  if (flags.asksIsScam) answer = QUESTION_ANSWERS.isScam;
  else if (flags.asksLegal) answer = QUESTION_ANSWERS.isLegal;
  else if (flags.asksChapado) answer = QUESTION_ANSWERS.chapado;
  else if (flags.asksWho) answer = QUESTION_ANSWERS.whoIsDrAlef;
  else if (flags.asksIfOnline) answer = QUESTION_ANSWERS.isOnline;
  else if (flags.asksHowConsultWorks) answer = QUESTION_ANSWERS.howConsultWorks;
  else if (flags.asksRecipe) answer = QUESTION_ANSWERS.recipe;
  else if (flags.asksMedCost) answer = QUESTION_ANSWERS.medCost;
  else if (flags.asksCanReschedule) answer = QUESTION_ANSWERS.canReschedule;
  else if (flags.asksPrivacy) answer = QUESTION_ANSWERS.privacy;
  else if (flags.asksStartNow) answer = QUESTION_ANSWERS.startNow;
  else if (flags.asksPayMethod) answer = QUESTION_ANSWERS.payMethod;
  else if (flags.asksIfForMe) answer = QUESTION_ANSWERS.isForMe;
  else if (flags.asksDifferential) answer = QUESTION_ANSWERS.differential;
  else if (flags.asksWhatIncludes) {
    // Se já tem plano selecionado ou contexto de acompanhamento
    const t = norm(text);
    if (/(447|acompanhamento|opcao 1|opção 1|primeira)/.test(t)) answer = QUESTION_ANSWERS.whatIncludes_full;
    else if (/(347|avaliacao|avaliação|opcao 2|opção 2|segunda)/.test(t)) answer = QUESTION_ANSWERS.whatIncludes_basic;
    else answer = QUESTION_ANSWERS.whatIncludes_full; // default: explicar o mais popular
  }

  if (answer) return answer + cta;
  return null;
}

/**
 * ▸ OBJECTION HANDLER
 * Verifica se o paciente expressou objeção e retorna tratamento.
 * Retorna null se nenhuma objeção detectada.
 */
function handleObjection(flags, state, text) {
  const priorityAnswer = getPriorityTrustAnswer(state, text);
  if (priorityAnswer) return priorityAnswer + getStageCTA(state);
  if (flags.saysExpensive) return handleExpensive(state);
  if (flags.saysWillSee) return handleWillSee(state);
  if (flags.saysUnsure) return handleUnsure(state, text);
  if (flags.saysCheaperElsewhere) return handleCheaperElsewhere(state);
  if (flags.saysCheckSpouse) return handleCheckSpouse();
  if (flags.saysIndecisive) {
    // ▸ Recomendar a opção mais popular com justificativa
    if (state.stage === "ASK_PLAN") {
      return `A maioria dos pacientes escolhe o *Acompanhamento* (opção 1) porque já inclui o retorno em ~30 dias — dá mais segurança para acompanhar o início do tratamento 😊\n\nMas se preferir começar só com a avaliação inicial, a opção 2 também funciona bem. Quer seguir com a 1 ou a 2?`;
    }
    if (state.stage === "OFFER_SLOTS" || state.stage === "ASK_DAY") {
      return `Os horários que os pacientes costumam preferir são no final da tarde/início da noite 😊 Se quiser, eu sugiro o melhor disponível.`;
    }
    return "Sem problema 😊 Me diz o que te deixa em dúvida que eu te ajudo a decidir.";
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════
   TRIAGEM ADAPTATIVA — NOVO NA V14
   ═══════════════════════════════════════════════════════════════════
   ▸ Decide quantas perguntas diagnósticas ainda são necessárias.
   ▸ Se o paciente já contou tudo, pode ser 0.
   ═══════════════════════════════════════════════════════════════════ */

function getNextDiagQuestion(state, text) {
  const has = {
    tempo: !!(state.diag_has_tempo),
    impacto: !!(state.diag_has_impacto),
    tratamento: !!(state.diag_has_tratamento),
  };

  // Detectar se o texto atual já contém respostas
  const low = norm(text);
  if (/(ha |há |faz |anos|meses|tempo|começo|comecou|começou)/.test(low)) has.tempo = true;
  if (/(rotina|dia a dia|trabalho|sono|atrapalha|incomoda|impacto|cansaço|cansaco)/.test(low)) has.impacto = true;
  if (/(ja tomei|já tomei|ja tentei|já tentei|remedio|remédio|anti.?inflamat|fisioterapia|medicacao|medicação|pregabalina|duloxetina|amitriptilina|gabapentina|infiltracao|infiltração)/.test(low)) has.tratamento = true;

  // Salvar o que já tem
  state.diag_has_tempo = has.tempo;
  state.diag_has_impacto = has.impacto;
  state.diag_has_tratamento = has.tratamento;

  // Decidir próxima pergunta
  const asked = Number(state.diagnostic_step || 0);
  if (asked >= 3) return null; // Limite absoluto
  // ▸ V14 FIX: Lead emocional → max 1 pergunta (spec 6.2: "Triagem mínima, 1 pergunta máx")
  if (state.lead_profile === "emocional" && asked >= 1) return null;

  if (!has.tempo && asked < 3) { state.diagnostic_step = asked + 1; return diagQ_tempo(state); }
  if (!has.impacto && asked < 3) { state.diagnostic_step = asked + 1; return diagQ_impacto(state); }
  if (!has.tratamento && asked < 3) { state.diagnostic_step = asked + 1; return diagQ_tratamento(); }

  return null; // Tudo já coletado
}

/* ═══════════════════════════════════════════════════════════════════
   STATE INITIALIZATION
   ═══════════════════════════════════════════════════════════════════ */

function initializeState(state, bot) {
  // ▸ V14 FIX: Migrar stages da V13 que não existem na V14
  // V13 usava DIAG_Q1, DIAG_Q2, DIAG_Q3 separados; V14 consolida em DIAGNOSTIC
  if (state.stage && /^DIAG_Q[123]$/.test(state.stage)) {
    const qNum = Number(state.stage.replace("DIAG_Q", "")) || 0;
    state.stage = "DIAGNOSTIC";
    state.diagnostic_step = Math.max(Number(state.diagnostic_step || 0), qNum);
  }
  // V13 usava AFTER_DIAGNOSTIC; V14 usa BRIDGE
  if (state.stage === "AFTER_DIAGNOSTIC") {
    state.stage = "BRIDGE";
  }

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
  state.last_bot_from = bot;
  return state;
}

/* ═══════════════════════════════════════════════════════════════════
   ROUTES
   ═══════════════════════════════════════════════════════════════════ */

if (!IS_SIMULATOR_MODE) {
  app.get("/", (req, res) => res.send("OK"));
  app.get("/mp/thanks", (req, res) => res.send("OK"));

  // Webhook Mercado Pago (preservado da V13)
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
        // ▸ V14 FIX: Setar stage CONFIRMED para consistência com spec 8.2
        if (status === "approved") state.stage = "CONFIRMED";
        await saveUserState(phone, state);

        if (status === "approved") {
          const botFrom = state?.last_bot_from || null;
          if (botFrom) {
            try {
              await twilioClient.messages.create({ to: `whatsapp:${phone}`, from: botFrom, body: afterPaidReply(state) });
            } catch {}
          }
        }
      }
    } catch (err) { console.error("❌ MP webhook erro:", err); }
  });

/* ═══════════════════════════════════════════════════════════════════
   ███████████████████████████████████████████████████████████████████
   MAIN HANDLER — LÓGICA DE DECISÃO V14
   ███████████████████████████████████████████████████████████████████

   ARQUITETURA:
   [0] Proteções (pagamento aprovado, urgência, admin)
   [1] Question Priority Engine (pergunta direta → resposta + CTA)
   [2] Objection Handler (objeção → tratamento + CTA)
   [3] State Machine (fluxo normal do funil)
   [4] Fallback GPT (prompt restrito com convicção)

   ═══════════════════════════════════════════════════════════════════ */

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

      // ── Admin reset ──
      if (norm(incomingText) === "reset" && phoneDigits === ADMIN_RESET_PHONE_DIGITS) {
        await pool.query(`UPDATE wa_users SET state = '{}'::jsonb, updated_at = NOW() WHERE regexp_replace(phone, '\\D', '', 'g') = $1`, [phoneDigits]);
        await pool.query(`DELETE FROM wa_slot_locks WHERE phone = $1 AND status='held'`, [phone]);
        await sendWhatsApp(`whatsapp:+${phoneDigits}`, bot, "🔄 Memória resetada. Pode testar do zero.", 0);
        return;
      }

      // ── Admin simular pagamento ──
      if (["simular pagamento","paguei_teste","simular_pagamento","aprovar_teste"].includes(norm(incomingText)) && phoneDigits === ADMIN_RESET_PHONE_DIGITS) {
        const st = await getUserState(phone);
        st.payment = st.payment || {};
        st.payment.status = "approved";
        st.payment.simulated = true;
        if (st.slot_key) await markSlotPaid(st.slot_key, phone);
        await saveUserState(phone, st);
        await sendWhatsApp(lead, bot, afterPaidReply(st), 0);
        return;
      }

      // ── Load state ──
      let state = initializeState(await getUserState(phone), bot);

      // ▸ FIX: Tratar mensagens sem texto (áudio, imagem, sticker, figurinha)
      const hasMedia = Number(req.body.NumMedia || 0) > 0;
      if ((!incomingText || incomingText.length < 2) && hasMedia) {
        const mediaReply = state.nome
          ? `${state.nome}, por enquanto eu só consigo ler mensagens de texto 😊 Me manda sua dúvida digitando que eu te ajudo.`
          : "Por enquanto eu só consigo ler mensagens de texto 😊 Me manda sua dúvida digitando que eu te ajudo.";
        state.last_bot_reply = mediaReply;
        state.last_sent_at = Date.now();
        await saveUserState(phone, state);
        await sendWhatsApp(lead, bot, mediaReply, randInt(1, 2));
        return;
      }

      const flags = detectIntent(incomingText);

      // Atualizar focus/condition passivamente
      if (flags.focus && !state.focus) state.focus = flags.focus;
      const detCond = detectCondition(incomingText);
      if (detCond && !state.condition) state.condition = detCond;
      const detProb = extractProblemText(incomingText);
      if (detProb && !state.problem_text) state.problem_text = detProb;

      // Classificar lead (se ainda não classificado ou sinal forte)
      const lp = classifyLead(flags, incomingText, state);
      if (!state.lead_profile || ["emocional","desconfiado","quente"].includes(lp)) state.lead_profile = lp;

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
         [CAMADA 1] — QUESTION PRIORITY ENGINE
         ▸ Se o paciente fez pergunta direta, responder ANTES de
         qualquer lógica de stage. A resposta inclui CTA do stage.
         ▸ Não avança o stage (funil aberto).
         ▸ Exceção: se pedir preço e nunca viu preço → transiciona.
         ═══════════════════════════════════════════════════════════════ */

      else if (state.stage) { // Só ativa se já entrou no funil

        // ▸ FIX: Durante DIAGNOSTIC e ASK_PROBLEM, Camada 1 só intercepta
        //   perguntas inequívocas (contêm "?" ou são flags de alta confiança).
        //   Evita que "melhora um pouco" seja interpretado como "funciona?".
        const isDiagStage = (state.stage === "DIAGNOSTIC" || state.stage === "ASK_PROBLEM");
        const hasQuestionMark = incomingText.includes("?");
        const highConfidenceQuestion = flags.asksIsScam || flags.asksLegal || flags.asksChapado
          || flags.asksWho || flags.asksHowConsultWorks || flags.asksIfOnline
          || flags.asksRecipe || flags.asksMedCost || flags.asksCanReschedule
          || flags.asksPrivacy || flags.asksStartNow || flags.asksPayMethod
          || flags.asksWhatIncludes || flags.asksIfForMe || flags.asksDifferential
          || flags.wantsBook || flags.asksHours || flags.intentPay;

        const shouldRunCamada1 = !isDiagStage || hasQuestionMark || highConfidenceQuestion;

        const operationalCloseReply = shouldRunCamada1 ? await maybeHandleOperationalClose(state, flags, incomingText) : null;
        if (operationalCloseReply) {
          reply = operationalCloseReply;
          // Não muda stage — reconecta ao ponto atual
        }

        const directAnswer = !reply && shouldRunCamada1 ? handleDirectQuestion(flags, state, incomingText) : null;
        if (directAnswer) {
          reply = directAnswer;
          // Não muda stage — reconecta ao ponto atual
        }

        // Preço: se pediu e tem stage ativo
        else if (flags.wantsPrice && state.stage !== "ASK_PLAN" && state.stage !== "WAIT_PAYMENT") {
          state.price_ask_count += 1;
          if (state.price_ask_count >= 2 || state.lead_profile === "pragmatico") {
            reply = priceReply();
            state.stage = "ASK_PLAN";
          } else {
            reply = `Claro 😊 Hoje trabalhamos com opções a partir de R$${PLANS.basic.price}. Depois te explico certinho as diferenças.` + getStageCTA(state);
          }
        }

        // AsksIfWorks: responder com testimony + CTA (só fora de triagem)
        else if (flags.asksIfWorks && !isDiagStage && !reply) {
          const cond = detectCondition(incomingText) || state.condition || "dor_cronica";
          const ev = EVIDENCE_DB[cond];
          if (ev) {
            state.evidence_used_count = Number(state.evidence_used_count || 0) + 1;
            reply = `${pickRandom(ev.testimony)}\n\n${ev.study}\n\n${ev.hope}` + getStageCTA(state);
          }
        }

      /* ═══════════════════════════════════════════════════════════════
         [CAMADA 2] — OBJECTION HANDLER
         ═══════════════════════════════════════════════════════════════ */

        if (!reply) {
          const objReply = handleObjection(flags, state, incomingText);
          if (objReply) reply = objReply;
        }
      }

      /* ═══════════════════════════════════════════════════════════════
         [CAMADA 3] — STATE MACHINE
         ═══════════════════════════════════════════════════════════════ */

      if (!reply) {

        // ── Abertura: sem stage e sem nome ──
        if (!state.stage && !state.nome) {
          // Verificar se a primeira mensagem já tem pergunta importante
          const firstQ = handleDirectQuestion(flags, state, incomingText);
          if (firstQ && !flags.wantsPrice) {
            // Responder a pergunta + pedir nome
            reply = firstQ.replace(/\n\nSe quiser.*$/, "") + "\n\nAntes de mais nada, qual é o seu *primeiro nome*? 😊";
          } else {
            reply = askNameIntroReply();
          }
          state.stage = "ASK_NAME";
        }

        // ── Captura do nome ──
        else if (state.stage === "ASK_NAME") {
          const nm = extractFirstName(incomingText);
          if (nm) {
            state.nome = nm;
            state.name_used_count = 0;

            // Se já temos problema detectado passivamente
            if (state.problem_text) {
              // ▸ Lead quente ou emocional: encurtar
              if (state.lead_profile === "quente" || flags.wantsBook) {
                state.stage = "ASK_DAY";
                reply = `Prazer, ${nm} 😊 Vou te mostrar os horários disponíveis.`;
                reply += "\n\n" + await askDayReply();
              }
              // ▸ Lead pragmático: acknowledger rápido + preço
              else if (state.lead_profile === "pragmatico" || flags.wantsPrice) {
                state.stage = "ASK_PLAN";
                const condLabel = state.condition ? { fibromialgia:"a fibromialgia", dor_cronica:"a dor", dor_lombar:"a dor na coluna", ansiedade:"a ansiedade", insonia:"o sono", artrose:"a artrose", artrite:"a artrite", enxaqueca:"a enxaqueca", dor_neuropatica:"a dor" }[state.condition] || "o que você mencionou" : "o que você mencionou";
                reply = `Prazer, ${nm} 😊 Entendi sobre ${condLabel}.\n\n${priceReply()}`;
              }
              // ▸ Outros: triagem adaptativa
              else {
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
            // Não conseguiu extrair nome — pode ser pergunta
            const directQ = handleDirectQuestion(flags, state, incomingText);
            if (directQ) {
              reply = directQ.replace(/\n\n(Se quiser|Qual|Me responde|Me passa|Seu horário).*$/, "") + "\n\nAntes de seguir, me diz seu *primeiro nome* 😊";
            } else {
              reply = "Antes de tudo, me diz seu *primeiro nome* 😊";
            }
          }
        }

        // ── Captura do problema ──
        else if (state.stage === "ASK_PROBLEM") {
          const pb = extractProblemText(incomingText);
          if (pb) {
            state.problem_text = pb;
            state.condition = state.condition || detectCondition(pb) || state.focus || null;

            // Triagem adaptativa
            state.stage = "DIAGNOSTIC";
            const nextQ = getNextDiagQuestion(state, incomingText);
            if (nextQ) {
              reply = nextQ;
            } else {
              // Paciente já contou tudo → bridge direto
              state.stage = "BRIDGE";
              reply = bridgeReply(state);
            }
          } else {
            // Texto não parece problema — GPT tenta extrair
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
          // Atualizar dados com a resposta
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

        // ── Bridge: pós-triagem, esperando confirmação para agenda ──
        else if (state.stage === "BRIDGE") {
          if (flags.wantsBook || flags.asksHours || flags.confirms) {
            state.stage = "ASK_DAY";
            reply = await askDayReply();
          } else if (flags.wantsPrice) {
            state.price_ask_count += 1;
            reply = priceReply();
            state.stage = "ASK_PLAN";
          } else {
            // GPT para conversa aberta pós-bridge
            const ai = await runLia({ incomingText, state, flags, stageCTA: "Se quiser, eu posso te mostrar os horários disponíveis" });
            if (ai.reply === "__NEED_BOOK__") { state.stage = "ASK_DAY"; reply = await askDayReply(); }
            else if (ai.reply === "__NEED_PRICE__") { state.price_ask_count += 1; reply = priceReply(); state.stage = "ASK_PLAN"; }
            else { reply = ai.reply; state = mergeState(state, ai.updates); }
          }
        }

        // ── Escolher dia ──
        else if (state.stage === "ASK_DAY") {
          const dayChoice = extractNumericChoice(incomingText);
          const explicitDate = extractDateKey(incomingText);
          const suggested = await getSuggestedDayKeys();

          if (dayChoice && suggested[dayChoice - 1]) {
            state.date_key = suggested[dayChoice - 1];
            state.stage = "OFFER_SLOTS";
            reply = await offerSlotsReply(state);
          } else if (explicitDate) {
            const avail = await getAvailableSlotsForDate(explicitDate);
            if (!avail.length) { reply = "Esse dia está sem vagas no momento 😕 Quer que eu te mostre outra data?"; }
            else { state.date_key = explicitDate; state.stage = "OFFER_SLOTS"; reply = await offerSlotsReply(state); }
          } else if (flags.confirms && suggested.length) {
            // "pode ser", "tanto faz" → sugerir o primeiro
            state.date_key = suggested[0];
            state.stage = "OFFER_SLOTS";
            reply = await offerSlotsReply(state);
          } else {
            // ▸ V14 FIX: Se a mensagem é longa (>40 chars) ou tem "?", provavelmente é pergunta, não escolha de dia.
            //   Usar GPT para responder naturalmente + CTA do stage, em vez de repetir "qual dia".
            if (incomingText.length > 40 || incomingText.includes("?")) {
              const ai = await runLia({ incomingText, state, flags, stageCTA: "Qual dia fica melhor para você?" });
              if (ai.reply === "__NEED_PRICE__") { state.price_ask_count += 1; reply = priceReply(); state.stage = "ASK_PLAN"; }
              else if (ai.reply === "__NEED_BOOK__") { reply = await askDayReply(); }
              else if (ai.reply.startsWith("__")) { reply = await askDayReply(); }
              else { reply = ai.reply; state = mergeState(state, ai.updates); }
            } else {
              reply = "Qual dia fica melhor para você? Pode me responder com o número ou com o dia, por exemplo *quinta-feira* 😊";
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
            // ▸ V14 FIX: Fallback GPT para mensagens longas/perguntas em OFFER_SLOTS
            if (incomingText.length > 40 || incomingText.includes("?")) {
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
            // ▸ V14: NÃO repetir explicação da consulta aqui (paciente já ouviu no bridge)
            reply = `Obrigada 😊\n\nHorário reservado: *${prettySlot(state.date_key, state.slot_time)}*.\n\n${priceReply()}`;
          } else {
            reply = "Me manda seu *e-mail* certinho, por favor.";
          }
        }

        // ── Escolha do plano ──
        else if (state.stage === "ASK_PLAN") {
          const planKey = extractPlanChoice(incomingText);

          if (planKey) {
            state.selected_plan_key = planKey;
            // Gerar pagamento
            const holdCheck = state.date_key && state.slot_time ? await acquireSlotHold(state.date_key, state.slot_time, phone) : { ok: true };
            if (state.date_key && !holdCheck.ok) {
              state.slot_time = null;
              state.slot_key = null;
              state.stage = "OFFER_SLOTS";
              reply = "Esse horário acabou de ser preenchido 😕 Vou te mostrar outras opções.\n\n" + (await offerSlotsReply(state));
            } else {
              if (holdCheck.slot_key) state.slot_key = holdCheck.slot_key;

              // Se ainda faltam dados, coletar
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
                // Tudo pronto → gerar pagamento
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
          }
          // ▸ Se paciente não escolheu plano e Camada 1/2 não respondeu
          else if (!reply) {
            // Tentar GPT para entender o que o paciente disse
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
              // Pergunta ou objeção já tratada na Camada 1/2.
              // Se chegou aqui, mensagem não é nem pergunta nem objeção.
              // GPT responde com naturalidade + reconecta ao link.
              const ai = await runLia({ incomingText, state, flags, stageCTA: `Seu horário continua reservado. Para confirmar é só finalizar aqui: ${state.payment.link}` });
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

        // ── Intenção de agendar (fora de stage) ──
        else if (flags.wantsBook || flags.asksHours) {
          if (!state.nome) { state.stage = "ASK_NAME"; reply = askNameIntroReply(); }
          else if (!state.problem_text) { state.stage = "ASK_PROBLEM"; reply = askProblemReply(state); }
          else if (!state.date_key) { state.stage = "ASK_DAY"; reply = await askDayReply(); }
          else if (!state.slot_time) { state.stage = "OFFER_SLOTS"; reply = await offerSlotsReply(state); }
          else { state.stage = "ASK_PLAN"; reply = priceReply(); }
        }

        // ── Intenção de preço (fora de stage) ──
        else if (flags.wantsPrice) {
          state.price_ask_count += 1;
          if (!state.nome) {
            if (state.price_ask_count >= 2) {
              state.stage = "ASK_PLAN";
              reply = priceReply();
            } else {
              state.stage = "ASK_NAME";
              reply = "Claro, vou te passar as opções 😊 Antes, me diz seu *primeiro nome*?";
            }
          } else {
            reply = priceReply();
            state.stage = "ASK_PLAN";
          }
        }

        // ── Intenção de pagar (fora de stage) ──
        else if (flags.intentPay) {
          if (state.payment?.status === "pending" && state.payment?.link) {
            reply = pendingPaymentReply(state);
            state.stage = "WAIT_PAYMENT";
          } else if (!state.date_key) {
            state.stage = "ASK_DAY";
            reply = `Perfeito 😊 Antes do pagamento, vou reservar seu horário.\n\n${await askDayReply()}`;
          } else {
            state.stage = "ASK_PLAN";
            reply = priceReply();
          }
        }

        // ── Recusa ──
        else if (flags.refuses) {
          reply = "Tranquilo, sem problema 😊 Se quiser tirar qualquer dúvida ou entender melhor como funciona, estou aqui.";
        }

      /* ═══════════════════════════════════════════════════════════════
         [CAMADA 4] — FALLBACK GPT
         ═══════════════════════════════════════════════════════════════ */

        else {
          const cta = getStageCTA(state);
          const ai = await runLia({ incomingText, state, flags, stageCTA: cta.trim() });

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
         ANTI-REPETIÇÃO + ENVIO
         ═══════════════════════════════════════════════════════════════ */

      // ▸ V14: Anti-repetição melhorado — nunca manda a mesma coisa
      // ▸ V14 FIX: Pular anti-repetição quando pagamento aprovado (repetir confirmação é esperado)
      if (state.payment?.status === "approved") {
        // OK — repetir afterPaidReply é comportamento correto
      } else if (similar(reply, state.last_bot_reply)) {
        // Tentar avançar para próximo passo lógico
        if (!state.nome) reply = askNameIntroReply();
        else if (!state.problem_text) reply = askProblemReply(state);
        else if (!state.date_key) reply = await askDayReply();
        else if (!state.slot_time && state.date_key) reply = await offerSlotsReply(state);
        else if (!state.nome_completo) reply = askFullNameReply(state);
        else if (!state.birthdate) reply = askBirthdateReply(state);
        else if (!state.email) reply = askEmailReply();
        else if (state.payment?.link) reply = pendingPaymentReply(state);
        else reply = "Me conta: como posso te ajudar agora? 😊";
      }

      // Contar uso do nome
      if (state.nome && reply.includes(state.nome)) {
        state.name_used_count = Number(state.name_used_count || 0) + 1;
      }

      const delaySec = computeHumanDelay(flags, state);
      state.last_bot_reply = reply;
      state.last_user_message = incomingText;
      state.last_sent_at = Date.now();

      await saveUserState(phone, state);
      await sendWhatsApp(lead, bot, reply, delaySec);

    } catch (err) {
      console.error("❌ Erro no processamento:", err);
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
}

/* ═══════════════════════════════════════════════════════════════════
   SERVER
   ═══════════════════════════════════════════════════════════════════ */

const PORT = process.env.PORT || 10000;
if (!IS_SIMULATOR_MODE) {
  app.listen(PORT, () => console.log(`🚀 LIA V17 rodando na porta ${PORT}`));
}

// =========================================
// ADAPTER PARA SIMULADOR
// =========================================

async function responderLIA_simulador(mensagem, contexto = {}) {
  const persona = contexto.persona || {};
  const historico = Array.isArray(contexto.historico) ? contexto.historico : [];
  const effectiveHistorico =
    historico.length > 0 &&
    historico[historico.length - 1]?.speaker === "patient" &&
    norm(historico[historico.length - 1]?.text || "") === norm(mensagem)
      ? historico.slice(0, -1)
      : historico;
  const flags = detectIntent(mensagem);
  const personaCondition = detectCondition(persona.condicao_principal || "");
  const messageCondition = detectCondition(mensagem);
  const firstName = typeof persona.nome_ficticio === "string" ? persona.nome_ficticio.split(" ")[0] : null;
  const normalizedMessage = norm(mensagem);

  const state = {
    nome: firstName,
    condition: messageCondition || personaCondition || null,
    focus: messageCondition || personaCondition || null,
    problem_text: extractProblemText(mensagem) || persona.condicao_principal || null,
    stage: null,
    evidence_used_count: 0,
    lead_profile: classifyLead(flags, mensagem, { problem_text: extractProblemText(mensagem) || persona.condicao_principal || null }),
    date_key: null,
    slot_time: null,
    nome_completo: null,
    birthdate: null,
    email: null,
    selected_plan_key: "basic",
    payment: null,
  };

  for (const item of effectiveHistorico) {
    const text = String(item.text || "");
    const low = norm(text);

    if (item.speaker === "lia") {
      if (
        text.includes("Essa semana ainda tenho horários disponíveis") ||
        low.includes("horarios disponiveis desta semana") ||
        low.includes("qual dia costuma ficar melhor") ||
        low.includes("qual dia fica melhor para voce") ||
        low.includes("qual dia fica melhor para você")
      ) {
        state.stage = "ASK_DAY";
      } else if (text.startsWith("Para *") && text.includes("Qual fica melhor")) {
        state.stage = "OFFER_SLOTS";
      } else if (low.includes("nome completo") && low.includes("data de nascimento") && (low.includes("e-mail") || low.includes("email"))) {
        state.stage = "ASK_CADASTRE";
      } else if (low.includes("nome completo")) {
        state.stage = "ASK_FULLNAME";
      } else if (low.includes("data de nascimento")) {
        state.stage = "ASK_BIRTHDATE";
      } else if (low.includes("e-mail") || low.includes("email")) {
        state.stage = "ASK_EMAIL";
      } else if (low.includes("hoje trabalhamos com estas opcoes") || low.includes("duas modalidades principais")) {
        state.stage = "ASK_PLAN";
      } else if (low.includes("para confirmar sua consulta, e so finalizar aqui") || low.includes("para confirmar, e so finalizar aqui")) {
        const linkMatch = text.match(/https?:\/\/\S+/i);
        state.payment = {
          status: "pending",
          link: linkMatch ? linkMatch[0] : "https://pagamento.teste/lia",
        };
        state.stage = "WAIT_PAYMENT";
      } else if (low.includes("pagamento confirmado") || low.includes("consulta esta marcada") || low.includes("consulta está marcada")) {
        state.payment = state.payment || { link: "https://pagamento.teste/lia" };
        state.payment.status = "approved";
        state.stage = "CONFIRMED";
      }
      continue;
    }

    if (!state.date_key) {
      const extractedDateKey = extractDateKey(text);
      if (extractedDateKey) state.date_key = extractedDateKey;
    }

    if (!state.slot_time) {
      const extractedTime = extractHourOnly(text);
      if (extractedTime) state.slot_time = extractedTime;
    }

    if (!state.nome_completo) {
      const fullName = extractFullName(text);
      if (fullName) state.nome_completo = fullName;
    }

    if (!state.birthdate) {
      const extractedBirthdate = extractBirthDate(text);
      if (extractedBirthdate) state.birthdate = extractedBirthdate;
    }

    if (!state.email) {
      const extractedEmail = extractEmail(text);
      if (extractedEmail) state.email = extractedEmail;
    }

    if (norm(text) === "aprovar_teste") {
      state.payment = state.payment || { link: "https://pagamento.teste/lia" };
      state.payment.status = "approved";
      state.stage = "CONFIRMED";
    }
  }

  const paymentWasRequested =
    state.payment?.link ||
    effectiveHistorico.some(
      (item) =>
        item.speaker === "lia" &&
        (norm(item.text || "").includes("para confirmar sua consulta, e so finalizar aqui") ||
          norm(item.text || "").includes("para confirmar, e so finalizar aqui") ||
          /https?:\/\/\S+/i.test(String(item.text || ""))),
    );

  if ((state.stage === "WAIT_PAYMENT" || paymentWasRequested) && normalizedMessage === "aprovar_teste") {
    state.payment = state.payment || { link: "https://pagamento.teste/lia" };
    state.payment.status = "approved";
    return afterPaidReply({
      ...state,
      date_key: state.date_key || "13-03",
      slot_time: state.slot_time || "19h",
    });
  }

  if (state.stage === "ASK_DAY") {
    let dateKey = extractDateKey(mensagem);
    if (!dateKey) {
      const numericChoice = extractNumericChoice(mensagem);
      const suggested = await getSuggestedDayKeys();
      if (numericChoice && suggested[numericChoice - 1]) dateKey = suggested[numericChoice - 1];
    }

    if (dateKey) {
      state.date_key = dateKey;
      return offerSlotsReply(state);
    }

    return await askDayReply();
  }

  if (state.stage === "OFFER_SLOTS") {
    let slotTime = extractHourOnly(mensagem);

    if (!slotTime) {
      const numericChoice = extractNumericChoice(mensagem);
      const best = await chooseBestSlotsForDate(state.date_key || "13-03", 3);
      if (numericChoice && best[numericChoice - 1]) slotTime = best[numericChoice - 1];
    }

    if (slotTime) {
      state.slot_time = slotTime;
      return askCadastreBundleReply({
        ...state,
        date_key: state.date_key || "13-03",
        slot_time: state.slot_time,
      });
    }

    return offerSlotsReply({
      ...state,
      date_key: state.date_key || "13-03",
    });
  }

  if (state.stage === "ASK_CADASTRE") {
    const fullName = extractFullName(mensagem);
    const birthdate = extractBirthDate(mensagem);
    const email = extractEmail(mensagem);

    if (fullName && birthdate && email) {
      state.nome_completo = fullName;
      state.birthdate = birthdate;
      state.email = email;
      const plan = PLANS[state.selected_plan_key || "basic"];
      const fakeLink = `https://pagamento.teste/${persona.id || "lead"}-${state.date_key || "13-03"}-${state.slot_time || "19h"}`;
      return paymentSentReply(plan, fakeLink, {
        ...state,
        date_key: state.date_key || "13-03",
        slot_time: state.slot_time || "19h",
      });
    }

    return askCadastreBundleReply({
      ...state,
      date_key: state.date_key || "13-03",
      slot_time: state.slot_time || "19h",
    });
  }

  if (state.stage === "ASK_FULLNAME") {
    const fullName = extractFullName(mensagem);
    if (fullName) {
      state.nome_completo = fullName;
      return askBirthdateReply({
        ...state,
        nome_completo: fullName,
      });
    }
    return "Me manda seu *nome completo* certinho, por favor.";
  }

  if (state.stage === "ASK_BIRTHDATE") {
    const birthdate = extractBirthDate(mensagem);
    if (birthdate) {
      state.birthdate = birthdate;
      return askEmailReply();
    }
    return "Me manda sua *data de nascimento* no formato *dd/mm/aaaa*.";
  }

  if (state.stage === "ASK_EMAIL") {
    const email = extractEmail(mensagem);
    if (email) {
      state.email = email;
      const plan = PLANS[state.selected_plan_key || "basic"];
      const fakeLink = `https://pagamento.teste/${persona.id || "lead"}-${state.date_key || "13-03"}-${state.slot_time || "19h"}`;
      return paymentSentReply(plan, fakeLink, {
        ...state,
        date_key: state.date_key || "13-03",
        slot_time: state.slot_time || "19h",
      });
    }
    return askEmailReply();
  }

  if (state.stage === "WAIT_PAYMENT" && state.payment?.link) {
    if (flags.intentPay || flags.asksPayMethod || normalizedMessage.includes("link")) {
      return pendingPaymentReply({
        ...state,
        date_key: state.date_key || "13-03",
        slot_time: state.slot_time || "19h",
      });
    }
  }

  const operationalCloseReply = await maybeHandleOperationalClose(state, flags, mensagem);
  if (operationalCloseReply) return operationalCloseReply;

  const priorityAnswer = getPriorityTrustAnswer(state, mensagem);
  if (priorityAnswer) return priorityAnswer + getStageCTA(state);

  if (flags.wantsPrice) {
    return "Hoje a consulta com o Dr. Alef tem duas modalidades principais: avaliação inicial por R$347 e acompanhamento com retorno por R$447. Se quiser, eu te explico rapidinho qual costuma fazer mais sentido para cada caso 😊";
  }

  const directAnswer = handleDirectQuestion(flags, state, mensagem);
  if (directAnswer) return directAnswer;

  const objectionAnswer = handleObjection(flags, state, mensagem);
  if (objectionAnswer) return objectionAnswer;

  if (flags.wantsBook || flags.asksHours || flags.confirms) {
    return "Consigo sim 😊 A consulta é 100% online e eu posso te mostrar os horários disponíveis desta semana. Qual dia costuma ficar melhor para você?";
  }

  if (flags.asksIfWorks) {
    return "Essa é uma dúvida muito comum. Muita gente procura o Dr. Alef justamente depois de já ter tentado outros caminhos. A consulta serve para avaliar com honestidade se existe indicação real para o seu caso, com segurança e sem promessa vazia.\n\nSe fizer sentido, eu posso te explicar como funciona a avaliação 😊";
  }

  if (state.problem_text || state.condition || persona.condicao_principal) {
    return bridgeReply(state);
  }

  return `Entendi, ${state.nome || "tudo bem"} 😊 Antes de te orientar melhor, me conta rapidinho o que mais tem te incomodado hoje?`;
}

module.exports = { responderLIA_simulador };
