/**
 * LIA V12 — WhatsApp Bot (Twilio + Render + Postgres + OpenAI + Mercado Pago)
 * - Conversa humana + closer premium
 * - Delay humano + anti-loop
 * - Pagamento Mercado Pago (Checkout Pro): gera link e manda no WhatsApp
 * - Webhook Mercado Pago: confirma pagamento e libera próximo passo
 * - Agenda ainda NÃO integrada (entra na V13)
 *
 * ENV:
 * OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, DATABASE_URL
 * MP_ACCESS_TOKEN
 * PUBLIC_BASE_URL (opcional) ex: https://lia-whatsapp-bot.onrender.com
 * MODEL_CHAT (opcional) ex: gpt-4.1
 * MIN_DELAY_SEC / MAX_DELAY_SEC (opcional)
 */

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();

// Twilio webhook usa x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));
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
  MP_WEBHOOK_SECRET, // opcional
} = process.env;

if (!OPENAI_API_KEY) console.error("❌ Falta OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) console.error("❌ Falta TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN");
if (!DATABASE_URL) console.error("❌ Falta DATABASE_URL");
if (!MP_ACCESS_TOKEN) console.error("❌ Falta MP_ACCESS_TOKEN (Mercado Pago)");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const CHAT_MODEL = MODEL_CHAT || "gpt-4.1";
const MIN_DELAY = Number(MIN_DELAY_SEC || 6);
const MAX_DELAY = Number(MAX_DELAY_SEC || 10);

const BASE_URL = (PUBLIC_BASE_URL || "").trim() || "http://localhost:10000";

// ====== PLANOS (ajuste se quiser) ======
const PLANS = {
  basic: { key: "basic", label: "Consulta online (45 min)", price: 347 },
  full: { key: "full", label: "Consulta + retorno (~30 dias)", price: 447 },
  retorno: { key: "retorno", label: "Retorno avulso", price: 200 },
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

// ====== INTENTS ======
function detectIntent(text) {
  const t = norm(text);

  const wantsPrice = /\b(preco|preço|valor|quanto custa|investimento|custa)\b/.test(t);
  const wantsBook = /\b(quero marcar|quero agendar|agendar consulta|marcar consulta|quero fechar|quero pagar|confirmar)\b/.test(t);
  const asksHours = /\b(horarios|horario|que horas|vagas|agenda|disponibilidade)\b/.test(t);
  const confirms = /\b(sim|ok|pode|confirmo|fechado|beleza|vamos|pode ser|serve)\b/.test(t);

  const refuses = /\b(nao quero|não quero|pare|para|chega|rude|grosso|nao gostei|não gostei)\b/.test(t);
  const declinesSlot = /\b(outro horario|outro horário|nao posso|nao da|não dá|nao consigo|nao esse|não esse)\b/.test(t);

  const asksStartNow = /\b(como tomar|dose|dosagem|quantas gotas|comecar agora|começar agora)\b/.test(t);
  const urgency = /\b(dor no peito|falta de ar|desmaio|avc|convuls|paralisia|confusao|confusão)\b/.test(t);
  const asksWho = /\b(quem e|quem eh|quem e o dr|quem é|quem é o dr)\b/.test(t);

  const asksIfWorks = /\b(funciona|serve|vale a pena|ajuda|melhora|tem resultado)\b/.test(t);

  // escolha de plano (gatilhos simples)
  const choosesFull = /\b(447|retorno|consulta com retorno|com retorno|pacote|com acompanhamento)\b/.test(t);
  const choosesBasic = /\b(347|consulta basica|consulta básica|so a consulta|só a consulta|consulta simples)\b/.test(t);
  const choosesRetorno = /\b(200|retorno avulso|apenas retorno)\b/.test(t);

  const focus =
    (/\b(insonia|insomnia|dormir|sono|acordar)\b/.test(t) && "insonia") ||
    (/\b(ansiedade|panico|pânico|crise)\b/.test(t) && "ansiedade") ||
    (/\b(dor|fibromialgia|lombar|artrose|artrite|neuropat|enxaqueca)\b/.test(t) && "dor") ||
    null;

  return {
    wantsPrice, wantsBook, asksHours, confirms,
    refuses, declinesSlot,
    asksStartNow, urgency, asksWho,
    asksIfWorks,
    choosesFull, choosesBasic, choosesRetorno,
    focus
  };
}

// ====== FUNIL (determinístico) ======
function urgencyReply() {
  return "Entendi. Pela sua mensagem, isso pode precisar de avaliação URGENTE. Procure um pronto atendimento agora (ou SAMU 192). Assim que estiver seguro(a), me chama aqui.";
}

function whoReply() {
  return "Oi 🙂 Eu sou a Lia, da equipe do Dr. Alef Kotula. Atendimento 100% online. Quer que eu te explique em 30 segundos como funciona a consulta?";
}

function priceReply() {
  return (
    "Perfeito 😊\n" +
    "• Consulta online (45 min): R$347\n" +
    "• Consulta + retorno (~30 dias): R$447 (recomendada)\n" +
    "• Retorno avulso: R$200\n\n" +
    "Qual opção faz mais sentido pra você: 347 (consulta) ou 447 (consulta + retorno)?"
  );
}

function safetyDoseReply() {
  return "Entendi sua vontade de começar. Por segurança, eu não consigo orientar dose/como tomar por aqui 🙏 Isso depende do seu caso e das medicações. Se quiser, eu te explico como funciona a avaliação e já te mando a forma de confirmar. Seu foco hoje é mais dor, sono ou ansiedade?";
}

function askPlanReply(nome) {
  const n = nome ? ` ${nome}` : "";
  return (
    `Perfeito${n} 😊\n` +
    "Pra eu te mandar o link certinho, qual você prefere?\n" +
    "1) Consulta (45 min) — R$347\n" +
    "2) Consulta + retorno — R$447 (recomendada)\n" +
    "3) Retorno avulso — R$200\n\n" +
    "Me responde com 1, 2 ou 3."
  );
}

function paymentSentReply(plan, link) {
  const label = plan?.label || "Consulta";
  const price = plan?.price || "";
  return (
    `Fechado ✅\n` +
    `${label} — R$${price}\n\n` +
    `Para confirmar, é só pagar por aqui:\n${link}\n\n` +
    "Assim que o pagamento for confirmado, eu te respondo aqui e seguimos pro próximo passo. 🙂"
  );
}

function afterPaidReply(nome) {
  const n = nome ? `, ${nome}` : "";
  return (
    `Pagamento confirmado ✅ Obrigado${n}!\n` +
    "Agora me diga: você prefere atendimento em qual turno?\n" +
    "• manhã\n• tarde\n• noite"
  );
}

// ====== HUMAN DELAY ======
function computeHumanDelay(flags, state) {
  let base = randInt(MIN_DELAY, MAX_DELAY);

  if (flags.wantsBook || flags.asksHours) base = randInt(3, 6);
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

// ====== OPENAI — conversa aberta (somente quando precisa) ======
function compactMemory(state) {
  const s = state || {};
  return {
    nome: s.nome || null,
    focus: s.focus || null,
    lead_type: s.lead_type || null,
    payment: s.payment || null,
    last_user_message: s.last_user_message || "",
    last_bot_reply: s.last_bot_reply || "",
  };
}

function buildSystemPromptV12() {
  return `
Você é "Lia", secretária/closer premium do Dr. Alef Kotula (consulta 100% online).
Objetivo: soar humana, acolher, gerar confiança e conduzir para confirmação (pagamento) quando houver sinal.

REGRAS ABSOLUTAS:
- Nunca prescrever dose, nunca orientar compra, nunca recomendar marca.
- Nunca prometer cura/garantir resultado.
- 1 pergunta por mensagem. Mensagens curtas. Tom humano (sem robô).
- Se o lead pedir preço: responda com valores e pergunte qual opção prefere.
- Se o lead estiver em "aguardando pagamento": lembrar do link e tirar dúvida curta.

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
- Se aparecer nome, guardar em updates.nome.
`;
}

async function runLiaV12({ incomingText, state, flags }) {
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.5,
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
  if (!parsed.updates) parsed.updates = {};
  parsed.reply = clip(parsed.reply, 700);
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
    // As URLs abaixo são opcionais e não travam nada.
    // Você pode mudar depois para páginas suas (ex: /obrigado).
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
  // init_point (produção) / sandbox_init_point (teste)
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

// Associa phone pelo external_reference/metadata (vem no pagamento)
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
  // Responde rápido para o MP
  res.status(200).send("OK");

  try {
    // Mercado Pago geralmente manda:
    // { action, api_version, data: { id }, date_created, id, live_mode, type, user_id }
    const body = req.body || {};
    const type = body.type || body.topic; // algumas variações
    const paymentId = body?.data?.id || body?.id;

    if (!paymentId) return;

    // Aqui dá pra validar assinatura depois com MP_WEBHOOK_SECRET (se quiser endurecer)
    // Por enquanto: confirma buscando o pagamento na API (bem confiável)

    if (type && String(type).includes("payment")) {
      const payment = await mpGetPayment(paymentId);

      const status = payment.status; // approved, pending, rejected...
      const phone = mpExtractPhoneFromPayment(payment);

      if (!phone) return;

      const state = await getUserState(phone);
      const nome = state?.nome || null;

      state.payment = state.payment || {};
      state.payment.payment_id = paymentId;
      state.payment.status = status;
      state.payment.updated_at = Date.now();
      state.payment.amount = payment.transaction_amount || null;
      state.payment.plan_key = payment?.metadata?.plan_key || state.payment.plan_key || null;

      await saveUserState(phone, state);

      // Se aprovado: avisa o lead no WhatsApp
      if (status === "approved") {
        // Para enviar, precisamos do formato do Twilio:
        // to = "whatsapp:+55..."
        // from = número do Twilio (não temos aqui).
        // Então: enviamos via Twilio REST usando "to" e "from" exige o bot number.
        // Como o bot number (req.body.To) não vem aqui no webhook do MP,
        // a forma segura é: esperar a próxima mensagem do lead e a Lia reconhece "pago".
        //
        // Mesmo assim, dá pra tentar armazenar um "pending_bot_from" no state quando mandar o link.
        // Aí aqui a gente consegue enviar proactive.
        const botFrom = state?.last_bot_from || null; // salvo no fluxo do WhatsApp
        if (botFrom) {
          try {
            await twilioClient.messages.create({
              to: `whatsapp:${phone}`,
              from: botFrom,
              body: afterPaidReply(nome),
            });
          } catch (e) {
            // se falhar, ok — na próxima msg a Lia continua
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ MP webhook erro:", err);
  }
});

// ====== WHATSAPP WEBHOOK (Twilio) ======
app.post("/whatsapp", async (req, res) => {
  // responde rápido pro Twilio (não bloqueia)
  const twiml = new twilio.twiml.MessagingResponse();
  res.type("text/xml").send(twiml.toString());

  (async () => {
    try {
      const lead = req.body.From || ""; // "whatsapp:+55..."
      const bot = req.body.To || "";    // número do Twilio sandbox/WA
      const phone = lead.replace("whatsapp:", "").trim();

      const incomingText = (req.body.Body || "").trim();
      let finalText = incomingText;

      let state = await getUserState(phone);
      state.last_bot_reply = state.last_bot_reply || "";
      state.last_user_message = state.last_user_message || "";
      state.last_sent_at = state.last_sent_at || 0;
      state.nome = state.nome || null;
      state.focus = state.focus || null;
      state.payment = state.payment || null;

      // guarda "from" do bot para envio proativo após webhook
      state.last_bot_from = bot;

      const flags = detectIntent(finalText);

      if (flags.focus) state.focus = flags.focus;

      let reply = "";

      // Se pagamento já aprovado, prioriza fluxo pós-pagamento
      if (state.payment?.status === "approved") {
        reply = afterPaidReply(state.nome);
      }
      // URGÊNCIA
      else if (flags.urgency) {
        reply = urgencyReply();
      }
      // QUEM É
      else if (flags.asksWho) {
        reply = whoReply();
      }
      // RESISTÊNCIA
      else if (flags.refuses) {
        reply = "Tranquilo 🙂 Desculpa se soou pressionado. Quer que eu te explique rapidinho como funciona a avaliação ou prefere só tirar uma dúvida agora?";
      }
      // PREÇO
      else if (flags.wantsPrice) {
        reply = priceReply();
      }
      // DOSE
      else if (flags.asksStartNow) {
        reply = safetyDoseReply();
      }
      // FLUXO PAGAMENTO: se ele quer agendar/pagar ou escolheu plano
      else if (flags.wantsBook || flags.asksHours || flags.choosesFull || flags.choosesBasic || flags.choosesRetorno) {
        // 1) Detecta plano
        let planKey = null;

        if (flags.choosesFull) planKey = "full";
        else if (flags.choosesBasic) planKey = "basic";
        else if (flags.choosesRetorno) planKey = "retorno";
        else {
          // se não escolheu explicitamente: pergunta
          reply = askPlanReply(state.nome);
          planKey = null;
        }

        // 2) Se já tem plano, gera link
        if (planKey) {
          // evita gerar link repetido em loop
          const already = state.payment && state.payment.preference_id && state.payment.plan_key === planKey && state.payment.status === "pending";
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
        }
      }
      // Se está aguardando pagamento e o lead fala algo
      else if (state.payment?.status === "pending" && state.payment?.link) {
        reply =
          "Perfeito 🙂 Pra confirmar o horário, só falta o pagamento pelo link:\n" +
          `${state.payment.link}\n\n` +
          "Quer que eu te ajude a escolher: Pix ou cartão?";
      }
      // CONVERSA ABERTA (LLM)
      else {
        const ai = await runLiaV12({ incomingText: finalText, state, flags });
        reply = ai.reply;
        state = mergeState(state, ai.updates);
      }

      // anti-loop final
      if (similar(reply, state.last_bot_reply)) {
        reply = "Entendi 🙂 Só pra eu te guiar sem enrolar: seu foco hoje é mais dor, sono ou ansiedade?";
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
// ==========================
// MERCADO PAGO - CRIAR LINK
// ==========================

app.post("/create-payment", async (req, res) => {
  try {
    const { amount, description } = req.body;

    const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        items: [
          {
            title: description,
            quantity: 1,
            currency_id: "BRL",
            unit_price: amount
          }
        ]
      })
    });

    const data = await response.json();

    res.json({
      payment_link: data.init_point
    });

  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao criar pagamento");
  }
});
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
