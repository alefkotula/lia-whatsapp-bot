/**
 * LIA V14 — WhatsApp Bot (Twilio + Render + Postgres + OpenAI + Mercado Pago)
 *
 * ✅ Mantido (sem mudar rotas/envs/tabelas):
 * - POST /whatsapp
 * - POST /mp/webhook
 * - GET  /mp/thanks
 * - GET  /
 * - Postgres: wa_users(phone PK, state JSONB, updated_at)
 * - Mercado Pago Checkout Pro (preferences + webhook)
 *
 * 🔒 Compliance (inalterável):
 * - Não diagnosticar / prescrever / sugerir dose / orientar compra.
 * - Nunca prometer cura ou garantir resultado.
 * - LLM NUNCA pode enviar “R$” ou links. Preço/link só via templates determinísticos.
 *
 * V14 — Mudanças principais (sem reescrever do zero):
 * A) Name Policy: mantém uso controlado do nome (anti-spam).
 * B) LoopGuard: evita respostas repetidas em loop.
 * C) Intents com prioridade fixa:
 *    URGENT > INTENT_PAY > INTENT_PRICE > INTENT_BOOK > INTENT_WORKS > objection > open chat
 * D) Closing Engine: premiumIntro/closingIntro 1x (flag PREMIUM_SENT) e retorno ao funil.
 * E) Evidence Engine (NUGGETS): 1–2 nuggets curtos por conversa, controlado por state.evidence.
 *    Formato obrigatório: Empatia → % curto → “Imagina…” → “na consulta avalio seu caso”.
 *    Regras: no máx. 1 nugget antes do preço e 1 nugget após objeção letal.
 * F) Objection Engine: respostas determinísticas para objeções letais + volta ao funil.
 * G) Idempotência:
 *    - Twilio por MessageSid (ignora duplicados).
 *    - Mercado Pago por paymentId/status + flag notified_approved.
 *
 * TODO (futuro, sem inventar agora): integração real de agenda (dia/hora), transcrição de áudio, painel admin.
 *
 * ENV:
 * OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, DATABASE_URL
 * MP_ACCESS_TOKEN
 * PUBLIC_BASE_URL (ex: https://lia-whatsapp-bot.onrender.com)
 * MODEL_CHAT (opcional) ex: gpt-4.1
 * MIN_DELAY_SEC / MAX_DELAY_SEC (opcional)
 * MP_WEBHOOK_SECRET (opcional) — ainda não validado aqui (hardening futuro)
 */

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();

// Twilio webhook usa x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

// Rotas JSON normais (debug)
app.use(express.json());

// Mercado Pago webhook geralmente vem JSON
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
  MP_WEBHOOK_SECRET, // opcional (não usado)
} = process.env;

if (!OPENAI_API_KEY) console.error("❌ Falta OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
  console.error("❌ Falta TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN");
if (!DATABASE_URL) console.error("❌ Falta DATABASE_URL");
if (!MP_ACCESS_TOKEN) console.error("❌ Falta MP_ACCESS_TOKEN (Mercado Pago)");
if (!PUBLIC_BASE_URL)
  console.warn(
    "⚠️ PUBLIC_BASE_URL não definido. Use em produção para URLs corretas (webhook/back_urls)."
  );

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const CHAT_MODEL = MODEL_CHAT || "gpt-4.1";
const MIN_DELAY = Number(MIN_DELAY_SEC || 6);
const MAX_DELAY = Number(MAX_DELAY_SEC || 10);

const BASE_URL = (PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "") || "http://localhost:10000";

// ====== PLANOS (Experiência) ======
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
  console.log("✅ Tabela wa_users pronta.");
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

async function saveUserState(phone, state) {
  await pool.query(
    "INSERT INTO wa_users (phone, state) VALUES ($1, $2::jsonb) ON CONFLICT (phone) DO UPDATE SET state=$2::jsonb, updated_at=NOW()",
    [phone, JSON.stringify(state || {})]
  );
}

// ====== HELPERS ======
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randDelaySec() {
  return randInt(MIN_DELAY, MAX_DELAY);
}

// ====== STRICT GUARD: LLM não pode enviar preço/link ======
function violatesNoPriceNoLink(text) {
  const t = String(text || "");
  if (!t) return false;

  // bloqueia links
  if (/https?:\/\/|www\./i.test(t)) return true;

  // bloqueia “R$” e padrões típicos de preço
  if (/R\$\s*\d+/i.test(t)) return true;
  if (/\b\d{2,4}\s*reais\b/i.test(t)) return true;

  return false;
}

// ====== NAME EXTRACT ======
function extractName(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  const low = norm(t);
  if (/(sim|ok|beleza|pode|claro|s|ss|show|tanto faz|nao|não)/.test(low)) return null;

  // remove emojis e pontuação excessiva
  const cleaned = t.replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  // se a pessoa escreveu "me chamo X" ou "sou X"
  const m = cleaned.match(/(?:me chamo|sou|nome é|nome e)\s+(.+)$/i);
  const candidate = (m?.[1] || cleaned).trim();

  const parts = candidate.split(" ").filter(Boolean);
  if (parts.length < 1 || parts.length > 4) return null;

  // descarta números puros
  if (/^\d+$/.test(candidate)) return null;

  // capitaliza
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

// evita “Robert, Robert, Robert”
function maybeUseName(state) {
  const nome = state?.nome;
  if (!nome) return "";
  const used = Number(state?.name_used_count || 0);
  // só usa nome nas 2 primeiras vezes e depois a cada 6 mensagens
  if (used < 2 || used % 6 === 0) return nome;
  return "";
}

// ====== TEXTO PREMIUM (ANTES DO PREÇO / ANTES DO AGENDAR) ======
function premiumIntroReply() {
  return (
    "A consulta é *100% online, segura e individualizada*, com duração média de *45 minutos*.\n\n" +
    "O Dr. Alef analisa seu caso com bastante profundidade - com base na experiência clínica e na formação médica na Rússia.\n" +
    "Ele revisa todo seu histórico, entende como os sintomas impactam sua rotina, analisa o que você já tentou, confere medicações em uso e define objetivos claros de melhora - tudo alinhado ao seu caso.\n\n" +
    "A maioria dos pacientes prefere já iniciar com acompanhamento, porque assim conseguimos ajustar o plano com mais segurança."
  );
}

// ====== V14: EVIDENCE ENGINE (NUGGETS) ======
const EVIDENCE_DB = {
  fibromialgia: {
    pct: "50–60%",
    claim: "de melhora na dor e na qualidade de vida",
    timeframe: "ao longo do tratamento",
  },
  dor_cronica: {
    pct: "47–51%",
    claim: "de redução no uso de opioides em pacientes com dor crônica",
    timeframe: "em alguns meses",
  },
  insonia: {
    pct: "60%",
    claim: "de pessoas que deixaram de ser classificadas como insones",
    timeframe: "em 2 semanas",
    extra: "com melhora de até 80% na qualidade do sono",
  },
};

function ensureEvidenceState(state) {
  if (!state.evidence || typeof state.evidence !== "object") {
    state.evidence = {
      used_count: 0,
      used_pre_price: false,
      used_post_objection: false,
      last_topic: null,
    };
  }
  state.evidence.used_count = Number(state.evidence.used_count || 0);
  state.evidence.used_pre_price = Boolean(state.evidence.used_pre_price);
  state.evidence.used_post_objection = Boolean(state.evidence.used_post_objection);
}

function detectEvidenceTopic(text, focusHint) {
  const t = norm(text || "");
  if (/(fibromialgia)/.test(t)) return "fibromialgia";
  if (/(insonia|insônia|insomnia|dormir|sono|acordar)/.test(t)) return "insonia";
  if (/(dor cr[oô]nica|dor cronica|dor|lombar|artrose|artrite|neuropat|enxaqueca)/.test(t))
    return "dor_cronica";
  if (focusHint === "insonia") return "insonia";
  if (focusHint === "dor") return "dor_cronica";
  return null;
}

function canUseEvidence(state, phase) {
  ensureEvidenceState(state);
  if (state.evidence.used_count >= 2) return false;
  if (phase === "pre_price" && state.evidence.used_pre_price) return false;
  if (phase === "post_objection" && state.evidence.used_post_objection) return false;
  return true;
}

function buildEvidenceNugget(topic) {
  const item = EVIDENCE_DB[topic];
  if (!item) return null;

  if (topic === "insonia") {
    return (
      "Sinto muito - insônia desgasta demais.\n" +
      `Um estudo mostrou que ${item.pct} das pessoas ${item.claim} ${item.timeframe} (${item.extra}).\n` +
      `Imagina dormir melhor já nas próximas semanas? Na consulta eu avalio seu caso com segurança.`
    );
  }

  if (topic === "dor_cronica") {
    return (
      "Entendo - dor crônica esgota a rotina.\n" +
      `Um estudo mostrou ${item.pct} ${item.claim} ${item.timeframe}.\n` +
      "Imagina ter mais controle da dor e depender menos de remédios fortes? Na consulta eu avalio seu caso."
    );
  }

  return (
    "Sinto muito - fibromialgia realmente desgasta.\n" +
    `Um estudo mostrou cerca de ${item.pct} ${item.claim} ${item.timeframe}.\n` +
    "Imagina você com bem menos dor no dia a dia? Na consulta eu avalio seu caso e vejo o que faz sentido pra você."
  );
}

function maybeAddEvidence(state, phase, topic) {
  if (!topic) return "";
  if (!EVIDENCE_DB[topic]) return "";
  if (!canUseEvidence(state, phase)) return "";

  const nugget = buildEvidenceNugget(topic);
  if (!nugget) return "";

  state.evidence.used_count = Number(state.evidence.used_count || 0) + 1;
  state.evidence.last_topic = topic;

  if (phase === "pre_price") state.evidence.used_pre_price = true;
  if (phase === "post_objection") state.evidence.used_post_objection = true;

  return nugget;
}

// ====== V14: OBJECTION ENGINE ======
function detectObjectionType(text) {
  const t = norm(text || "");

  if (/(maconha|chapar|chapado|drog(a|ado)|brisa|ficar doido|psicoativo)/.test(t))
    return "stigma_psychoactive";
  if (/(e legal|é legal|legalidade|anvisa|receita|policia|polícia|crime|ilegal)/.test(t))
    return "legalidade";
  if (/(caro|muito caro|sem dinheiro|nao tenho dinheiro|não tenho dinheiro|valor alto|preco alto|preço alto)/.test(t))
    return "custo";
  if (/(efeito colateral|faz mal|vicio|vício|dependencia|dependência|seguro|segurança|interacao|interação)/.test(t))
    return "seguranca";
  if (/(teste|exame|doping|antidoping|empresa|trabalho|drug test)/.test(t))
    return "teste_trabalho";
  if (/(marido|esposa|familia|família|medo do que vao dizer|medo do que vão dizer)/.test(t))
    return "familia_estigma";

  return null;
}

function isLethalObjection(type) {
  return [
    "stigma_psychoactive",
    "legalidade",
    "custo",
    "seguranca",
    "teste_trabalho",
    "familia_estigma",
  ].includes(type);
}

function objectionReply(type) {
  switch (type) {
    case "stigma_psychoactive":
      return (
        "Entendo totalmente essa preocupação.\n" +
        "Na consulta o Dr. avalia seu caso e explica opções seguras, sem “sensação de estar chapado”, quando isso for prioridade.\n" +
        "O mais importante é fazer do jeito certo e individualizado."
      );
    case "legalidade":
      return (
        "Boa pergunta - é um tema sério.\n" +
        "Na consulta o Dr. te orienta com segurança dentro do que é permitido e do que faz sentido pro seu caso.\n" +
        "Nada aqui é compra ou prescrição no chat: a gente avalia primeiro."
      );
    case "custo":
      return (
        "Entendo - e faz sentido pensar no investimento.\n" +
        "A ideia é avaliar se realmente vale pra você antes de qualquer decisão.\n" +
        "Se fizer sentido, eu te mostro as opções de consulta e você escolhe com calma."
      );
    case "seguranca":
      return (
        "Perfeito você perguntar isso.\n" +
        "Na consulta o Dr. revisa seu histórico e medicações pra ver segurança, interações e o que é adequado no seu caso.\n" +
        "Aqui no chat a gente não prescreve nada."
      );
    case "teste_trabalho":
      return (
        "Entendo - isso é importante.\n" +
        "Na consulta o Dr. avalia seu caso e conversa sobre riscos e cuidados com o seu contexto (inclusive trabalho).\n" +
        "Cada caso é individual."
      );
    case "familia_estigma":
      return (
        "Entendo demais - isso pesa mesmo.\n" +
        "Na consulta o Dr. explica de forma clínica e segura, pra você se sentir confiante e explicar pra família se precisar.\n" +
        "O foco é saúde, não uso recreativo."
      );
    default:
      return "";
  }
}

// ====== INTENTS ======
function detectIntent(text) {
  const t = norm(text);

  const urgency = /\b(dor no peito|falta de ar|desmaio|avc|convuls|paralisia|confusao|confusão|suicid|autoagress)\b/.test(
    t
  );

  const wantsPay = /\b(pagar|pagamento|pix|cartao|cartão|boleto|link de pagamento|link|checkout|finalizar)\b/.test(
    t
  );

  const wantsPrice = /\b(preco|preço|valor|quanto custa|investimento|custa|valores)\b/.test(t);

  const wantsBook = /\b(quero marcar|quero agendar|agendar|marcar|confirmar consulta|quero consulta|gostaria de agendar)\b/.test(
    t
  );
  const asksHours = /\b(horarios|horário|horarios|que horas|vagas|agenda|disponibilidade|amanha|amanhã|hoje|semana)\b/.test(
    t
  );

  const asksIfWorks = /\b(funciona|serve|vale a pena|ajuda|melhora|tem resultado)\b/.test(t);

  const asksWho = /\b(quem e|quem eh|quem é|quem é o dr|quem e o dr)\b/.test(t);

  const refuses = /\b(nao quero|não quero|pare|para|chega|grosso|rude|nao gostei|não gostei)\b/.test(t);

  const asksStartNow = /\b(como tomar|dose|dosagem|quantas gotas|começar agora|comecar agora)\b/.test(t);

  const choosesFull = /\b(1|447|consulta com retorno|com retorno|acompanhamento|pacote|retorno em 30|acompanhamento medico|acompanhamento médico)\b/.test(
    t
  );
  const choosesBasic = /\b(2|347|avaliacao|avaliação|avaliacao especializada|avaliação especializada|so a consulta|só a consulta)\b/.test(
    t
  );
  const choosesRetorno = /\b(3|200|retorno avulso|apenas retorno|consulta de ajuste)\b/.test(t);

  const mentionsTime = /\b(\d{1,2}\s?h|\d{1,2}:\d{2}|amanha|amanhã|hoje|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo)\b/.test(
    t
  );

  const focus =
    (/\b(insonia|insônia|insomnia|dormir|sono|acordar)\b/.test(t) && "insonia") ||
    (/\b(ansiedade|panico|pânico|crise)\b/.test(t) && "ansiedade") ||
    (/\b(dor|fibromialgia|lombar|artrose|artrite|neuropat|enxaqueca)\b/.test(t) && "dor") ||
    null;

  const objectionType = detectObjectionType(text);
  const isObjection = Boolean(objectionType);

  return {
    urgency,
    wantsPay,
    wantsPrice,
    wantsBook,
    asksHours,
    asksIfWorks,
    asksWho,
    refuses,
    asksStartNow,
    choosesFull,
    choosesBasic,
    choosesRetorno,
    mentionsTime,
    focus,
    isObjection,
    objectionType,
  };
}

// ====== CONTEÚDO (determinístico) ======
function askPlanReply(state) {
  const nome = maybeUseName(state);
  if (nome) state.name_used_count = Number(state.name_used_count || 0) + 1;

  return (
    (nome ? `${nome}, ` : "") +
    "qual opção você prefere?\n\n" +
    `1) *${PLANS.full.label}* - R$${PLANS.full.price} *(87% das pessoas escolhem essa opção)* ⭐\n` +
    `2) *${PLANS.basic.label}* - R$${PLANS.basic.price}\n` +
    `3) *${PLANS.retorno.label}* - R$${PLANS.retorno.price}\n\n` +
    "Responda com *1*, *2* ou *3*."
  );
}

function paymentSentReply(plan, link) {
  return (
    `Perfeito. Para finalizar, use este link de pagamento:\n${link}\n\n` +
    `Opção escolhida: *${plan.label}*.\n\n` +
    "Assim que o pagamento confirmar, eu te peço sua preferência de turno."
  );
}

function afterPaidReply(state) {
  const nome = maybeUseName(state);
  if (nome) state.name_used_count = Number(state.name_used_count || 0) + 1;

  return (
    "Pagamento confirmado ✅\n\n" +
    (nome ? `${nome}, ` : "") +
    "para agilizar, você prefere atendimento em qual turno?\n" +
    "1) Manhã\n2) Tarde\n3) Noite\n\n" +
    "Responda com *1*, *2* ou *3*."
  );
}

// ====== MERCADO PAGO ======
async function mpFetch(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.message || JSON.stringify(data);
    throw new Error(`MP error (${resp.status}): ${msg}`);
  }
  return data;
}

function mpExtractPhoneFromPayment(payment) {
  const phone = payment?.metadata?.phone || payment?.additional_info?.payer?.phone?.number;
  if (!phone) return null;
  return String(phone).replace(/\D/g, "").replace(/^55/, "")
    ? String(phone).replace(/\D/g, "")
    : String(phone).replace(/\D/g, "");
}

async function mpGetPayment(paymentId) {
  return await mpFetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, { method: "GET" });
}

async function mpCreatePreference({ phone, planKey }) {
  const plan = PLANS[planKey] || PLANS.basic;

  const payload = {
    items: [
      {
        title: `Consulta Dr. Alef Kotula - ${plan.label}`,
        quantity: 1,
        unit_price: plan.price,
      },
    ],
    payer: {},
    back_urls: {
      success: `${BASE_URL}/mp/thanks`,
      pending: `${BASE_URL}/mp/thanks`,
      failure: `${BASE_URL}/mp/thanks`,
    },
    auto_return: "approved",
    notification_url: `${BASE_URL}/mp/webhook`,
    metadata: {
      phone,
      plan_key: plan.key,
      plan_price: plan.price,
    },
  };

  const pref = await mpFetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return pref;
}

// ====== TWILIO SEND ======
async function sendWhatsApp(to, from, body, delaySec) {
  const delay = Math.max(0, Number(delaySec || 0));
  if (delay) await new Promise((r) => setTimeout(r, delay * 1000));
  await twilioClient.messages.create({ to, from, body });
}

// ====== OPENAI (V12 compat) ======
function buildSystemPromptV12() {
  return `
Você é a LIA, secretária virtual (tom humano) da equipe do Dr. Alef Kotula (médico, pós-graduado em Cannabis Medicinal, atendimento 100% online).
Sua missão: acolher, qualificar e conduzir para agendamento/pagamento da consulta (NÃO é consulta no chat).

REGRAS ABSOLUTAS:
- NUNCA diagnosticar.
- NUNCA prescrever, sugerir dose, nem orientar compra.
- NUNCA prometer cura ou garantir resultado.
- Se houver sinais de urgência (dor no peito, falta de ar, desmaio, sintomas neurológicos súbitos, risco de autoagressão), orientar procurar emergência/UPA e ENCERRAR.
- PRIVACIDADE: peça só o necessário.

REGRA CRÍTICA:
- Você NUNCA pode mencionar preço, valores em R$, nem enviar links.
- Se o usuário pedir preço/valores, responda APENAS com o token: __NEED_PRICE__
- Se o usuário pedir agendar/horários, responda APENAS com o token: __NEED_BOOK__

FORMATO DE SAÍDA (obrigatório):
Responda SEMPRE em JSON puro, sem markdown, no formato:
{"reply":"...","updates":{...}}
`;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function runLiaV12({ incomingText, state, flags }) {
  const sys = buildSystemPromptV12();
  const userMsg = incomingText || "";

  const messages = [
    { role: "system", content: sys },
    { role: "user", content: userMsg },
  ];

  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages,
    temperature: 0.6,
    max_tokens: 320,
  });

  const content = resp?.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(content);

  if (!parsed || typeof parsed.reply !== "string") {
    return {
      reply: "Entendi. Só pra eu te ajudar melhor: seu foco hoje é mais dor, sono ou ansiedade?",
      state,
    };
  }

  // tokens especiais para cair no determinístico
  if (parsed.reply.trim() === "__NEED_PRICE__") {
    return { reply: "__NEED_PRICE__", state };
  }
  if (parsed.reply.trim() === "__NEED_BOOK__") {
    return { reply: "__NEED_BOOK__", state };
  }

  const reply = String(parsed.reply || "").trim();

  // updates opcionais
  const updates = parsed.updates && typeof parsed.updates === "object" ? parsed.updates : null;
  if (updates) {
    state = { ...(state || {}), ...updates };
  }

  return { reply, state };
}

// ====== ROTAS MERCADO PAGO ======
app.get("/mp/thanks", (req, res) => {
  res.status(200).send("OK");
});

app.post("/mp/webhook", async (req, res) => {
  // Responde rápido (Mercado Pago pode reenviar)
  res.status(200).send("OK");

  try {
    const body = req.body || {};
    const type = body.type || body.topic;
    const paymentId = body?.data?.id || body?.id;

    if (!paymentId) return;

    // Só processa eventos de pagamento
    if (type && !String(type).includes("payment")) return;

    const payment = await mpGetPayment(paymentId);
    const status = payment.status; // approved, pending, rejected...

    const phone = mpExtractPhoneFromPayment(payment);
    if (!phone) return;

    const state = await getUserState(phone);

    state.payment = state.payment || {};
    state.payment.webhook = state.payment.webhook || {};

    // ====== V14: idempotência do webhook ======
    // Se já processamos este (paymentId + status), não faz nada (evita spam/duplicação)
    const already =
      state.payment.webhook.last_payment_id === String(paymentId) &&
      state.payment.webhook.last_status === String(status);

    if (already) return;

    state.payment.payment_id = paymentId;
    state.payment.status = status;
    state.payment.updated_at = Date.now();
    state.payment.amount = payment.transaction_amount || null;
    state.payment.plan_key = payment?.metadata?.plan_key || state.payment.plan_key || null;

    state.payment.webhook.last_payment_id = String(paymentId);
    state.payment.webhook.last_status = String(status);
    state.payment.webhook.last_at = Date.now();

    await saveUserState(phone, state);

    // Notificação proativa só 1x quando aprovado
    if (status === "approved") {
      if (state.payment.notified_approved) return;
      state.payment.notified_approved = true;
      await saveUserState(phone, state);

      const botFrom = state?.last_bot_from || null;
      if (botFrom) {
        try {
          await twilioClient.messages.create({
            to: `whatsapp:${phone}`,
            from: botFrom,
            body: afterPaidReply(state),
          });
        } catch (e) {
          console.warn("⚠️ Falha ao notificar approved:", e?.message || e);
        }
      }
    }
  } catch (err) {
    console.error("❌ MP webhook erro:", err);
  }
});

// ====== ROOT (health) ======
app.get("/", (req, res) => res.status(200).send("OK"));

// ====== DEBUG: criar pagamento manual (opcional) ======
app.post("/create-payment", async (req, res) => {
  try {
    const phone = String(req.body.phone || "").replace(/\D/g, "");
    const planKey = String(req.body.planKey || "basic");
    const pref = await mpCreatePreference({ phone, planKey });
    res.status(200).json({ init_point: pref.init_point, id: pref.id });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ====== TWILIO WHATSAPP WEBHOOK ======
app.post("/whatsapp", async (req, res) => {
  // Responde Twilio IMEDIATO para evitar retries
  const twiml = new twilio.twiml.MessagingResponse();
  res.type("text/xml").send(twiml.toString());

  try {
    const lead = req.body.From || "";
    const bot = req.body.To || "";
    const phone = String(lead).replace("whatsapp:", "").trim();

    const incomingTextRaw = (req.body.Body || "").trim();
    const incomingText = incomingTextRaw || "";

    // ====== V14: Idempotência Twilio por MessageSid ======
    const messageSid = req.body.MessageSid || req.body.SmsMessageSid || req.body.SmsSid || null;

    let state = await getUserState(phone);

    // Guarda o "from" do bot para envio proativo no webhook de pagamento
    state.last_bot_from = bot;

    // Inicializações (V14)
    state.stage = state.stage || "ASK_NAME";
    state.name_used_count = Number(state.name_used_count || 0);
    state.premium_sent = Boolean(state.premium_sent);

    ensureEvidenceState(state);

    // Se mensagem duplicada, ignora sem responder (evita loops e spam)
    if (
      messageSid &&
      state.last_message_sid &&
      String(state.last_message_sid) === String(messageSid)
    ) {
      console.log("↩️ DUPLICATE MessageSid ignorado:", messageSid);
      return;
    }
    if (messageSid) state.last_message_sid = String(messageSid);

    // Se já pagou, prioriza pós-pagamento (turno) e não “volta” para preço
    if (state?.payment?.status === "approved") {
      const reply = afterPaidReply(state);
      await saveUserState(phone, state);
      await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
      return;
    }

    const intent = detectIntent(incomingText);

    // atualiza focus no estado (se detectar)
    if (intent.focus && !state.focus) state.focus = intent.focus;

    // Detecta topic científico (por texto ou focus)
    const topic = detectEvidenceTopic(incomingText, intent.focus || state.focus);

    // ====== Prioridade de intents (V14) ======
    // URGENT > PAY > PRICE > BOOK > WORKS > objection > open chat

    // 1) Urgência
    if (intent.urgency) {
      const reply =
        "⚠️ Entendi. Pela segurança, esse tipo de sintoma precisa de avaliação presencial imediata.\n" +
        "Procure a emergência/UPA mais próxima agora, por favor. 🙏";
      await saveUserState(phone, state);
      await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
      return;
    }

    // 2) Gate de nome (quando apropriado)
    if (!state.nome && (intent.wantsPrice || intent.wantsBook || intent.wantsPay)) {
      const reply = "Antes de eu te passar as opções, me diz seu nome por favor 🙂";
      state.stage = "ASK_NAME";
      await saveUserState(phone, state);
      await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
      return;
    }

    // Se estamos coletando nome
    if (state.stage === "ASK_NAME" && !state.nome) {
      const nome = extractName(incomingText);
      if (nome) {
        state.nome = nome;
        state.stage = "ASK_TURNO";
        await saveUserState(phone, state);
        const reply = `Perfeito, ${nome}! 🙂 Você prefere focar mais em *dor*, *sono* ou *ansiedade*?`;
        await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
        return;
      } else {
        const reply = "Me diz só seu *nome* (pode ser só o primeiro) 🙂";
        await saveUserState(phone, state);
        await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
        return;
      }
    }

    // 3) Intent PAY (quer pagar / quer link / pix/cartão)
    if (intent.wantsPay) {
      // Se já existe pagamento pendente, reenvia link determinístico
      if (state?.payment?.status === "pending" && state?.payment?.link && state?.payment?.plan_key) {
        const plan = PLANS[state.payment.plan_key] || PLANS.basic;
        const reply = paymentSentReply(plan, state.payment.link);
        await saveUserState(phone, state);
        await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
        return;
      }

      // Se ainda não escolheu plano, manda fechamento (premium 1x) + nugget (preço) + menu de planos
      if (!state.premium_sent) {
        state.premium_sent = true; // PREMIUM_SENT (V14)
      }
      const nugget = maybeAddEvidence(state, "pre_price", topic);
      const reply = premiumIntroReply() + (nugget ? "\n\n" + nugget : "") + "\n\n" + askPlanReply(state);
      state.stage = "ASK_PLAN";
      await saveUserState(phone, state);
      await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
      return;
    }

    // 4) Intent PRICE
    if (intent.wantsPrice) {
      if (!state.premium_sent) state.premium_sent = true; // PREMIUM_SENT (V14)
      const nugget = maybeAddEvidence(state, "pre_price", topic);

      const reply = premiumIntroReply() + (nugget ? "\n\n" + nugget : "") + "\n\n" + askPlanReply(state);

      state.stage = "ASK_PLAN";
      await saveUserState(phone, state);
      await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
      return;
    }

    // 5) Intent BOOK (horários / marcar)
    if (intent.wantsBook || intent.asksHours || intent.mentionsTime) {
      // se ainda não falou do premium, manda 1x antes
      if (!state.premium_sent) state.premium_sent = true; // PREMIUM_SENT (V14)

      // Aqui: SEM enrolar. Se não tem plano/pgto pendente, vai pro plano.
      if (state?.payment?.status === "pending" && state?.payment?.link && state?.payment?.plan_key) {
        const plan = PLANS[state.payment.plan_key] || PLANS.basic;
        const reply =
          "Perfeito. Só falta finalizar o pagamento para eu confirmar sua preferência de turno.\n\n" +
          paymentSentReply(plan, state.payment.link);
        state.stage = "WAIT_PAYMENT";
        await saveUserState(phone, state);
        await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
        return;
      }

      const nugget = maybeAddEvidence(state, "pre_price", topic);

      const reply = premiumIntroReply() + (nugget ? "\n\n" + nugget : "") + "\n\n" + askPlanReply(state);

      state.stage = "ASK_PLAN";
      await saveUserState(phone, state);
      await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
      return;
    }

    // 6) Intent WORKS (funciona?) — pode usar 1 nugget cedo, sem palestra, e volta pro funil
    if (intent.asksIfWorks) {
      const nugget = maybeAddEvidence(state, "pre_price", topic);

      const nome = maybeUseName(state);
      const follow =
        (nome ? `${nome}, ` : "") +
        "pra eu te orientar direitinho: há quanto tempo você tem isso e o quanto atrapalha sua rotina (0 a 10)?";

      const reply = (nugget ? nugget + "\n\n" : "") + follow;

      await saveUserState(phone, state);
      await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
      return;
    }

    // 7) Objeção (determinístico) — pode usar 1 nugget após objeção letal
    if (intent.isObjection) {
      const base = objectionReply(intent.objectionType);

      let extra = "";
      if (isLethalObjection(intent.objectionType)) {
        // 1 nugget pós-objeção (se ainda não usado)
        extra = maybeAddEvidence(state, "post_objection", topic);
      }

      // volta pro funil (sem enrolar)
      let next = "";
      if (!state.nome) {
        next = "\n\nMe diz seu nome pra eu te ajudar certinho 🙂";
        state.stage = "ASK_NAME";
      } else {
        // chama o fechamento para plano (sem repetir premium)
        next = "\n\nSe fizer sentido pra você, eu te passo as opções de consulta agora. Quer que eu envie?";
      }

      const reply = base + (extra ? "\n\n" + extra : "") + next;

      await saveUserState(phone, state);
      await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
      return;
    }

    // 8) Escolha de plano (quando o usuário manda 1/2/3)
    if (intent.choosesFull || intent.choosesBasic || intent.choosesRetorno) {
      const planKey = intent.choosesFull ? "full" : intent.choosesBasic ? "basic" : "retorno";
      const plan = PLANS[planKey];

      // Reusa link pendente do mesmo plano (anti-duplicação já existente)
      if (
        state?.payment?.status === "pending" &&
        state?.payment?.link &&
        state?.payment?.plan_key === planKey
      ) {
        const reply = paymentSentReply(plan, state.payment.link);
        state.stage = "WAIT_PAYMENT";
        await saveUserState(phone, state);
        await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
        return;
      }

      // Cria preference + salva link pendente
      const pref = await mpCreatePreference({ phone, planKey });

      state.payment = state.payment || {};
      state.payment.status = "pending";
      state.payment.plan_key = planKey;
      state.payment.link = pref.init_point;
      state.payment.created_at = Date.now();

      state.stage = "WAIT_PAYMENT";

      const reply = paymentSentReply(plan, pref.init_point);

      await saveUserState(phone, state);
      await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
      return;
    }

    // 9) Se tem pagamento pendente e perguntou algo, relembrar sem gerar novo link
    if (state?.payment?.status === "pending" && state?.payment?.link && state?.payment?.plan_key) {
      const plan = PLANS[state.payment.plan_key] || PLANS.basic;
      const reply = paymentSentReply(plan, state.payment.link);
      state.stage = "WAIT_PAYMENT";
      await saveUserState(phone, state);
      await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
      return;
    }

    // (continua na PARTE 2...)    // 10) Dose / como tomar (compliance)
    if (intent.asksStartNow) {
      const reply =
        "Entendo sua dúvida.\n" +
        "Mas por segurança eu não posso orientar dose/como usar por aqui.\n" +
        "Na consulta o Dr. avalia seu caso e explica tudo com segurança.";
      await saveUserState(phone, state);
      await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
      return;
    }

    // 11) Quem é
    if (intent.asksWho) {
      const reply =
        "Eu sou a *Lia*, secretária virtual da equipe do Dr. Alef Kotula (atendimento 100% online).\n" +
        "Me conta rapidinho: você quer focar mais em *dor*, *sono* ou *ansiedade*?";
      await saveUserState(phone, state);
      await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
      return;
    }

    // ====== OPEN CHAT (LLM) — última opção ======
    // Mantém as travas: JSON obrigatório + nunca preço/link/R$ + tokens __NEED_PRICE__/__NEED_BOOK__
    const flags = { focus: state.focus || null };
    const result = await runLiaV12({ incomingText, state, flags });

    let reply = (result?.reply || "").trim();
    state = result?.state || state;

    // Tokens do LLM (V12 compat) caem no determinístico
    if (reply === "__NEED_PRICE__" || reply === "__NEED_BOOK__") {
      // Trata como pedido de preço/agendamento, com prioridade V14
      if (!state.nome) {
        reply = "Antes de eu te passar as opções, me diz seu nome por favor 🙂";
        state.stage = "ASK_NAME";
      } else {
        if (!state.premium_sent) state.premium_sent = true;
        const nugget = maybeAddEvidence(state, "pre_price", topic);
        reply =
          premiumIntroReply() +
          (nugget ? "\n\n" + nugget : "") +
          "\n\n" +
          askPlanReply(state);
        state.stage = "ASK_PLAN";
      }
      await saveUserState(phone, state);
      await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
      return;
    }

    // Guardrails extras (anti-vazamento)
    if (violatesNoPriceNoLink(reply)) {
      reply =
        "Para te passar valores ou links, eu preciso seguir um fluxo seguro.\n" +
        "Quer que eu te mostre as opções de consulta agora?";
    }

    // LoopGuard (V14): se repetir resposta, cai em fallback
    const normReply = norm(reply);
    if (state.last_bot_reply_norm && normReply && state.last_bot_reply_norm === normReply) {
      reply = "Entendi. Pra eu te ajudar melhor: seu foco hoje é mais *dor*, *sono* ou *ansiedade*?";
    }
    state.last_bot_reply_norm = normReply;

    await saveUserState(phone, state);
    await sendWhatsApp(`whatsapp:${phone}`, bot, reply, randDelaySec());
  } catch (err) {
    console.error("❌ /whatsapp erro:", err);
  }
});

// ====== START SERVER ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("✅ LIA rodando na porta", PORT));
