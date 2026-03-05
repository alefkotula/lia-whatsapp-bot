/**
 * LIA V13 — WhatsApp Bot (Twilio + Render + Postgres + OpenAI + Mercado Pago)
 *
 * STATE MACHINE com funil linear:
 *   greeting → collect_name → collect_focus → present_premium →
 *   choose_plan → generate_payment → await_payment →
 *   schedule_turn → schedule_day → finish
 *
 * Correções V13:
 *   - State machine linear: cada etapa acontece UMA VEZ
 *   - "como faço para pagar" → INTENT_PAY (não confunde com recusa)
 *   - Nome usado max 1x saudação + 1x confirmação + 1x a cada 6 msgs
 *   - Link pendente reutilizado (não gera duplicata)
 *   - Anti-alucinação: IA nunca solta preço/link
 *   - Compliance médico total
 *
 * ENV:
 *   OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, DATABASE_URL
 *   MP_ACCESS_TOKEN, PUBLIC_BASE_URL
 *   MODEL_CHAT (opcional, default gpt-4.1)
 *   MIN_DELAY_SEC / MAX_DELAY_SEC (opcional)
 */

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

console.log("NODE VERSION:", process.version);

// ============================================================
// ENV
// ============================================================
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

if (!OPENAI_API_KEY) console.error("Falta OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) console.error("Falta TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN");
if (!DATABASE_URL) console.error("Falta DATABASE_URL");
if (!MP_ACCESS_TOKEN) console.error("Falta MP_ACCESS_TOKEN");
if (!PUBLIC_BASE_URL) console.warn("PUBLIC_BASE_URL nao definido");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const CHAT_MODEL = MODEL_CHAT || "gpt-4.1";
const MIN_DELAY = Number(MIN_DELAY_SEC || 6);
const MAX_DELAY = Number(MAX_DELAY_SEC || 10);
const BASE_URL = (PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "") || "http://localhost:10000";

// ============================================================
// PLANOS
// ============================================================
const PLANS = {
  full: {
    key: "full",
    label: "Acompanhamento Medico Especializado (Consulta + Retorno ~30 dias)",
    price: 447,
    short: "1",
  },
  basic: {
    key: "basic",
    label: "Avaliacao Medica Especializada (45 min)",
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

// ============================================================
// FUNNEL STEPS (ordem linear estrita)
// ============================================================
const FUNNEL_ORDER = [
  "greeting",
  "collect_name",
  "collect_focus",
  "present_premium",
  "choose_plan",
  "generate_payment",
  "await_payment",
  "schedule_turn",
  "schedule_day",
  "finish",
];

function stepIndex(step) {
  const idx = FUNNEL_ORDER.indexOf(step);
  return idx >= 0 ? idx : 0;
}

function canAdvanceTo(currentStep, targetStep) {
  return stepIndex(targetStep) > stepIndex(currentStep);
}

function advanceStep(state, targetStep) {
  if (canAdvanceTo(state.funnel_step, targetStep)) {
    state.funnel_step = targetStep;
  }
  return state;
}

// ============================================================
// POSTGRES
// ============================================================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
pool.on("error", (err) => console.error("Postgres pool error:", err));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_users (
      phone TEXT PRIMARY KEY,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("Tabela wa_users pronta.");
}
initDB().catch((e) => console.error("initDB erro:", e));

// ============================================================
// MEMORY HELPERS
// ============================================================
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

// ============================================================
// UTILS
// ============================================================
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
  return t.length <= max ? t : t.slice(0, max).trim();
}

// ============================================================
// NOME HELPERS
// ============================================================
function extractNameFromText(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const low = norm(t);
  if (/^(sim|ok|beleza|pode|claro|s|ss|show|tanto faz|nao|nao quero|nao sei)$/.test(low)) return null;
  const cleaned = t.replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const m = cleaned.match(/(?:me chamo|meu nome e|sou|nome e|nome)\s+(.+)$/i);
  const candidate = (m?.[1] || cleaned).trim();
  const parts = candidate.split(" ").filter(Boolean);
  if (parts.length < 1 || parts.length > 4) return null;
  if (/^\d+$/.test(candidate)) return null;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");
}

/**
 * Controle de uso do nome: max 1x saudacao + 1x confirmacao + 1x cada 6 msgs
 */
function maybeUseName(state) {
  const nome = state?.nome;
  if (!nome) return "";
  const used = Number(state?.name_used_count || 0);
  if (used < 2) return nome;
  if (used % 6 === 0) return nome;
  return "";
}

function bumpNameCount(state, reply) {
  if (state.nome && reply.includes(state.nome)) {
    state.name_used_count = (Number(state.name_used_count) || 0) + 1;
  }
}

// ============================================================
// INTENT DETECTION (v13 — com INTENT_PAY)
// ============================================================
function detectIntent(text) {
  const t = norm(text);

  // INTENT_PAY — prioridade alta (BUG 2 fix)
  const wantsPay = /\b(como (faco|faço) (para|pra) pagar|como pagar|formas? de pagamento|link de pagamento|pagar consulta|quero pagar|quero o link|manda o link|envia o link|me manda o link)\b/.test(t);

  const wantsPrice = /\b(preco|preço|valor|quanto custa|investimento|custa|valores|quanto e|quanto é)\b/.test(t);
  const wantsBook = /\b(quero marcar|quero agendar|agendar|marcar|quero fechar|confirmar consulta|quero consulta|gostaria de agendar)\b/.test(t);
  const asksHours = /\b(horarios|horario|que horas|vagas|agenda|disponibilidade)\b/.test(t);
  const confirms = /\b(sim|ok|pode|confirmo|fechado|beleza|vamos|pode ser|serve|confirmar|isso|certo|perfeito)\b/.test(t);
  const refuses = /\b(nao quero|nao obrigado|não quero|não obrigado|pare|para|chega|desisto|cancel)\b/.test(t);
  const asksStartNow = /\b(como tomar|dose|dosagem|quantas gotas|comecar agora|começar agora|posso tomar)\b/.test(t);
  const urgency = /\b(dor no peito|falta de ar|desmaio|avc|convuls|paralisia|confusao|confusão)\b/.test(t);
  const asksWho = /\b(quem e|quem eh|quem é|quem e o dr|quem é o dr|quem e a lia|quem é a lia)\b/.test(t);
  const asksIfWorks = /\b(funciona|serve|vale a pena|ajuda mesmo|melhora|tem resultado|tem evidencia|tem estudo)\b/.test(t);

  // Escolha de plano
  const choosesFull = /\b(1|447|com retorno|acompanhamento|pacote completo)\b/.test(t) && !/\b(2|3)\b/.test(t);
  const choosesBasic = /\b(2|347|so a consulta|só a consulta|avaliacao|avaliação)\b/.test(t) && !/\b(1|3)\b/.test(t);
  const choosesRetorno = /\b(3|200|retorno avulso|apenas retorno|consulta de ajuste)\b/.test(t) && !/\b(1|2)\b/.test(t);

  // Turno
  const choosesManha = /\b(manha|manhã|de manha)\b/.test(t);
  const choosesTarde = /\b(tarde|de tarde|a tarde)\b/.test(t);
  const choosesNoite = /\b(noite|de noite|a noite)\b/.test(t);
  const turno = choosesManha ? "manha" : choosesTarde ? "tarde" : choosesNoite ? "noite" : null;

  // Dia
  const mentionsDay = t.match(/\b(segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo|amanha|amanhã|hoje|proxima semana|próxima semana)\b/);
  const dayChoice = mentionsDay ? mentionsDay[0] : null;

  // Foco clinico
  const focus =
    (/\b(insonia|insomnia|dormir|sono|acordar|noite mal dormida)\b/.test(t) && "insonia") ||
    (/\b(ansiedade|panico|pânico|crise|nervos|estresse|stress)\b/.test(t) && "ansiedade") ||
    (/\b(dor|fibromialgia|lombar|artrose|artrite|neuropat|enxaqueca|cefaleia)\b/.test(t) && "dor") ||
    (/\b(depressao|depressão|tristeza|desanimo|desânimo)\b/.test(t) && "depressao") ||
    (/\b(epilepsia|convulsao|convulsão|espasmo)\b/.test(t) && "epilepsia") ||
    null;

  return {
    wantsPay,
    wantsPrice,
    wantsBook,
    asksHours,
    confirms,
    refuses,
    asksStartNow,
    urgency,
    asksWho,
    asksIfWorks,
    choosesFull,
    choosesBasic,
    choosesRetorno,
    turno,
    dayChoice,
    focus,
  };
}

// ============================================================
// RESPOSTAS DETERMINISTICAS (variadas para evitar robotizacao)
// ============================================================
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function greetingReply() {
  return pick([
    "Oi! Eu sou a Lia, da equipe do Dr. Alef Kotula. Atendimento 100% online, seguro e individualizado.\n\nQual o seu *primeiro nome*?",
    "Ola! Sou a Lia, assistente do Dr. Alef Kotula. A consulta e 100% online e personalizada.\n\nPra comecar, qual seu *primeiro nome*?",
    "Oi! Aqui e a Lia, do consultorio do Dr. Alef Kotula. Tudo por aqui e online e com bastante cuidado.\n\nMe diz seu *primeiro nome*?",
  ]);
}

function askNameReply() {
  return pick([
    "Pra eu te ajudar direitinho, me diz seu *primeiro nome*?",
    "Antes de tudo, qual seu *primeiro nome*?",
    "Me conta seu *primeiro nome* pra eu seguir te ajudando?",
  ]);
}

function askFocusReply(state) {
  const n = maybeUseName(state);
  const greet = n ? `Prazer, ${n}!` : "Prazer!";
  return pick([
    `${greet} Pra eu entender melhor o que voce busca: seu foco hoje e mais *dor*, *ansiedade*, *sono* ou *outro*?`,
    `${greet} Me conta: o que mais te incomoda hoje? *Dor*, *ansiedade*, *sono* ou *outro assunto*?`,
    `${greet} Qual a principal queixa que te trouxe aqui? *Dor*, *ansiedade*, *sono* ou *outro*?`,
  ]);
}

function premiumReply(state) {
  const n = maybeUseName(state);
  const intro = n ? `Entendi, ${n}.` : "Entendi.";
  return (
    `${intro} Vou te explicar rapidinho como funciona:\n\n` +
    "A consulta e *100% online, segura e individualizada*, com duracao media de *45 minutos*.\n\n" +
    "O Dr. Alef analisa seu caso com profundidade — revisa historico, entende como os sintomas impactam sua rotina, avalia o que voce ja tentou, confere medicacoes e define objetivos claros de melhora.\n\n" +
    "A maioria dos pacientes prefere ja iniciar com acompanhamento, porque assim conseguimos ajustar o plano com mais seguranca.\n\n" +
    "Quer que eu te mostre as opcoes de consulta?"
  );
}

function planMenuReply() {
  return (
    "Aqui estao as opcoes:\n\n" +
    `1) *${PLANS.full.label}* — R$${PLANS.full.price} *(87% das pessoas escolhem essa opcao)*\n` +
    `2) *${PLANS.basic.label}* — R$${PLANS.basic.price}\n` +
    `3) *${PLANS.retorno.label}* — R$${PLANS.retorno.price}\n\n` +
    "Qual voce prefere? Responda com *1*, *2* ou *3*."
  );
}

function paymentSentReply(plan, link, state) {
  const n = maybeUseName(state);
  const greet = n ? `Fechado, ${n}!` : "Fechado!";
  return (
    `${greet}\n` +
    `*${plan.label}* — R$${plan.price}\n\n` +
    `Pra confirmar, e so pagar por aqui:\n${link}\n\n` +
    "Aceita *Pix, cartao ou boleto*. Assim que o pagamento for confirmado, eu te aviso aqui."
  );
}

function awaitPaymentReply(state) {
  const link = state?.payment?.link;
  if (!link) return "Estou gerando seu link de pagamento, um momento...";
  return pick([
    `Seu link de pagamento ainda esta ativo:\n${link}\n\nVoce prefere pagar no *Pix* ou *cartao*?`,
    `O link pra confirmar esta aqui:\n${link}\n\nQualquer duvida sobre o pagamento, me fala!`,
  ]);
}

function afterPaidReply(state) {
  const n = maybeUseName(state);
  const thanks = n ? `Pagamento confirmado! Obrigada, ${n}!` : "Pagamento confirmado! Obrigada!";
  return (
    `${thanks}\n\n` +
    "Agora me diz: voce prefere atendimento de *manha*, *tarde* ou *noite*?"
  );
}

function askDayReply(state) {
  const turno = state?.turno || "";
  return pick([
    `Anotei: turno da ${turno}. E qual *dia da semana* funciona melhor pra voce?`,
    `Perfeito, ${turno}. Qual *dia* voce prefere? (ex: segunda, terca, quarta...)`,
  ]);
}

function finishReply(state) {
  const n = maybeUseName(state);
  const nome = n ? `, ${n}` : "";
  const turno = state?.turno || "";
  const dia = state?.day_choice || "";
  return (
    `Tudo certo${nome}! Vou encaminhar pro Dr. Alef a preferencia: *${dia}* de *${turno}*.\n\n` +
    "A equipe vai confirmar o horario exato com voce por aqui em breve.\n\n" +
    "Qualquer duvida ate la, e so me chamar!"
  );
}

function urgencyReply() {
  return "Esses sintomas podem precisar de avaliacao urgente. Por favor, procure um pronto atendimento agora (ou SAMU 192). Quando estiver seguro(a), pode me chamar aqui.";
}

function whoReply() {
  return "Sou a Lia, assistente do Dr. Alef Kotula. O atendimento e 100% online. Quer que eu te explique como funciona?";
}

function safetyDoseReply() {
  return "Entendo sua vontade de comecar. Por seguranca, nao consigo orientar dose por aqui — isso depende do seu caso e das medicacoes que voce usa. Na consulta, o Dr. Alef avalia tudo com cuidado e define o melhor caminho pra voce.";
}

function worksReply(state) {
  const focus = state?.focus;
  const focusMap = {
    dor: "Estudos publicados no JAMA com mais de 8.000 pacientes mostraram que o tratamento ajudou a reduzir outros medicamentos em ate 51%. Revisoes cientificas encontraram reducao de dor variando de 42% a 66%. Sao resultados promissores, mas cada caso precisa de avaliacao individual.",
    insonia: "Em um ensaio clinico, 60% dos pacientes com insonia cronica deixaram de ser classificados como insones apos 2 semanas de tratamento. A qualidade do sono melhorou em ate 80%. Cada organismo responde de forma diferente, por isso a avaliacao medica e essencial.",
    ansiedade: "Uma meta-analise recente mostrou que cerca de 70% dos pacientes apresentaram melhora significativa nos sintomas de ansiedade. Um estudo de Harvard relatou reducao ja na primeira semana. Mas cada caso e unico — por isso a avaliacao individualizada e tao importante.",
    depressao: "Pesquisas mostram que o tratamento pode melhorar nao so o humor, mas tambem o sono e a qualidade de vida. Um estudo de Harvard relatou melhoras ja nas primeiras semanas. Cada caso precisa de avaliacao individual.",
    epilepsia: "Existem estudos clinicos promissores, especialmente para formas refratarias. Mas o tratamento depende de avaliacao detalhada — cada caso precisa de conduta especifica.",
    outro: "Estudos cientificos de alto nivel mostram resultados promissores em varias condicoes. Mas cada organismo responde de forma diferente — por isso a avaliacao medica individualizada e essencial.",
  };
  const base = focusMap[focus] || focusMap["outro"];
  return base + "\n\nQuer que eu te explique como funciona a consulta?";
}

// ============================================================
// RESPOSTAS PARA OBJECOES COMUNS
// ============================================================
function detectObjection(text) {
  const t = norm(text);
  if (/\b(maconha|droga|ilegal|trafico|traficante)\b/.test(t)) return "droga";
  if (/\b(caro|cara|muito caro|nao tenho dinheiro|não tenho dinheiro|puxado)\b/.test(t)) return "caro";
  if (/\b(chapado|drogado|barato|fica louco|ficar louco|altera)\b/.test(t)) return "chapado";
  if (/\b(dependencia|vicia|vicio|vício|dependência)\b/.test(t)) return "dependencia";
  if (/\b(legal|e legal|é legal|legalizado|permitido|anvisa)\b/.test(t)) return "legal";
  if (/\b(ja tentei|já tentei|nada funciona|nada resolve|tentei de tudo)\b/.test(t)) return "tentei_tudo";
  if (/\b(familia|família|minha mae|meu pai|marido|esposa|nao aceita|não aceita)\b/.test(t)) return "familia";
  if (/\b(efeito colateral|efeitos colaterais|faz mal|prejudica)\b/.test(t)) return "colateral";
  if (/\b(fumar|fumaca|fumaça|baseado|cigarro)\b/.test(t)) return "fumar";
  if (/\b(placebo|nao funciona|não funciona|mentira|mito)\b/.test(t)) return "placebo";
  if (/\b(demora|quanto tempo|rapido|rápido|logo)\b/.test(t) && /\b(efeito|resultado|funcionar|sentir)\b/.test(t)) return "demora";
  if (/\b(dirigir|trabalhar|volante|carro)\b/.test(t)) return "dirigir";
  if (/\b(meu medico|meu médico|medico disse|médico disse|doutor disse)\b/.test(t)) return "medico_disse";
  return null;
}

function objectionReply(type) {
  const replies = {
    droga: "Cannabis medicinal e um tratamento legal, prescrito por medico e regulamentado pela Anvisa desde 2015. Usa oleos, capsulas ou cremes — nao tem fumo envolvido. E diferente do uso recreativo: doses controladas e acompanhamento medico.",
    caro: "Muitos pacientes conseguem reduzir ate 50% o uso de outros medicamentos apos iniciar o tratamento. A consulta de 45 minutos e uma avaliacao completa e personalizada — um investimento pra encontrar o caminho certo pro seu caso.",
    chapado: "O CBD, principal componente de muitos tratamentos, nao e psicoativo. Quando THC e necessario, sao usadas microdoses que tratam os sintomas sem alterar a consciencia. O medico ajusta a dose de forma gradual.",
    dependencia: "A OMS declarou que o CBD nao causa dependencia. Na verdade, estudos mostram que o tratamento ajuda pacientes a reduzir em ate 51% o uso de opioides e outros medicamentos que sim causam dependencia.",
    legal: "Sim, e 100% legal. A Anvisa regulamentou em 2015 e atualizou as normas. Com prescricao medica voce pode comprar em farmacias ou importar. O Dr. Alef fornece toda a documentacao necessaria.",
    tentei_tudo: "A cannabis age por um mecanismo diferente — o sistema endocanabinoide — que nao e atingido pela maioria dos medicamentos tradicionais. Estudos mostram eficacia de 40% a 70% em pacientes que ja tentaram multiplos tratamentos.",
    familia: "O medo geralmente vem da falta de informacao. Cannabis medicinal e tratamento medico legal, com doses controladas. Quando a familia entende isso e ve os resultados, a aceitacao geralmente melhora. O Dr. Alef pode ajudar com informacoes pra compartilhar.",
    colateral: "Os efeitos colaterais mais comuns sao leves: boca seca, sonolencia. Compare com anti-inflamatorios (problemas gastricos) ou opioides (dependencia). A maioria dos pacientes tolera muito bem o tratamento.",
    fumar: "Cannabis medicinal nao envolve fumo! O tratamento usa oleos sublinguais, capsulas ou cremes. Sao formas farmaceuticas controladas, como qualquer outro medicamento.",
    placebo: "Existem milhares de estudos publicados em revistas como JAMA, Nature e Cochrane. O primeiro ensaio clinico controlado pra enxaqueca mostrou 67% de eficacia vs 46% do placebo. Mais de 40 paises ja aprovaram o uso medicinal.",
    demora: "Muitos pacientes notam melhora em 2 a 4 semanas. Um estudo de Harvard mostrou reducao da ansiedade ja na primeira semana. Pra dor, muitos relatam alivio desde as primeiras doses. O medico acompanha a evolucao.",
    dirigir: "O CBD nao causa prejuizo cognitivo ou motor. Quando THC e necessario, o medico ajusta dose e horario pra minimizar qualquer impacto. A maioria dos pacientes mantem todas as atividades normalmente.",
    medico_disse: "Menos de 1% dos medicos brasileiros prescrevem cannabis porque nao faz parte da formacao tradicional. A OMS e a Anvisa reconhecem a eficacia. O Dr. Alef e especialista dedicado exclusivamente a esta area e pode complementar seu tratamento.",
  };
  return (replies[type] || "") + "\n\nQuer que eu te explique como funciona a consulta?";
}

function resistanceReply() {
  return pick([
    "Sem problema! Se quiser, posso te explicar como funciona a consulta sem compromisso. Ou se preferir, pode tirar uma duvida agora.",
    "Tranquilo! Estou aqui se quiser saber mais. Sem pressao nenhuma.",
    "Entendo! Fico por aqui caso mude de ideia ou queira tirar uma duvida.",
  ]);
}

// ============================================================
// HUMAN DELAY
// ============================================================
function computeDelay(flags) {
  if (flags.wantsBook || flags.wantsPay || flags.turno || flags.dayChoice) return randInt(3, 5);
  if (flags.wantsPrice || flags.choosesFull || flags.choosesBasic || flags.choosesRetorno) return randInt(4, 7);
  if (flags.asksIfWorks) return randInt(6, 10);
  return randInt(MIN_DELAY, MAX_DELAY);
}

async function sendWhatsApp(to, from, body, delaySec) {
  await sleep(delaySec * 1000);
  await twilioClient.messages.create({ to, from, body });
}

// ============================================================
// OPENAI — conversa aberta (com travas anti-alucinacao)
// ============================================================
function buildSystemPrompt() {
  return `Voce e "Lia", secretaria do Dr. Alef Kotula, medico especialista em cannabis medicinal (consulta 100% online).
REGRAS ABSOLUTAS:
- Nunca inventar preco, valor em R$ ou link.
- Nunca prescrever dose, orientar compra ou recomendar marca.
- Nunca prometer cura ou garantir resultado. Use "muitos pacientes relatam", "estudos mostram".
- Mensagens curtas (2-3 frases). Tom humano e acolhedor.
- 1 pergunta por mensagem no maximo.
- Se pedirem preco/valores/link: responda EXATAMENTE "PRECISA_PRECO"
- Se pedirem agendar: responda EXATAMENTE "PRECISA_AGENDAR"
DADOS CIENTIFICOS (use quando relevante, sem prometer resultado):
- Fibromialgia: estudos com reducao de 50-60% na dor. Mayo Clinic 1336 pacientes, 40%+ melhora.
- Dor cronica: JAMA 8000 pacientes, reducao de opioides em 47-51%. CBD: reducao de dor 42-66%.
- Insonia: 60% deixaram de ser insones apos 2 semanas. Melhora de ate 80% na qualidade do sono.
- Ansiedade: meta-analise 70% melhora. Harvard: reducao na 1a semana.
- Enxaqueca: 67% alivio em 2h. 61% reduziram crises em 50%+.
- Artrose: 44% reducao na dor. 83% relataram melhora.
- Dor lombar: Nature Medicine 820 pacientes, 30-50% alivio relevante.
- Dor neuropatica: 40-55% alivio significativo. Cochrane 2187 participantes.
FORMATO: JSON puro: { "reply": "...", "updates": {} }
updates pode ter: nome (string), focus (string: dor|ansiedade|insonia|depressao|epilepsia|outro)`;
}

function buildUserPrompt(text, state, flags) {
  return `MEMORIA: ${JSON.stringify({
    nome: state.nome || null,
    focus: state.focus || null,
    funnel_step: state.funnel_step || null,
    last_bot_reply: (state.last_bot_reply || "").slice(0, 200),
  })}
MSG: ${text}
SINAIS: ${JSON.stringify(flags)}
Responda curto e humano. Se detectar nome, salve em updates.nome.`;
}

function violatesRules(text) {
  if (!text) return false;
  if (/\bhttps?:\/\//i.test(text)) return true;
  if (/R\$\s?\d/i.test(text)) return true;
  if (/\b(200|300|347|400|447|500)\b/.test(text)) return true;
  return false;
}

async function runLIA(text, state, flags) {
  try {
    const resp = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.4,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(text, state, flags) },
      ],
    });
    const content = resp.choices?.[0]?.message?.content?.trim() || "";
    let parsed;
    try { parsed = JSON.parse(content); } catch { parsed = null; }

    if (!parsed || !parsed.reply) {
      return { reply: null, updates: {} };
    }

    const r = String(parsed.reply).trim();
    if (r === "PRECISA_PRECO") return { reply: "__PRICE__", updates: parsed.updates || {} };
    if (r === "PRECISA_AGENDAR") return { reply: "__BOOK__", updates: parsed.updates || {} };

    if (violatesRules(r)) {
      return { reply: null, updates: {} };
    }

    return { reply: clip(r, 700), updates: parsed.updates || {} };
  } catch (err) {
    console.error("OpenAI erro:", err.message);
    return { reply: null, updates: {} };
  }
}

// ============================================================
// MERCADO PAGO
// ============================================================
async function mpCreatePreference(phone, planKey) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error("Plano invalido: " + planKey);

  const external_reference = `lia_${phone}_${planKey}_${Date.now()}`;
  const body = {
    items: [{
      title: `Dr. Alef Kotula - ${plan.label}`,
      quantity: 1,
      unit_price: plan.price,
      currency_id: "BRL",
    }],
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
  if (!link) throw new Error("MP nao retornou init_point");

  return { preference_id: data.id, link, plan, external_reference };
}

async function mpGetPayment(paymentId) {
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  if (!r.ok) throw new Error(`MP payment fetch erro: ${r.status}`);
  return await r.json();
}

// ============================================================
// ROTAS MP
// ============================================================
app.get("/mp/thanks", (_req, res) => res.send("OK"));

app.post("/mp/webhook", express.json({ type: "*/*" }), async (req, res) => {
  res.status(200).send("OK");

  try {
    const body = req.body || {};
    const type = body.type || body.topic;
    const paymentId = body?.data?.id || body?.id;
    if (!paymentId) return;
    if (!type || !String(type).includes("payment")) return;

    const payment = await mpGetPayment(paymentId);
    const status = payment.status;
    const phone = payment?.metadata?.phone ? String(payment.metadata.phone).trim() : null;
    if (!phone) return;

    const state = await getUserState(phone);
    state.payment = state.payment || {};
    state.payment.payment_id = paymentId;
    state.payment.status = status;
    state.payment.updated_at = Date.now();
    state.payment.amount = payment.transaction_amount || null;
    state.payment.plan_key = payment?.metadata?.plan_key || state.payment.plan_key;

    if (status === "approved") {
      state.funnel_step = "schedule_turn";
      const botFrom = state?.last_bot_from;
      if (botFrom) {
        try {
          const reply = afterPaidReply(state);
          bumpNameCount(state, reply);
          await twilioClient.messages.create({
            to: `whatsapp:${phone}`,
            from: botFrom,
            body: reply,
          });
        } catch (e) { console.error("Erro envio pos-pagamento:", e.message); }
      }
    }

    await saveUserState(phone, state);
  } catch (err) {
    console.error("MP webhook erro:", err.message);
  }
});

// ============================================================
// WHATSAPP WEBHOOK — STATE MACHINE PRINCIPAL
// ============================================================
app.post("/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  res.type("text/xml").send(twiml.toString());

  (async () => {
    try {
      const lead = req.body.From || "";
      const bot = req.body.To || "";
      const phone = lead.replace("whatsapp:", "").trim();
      const incomingText = (req.body.Body || "").trim();

      let state = await getUserState(phone);

      // Defaults
      state.funnel_step = state.funnel_step || "greeting";
      state.nome = state.nome || null;
      state.focus = state.focus || null;
      state.payment = state.payment || null;
      state.name_used_count = Number(state.name_used_count || 0);
      state.last_bot_reply = state.last_bot_reply || "";
      state.last_user_message = state.last_user_message || "";
      state.msg_count = Number(state.msg_count || 0) + 1;
      state.last_bot_from = bot;

      const flags = detectIntent(incomingText);

      // Atualiza foco se detectado em qualquer momento
      if (flags.focus && !state.focus) {
        state.focus = flags.focus;
      }

      let reply = "";
      const step = state.funnel_step;

      // -------------------------------------------------------
      // PRIORIDADE 0: Urgencia medica (qualquer etapa)
      // -------------------------------------------------------
      if (flags.urgency) {
        reply = urgencyReply();
        state.funnel_step = "finish";
      }

      // -------------------------------------------------------
      // PRIORIDADE 1: "Quem e?"
      // -------------------------------------------------------
      else if (flags.asksWho) {
        reply = whoReply();
      }

      // -------------------------------------------------------
      // PRIORIDADE 2: Dose/seguranca (qualquer etapa)
      // -------------------------------------------------------
      else if (flags.asksStartNow) {
        reply = safetyDoseReply();
      }

      // -------------------------------------------------------
      // PRIORIDADE 3: "Funciona?" (qualquer etapa)
      // -------------------------------------------------------
      else if (flags.asksIfWorks) {
        reply = worksReply(state);
      }

      // -------------------------------------------------------
      // PRIORIDADE 4: Objecoes comuns sobre cannabis (qualquer etapa)
      // -------------------------------------------------------
      else if (detectObjection(incomingText)) {
        const objType = detectObjection(incomingText);
        reply = objectionReply(objType);
      }

      // -------------------------------------------------------
      // PRIORIDADE 5: Recusa (qualquer etapa, MAS nao confundir com wantsPay)
      // -------------------------------------------------------
      else if (flags.refuses && !flags.wantsPay && !flags.wantsPrice && !flags.wantsBook) {
        reply = resistanceReply();
      }

      // -------------------------------------------------------
      // STEP: greeting — primeira mensagem
      // -------------------------------------------------------
      else if (step === "greeting") {
        // Se ja mandou nome na primeira msg
        const nm = extractNameFromText(incomingText);
        if (nm) {
          state.nome = nm;
          advanceStep(state, "collect_focus");
          reply = askFocusReply(state);
        } else {
          advanceStep(state, "collect_name");
          reply = greetingReply();
        }
      }

      // -------------------------------------------------------
      // STEP: collect_name
      // -------------------------------------------------------
      else if (step === "collect_name") {
        const nm = extractNameFromText(incomingText);
        if (nm) {
          state.nome = nm;
          // Se ja tem foco, pula pra premium
          if (state.focus) {
            advanceStep(state, "present_premium");
            reply = premiumReply(state);
          } else {
            advanceStep(state, "collect_focus");
            reply = askFocusReply(state);
          }
        } else {
          reply = askNameReply();
        }
      }

      // -------------------------------------------------------
      // STEP: collect_focus
      // -------------------------------------------------------
      else if (step === "collect_focus") {
        if (flags.focus) {
          state.focus = flags.focus;
        }
        if (state.focus) {
          advanceStep(state, "present_premium");
          reply = premiumReply(state);
        } else {
          // Tenta extrair do texto livre
          const low = norm(incomingText);
          if (low.length > 1 && !flags.confirms) {
            state.focus = "outro";
            advanceStep(state, "present_premium");
            reply = premiumReply(state);
          } else {
            reply = "Me conta um pouco mais: o que mais te incomoda hoje?";
          }
        }
      }

      // -------------------------------------------------------
      // STEP: present_premium (aguarda confirmacao pra mostrar planos)
      // -------------------------------------------------------
      else if (step === "present_premium") {
        if (flags.confirms || flags.wantsPrice || flags.wantsBook || flags.wantsPay) {
          advanceStep(state, "choose_plan");
          reply = planMenuReply();
        } else if (flags.refuses) {
          reply = resistanceReply();
        } else {
          // Qualquer resposta que nao seja recusa, avanca
          advanceStep(state, "choose_plan");
          reply = planMenuReply();
        }
      }

      // -------------------------------------------------------
      // STEP: choose_plan
      // -------------------------------------------------------
      else if (step === "choose_plan") {
        let planKey = null;
        if (flags.choosesFull) planKey = "full";
        else if (flags.choosesBasic) planKey = "basic";
        else if (flags.choosesRetorno) planKey = "retorno";
        else if (flags.confirms) planKey = "full"; // default mais escolhido

        if (planKey) {
          // BUG 4 fix: reutiliza link existente se mesmo plano e pendente
          const hasPending =
            state.payment?.status === "pending" &&
            state.payment?.plan_key === planKey &&
            state.payment?.link;

          if (hasPending) {
            advanceStep(state, "await_payment");
            reply = paymentSentReply(PLANS[planKey], state.payment.link, state);
          } else {
            try {
              const pref = await mpCreatePreference(phone, planKey);
              state.payment = {
                status: "pending",
                plan_key: planKey,
                preference_id: pref.preference_id,
                link: pref.link,
                external_reference: pref.external_reference,
                created_at: Date.now(),
              };
              advanceStep(state, "await_payment");
              reply = paymentSentReply(pref.plan, pref.link, state);
            } catch (err) {
              console.error("Erro MP preference:", err.message);
              reply = "Tive um probleminha pra gerar o link. Pode tentar de novo em alguns segundos?";
            }
          }
        } else {
          reply = "Me responde com *1*, *2* ou *3* pra eu gerar o link certinho:\n\n" +
            `1) Acompanhamento — R$${PLANS.full.price}\n` +
            `2) Avaliacao — R$${PLANS.basic.price}\n` +
            `3) Retorno — R$${PLANS.retorno.price}`;
        }
      }

      // -------------------------------------------------------
      // STEP: await_payment
      // -------------------------------------------------------
      else if (step === "await_payment") {
        // Verifica se pagamento ja foi aprovado
        if (state.payment?.status === "approved") {
          advanceStep(state, "schedule_turn");
          reply = afterPaidReply(state);
        } else {
          reply = awaitPaymentReply(state);
        }
      }

      // -------------------------------------------------------
      // STEP: schedule_turn
      // -------------------------------------------------------
      else if (step === "schedule_turn") {
        if (flags.turno) {
          state.turno = flags.turno;
          advanceStep(state, "schedule_day");
          reply = askDayReply(state);
        } else {
          // Tenta inferir turno de texto livre
          const low = norm(incomingText);
          if (/manha|manhã/.test(low)) {
            state.turno = "manha";
            advanceStep(state, "schedule_day");
            reply = askDayReply(state);
          } else if (/tarde/.test(low)) {
            state.turno = "tarde";
            advanceStep(state, "schedule_day");
            reply = askDayReply(state);
          } else if (/noite/.test(low)) {
            state.turno = "noite";
            advanceStep(state, "schedule_day");
            reply = askDayReply(state);
          } else {
            reply = "Voce prefere *manha*, *tarde* ou *noite*?";
          }
        }
      }

      // -------------------------------------------------------
      // STEP: schedule_day
      // -------------------------------------------------------
      else if (step === "schedule_day") {
        if (flags.dayChoice) {
          state.day_choice = flags.dayChoice;
          advanceStep(state, "finish");
          reply = finishReply(state);
        } else {
          // Aceita qualquer texto como dia
          const day = incomingText.trim();
          if (day.length >= 2 && day.length <= 40) {
            state.day_choice = day;
            advanceStep(state, "finish");
            reply = finishReply(state);
          } else {
            reply = "Qual dia funciona melhor pra voce? (ex: segunda, terca, quarta...)";
          }
        }
      }

      // -------------------------------------------------------
      // STEP: finish (pos-agendamento)
      // -------------------------------------------------------
      else if (step === "finish") {
        // IA responde de forma aberta
        const ai = await runLIA(incomingText, state, flags);
        if (ai.reply && ai.reply !== "__PRICE__" && ai.reply !== "__BOOK__") {
          reply = ai.reply;
        } else {
          reply = "Seu agendamento ja esta encaminhado! Qualquer duvida, estou por aqui.";
        }
      }

      // -------------------------------------------------------
      // ATALHOS GLOBAIS: wantsPay / wantsPrice / wantsBook
      // (aplicados quando o step atual nao tratou a msg)
      // -------------------------------------------------------
      if (!reply) {
        // INTENT_PAY: quer pagar diretamente
        if (flags.wantsPay) {
          if (!state.nome) {
            state.funnel_step = "collect_name";
            reply = askNameReply();
          } else if (stepIndex(step) < stepIndex("choose_plan")) {
            state.funnel_step = "choose_plan";
            reply = planMenuReply();
          } else if (state.payment?.link && state.payment?.status === "pending") {
            reply = awaitPaymentReply(state);
          } else {
            state.funnel_step = "choose_plan";
            reply = planMenuReply();
          }
        }
        // Quer preco
        else if (flags.wantsPrice) {
          if (!state.nome) {
            state.funnel_step = "collect_name";
            reply = askNameReply();
          } else if (stepIndex(step) < stepIndex("choose_plan")) {
            state.funnel_step = "choose_plan";
            reply = planMenuReply();
          } else {
            reply = planMenuReply();
          }
        }
        // Quer agendar
        else if (flags.wantsBook || flags.asksHours) {
          if (!state.nome) {
            state.funnel_step = "collect_name";
            reply = askNameReply();
          } else if (stepIndex(step) < stepIndex("present_premium")) {
            state.funnel_step = "present_premium";
            reply = premiumReply(state);
          } else if (state.payment?.status === "approved") {
            if (stepIndex(step) < stepIndex("schedule_turn")) {
              state.funnel_step = "schedule_turn";
            }
            reply = "Voce prefere atendimento de *manha*, *tarde* ou *noite*?";
          } else {
            state.funnel_step = "choose_plan";
            reply = planMenuReply();
          }
        }
      }

      // -------------------------------------------------------
      // FALLBACK: IA aberta (se nenhuma regra acima deu reply)
      // -------------------------------------------------------
      if (!reply) {
        const ai = await runLIA(incomingText, state, flags);

        // Merge updates da IA
        if (ai.updates?.nome && !state.nome) {
          state.nome = String(ai.updates.nome).trim();
        }
        if (ai.updates?.focus && !state.focus) {
          state.focus = ai.updates.focus;
        }

        if (ai.reply === "__PRICE__") {
          if (!state.nome) {
            state.funnel_step = "collect_name";
            reply = askNameReply();
          } else {
            state.funnel_step = "choose_plan";
            reply = planMenuReply();
          }
        } else if (ai.reply === "__BOOK__") {
          if (!state.nome) {
            state.funnel_step = "collect_name";
            reply = askNameReply();
          } else {
            state.funnel_step = "present_premium";
            reply = premiumReply(state);
          }
        } else if (ai.reply) {
          reply = ai.reply;
        } else {
          // Fallback final
          reply = "Entendi! Me conta: o que mais te incomoda hoje? Dor, ansiedade, sono ou outro assunto?";
        }
      }

      // -------------------------------------------------------
      // ANTI-LOOP: nao repetir mesma resposta
      // -------------------------------------------------------
      if (similar(reply, state.last_bot_reply)) {
        if (step === "await_payment" && state.payment?.link) {
          reply = `O link pra pagamento esta aqui: ${state.payment.link}\nMe avisa se precisar de ajuda!`;
        } else {
          reply = "Estou aqui pra te ajudar! Me conta o que voce precisa e eu sigo te guiando.";
        }
      }

      // -------------------------------------------------------
      // ENVIO
      // -------------------------------------------------------
      bumpNameCount(state, reply);

      state.last_bot_reply = reply;
      state.last_user_message = incomingText;
      state.last_sent_at = Date.now();

      await saveUserState(phone, state);

      const delaySec = computeDelay(flags);
      await sendWhatsApp(lead, bot, reply, delaySec);

    } catch (err) {
      console.error("Erro processamento:", err);
      try {
        const lead = req.body.From || "";
        const bot = req.body.To || "";
        await twilioClient.messages.create({
          to: lead,
          from: bot,
          body: "Tive uma instabilidade rapida. Me manda sua mensagem de novo?",
        });
      } catch {}
    }
  })();
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/", (_req, res) => res.send("OK"));

// ============================================================
// DEBUG: criar pagamento manual
// ============================================================
app.post("/create-payment", async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || "Pagamento");
    const phone = String(req.body?.phone || "").trim().replace(/^whatsapp:/, "");
    if (!amount || amount <= 0) return res.status(400).json({ error: "amount invalido" });

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

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`LIA V13 rodando na porta ${PORT}`));
