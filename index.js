/**
 * LIA V12.1 — WhatsApp Bot (Twilio + Render + Postgres + OpenAI + Mercado Pago)
 * Corrige:
 * - Nome obrigatório (gate)
 * - Premium antes do agendamento/preço
 * - 87% prova social
 * - Anti-alucinação: IA não pode soltar preço/link
 * - Link real Mercado Pago (Checkout Pro) + webhook de confirmação
 *
 * ENV:
 * OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, DATABASE_URL
 * MP_ACCESS_TOKEN
 * PUBLIC_BASE_URL (ex: https://lia-whatsapp-bot.onrender.com)
 * MODEL_CHAT (opcional) ex: gpt-4.1
 * MIN_DELAY_SEC / MAX_DELAY_SEC (opcional)
 * MP_WEBHOOK_SECRET (opcional) — não implementado aqui (opcional endurecer)
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
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) console.error("❌ Falta TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN");
if (!DATABASE_URL) console.error("❌ Falta DATABASE_URL");
if (!MP_ACCESS_TOKEN) console.error("❌ Falta MP_ACCESS_TOKEN (Mercado Pago)");
if (!PUBLIC_BASE_URL) console.warn("⚠️ PUBLIC_BASE_URL não definido. Use em produção para URLs corretas (webhook/back_urls).");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const CHAT_MODEL = MODEL_CHAT || "gpt-4.1";
const MIN_DELAY = Number(MIN_DELAY_SEC || 0);
const MAX_DELAY = Number(MAX_DELAY_SEC || 0);

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

// ====== Nome (gate) ======
function extractNameFromText(text) {
  // captura nome simples (1 a 3 palavras) e ignora respostas óbvias
  const t = (text || "").trim();
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
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

// evita “Robert, Robert, Robert…”
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
    "O Dr. Alef analisa seu caso com bastante profundidade — com base na experiência clínica e na formação médica na Rússia.\n" +
    "Ele revisa todo seu histórico, entende como os sintomas impactam sua rotina, analisa o que você já tentou, confere medicações em uso e define objetivos claros de melhora — tudo alinhado ao seu caso.\n\n" +
    "A maioria dos pacientes prefere já iniciar com acompanhamento, porque assim conseguimos ajustar o plano com mais segurança."
  );
}

// ====== INTENTS ======
function detectIntent(text) {
  const t = norm(text);

  const wantsPrice = /\b(preco|preço|valor|quanto custa|investimento|custa|valores)\b/.test(t);
  const wantsBook = /\b(quero marcar|quero agendar|agendar|marcar|quero fechar|quero pagar|confirmar|pagar agora|quero consulta|gostaria de agendar)\b/.test(t);
  const asksHours = /\b(horarios|horario|que horas|vagas|agenda|disponibilidade|amanha|hoje|semana)\b/.test(t);
  const confirms = /\b(sim|ok|pode|confirmo|fechado|beleza|vamos|pode ser|serve|confirmar)\b/.test(t);

  const refuses = /\b(nao quero|não quero|pare|para|chega|rude|grosso|nao gostei|não gostei)\b/.test(t);

  const asksStartNow = /\b(como tomar|dose|dosagem|quantas gotas|comecar agora|começar agora)\b/.test(t);
  const urgency = /\b(dor no peito|falta de ar|desmaio|avc|convuls|paralisia|confusao|confusão)\b/.test(t);
  const asksWho = /\b(quem e|quem eh|quem e o dr|quem é|quem é o dr)\b/.test(t);
  const asksIfWorks = /\b(funciona|serve|vale a pena|ajuda|melhora|tem resultado)\b/.test(t);

  // escolha de plano (número ou palavras)
  const choosesFull = /\b(1|447|consulta com retorno|com retorno|acompanhamento|pacote|retorno em 30|acompanhamento medico)\b/.test(t);
  const choosesBasic = /\b(2|347|avaliacao|avaliação|avaliacao especializada|avaliação especializada|so a consulta|só a consulta)\b/.test(t);
  const choosesRetorno = /\b(3|200|retorno avulso|apenas retorno|consulta de ajuste)\b/.test(t);

  // “amanhã às 13”, “terça 14h” etc: capturamos só como sinal de horário
  const mentionsTime = /\b(\d{1,2}\s?h|\d{1,2}:\d{2}|amanha|amanhã|hoje|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo)\b/.test(t);

  const focus =
    (/\b(insonia|insomnia|dormir|sono|acordar)\b/.test(t) && "insonia") ||
    (/\b(ansiedade|panico|pânico|crise)\b/.test(t) && "ansiedade") ||
    (/\b(dor|fibromialgia|lombar|artrose|artrite|neuropat|enxaqueca)\b/.test(t) && "dor") ||
    null;

  return {
    wantsPrice, wantsBook, asksHours, confirms,
    refuses,
    asksStartNow, urgency, asksWho,
    asksIfWorks,
    choosesFull, choosesBasic, choosesRetorno,
    mentionsTime,
    focus
  };
}

// ====== Respostas determinísticas ======
function urgencyReply() {
  return "Entendi. Pela sua mensagem, isso pode precisar de avaliação URGENTE. Procure um pronto atendimento agora (ou SAMU 192). Assim que estiver seguro(a), me chama aqui.";
}

function whoReply() {
  return "Oi 🙂 Eu sou a Lia, da equipe do Dr. Alef Kotula. Atendimento 100% online. Quer que eu te explique em 30 segundos como funciona?";
}

function safetyDoseReply() {
  return "Entendi sua vontade de começar. Por segurança, eu não consigo orientar dose/como tomar por aqui 🙏 Isso depende do seu caso e das medicações. Se quiser, eu te explico como funciona a avaliação e já te ajudo a confirmar. Seu foco hoje é mais dor, sono ou ansiedade?";
}

// Preço com premium + 87%
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

function askPlanReply(state) {
  const n = maybeUseName(state);
  const greet = n ? `Perfeito, ${n} 😊` : "Perfeito 😊";
  return (
    `${greet}\n\n` +
    premiumIntroReply() + "\n\n" +
    "Pra eu te mandar o link certinho, qual opção você prefere?\n" +
    `1) *${PLANS.full.label}* — R$${PLANS.full.price} *(87% escolhem)* ⭐\n` +
    `2) *${PLANS.basic.label}* — R$${PLANS.basic.price}\n` +
    `3) *${PLANS.retorno.label}* — R$${PLANS.retorno.price}\n\n` +
    "Me responde com 1, 2 ou 3."
  );
}

function askNameReply() {
  return "Perfeito 🙂 Antes de eu te ajudar a agendar, qual seu *primeiro nome*?";
}

function askTurnoReply(state) {
  const n = maybeUseName(state);
  const greet = n ? `Perfeito, ${n} 🙂` : "Perfeito 🙂";
  return (
    `${greet}\n` +
    "Pra eu te sugerir horários reais, você prefere atendimento em qual turno?\n" +
    "• manhã\n• tarde\n• noite"
  );
}

function paymentSentReply(plan, link) {
  return (
    `Fechado ✅\n` +
    `*${plan.label}* — R$${plan.price}\n\n` +
    `Para confirmar, é só pagar por aqui:\n${link}\n\n` +
    "Assim que o pagamento for confirmado, eu te aviso aqui e seguimos. 🙂"
  );
}

function afterPaidReply(state) {
  const n = maybeUseName(state);
  const thanks = n ? `Pagamento confirmado ✅ Obrigado, ${n}!` : "Pagamento confirmado ✅ Obrigado!";
  return (
    `${thanks}\n` +
    "Agora me diga: você prefere atendimento em qual turno?\n" +
    "• manhã\n• tarde\n• noite"
  );
}

// ====== HUMAN DELAY ======
function computeHumanDelay(flags, state) {
  let base = randInt(MIN_DELAY, MAX_DELAY);
  if (flags.wantsBook || flags.asksHours || flags.mentionsTime) base = randInt(3, 6);
  if (flags.wantsPrice) base = randInt(4, 7);
  if (flags.asksIfWorks) base = randInt(6, 11);
  if (flags.refuses) base = randInt(5, 10);

  const lastAt = Number(state.last_sent_at || 0);
  if (Date.now() - lastAt < 2000) base += 2;

  return Math.max(2, base);
}

async function sendWhatsApp(to, from, body, delaySec) {
  await sleep(delaySec * 1000);
  await twilioClient.messages.create({ to, from, body });
}

// ====== OPENAI — somente para conversa aberta (com trava anti-alucinação) ======
function compactMemory(state) {
  const s = state || {};
  return {
    nome: s.nome || null,
    focus: s.focus || null,
    last_user_message: s.last_user_message || "",
    last_bot_reply: s.last_bot_reply || "",
    stage: s.stage || null,
  };
}

function buildSystemPromptV12() {
  return `
Você é "Lia", secretária/closer premium do Dr. Alef Kotula (consulta 100% online).

REGRAS ABSOLUTAS:
- Nunca inventar preço.
- Nunca enviar links.
- Nunca citar valores em R$ (isso é função do sistema).
- Nunca prescrever dose, nunca orientar compra, nunca recomendar marca.
- Nunca prometer cura/garantir resultado.
- 1 pergunta por mensagem. Mensagens curtas. Tom humano.

Se pedirem preço/valores/link de pagamento: responda "PRECISA_PRECO" (apenas isso).
Se pedirem agendar: responda "PRECISA_AGENDAR" (apenas isso).

FORMATO OBRIGATÓRIO (JSON puro):
{ "reply": "...", "updates": { ... } }
`;
}

function buildUserPromptV12({ incomingText, state, flags }) {
  const mem = compactMemory(state);
  return `
MEMÓRIA:
${JSON.stringify(mem)}

MENSAGEM:
${incomingText}

SINAIS:
${JSON.stringify(flags)}

TAREFA:
- Responder curto e humano.
- 1 pergunta no final.
- Se detectar nome do usuário, salvar em updates.nome (somente primeiro nome ou nome simples).
`;
}

function violatesNoPriceNoLink(text) {
  if (!text) return false;
  // se contiver R$, números tipo 300/400 em contexto de preço, ou qualquer http/https
  if (/\bhttps?:\/\//i.test(text)) return true;
  if (/R\$\s?\d/i.test(text)) return true;
  // bloquear "300", "400", "447", "347", "200" se vier fora das funções determinísticas
  if (/\b(200|300|347|400|447|500|600|700)\b/.test(text)) return true;
  return false;
}

async function runLiaV12({ incomingText, state, flags }) {
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.4,
    messages: [
      { role: "system", content: buildSystemPromptV12() },
      { role: "user", content: buildUserPromptV12({ incomingText, state, flags }) },
    ],
  });

  const content = resp.choices?.[0]?.message?.content?.trim() || "";
  let parsed = null;
  try { parsed = JSON.parse(content); } catch {}

  if (!parsed || typeof parsed !== "object" || !parsed.reply) {
    return { reply: "Entendi 🙂 Só pra eu te guiar: seu foco hoje é mais dor, sono ou ansiedade?", updates: {} };
  }

  const r = String(parsed.reply || "").trim();

  // comandos especiais (volta pro determinístico)
  if (r === "PRECISA_PRECO") return { reply: "__NEED_PRICE__", updates: parsed.updates || {} };
  if (r === "PRECISA_AGENDAR") return { reply: "__NEED_BOOK__", updates: parsed.updates || {} };

  // trava anti-alucinação (preço/link)
  if (violatesNoPriceNoLink(r)) {
    return { reply: "Entendi 🙂 Pra eu te passar valores certinhos e a forma de confirmar, me diga: seu foco hoje é mais dor, sono ou ansiedade?", updates: {} };
  }

  if (!parsed.updates) parsed.updates = {};
  parsed.reply = clip(r, 700);
  return parsed;
}

// ====== MERCADO PAGO (Checkout Pro) ======
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

// ====== MP THANKS (opcional) ======
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

      const status = payment.status; // approved, pending, rejected...
      const phone = mpExtractPhoneFromPayment(payment);
      if (!phone) return;

      const state = await getUserState(phone);

      state.payment = state.payment || {};
      state.payment.payment_id = paymentId;
      state.payment.status = status;
      state.payment.updated_at = Date.now();
      state.payment.amount = payment.transaction_amount || null;
      state.payment.plan_key = payment?.metadata?.plan_key || state.payment.plan_key || null;

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

// ====== WHATSAPP WEBHOOK (Twilio) ======
app.post("/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  res.type("text/xml").send(twiml.toString());

  (async () => {
    try {
      const lead = req.body.From || ""; // "whatsapp:+55..."
      const bot = req.body.To || "";
      const phone = lead.replace("whatsapp:", "").trim();

      const incomingText = (req.body.Body || "").trim();
      const finalText = incomingText;

      let state = await getUserState(phone);

      // defaults
      state.last_bot_reply = state.last_bot_reply || "";
      state.last_user_message = state.last_user_message || "";
      state.last_sent_at = state.last_sent_at || 0;
      state.nome = state.nome || null;
      state.focus = state.focus || null;
      state.payment = state.payment || null;
      state.stage = state.stage || null; // "ASK_NAME" | "PREMIUM_SENT" | "ASK_TURNO" | "ASK_PLAN" | etc
      state.name_used_count = Number(state.name_used_count || 0);

      // guarda "from" do bot (para envio proativo no webhook do MP)
      state.last_bot_from = bot;

      const flags = detectIntent(finalText);
      if (flags.focus) state.focus = flags.focus;

      let reply = "";

      // 0) Se pagamento aprovado: pós-pagamento
      if (state.payment?.status === "approved") {
        reply = afterPaidReply(state);
      }

      // 1) Urgência
      else if (flags.urgency) {
        reply = urgencyReply();
      }

      // 2) Quem é
      else if (flags.asksWho) {
        reply = whoReply();
      }

      // 3) Se estamos esperando nome
      else if (state.stage === "ASK_NAME" && !state.nome) {
        const nm = extractNameFromText(finalText);
        if (nm) {
          state.nome = nm;
          state.stage = "ASK_TURNO";
          reply = askTurnoReply(state);
        } else {
          reply = "Me diz só seu *primeiro nome* 🙂";
        }
      }

      // 4) Se usuário pediu preço: preço determinístico (com premium + 87%)
      else if (flags.wantsPrice) {
        // se não tem nome ainda, pergunta nome primeiro (gate)
        if (!state.nome) {
          state.stage = "ASK_NAME";
          reply = askNameReply();
        } else {
          reply = priceReply();
          state.stage = "ASK_PLAN";
        }
      }

      // 5) Dose
      else if (flags.asksStartNow) {
        reply = safetyDoseReply();
      }

      // 6) Agendar: PREMIUM PRIMEIRO (como você pediu)
      else if (flags.wantsBook || flags.asksHours || flags.mentionsTime) {
        // se ainda não mandamos o premium, manda agora (1x) e já “puxa” o nome/turno
        if (state.stage !== "PREMIUM_SENT" && state.stage !== "ASK_NAME" && state.stage !== "ASK_TURNO" && state.stage !== "ASK_PLAN") {
          reply = premiumIntroReply() + "\n\n" + "Pra eu te ajudar a agendar direitinho: qual seu *primeiro nome*?";
          state.stage = "ASK_NAME";
        } else {
          // já passou do premium, segue gate do nome
          if (!state.nome) {
            state.stage = "ASK_NAME";
            reply = askNameReply();
          } else {
            state.stage = "ASK_TURNO";
            reply = askTurnoReply(state);
          }
        }
      }

      // 7) Escolha de plano / confirmação de pagamento
      else if (flags.choosesFull || flags.choosesBasic || flags.choosesRetorno || (state.stage === "ASK_PLAN" && flags.confirms)) {
        // gate do nome
        if (!state.nome) {
          state.stage = "ASK_NAME";
          reply = askNameReply();
        } else {
          let planKey = null;
          if (flags.choosesFull) planKey = "full";
          else if (flags.choosesBasic) planKey = "basic";
          else if (flags.choosesRetorno) planKey = "retorno";

          if (!planKey) {
            reply = askPlanReply(state);
            state.stage = "ASK_PLAN";
          } else {
            const already =
              state.payment &&
              state.payment.preference_id &&
              state.payment.plan_key === planKey &&
              state.payment.status === "pending";

            if (already && state.payment.link) {
              reply = paymentSentReply(PLANS[planKey], state.payment.link);
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

              reply = paymentSentReply(pref.plan, pref.link);
            }

            state.stage = "WAIT_PAYMENT";
          }
        }
      }

      // 8) Se está aguardando pagamento: reforça link real
      else if (state.payment?.status === "pending" && state.payment?.link) {
        reply =
          "Perfeito 🙂 Pra confirmar, só falta o pagamento pelo link:\n" +
          `${state.payment.link}\n\n` +
          "Você prefere pagar no *Pix* ou *cartão*?";
      }

      // 9) Resistência
      else if (flags.refuses) {
        reply = "Tranquilo 🙂 Desculpa se soou pressionado. Quer que eu te explique rapidinho como funciona ou prefere só tirar uma dúvida agora?";
      }

      // 10) Conversa aberta (IA) — com travas
      else {
        const ai = await runLiaV12({ incomingText: finalText, state, flags });

        // se IA pedir preço/agendar, joga pro determinístico
        if (ai.reply === "__NEED_PRICE__") {
          if (!state.nome) {
            state.stage = "ASK_NAME";
            reply = askNameReply();
          } else {
            reply = priceReply();
            state.stage = "ASK_PLAN";
          }
        } else if (ai.reply === "__NEED_BOOK__") {
          if (state.stage !== "PREMIUM_SENT") {
            reply = premiumIntroReply() + "\n\n" + "Pra eu te ajudar a agendar direitinho: qual seu *primeiro nome*?";
            state.stage = "ASK_NAME";
          } else if (!state.nome) {
            state.stage = "ASK_NAME";
            reply = askNameReply();
          } else {
            state.stage = "ASK_TURNO";
            reply = askTurnoReply(state);
          }
        } else {
          reply = ai.reply;
          state = mergeState(state, ai.updates);

          // se a IA capturou nome via updates
          if (!state.nome && ai.updates?.nome) state.nome = String(ai.updates.nome).trim();
        }
      }

      // anti-loop final
      if (similar(reply, state.last_bot_reply)) {
        reply = "Entendi 🙂 Só pra eu te guiar sem enrolar: seu foco hoje é mais dor, sono ou ansiedade?";
      }

      // controla repetição do nome
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
          body: "Tive uma instabilidade rápida aqui 🙏 Me manda de novo em 1 frase: seu foco hoje é mais dor, sono ou ansiedade?",
        });
      } catch {}
    }
  })();
});

// ====== HEALTH CHECK ======
app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;

// (Opcional / Debug) cria link manual
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
