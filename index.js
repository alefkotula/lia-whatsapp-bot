/**
 * LIA V11 — WhatsApp Bot (Twilio + Render + Postgres)
 * - Closer médico premium (determinístico no que importa: agenda/preço/segurança)
 * - Delay humano (config por ENV)
 * - Anti-loop forte
 * - Nome: captura cedo + usa com moderação (a cada 2-3 mensagens)
 * - Evidence Engine (com %): usa quando
 *    (a) lead pergunta "funciona/vale a pena?"
 *    (b) lead é cético/curioso
 *    (c) timing oportuno após 1-3 mensagens mesmo sem perguntar (proativo)
 * - Foco/subfoco: evita “condição fantasma” (não inventa fibromialgia)
 * - Modelo padrão: gpt-4.1 (troca por ENV MODEL_CHAT)
 *
 * REQUISITOS:
 * - Node recomendado: 20
 * - Postgres (DATABASE_URL)
 * - Twilio WhatsApp (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
 * - OpenAI (OPENAI_API_KEY)
 *
 * ENV OPCIONAIS:
 * - MODEL_CHAT: "gpt-4.1" | "gpt-4o" | "gpt-4o-mini" etc
 * - MIN_DELAY_SEC / MAX_DELAY_SEC
 */

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

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
} = process.env;

if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error("❌ Falta OPENAI_API_KEY / TWILIO_* nas env vars.");
}
if (!DATABASE_URL) {
  console.error("❌ Falta DATABASE_URL nas env vars.");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const CHAT_MODEL = MODEL_CHAT || "gpt-4.1";
const MIN_DELAY = Number(MIN_DELAY_SEC || 6);
const MAX_DELAY = Number(MAX_DELAY_SEC || 10);

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
  return (s || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim();
}
function similar(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  if (x.length > 70 && y.length > 70 && x.slice(0, 70) === y.slice(0, 70)) return true;
  return false;
}
function clip(text, max = 800) {
  const t = (text || "").trim();
  return t.length <= max ? t : t.slice(0, max).trim();
}

// Nome: extrator simples (determinístico) — ajuda o LLM
function extractName(text) {
  const t = (text || "").trim();
  // "me chamo X", "meu nome é X", "sou o/a X"
  let m = t.match(/(?:me chamo|meu nome e|meu nome é|sou o|sou a)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){0,2})/i);
  if (m && m[1]) return m[1].trim();
  // se a mensagem for só um nome curto
  if (/^[A-Za-zÀ-ÿ]{2,20}(?:\s+[A-Za-zÀ-ÿ]{2,20})?$/.test(t)) return t;
  return "";
}

function maybeUseName(state) {
  // usa nome com moderação: a cada 2-3 mensagens
  const nome = (state?.nome || "").trim();
  if (!nome) return "";
  const n = Number(state?.name_use_counter || 0);
  if (n % 3 === 2) return `, ${nome}`;
  return "";
}

// ====== TWILIO MEDIA DOWNLOAD (Basic Auth) ======
async function downloadTwilioMedia(url) {
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Falha ao baixar mídia: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ====== OPENAI TRANSCRIBE (áudio) ======
async function transcribeAudio(buffer, mimeType) {
  const guessedType = mimeType && mimeType.startsWith("audio/") ? mimeType : "audio/ogg";

  let file;
  if (typeof File !== "undefined") {
    file = new File([buffer], "audio", { type: guessedType });
  } else if (typeof Blob !== "undefined") {
    const blob = new Blob([buffer], { type: guessedType });
    blob.name = "audio";
    file = blob;
  } else {
    return "";
  }

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
  });

  return (transcription.text || "").trim();
}

// ====== INTENTS + FOCO + SINAIS ======
function detectIntent(text) {
  const t = norm(text);

  const wantsPrice = /\b(preco|preço|valor|quanto custa|investimento|custa)\b/.test(t);

  const wantsBook =
    /\b(quero marcar|quero agendar|marcar consulta|agendar consulta|quero a consulta|quero consulta|vamos agendar|pode marcar|quero fechar|quero pagar|quero confirmar|quero reservar)\b/.test(t);

  const asksHours =
    /\b(horarios|horario|que horas|vagas|agenda|disponibilidade|tem horario|tem horarios)\b/.test(t);

  const confirms =
    /\b(sim|ok|pode|confirmo|fechado|beleza|vamos|pode ser|serve|confirmar|manda)\b/.test(t);

  const refuses =
    /\b(nao quero|não quero|pare|para|chega|rude|grosso|nao gostei|não gostei|voce esta sendo rude|você está sendo rude)\b/.test(t);

  const declinesSlot =
    /\b(nao posso|nao da|não dá|nao consigo|esse horario nao|esse horario nao posso|outro horario|outro horário|nao esse|não esse|nao serve)\b/.test(t);

  const asksStartNow =
    /\b(quero comecar a tomar|quero começar a tomar|posso tomar|como tomar|dose|dosagem|quantas gotas|comecar agora)\b/.test(t);

  const urgency =
    /\b(dor no peito|falta de ar|desmaio|desmaiei|avc|convuls|paralisia|confusao|confusão)\b/.test(t);

  const asksWho =
    /\b(quem e|quem eh|quem e o dr|quem eh o dr|quem e esse doutor|quem é|quem é o dr|quem é esse doutor)\b/.test(t);

  // variações "funciona / vale a pena / serve pra mim"
  const asksIfWorks =
    /\b(funciona|serve|vale a pena|e bom|é bom|ajuda|melhora|tem resultado|da resultado|compensa|resolve)\b/.test(t);

  // foco macro
  const focus =
    (/\b(insonia|insomnia|dormir|sono|acordar)\b/.test(t) && "insonia") ||
    (/\b(ansiedade|panico|pânico|crise)\b/.test(t) && "ansiedade") ||
    (/\b(dor|lombar|artrose|artrite|neuropat|enxaqueca|fibromial|reumat)\b/.test(t) && "dor") ||
    null;

  // subfoco (para evidence com % mais específico)
  const subfocus =
    (/\b(fibromial|fibromialgia)\b/.test(t) && "fibromialgia") ||
    (/\b(neuropat|neuropatica|neuropática)\b/.test(t) && "dor_neuropatica") ||
    (/\b(lombar|coluna|hérnia|herni|ciatica|ciática)\b/.test(t) && "dor_lombar") ||
    (/\b(enxaqueca|migraine|cefaleia)\b/.test(t) && "enxaqueca") ||
    (/\b(artrose|osteoartrite)\b/.test(t) && "artrose") ||
    (/\b(reumat|dor difusa)\b/.test(t) && "reumatismo") ||
    null;

  // objeções comuns
  const objection_price = /\b(caro|caro demais|sem dinheiro|nao tenho dinheiro|muito caro|parcel|valor alto)\b/.test(t);
  const objection_fear = /\b(medo|tenho receio|vicia|viciar|dependen|efeito colateral|faz mal|maconha|droga|legal|policia|familia|relig)\b/.test(t);
  const objection_online = /\b(online funciona|consulta online|videochamada|telemed|nao confio online|prefiro presencial)\b/.test(t);
  const objection_skeptic = /\b(nao acredito|duvido|isso funciona mesmo|charlata|marketing|golpe)\b/.test(t);

  return {
    wantsPrice, wantsBook, asksHours, confirms, refuses, declinesSlot,
    asksStartNow, urgency, asksWho, asksIfWorks, focus, subfocus,
    objection_price, objection_fear, objection_online, objection_skeptic
  };
}

function extractPreferredSlot(text) {
  const t = norm(text);
  const day =
    (t.includes("segunda") && "segunda") ||
    (t.includes("terca") && "terça") ||
    (t.includes("quarta") && "quarta") ||
    (t.includes("quinta") && "quinta") ||
    (t.includes("sexta") && "sexta") ||
    (t.includes("sabado") && "sábado") ||
    (t.includes("domingo") && "domingo") ||
    null;

  let hour = null;
  const m1 = t.match(/\b(\d{1,2})\s*h\b/);
  const m2 = t.match(/\b(\d{1,2})\s*:\s*(\d{2})\b/);
  if (m2) hour = `${m2[1].padStart(2, "0")}:${m2[2]}`;
  else if (m1) hour = `${m1[1].padStart(2, "0")}:00`;

  return { day, hour };
}

// ====== EVIDENCE ENGINE (com % do seu doc) ======
const EVIDENCE_DB = {
  fibromialgia: {
    label: "fibromialgia",
    studies: [
      { ref: "Pain Medicine (2016) — fitocanabinoides", pct: "50–60%", msg: "Em um estudo no *Pain Medicine*, pacientes com fibromialgia tiveram redução média de **50–60%** da dor após algumas semanas com canabinoides." },
      { ref: "Clinical Rheumatology (2020) — cannabis medicinal", pct: "40–50%", msg: "Outro estudo mostrou melhora de **40–50%** em dor e qualidade de vida em parte dos pacientes com fibromialgia após semanas de acompanhamento." },
      { ref: "Israel (2019) — coorte clínica", pct: "30–40%", msg: "Em coortes clínicas, parte dos pacientes relata melhora de **30–40%** em dor e sono quando o plano é bem individualizado e acompanhado." }
    ]
  },
  dor_neuropatica: {
    label: "dor neuropática",
    studies: [
      { ref: "J Pain (2018) — neuropatia", pct: "30–50%", msg: "Em dor neuropática, estudos mostram melhora de **30–50%** em intensidade da dor em parte dos pacientes com canabinoides, variando conforme a causa." },
      { ref: "Neurology (2015) — esclerose múltipla / neuropatia", pct: "35–45%", msg: "Em alguns perfis neurológicos, houve melhora de **35–45%** em sintomas dolorosos e espasticidade (quando aplicável), com avaliação e acompanhamento." },
      { ref: "Revisões clínicas", pct: "30–40%", msg: "Revisões apontam respostas de **30–40%** de melhora em parte dos pacientes — e o que define resultado é indicação + ajuste individual." }
    ]
  },
  dor_lombar: {
    label: "dor lombar crônica",
    studies: [
      { ref: "Spine / revisão clínica", pct: "30–40%", msg: "Em dor lombar crônica, há evidências de melhora de **30–40%** em dor e funcionalidade em parte dos pacientes, principalmente quando o tratamento é individualizado." },
      { ref: "Pain Research (2017)", pct: "25–35%", msg: "Alguns estudos observam melhora de **25–35%** em dor e sono após algumas semanas, com variação conforme o tipo de lombalgia." },
      { ref: "Clínicas (coorte)", pct: "30–50%", msg: "Em coortes reais, parte dos pacientes relata melhora de **30–50%** — mas depende muito de causa, comorbidades e acompanhamento." }
    ]
  },
  enxaqueca: {
    label: "enxaqueca crônica",
    studies: [
      { ref: "Headache (2019)", pct: "30–50%", msg: "Para enxaqueca crônica, há estudos mostrando redução de **30–50%** na frequência/intensidade das crises em parte dos pacientes com uso supervisionado." },
      { ref: "Revisões (cefaleia)", pct: "25–45%", msg: "Revisões clínicas sugerem melhora de **25–45%** em parte dos casos, principalmente quando há estratégia personalizada." },
      { ref: "Dados observacionais", pct: "30–40%", msg: "Em dados observacionais, parte dos pacientes relata melhora de **30–40%** — e a avaliação é crucial para indicar corretamente." }
    ]
  },
  artrose: {
    label: "artrose / osteoartrite",
    studies: [
      { ref: "Osteoarthritis (2018)", pct: "20–40%", msg: "Em artrose, estudos mostram melhora de **20–40%** em dor e rigidez em parte dos pacientes, com resposta variável." },
      { ref: "Clínica / acompanhamento", pct: "25–35%", msg: "Com acompanhamento e ajuste individual, parte dos pacientes relata melhora de **25–35%** em dor e sono." },
      { ref: "Revisões", pct: "20–30%", msg: "Revisões apontam melhora média de **20–30%** em parte dos casos — sem prometer, porque depende do perfil." }
    ]
  },
  reumatismo: {
    label: "dor difusa / reumatismo",
    studies: [
      { ref: "Clinical Pain (2020)", pct: "30–45%", msg: "Em dor difusa/reumatismo, há dados mostrando melhora de **30–45%** em dor e qualidade de vida em parte dos pacientes com acompanhamento." },
      { ref: "Estudos observacionais", pct: "25–40%", msg: "Em estudos observacionais, parte dos pacientes relata melhora de **25–40%** em sono e dor (quando o plano é bem ajustado)." },
      { ref: "Revisões", pct: "30–40%", msg: "Revisões sugerem respostas por volta de **30–40%** em parte dos casos — e a avaliação decide indicação e segurança." }
    ],
    objections: [
      { q: "Isso não é placebo? / marketing?", a: "É uma dúvida justa. O que ajuda aqui é olhar evidência + sua história clínica. Tem estudos e também casos reais com melhora mensurável — mas varia, então a avaliação é o que separa tentativa no escuro de estratégia." },
      { q: "Tenho medo de vício / ficar chapado", a: "Entendo. Por isso o plano é individualizado e com segurança; nem todo protocolo envolve THC, e o acompanhamento reduz risco de efeitos indesejados." },
      { q: "É legal? vou ter problema?", a: "Entendo a preocupação. A ideia é seguir o caminho médico e regular, dentro das regras. Na consulta o Dr. explica o processo correto e seguro." },
      { q: "Consulta online funciona?", a: "Funciona bem quando é bem conduzida: histórico completo, objetivos claros, plano individualizado e orientação organizada. E você sai com direcionamento prático." }
    ]
  },
  insonia: {
    label: "insônia",
    studies: [
      { ref: "Sleep Medicine (2020)", pct: "30–50%", msg: "Para insônia, estudos mostram melhora de **30–50%** em qualidade do sono em parte dos pacientes — variando conforme a causa e rotina." },
      { ref: "Revisões (sono)", pct: "25–45%", msg: "Revisões apontam melhora de **25–45%** em alguns perfis, principalmente quando se ajusta estratégia ao tipo de insônia." },
      { ref: "Dados clínicos", pct: "30–40%", msg: "Em prática clínica, parte dos pacientes relata melhora de **30–40%** em sono — mas precisa individualizar por segurança." }
    ]
  },
  ansiedade: {
    label: "ansiedade",
    studies: [
      { ref: "Estudos clínicos (ansiedade)", pct: "20–40%", msg: "Para ansiedade, há estudos mostrando melhora de **20–40%** em sintomas em parte dos pacientes — mas depende muito do tipo de ansiedade e do contexto." }
    ]
  }
};

// 10 variações “final” (uma pergunta só no final)
const EVIDENCE_HOOKS = [
  (pct, tema) => `É um resultado bem interessante — imagina melhorar cerca de ${pct} nesse ${tema}. Faz sentido pra você?`,
  (pct, tema) => `Isso chama atenção: em média, algo perto de ${pct}. Se fosse com você, já mudaria seu dia a dia?`,
  (pct, tema) => `Pra muita gente, ${pct} já muda a vida. Se você tivesse essa melhora no ${tema}, o que voltaria a fazer?`,
  (pct, tema) => `É animador ver números assim (${pct}). O que hoje você mais quer destravar no ${tema}?`,
  (pct, tema) => `Se a gente conseguisse chegar perto de ${pct}, qual seria a maior diferença na sua rotina?`,
  (pct, tema) => `Resultados assim (${pct}) não são “milagre”, mas são um bom sinal. O seu ${tema} é mais constante ou em crises?`,
  (pct, tema) => `Muita gente se surpreende com isso (${pct}). Qual é a sua meta principal com esse ${tema}?`,
  (pct, tema) => `É o tipo de dado que dá esperança (${pct}). Hoje isso te atrapalha mais no trabalho ou em casa?`,
  (pct, tema) => `Se fosse possível reduzir cerca de ${pct}, qual seria seu “primeiro ganho” no ${tema}?`,
  (pct, tema) => `É um número forte (${pct}) — e varia de pessoa pra pessoa. No seu caso, isso começou há quanto tempo?`
];

function pickEvidenceKey(flags, state) {
  // prioridade: subfoco explícito > foco macro
  if (flags.subfocus) return flags.subfocus;
  if (state.subfocus) return state.subfocus;
  const f = flags.focus || state.focus;
  if (f === "insonia") return "insonia";
  if (f === "ansiedade") return "ansiedade";
  if (f === "dor") return "dor_lombar"; // fallback ruim -> melhor não usar; então retorna null
  return null;
}

function canUseEvidence(state, evidenceKey) {
  if (!evidenceKey) return false;
  state.evidence_used = state.evidence_used || {};
  return !state.evidence_used[evidenceKey];
}

function markEvidenceUsed(state, evidenceKey) {
  state.evidence_used = state.evidence_used || {};
  state.evidence_used[evidenceKey] = true;
}

function buildEvidenceMessage(evidenceKey, state) {
  const pack = EVIDENCE_DB[evidenceKey];
  if (!pack || !pack.studies?.length) return "";

  // escolhe 1 estudo “rotativo”
  const idx = Number(state.evidence_rot || 0) % pack.studies.length;
  state.evidence_rot = Number(state.evidence_rot || 0) + 1;

  const st = pack.studies[idx];
  const tema = pack.label || "sintoma";
  const pct = st.pct || "alguns %";

  const hookFn = EVIDENCE_HOOKS[randInt(0, EVIDENCE_HOOKS.length - 1)];
  const hook = hookFn(pct, tema);

  // regra: não prometer; dizer “parte dos pacientes” + “varia”
  return `Existe pesquisa interessante sobre isso. ${st.msg} Em geral, isso varia de pessoa pra pessoa e depende do perfil — por isso a avaliação é importante. ${hook}`;
}

function shouldInjectEvidence(flags, state, leadType) {
  // Nunca atrapalhar fechamento/preço/urgência/resistência
  if (flags.wantsBook || flags.asksHours || flags.wantsPrice || flags.urgency || flags.refuses) return false;

  const key = pickEvidenceKey(flags, state);
  if (!key) return false;
  if (!canUseEvidence(state, key)) return false;

  const turns = Number(state.turn_count || 0);

  // 1) Se perguntou “funciona/vale a pena”
  if (flags.asksIfWorks) return true;

  // 2) Se cético/curioso -> evidência cedo
  if (leadType === "SKEPTIC" || leadType === "CURIOUS") return true;

  // 3) Proativo: após 2–3 mensagens (aquecido) e já temos foco/subfoco definido
  if (turns >= 2 && turns <= 5) return true;

  return false;
}

// ====== CLASSIFICADOR PSICOLÓGICO (determinístico) ======
function classifyLead(flags, text, state) {
  if (flags.wantsBook || flags.asksHours) return "HOT_SCHEDULE";
  if (flags.wantsPrice) return "PRICE_NOW";
  if (flags.refuses) return "RESISTANT";
  if (flags.urgency) return "URGENT";
  if (flags.asksStartNow) return "DOSE_SEEKER";

  if (flags.objection_skeptic) return "SKEPTIC";
  if (flags.objection_fear) return "FEARFUL";
  if (flags.objection_online) return "ONLINE_DOUBT";
  if (flags.objection_price) return "PRICE_SENSITIVE";

  if (flags.asksIfWorks) return "CURIOUS";
  if (state?.lead_type) return state.lead_type;

  return "NEUTRAL";
}

// ====== MOTOR DE OBJEÇÕES (templates premium) ======
function objectionReply(type, focus, state) {
  const nome = maybeUseName(state);
  const topic = focus === "insonia" ? "sono" : focus === "ansiedade" ? "ansiedade" : focus === "dor" ? "dor" : "seu caso";

  switch (type) {
    case "SKEPTIC":
      return `Entendo total sua dúvida${nome} 🙂 Eu também sou bem pé no chão: não é “milagre” e não é igual pra todo mundo. O que muda o jogo é avaliar seu histórico e montar estratégia segura pro ${topic}. Hoje o ${topic} te atrapalha mais em qual parte do dia?`;
    case "FEARFUL":
      return `Faz sentido ter receio${nome} 🙂 Por isso a gente trabalha com segurança e individualização, sem prometer resultado. Seu medo é mais de efeito colateral, de “dependência”, ou de questão legal/família?`;
    case "ONLINE_DOUBT":
      return `Super compreensível${nome}. A consulta online funciona bem quando é bem conduzida: histórico completo, padrão do sintoma e plano claro — sem tentativa no escuro. O que te trava mais no online: confiança, privacidade ou “não ser examinado”?`;
    case "PRICE_SENSITIVE":
      return `Entendo${nome} 🙂 Ajuda pensar assim: é uma avaliação de 45min bem direcionada pra evitar gastar tempo e dinheiro tentando coisa no escuro. Você quer primeiro entender se faz sentido pro seu caso, ou já quer ver valores?`;
    case "CURIOUS":
      return `Boa pergunta${nome} 🙂 Em parte dos pacientes pode ajudar, mas varia bastante — o que define é o perfil e o objetivo. Pra eu te responder do jeito certo: seu objetivo é melhorar o quê primeiro?`;
    default:
      return `Entendi${nome} 🙂 Pra eu te orientar melhor: seu foco hoje é mais sono, dor ou ansiedade?`;
  }
}

// ====== FUNIL DETERMINÍSTICO (clínica premium) ======
function urgencyReply() {
  return "Entendi. Pela sua mensagem, isso pode precisar de avaliação URGENTE. Procure um pronto atendimento agora (ou SAMU 192). Assim que estiver seguro(a), me chama aqui.";
}

function whoReply(state) {
  const nome = maybeUseName(state);
  return `Oi${nome} 🙂 Eu sou a Lia, da equipe do Dr. Alef Kotula. Ele é médico formado na Rússia e tem pós-graduação internacional em Cannabis Medicinal, atendimento 100% online. Quer que eu te explique em 30 segundos como funciona a consulta?`;
}

function priceReply(state) {
  const nome = maybeUseName(state);
  return (
    `Perfeito${nome} — te passo com transparência 😊\n` +
    "• Consulta online (45 min): R$347\n" +
    "• Consulta + retorno (~30 dias): R$447 (recomendada)\n" +
    "• Retorno avulso: R$200\n" +
    "Quer que eu te sugira 3 horários pra você escolher ou prefere dizer um dia/turno (manhã/tarde/noite)?"
  );
}

function safetyDoseReply(state) {
  const nome = maybeUseName(state);
  return `Entendi${nome}. Por segurança, eu não consigo orientar dose/como tomar por aqui 🙏 Isso depende do seu caso, medicações e objetivo. Se você quiser, eu te explico como funciona a avaliação (45 min) e te passo horários pra escolher. Você prefere manhã, tarde ou noite?`;
}

// slots “template” (agenda real entra depois)
function suggestSlots(preferDay) {
  if (preferDay === "sábado") return ["sábado 11h", "sábado 13h", "sábado 16h"];
  if (preferDay === "segunda") return ["segunda 13h", "segunda 18h", "terça 19h"];
  if (preferDay === "terça") return ["terça 13h", "terça 19h", "quinta 13h"];
  return ["terça 19h", "quinta 13h", "sábado 11h"];
}

function bookingOffer(state, slot) {
  const options = suggestSlots(slot?.day || state?.booking?.prefer_day);
  const nome = maybeUseName(state);
  return `Perfeito${nome} 😊 Tenho essas opções: ${options.join(" / ")}. Qual você prefere?`;
}

function bookingConfirm(state, slotStr) {
  const nome = maybeUseName(state);
  return `Fechado${nome} ✅ Vou reservar ${slotStr}. Pra confirmar, me diga por favor: seu nome completo e seu e-mail (pra eu te enviar o link e as orientações).`;
}

function bookingNeedAlternatives(state) {
  const nome = maybeUseName(state);
  return `Sem problema${nome} 🙂 Você prefere manhã, tarde ou noite? Se me disser isso, eu te mando 3 opções certeiras.`;
}

// ====== LIA (LLM) — conversa aberta + aquecimento ======
function compactMemory(state) {
  const s = state || {};
  return {
    nome: s.nome || null,
    focus: s.focus || null,
    subfocus: s.subfocus || null,
    lead_type: s.lead_type || null,
    booking: s.booking || { status: "idle" },
    last_user_message: s.last_user_message || "",
    last_bot_reply: s.last_bot_reply || "",
    turn_count: Number(s.turn_count || 0),
  };
}

function buildSystemPromptV11() {
  return `
Você é "Lia", secretária/closer premium do Dr. Alef Kotula (consulta 100% online).
Objetivo: soar humana, criar confiança e conduzir para agendamento quando houver sinal.

REGRAS ABSOLUTAS:
- Nunca prescrever dose, nunca orientar compra, nunca recomendar marca.
- Nunca prometer cura/garantir resultado.
- Nunca inventar uma condição (ex.: fibromialgia) se o lead NÃO mencionou e não está na memória.
- 1 pergunta por mensagem. Mensagens curtas. Sem “Oi” repetido.
- Se o lead pedir agendamento/horários: NÃO faça perguntas clínicas, apenas feche.
- Se o lead resistir/ficar irritado: recue (valide + desculpa curta + ofereça ajudar sem pressão).

NOME:
- Se ainda não souber o nome, peça cedo de forma natural (sem parecer formulário).
- Use o nome com moderação (não em toda mensagem).

CIÊNCIA/EVIDÊNCIA:
- Se receber um trecho de evidência com porcentagem, use em linguagem simples e responsável.
- Sempre ressalvar que varia e que avaliação define a estratégia.

FORMATO OBRIGATÓRIO (JSON puro):
{ "reply": "...", "updates": { ... } }
`;
}

function buildUserPromptV11({ incomingText, state, flags, leadType }) {
  const mem = compactMemory(state);
  const focus = flags.focus || state.focus || null;
  const subfocus = flags.subfocus || state.subfocus || null;

  return `
MEMÓRIA CURTA:
${JSON.stringify(mem)}

MENSAGEM:
${incomingText}

SINAIS:
${JSON.stringify(flags)}

LEAD TYPE:
${leadType}

FOCO / SUBFOCO:
${JSON.stringify({ focus, subfocus })}

TAREFA:
- Responder curto, humano e premium.
- 1 pergunta no final.
- Se não souber o nome, peça de forma natural.
- Atualize updates com: nome, queixa_principal, tempo, intensidade(0-10 se dor), foco, subfoco, objecoes.
`;
}

async function runLiaV11({ incomingText, state, flags, leadType }) {
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.55,
    messages: [
      { role: "system", content: buildSystemPromptV11() },
      { role: "user", content: buildUserPromptV11({ incomingText, state, flags, leadType }) },
    ],
  });

  const content = resp.choices?.[0]?.message?.content?.trim() || "";
  let parsed = null;
  try { parsed = JSON.parse(content); } catch {}

  if (!parsed || typeof parsed !== "object" || !parsed.reply) {
    return { reply: "Entendi 🙂 Pra eu te orientar melhor: seu foco hoje é mais sono, dor ou ansiedade?", updates: {} };
  }
  if (!parsed.updates) parsed.updates = {};
  parsed.reply = clip(parsed.reply, 800);
  return parsed;
}

// ====== HUMAN DELAY ======
function computeHumanDelay(flags, state, leadType) {
  let base = randInt(MIN_DELAY, MAX_DELAY);

  // fechamento: mais rápido (mas humano)
  if (flags.wantsBook || flags.asksHours) base = randInt(3, 6);
  if (flags.wantsPrice) base = randInt(4, 7);

  // evidência / objeção: “pensando”
  if (flags.asksIfWorks) base = randInt(6, 11);
  if (flags.refuses) base = randInt(5, 10);
  if (leadType === "SKEPTIC" || leadType === "FEARFUL") base = randInt(7, 12);

  // se respondeu muito em seguida, adiciona leve atraso
  const lastAt = Number(state.last_sent_at || 0);
  if (Date.now() - lastAt < 2000) base += 2;

  return Math.max(2, base);
}

async function sendWhatsApp(to, from, body, delaySec) {
  await sleep(delaySec * 1000);
  await twilioClient.messages.create({ to, from, body });
}

// ====== WEBHOOK ======
app.post("/whatsapp", async (req, res) => {
  // responde rápido pro Twilio (não bloqueia)
  const twiml = new twilio.twiml.MessagingResponse();
  res.type("text/xml").send(twiml.toString());

  (async () => {
    try {
      const lead = req.body.From || ""; // "whatsapp:+55..."
      const bot = req.body.To || "";
      const phone = lead.replace("whatsapp:", "").trim();

      const incomingText = (req.body.Body || "").trim();
      const numMedia = parseInt(req.body.NumMedia || "0", 10);

      let finalText = incomingText;

      // áudio/mídia
      if (numMedia > 0) {
        const mediaUrl = req.body.MediaUrl0;
        const mediaType = req.body.MediaContentType0 || "";
        if (mediaUrl && mediaType.startsWith("audio")) {
          const buf = await downloadTwilioMedia(mediaUrl);
          const transcript = await transcribeAudio(buf, mediaType);
          finalText = transcript ? transcript : "[ÁUDIO] (não consegui transcrever)";
        } else {
          finalText = incomingText || "[MÍDIA] Em uma frase: o que você precisa?";
        }
      }

      let state = await getUserState(phone);
      state.booking = state.booking || { status: "idle" };
      state.last_bot_reply = state.last_bot_reply || "";
      state.focus = state.focus || null;
      state.subfocus = state.subfocus || null;
      state.lead_type = state.lead_type || null;
      state.turn_count = Number(state.turn_count || 0);
      state.name_use_counter = Number(state.name_use_counter || 0);
      state.evidence_used = state.evidence_used || {};
      state.evidence_rot = Number(state.evidence_rot || 0);

      // contador de turnos
      state.turn_count += 1;

      const flags = detectIntent(finalText);
      const slot = extractPreferredSlot(finalText);

      // captura nome determinística
      if (!state.nome) {
        const extracted = extractName(finalText);
        if (extracted) state.nome = extracted;
      }

      // atualiza foco/subfoco conforme mensagem do lead
      if (flags.focus) state.focus = flags.focus;
      if (flags.subfocus) state.subfocus = flags.subfocus;

      // classificador
      const leadType = classifyLead(flags, finalText, state);
      state.lead_type = leadType;

      let reply = "";

      // === 0) PRIMEIRO PASSO: pedir nome (se ainda não tiver) sem atrapalhar intenção forte
      const noNameYet = !state.nome;
      const strongIntent = flags.wantsBook || flags.asksHours || flags.wantsPrice || flags.urgency || flags.refuses || flags.asksWho;

      if (noNameYet && !strongIntent && state.turn_count <= 2) {
        reply = "Oi 😊 Eu sou a Lia, da equipe do Dr. Alef. Pra eu te ajudar do jeito certo, qual seu nome?";
      }
      // === 1) URGÊNCIA
      else if (flags.urgency) {
        reply = urgencyReply();
        state.booking.status = "idle";
      }
      // === 2) QUEM É
      else if (flags.asksWho) {
        reply = whoReply(state);
      }
      // === 3) RESISTÊNCIA
      else if (flags.refuses) {
        const nome = maybeUseName(state);
        reply = `Tranquilo${nome} 🙂 Desculpa se soou pressionado. Você prefere que eu explique rapidinho como funciona a avaliação ou quer só tirar uma dúvida agora?`;
        state.booking.status = "idle";
      }
      // === 4) PREÇO
      else if (flags.wantsPrice) {
        reply = priceReply(state);
      }
      // === 5) DOSE / “COMEÇAR AGORA”
      else if (flags.asksStartNow) {
        reply = safetyDoseReply(state);
      }
      // === 6) AGENDAMENTO / HORÁRIOS (Closer hard + anti-loop)
      else if (flags.wantsBook || flags.asksHours || state.booking.status === "offered") {
        if (flags.declinesSlot) {
          reply = bookingNeedAlternatives(state);
          state.booking.status = "needs_alternatives";
        } else if (slot.day || slot.hour) {
          const slotStr = `${slot.day || "dia"} ${slot.hour || ""}`.trim();
          const askReserve = `Perfeito${maybeUseName(state)} 😊 Posso reservar ${slotStr} pra você?`;
          state.booking.status = "offered";
          state.booking.proposed = slotStr;

          reply = similar(askReserve, state.last_bot_reply) ? bookingOffer(state, slot) : askReserve;
        } else if (state.booking.status === "offered" && flags.confirms) {
          reply = bookingConfirm(state, state.booking.proposed || "o horário");
          state.booking.status = "confirmed";
        } else {
          const offer = bookingOffer(state, slot);
          state.booking.status = "offered";
          state.booking.prefer_day = slot.day || state.booking.prefer_day || null;

          reply = similar(offer, state.last_bot_reply)
            ? `Fechado${maybeUseName(state)} 😊 Você prefere manhã, tarde ou noite? Aí eu te mando 3 opções certeiras.`
            : offer;
        }
      }
      // === 7) EVIDENCE ENGINE (com %): proativo e por gatilho
      else if (shouldInjectEvidence(flags, state, leadType)) {
        const key = pickEvidenceKey(flags, state);
        // se não tiver chave válida, cai para objeções/LLM
        if (key && EVIDENCE_DB[key]) {
          reply = buildEvidenceMessage(key, state);
          markEvidenceUsed(state, key);
        }
      }
      // === 8) OBJEÇÕES / CURIOSIDADE (templates)
      if (!reply) {
        if (
          leadType === "SKEPTIC" ||
          leadType === "FEARFUL" ||
          leadType === "ONLINE_DOUBT" ||
          leadType === "PRICE_SENSITIVE" ||
          leadType === "CURIOUS"
        ) {
          reply = objectionReply(leadType, state.focus, state);
        }
      }
      // === 9) CONVERSA ABERTA (LLM)
      if (!reply) {
        const ai = await runLiaV11({ incomingText: finalText, state, flags, leadType });
        reply = ai.reply;
        state = mergeState(state, ai.updates);
      }

      // anti-loop final (hard)
      if (similar(reply, state.last_bot_reply)) {
        reply = `Entendi${maybeUseName(state)} 🙂 Só pra eu te guiar sem enrolar: hoje seu foco é mais sono, dor ou ansiedade?`;
      }

      // incrementa contador de uso do nome
      state.name_use_counter += 1;

      // bookkeeping
      const delaySec = computeHumanDelay(flags, state, leadType);

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
          body: "Tive uma instabilidade rápida aqui 🙏 Me manda de novo em 1 frase: seu foco hoje é mais sono, dor ou ansiedade?",
        });
      } catch {}
    }
  })();
});

// ====== HEALTH CHECK ======
app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
