// index.js
// LIA — WhatsApp Bot (Twilio + Render + Postgres + OpenAI)
// Fluxo:
// greeting -> collect_name -> collect_problem -> present_plan -> choose_plan -> await_payment -> schedule_day -> finish

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER,
  DATABASE_URL,
  PORT = 3000,
  MODEL_CHAT = "gpt-5.2",
  PUBLIC_BASE_URL = "",
  ADMIN_PHONE = "",
} = process.env;

if (!OPENAI_API_KEY) console.error("❌ Falta OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) console.error("❌ Falta TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN");
if (!TWILIO_WHATSAPP_NUMBER) console.error("❌ Falta TWILIO_WHATSAPP_NUMBER");
if (!DATABASE_URL) console.error("❌ Falta DATABASE_URL");

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const PLANS = {
  full: {
    code: "full",
    label: "Acompanhamento Médico Especializado (Consulta + Retorno ~30 dias)",
    price: 447,
  },
  basic: {
    code: "basic",
    label: "Avaliação Médica Especializada (45 min)",
    price: 347,
  },
  retorno: {
    code: "retorno",
    label: "Consulta de Ajuste (Retorno avulso)",
    price: 200,
  },
};

const STATES = {
  GREETING: "greeting",
  COLLECT_NAME: "collect_name",
  COLLECT_PROBLEM: "collect_problem",
  PRESENT_PLAN: "present_plan",
  CHOOSE_PLAN: "choose_plan",
  AWAIT_PAYMENT: "await_payment",
  SCHEDULE_DAY: "schedule_day",
  FINISH: "finish",
};

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_users (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
}

function normalizePhone(phone = "") {
  return phone.replace(/\D/g, "");
}

async function getUser(phone) {
  const r = await pool.query(`SELECT * FROM wa_users WHERE phone = $1 LIMIT 1`, [phone]);
  if (r.rowCount) return r.rows[0];

  const inserted = await pool.query(
    `INSERT INTO wa_users (phone, state) VALUES ($1, $2::jsonb) RETURNING *`,
    [phone, JSON.stringify({ stage: STATES.GREETING, history: [] })]
  );
  return inserted.rows[0];
}

async function saveState(phone, state) {
  await pool.query(
    `UPDATE wa_users
     SET state = $2::jsonb,
         updated_at = NOW()
     WHERE phone = $1`,
    [phone, JSON.stringify(state)]
  );
}

async function sendWhatsApp(toPhoneDigits, message) {
  const to = `whatsapp:+${toPhoneDigits}`;
  await client.messages.create({
    from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
    to,
    body: message,
  });
}

function capHistory(history = [], max = 10) {
  return history.slice(-max);
}

function pushHistory(state, role, text) {
  if (!Array.isArray(state.history)) state.history = [];
  state.history.push({ role, text, ts: Date.now() });
  state.history = capHistory(state.history, 12);
}

function premiumIntroReply() {
  return (
    "A consulta é *100% online, segura e individualizada*, com duração média de *45 minutos*.\n\n" +
    "O *Dr. Alef* analisa seu caso com bastante profundidade — com base na experiência clínica e na formação médica na Rússia.\n" +
    "Ele revisa todo seu histórico, entende como os sintomas impactam sua rotina, analisa o que você já tentou, confere medicações em uso e define objetivos claros de melhora — tudo alinhado ao seu caso.\n\n" +
    "A maioria dos pacientes prefere já iniciar com *acompanhamento*, porque assim conseguimos ajustar o plano com mais segurança."
  );
}

function askNameReply() {
  return (
    "Olá 🙂 Sou a *LIA*, assistente virtual do Dr. Alef Kotula.\n\n" +
    "Atendo principalmente pessoas com *dor crônica, fibromialgia, artrose, artrite, dor na coluna, ansiedade e insônia*.\n\n" +
    "Pra eu te ajudar melhor, me diz seu *primeiro nome*?"
  );
}

function askProblemReply(name) {
  return (
    `Perfeito, *${name}*.\n\n` +
    "O que você quer tratar hoje?\n" +
    "*(Fibromialgia, dor crônica, artrose, artrite, dor na coluna, ansiedade, insônia ou outro?)*"
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

function choosePlanFromText(text = "") {
  const t = text.trim().toLowerCase();

  if (["1", "full", "acompanhamento", "consulta + retorno", "447"].includes(t)) return PLANS.full;
  if (["2", "basic", "avaliação", "avaliacao", "347"].includes(t)) return PLANS.basic;
  if (["3", "retorno", "ajuste", "200"].includes(t)) return PLANS.retorno;

  if (t.includes("acompanhamento")) return PLANS.full;
  if (t.includes("consulta + retorno")) return PLANS.full;
  if (t.includes("avalia")) return PLANS.basic;
  if (t.includes("retorno")) return PLANS.retorno;

  return null;
}

function looksLikePaymentConfirmation(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("paguei") ||
    t.includes("já paguei") ||
    t.includes("ja paguei") ||
    t.includes("pago") ||
    t.includes("comprovante") ||
    t.includes("pix feito") ||
    t.includes("pode confirmar")
  );
}

function looksLikeQuestionAboutPrice(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("valor") ||
    t.includes("preço") ||
    t.includes("preco") ||
    t.includes("quanto custa") ||
    t.includes("investimento")
  );
}

function sanitizeName(text = "") {
  const cleaned = text
    .replace(/[^\p{L}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const first = cleaned.split(" ")[0] || "";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function detectProblemTag(text = "") {
  const t = text.toLowerCase();

  if (t.includes("fibro")) return "fibromialgia";
  if (t.includes("artrose")) return "artrose";
  if (t.includes("artrite")) return "artrite";
  if (t.includes("coluna") || t.includes("lombar") || t.includes("cervical")) return "dor na coluna";
  if (t.includes("dor") || t.includes("crônica") || t.includes("cronica")) return "dor crônica";
  if (t.includes("ansiedade") || t.includes("ansioso")) return "ansiedade";
  if (t.includes("insônia") || t.includes("insonia") || t.includes("dormir")) return "insônia";

  return "outro";
}

function buildSystemPrompt() {
  return `
Você é a LIA, assistente virtual do Dr. Alef Kotula.
Sua missão é converter pacientes interessados em consulta médica para tratamento com cannabis medicinal em um próximo passo concreto: escolha de plano, pagamento e agendamento.

CONTEXTO DO PÚBLICO:
- dores crônicas
- fibromialgia
- artrose
- artrite
- dor na coluna
- ansiedade
- insônia
- podem aparecer outros quadros, mas a maioria será desses grupos

ESTILO:
- linguagem humana, acolhedora, segura e confiante
- mensagens curtas, em estilo WhatsApp
- máximo de 3 frases curtas por resposta
- foco em avanço de funil, não em aula longa
- sempre conduzir para o próximo passo

REGRAS DE CONVERSÃO:
- validar a dor do paciente
- transmitir segurança
- reforçar que a consulta é individualizada
- quando útil, mostrar que muita gente prefere acompanhamento
- evitar enrolação
- evitar excesso de tecnicismo
- não prometer cura
- não dar diagnóstico
- não prescrever
- não inventar preço
- não alterar os preços
- não oferecer descontos
- não mudar a estrutura dos planos
- nunca contradizer o texto oficial dos planos

TEXTO OFICIAL DOS PLANOS:
A consulta é 100% online, segura e individualizada, com duração média de 45 minutos.
O Dr. Alef analisa seu caso com bastante profundidade — com base na experiência clínica e na formação médica na Rússia.
Ele revisa todo seu histórico, entende como os sintomas impactam sua rotina, analisa o que você já tentou, confere medicações em uso e define objetivos claros de melhora — tudo alinhado ao seu caso.
A maioria dos pacientes prefere já iniciar com acompanhamento, porque assim conseguimos ajustar o plano com mais segurança.

O investimento é:
1) Acompanhamento Médico Especializado (Consulta + Retorno ~30 dias) — R$447 (87% das pessoas escolhem essa opção) ⭐
2) Avaliação Médica Especializada (45 min) — R$347
3) Consulta de Ajuste (Retorno avulso) — R$200

COMPORTAMENTO POR ETAPA:
- se o paciente ainda não informou nome: pedir o primeiro nome
- se já informou nome e ainda não informou principal queixa: perguntar o que deseja tratar
- se o paciente demonstrar interesse, medo, dúvida sobre funcionar ou segurança: responder em 2 ou 3 frases, com empatia e chamando para a consulta
- se o paciente perguntar valor: usar o texto oficial de preço, sem alterar valores
- se o paciente estiver hesitante: responder curto, com acolhimento, segurança e convite para avançar
- se o paciente estiver pronto: direcionar para pagamento ou agendamento
- sempre respeitar a etapa atual do funil enviada pelo sistema

FORMATO:
- retorne apenas a mensagem final
- sem aspas
- sem markdown excessivo
- no máximo 450 caracteres
  `.trim();
}

async function generateLiaReply({ stage, name, problem, userText, history }) {
  const prompt = buildSystemPrompt();

  const input = [
    {
      role: "system",
      content: [
        { type: "input_text", text: prompt }
      ]
    },
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            `ETAPA_ATUAL: ${stage}\n` +
            `NOME: ${name || "não informado"}\n` +
            `QUEIXA_PRINCIPAL: ${problem || "não informada"}\n` +
            `ULTIMAS_INTERACOES: ${JSON.stringify(history || [])}\n` +
            `MENSAGEM_DO_PACIENTE: ${userText}`
        }
      ]
    }
  ];

  const resp = await openai.responses.create({
    model: MODEL_CHAT,
    input,
    max_output_tokens: 160,
    temperature: 0.2,
  });

  return (resp.output_text || "").trim();
}

async function handleMessage(phoneDigits, incomingTextRaw) {
  const incomingText = (incomingTextRaw || "").trim();
  const userRow = await getUser(phoneDigits);
  const state = userRow.state || {};

  if (!state.stage) state.stage = STATES.GREETING;
  if (!Array.isArray(state.history)) state.history = [];

  if (incomingText.toLowerCase() === "reset" && ADMIN_PHONE && phoneDigits === normalizePhone(ADMIN_PHONE)) {
    const newState = { stage: STATES.GREETING, history: [] };
    await saveState(phoneDigits, newState);
    await sendWhatsApp(phoneDigits, "🔁 Memória resetada. Pode testar do zero agora.");
    return;
  }

  pushHistory(state, "user", incomingText);

  // Etapa 1
  if (state.stage === STATES.GREETING) {
    state.stage = STATES.COLLECT_NAME;
    const msg = askNameReply();
    pushHistory(state, "assistant", msg);
    await saveState(phoneDigits, state);
    await sendWhatsApp(phoneDigits, msg);
    return;
  }

  // Etapa 2
  if (state.stage === STATES.COLLECT_NAME) {
    const name = sanitizeName(incomingText);
    if (!name || name.length < 2) {
      const msg = "Me diz só seu *primeiro nome*, por favor 🙂";
      pushHistory(state, "assistant", msg);
      await saveState(phoneDigits, state);
      await sendWhatsApp(phoneDigits, msg);
      return;
    }

    state.name = name;
    state.stage = STATES.COLLECT_PROBLEM;
    const msg = askProblemReply(name);
    pushHistory(state, "assistant", msg);
    await saveState(phoneDigits, state);
    await sendWhatsApp(phoneDigits, msg);
    return;
  }

  // Etapa 3
  if (state.stage === STATES.COLLECT_PROBLEM) {
    state.problem = detectProblemTag(incomingText);

    const aiMsg = await generateLiaReply({
      stage: state.stage,
      name: state.name,
      problem: state.problem,
      userText:
        `O paciente descreveu a queixa assim: "${incomingText}". ` +
        `Valide em 1 frase curta e em seguida apresente o texto de valor de forma natural, guiando para a escolha do plano.`,
      history: state.history,
    });

    state.stage = STATES.CHOOSE_PLAN;
    pushHistory(state, "assistant", aiMsg);
    await saveState(phoneDigits, state);
    await sendWhatsApp(phoneDigits, aiMsg || askPlanReply());
    return;
  }

  // Etapa 4
  if (state.stage === STATES.CHOOSE_PLAN) {
    const chosen = choosePlanFromText(incomingText);

    if (chosen) {
      state.selected_plan = chosen.code;
      state.payment_link = await createPaymentLink(phoneDigits, chosen);
      state.stage = STATES.AWAIT_PAYMENT;

      const msg =
        `Perfeito, *${state.name || ""}*.\n\n` +
        `Você escolheu: *${chosen.label}* — *R$${chosen.price}*.\n\n` +
        `Aqui está seu link para confirmar a consulta:\n${state.payment_link}\n\n` +
        `Assim que pagar, me envie *“paguei”* para eu seguir com o agendamento.`;

      pushHistory(state, "assistant", msg);
      await saveState(phoneDigits, state);
      await sendWhatsApp(phoneDigits, msg);
      return;
    }

    if (looksLikeQuestionAboutPrice(incomingText)) {
      const msg = askPlanReply();
      pushHistory(state, "assistant", msg);
      await saveState(phoneDigits, state);
      await sendWhatsApp(phoneDigits, msg);
      return;
    }

    const aiMsg = await generateLiaReply({
      stage: state.stage,
      name: state.name,
      problem: state.problem,
      userText:
        `O paciente respondeu: "${incomingText}". ` +
        `Tente converter para a escolha de um dos 3 planos, com resposta curta e objetiva.`,
      history: state.history,
    });

    pushHistory(state, "assistant", aiMsg);
    await saveState(phoneDigits, state);
    await sendWhatsApp(phoneDigits, aiMsg || "Me responda com *1*, *2* ou *3* para eu seguir 🙂");
    return;
  }

  // Etapa 5
  if (state.stage === STATES.AWAIT_PAYMENT) {
    if (looksLikePaymentConfirmation(incomingText)) {
      state.stage = STATES.SCHEDULE_DAY;
      const msg = await askDayReply();
      pushHistory(state, "assistant", msg);
      await saveState(phoneDigits, state);
      await sendWhatsApp(phoneDigits, msg);
      return;
    }

    const aiMsg = await generateLiaReply({
      stage: state.stage,
      name: state.name,
      problem: state.problem,
      userText:
        `O paciente respondeu: "${incomingText}". ` +
        `Responda curto e conduza para pagamento do plano já escolhido.`,
      history: state.history,
    });

    pushHistory(state, "assistant", aiMsg);
    await saveState(phoneDigits, state);
    await sendWhatsApp(
      phoneDigits,
      aiMsg || `Assim que concluir o pagamento, me envie *“paguei”* para eu abrir as opções de agenda 🙂`
    );
    return;
  }

  // Etapa 6
  if (state.stage === STATES.SCHEDULE_DAY) {
    const dayKeys = await getSuggestedDayKeys();
    const matched = matchDayChoice(incomingText, dayKeys);

    if (!matched) {
      const msg =
        "Me diga qual dia você prefere dentre as opções enviadas 🙂\n" +
        `${formatDayOptions(dayKeys)}`;
      pushHistory(state, "assistant", msg);
      await saveState(phoneDigits, state);
      await sendWhatsApp(phoneDigits, msg);
      return;
    }

    state.date_key = matched;
    state.stage = STATES.FINISH;

    const msg =
      `Perfeito, *${state.name || ""}* 🙂\n\n` +
      `Recebi sua preferência para *${matched}*.\n` +
      `Vou deixar essa opção separada e a confirmação final segue conforme a disponibilidade no fechamento do agendamento.\n\n` +
      `Se quiser, já posso te orientar no próximo passo.`;

    pushHistory(state, "assistant", msg);
    await saveState(phoneDigits, state);
    await sendWhatsApp(phoneDigits, msg);
    return;
  }

  // Etapa final
  const aiMsg = await generateLiaReply({
    stage: state.stage,
    name: state.name,
    problem: state.problem,
    userText: incomingText,
    history: state.history,
  });

  pushHistory(state, "assistant", aiMsg);
  await saveState(phoneDigits, state);
  await sendWhatsApp(phoneDigits, aiMsg || "Perfeito 🙂");
}

async function askDayReply() {
  const dayKeys = await getSuggestedDayKeys();
  if (!dayKeys.length) {
    return "No momento os horários dessa semana já estão completos. Quer que eu te coloque na lista de prioridade assim que abrir uma vaga? 🙂";
  }

  return (
    "Perfeito 🙂\n\n" +
    "Nos próximos dias tenho agenda em:\n" +
    `${formatDayOptions(dayKeys)}\n\n` +
    "Qual você prefere?"
  );
}

function formatDayOptions(dayKeys = []) {
  return dayKeys.map((d, i) => `${i + 1}) ${d}`).join("\n");
}

function matchDayChoice(text = "", dayKeys = []) {
  const t = text.trim().toLowerCase();

  const byIndex = parseInt(t, 10);
  if (!Number.isNaN(byIndex) && dayKeys[byIndex - 1]) return dayKeys[byIndex - 1];

  const found = dayKeys.find((d) => t.includes(d.toLowerCase()));
  return found || null;
}

// ====== STUBS / CONECTE COM SUA LÓGICA REAL ======

async function createPaymentLink(phoneDigits, plan) {
  // Troque pela sua integração real com Mercado Pago / checkout
  const code = encodeURIComponent(`${phoneDigits}-${plan.code}-${Date.now()}`);
  return `${PUBLIC_BASE_URL || "https://example.com"}/pay/${code}`;
}

async function getSuggestedDayKeys() {
  // Troque pela sua lógica real de agenda
  return ["Terça 10/03", "Quarta 11/03", "Quinta 12/03"];
}

// ====== ROTAS ======

app.get("/", async (_req, res) => {
  res.status(200).send("LIA online ✅");
});

app.post("/whatsapp", async (req, res) => {
  try {
    const from = req.body.From || "";
    const body = req.body.Body || "";

    const phoneDigits = normalizePhone(from);
    if (!phoneDigits) {
      return res.status(200).send("ok");
    }

    await handleMessage(phoneDigits, body);
    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Erro /whatsapp:", err);
    res.status(200).send("ok");
  }
});

// ====== START ======

(async () => {
  try {
    await ensureSchema();
    app.listen(PORT, () => {
      console.log(`🚀 LIA rodando na porta ${PORT}`);
      console.log(`🤖 MODEL_CHAT=${MODEL_CHAT}`);
    });
  } catch (err) {
    console.error("❌ Falha ao iniciar:", err);
    process.exit(1);
  }
})();
