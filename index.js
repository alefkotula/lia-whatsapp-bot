/**
 * LIA V11 — WhatsApp Bot (Twilio + Render + Postgres)
 * - Closer médico premium
 * - Delay humano
 * - Anti-loop forte
 * - Classificador psicológico (lead type)
 * - Motor de objeções (determinístico)
 * - Evidence Engine com % (do doc "ESTUDOS COM RESULTADO EM %")
 * - Memória curta + foco do lead (evita “condição fantasma”)
 * - Modelo padrão: gpt-4.1 (troca por ENV MODEL_CHAT)
 *
 * Node recomendado: 20 (mas roda em 18/20/22; 20 é o mais estável)
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
    /\b(quero marcar|quero agendar|marcar consulta|agendar consulta|quero a consulta|quero consulta|vamos agendar|pode marcar|quero fechar|quero pagar|quero confirmar)\b/.test(t);

  const asksHours =
    /\b(horarios|horario|que horas|vagas|agenda|disponibilidade|tem horario|tem horarios)\b/.test(t);

  const confirms =
    /\b(sim|ok|pode|confirmo|fechado|beleza|vamos|pode ser|serve|confirmar)\b/.test(t);

  const refuses =
    /\b(nao quero|não quero|pare|para|chega|rude|grosso|nao gostei|não gostei|voce esta sendo rude|você está sendo rude)\b/.test(t);

  const declinesSlot =
    /\b(nao posso|nao da|não dá|nao consigo|esse horario nao|esse horario nao posso|outro horario|outro horário|nao esse|não esse)\b/.test(t);

  const asksStartNow =
    /\b(quero comecar a tomar|quero começar a tomar|posso tomar|como tomar|dose|dosagem|quantas gotas|comecar agora)\b/.test(t);

  const urgency =
    /\b(dor no peito|falta de ar|desmaio|desmaiei|avc|convuls|paralisia|confusao|confusão)\b/.test(t);

  const asksWho =
    /\b(quem e|quem eh|quem e o dr|quem eh o dr|quem e esse doutor|quem é|quem é o dr|quem é esse doutor)\b/.test(t);

  // “funciona mesmo?” / “é bom?” (gatilho do Evidence Engine)
  const asksIfWorks =
    /\b(funciona|serve|e bom|é bom|ajuda|melhora|tem resultado|vale a pena|da certo)\b/.test(t);

  // foco/tema (evita “condição fantasma”)
  const focus =
    (/\b(insonia|insomnia|dormir|sono|acordar)\b/.test(t) && "insonia") ||
    (/\b(ansiedade|panico|pânico|crise)\b/.test(t) && "ansiedade") ||
    (/\b(enxaqueca|enxaqueca)\b/.test(t) && "enxaqueca") ||
    (/\b(artrose|osteoartrite)\b/.test(t) && "artrose") ||
    (/\b(neuropat|neuropatica|neuropática)\b/.test(t) && "neuropatica") ||
    (/\b(dor|fibromialgia|lombar|artrite)\b/.test(t) && "dor") ||
    null;

  // objeções comuns
  const objection_price = /\b(caro|caro demais|sem dinheiro|nao tenho dinheiro|muito caro|parcel|valor alto)\b/.test(t);
  const objection_fear = /\b(medo|tenho receio|vicia|viciar|dependen|efeito colateral|faz mal|maconha|droga|legal|policia|familia|relig)\b/.test(t);
  const objection_online = /\b(online funciona|consulta online|videochamada|telemed|nao confio online|prefiro presencial)\b/.test(t);
  const objection_skeptic = /\b(nao acredito|duvido|isso funciona mesmo|charlata|marketing|golpe)\b/.test(t);

  return {
    wantsPrice, wantsBook, asksHours, confirms, refuses, declinesSlot,
    asksStartNow, urgency, asksWho, asksIfWorks, focus,
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

// ====== EVIDENCE ENGINE (do doc "ESTUDOS COM RESULTADO EM %") ======
const EVIDENCE_DB = {
  fibromialgia: {
    topic: "fibromialgia",
    lines: [
      "Tem pesquisa bem interessante: em estudos com fibromialgia, houve redução de cerca de 50% a 60% em indicadores de dor e qualidade de vida após alguns meses em parte dos pacientes.",
      "Outra análise encontrou redução média de 40% a 60% nos escores de dor/impacto funcional em alguns grupos.",
    ],
    guard: "Cada pessoa responde de um jeito — por isso a avaliação é essencial pra ver se faz sentido pro seu caso.",
  },
  dor_cronica: {
    topic: "dor crônica",
    lines: [
      "Em dor crônica, há dados interessantes: um estudo grande mostrou redução de uso de opioides em torno de 47% a 51% após iniciar tratamento com cannabis medicinal em parte dos pacientes.",
      "Outras revisões apontam redução de dor variando de 42% a 66% com CBD isolado ou combinado, dependendo do perfil e formulação.",
    ],
    guard: "Não é milagre — a resposta varia e a estratégia precisa ser individualizada com segurança.",
  },
  insonia: {
    topic: "insônia",
    lines: [
      "Para insônia, há ensaio clínico com um dado forte: cerca de 60% deixaram de ser classificados como insones após poucas semanas em um protocolo.",
      "Também há melhora de qualidade do sono relatada em até 80% em alguns estudos e manutenção de melhora em >40% no acompanhamento longo.",
      "Em alguns casos, foi observado aumento de melatonina em torno de 30% (variável).",
    ],
    guard: "O ponto-chave é entender a causa da sua insônia e personalizar — por isso a avaliação faz diferença.",
  },
  neuropatica: {
    topic: "dor neuropática",
    lines: [
      "Dor neuropática é uma das áreas com mais dados: estudos mostram que 40% a 55% dos pacientes podem relatar alívio clinicamente relevante em alguns protocolos.",
      "Há trabalhos mostrando aumento de pacientes com ≥30% de alívio da dor em comparação ao placebo em revisões grandes.",
    ],
    guard: "Mas precisa encaixar com seu tipo de dor e histórico — por isso avaliação é o caminho seguro.",
  },
  ansiedade: {
    topic: "ansiedade",
    lines: [
      "Para ansiedade, meta-análises apontam redução importante de sintomas em parte dos pacientes — em alguns recortes, cerca de 70% relataram melhora significativa.",
      "Muita gente melhora também o sono e o humor quando o plano está bem alinhado ao quadro.",
    ],
    guard: "Como ansiedade tem vários perfis, a avaliação ajuda a definir se é o seu caso e como fazer com segurança.",
  },
  artrose: {
    topic: "artrose",
    lines: [
      "Em artrose, há estudo com relato de 44% de redução de dor após uso de CBD em parte dos pacientes, e 83% relatando alguma melhora.",
      "Também há dados de 60% relatando melhora funcional e redução/cessação de anti-inflamatórios em um protocolo transdérmico em alguns grupos.",
    ],
    guard: "De novo: varia por pessoa — a avaliação define se é adequado e como acompanhar.",
  },
  enxaqueca: {
    topic: "enxaqueca",
    lines: [
      "Em enxaqueca, há estudo controlado com alívio de dor em 2 horas em cerca de 67% com combinação THC+CBD (em um protocolo).",
      "E estudo observacional com 61% reduzindo a frequência de crises em mais de 50% em parte dos pacientes.",
      "Também há redução de crises mensais de ~10 para ~5 em alguns acompanhamentos (varia por perfil).",
    ],
    guard: "É promissor, mas precisa ser individualizado (tipo de crise, gatilhos e medicações).",
  },
};

// 10 variações do “final forte”
const EVIDENCE_CLOSERS = [
  "Esse tipo de resultado chama atenção, né? Imagina se você conseguir uma melhora parecida no seu caso.",
  "É um dado bem forte. Imagina o impacto de reduzir isso em dezenas de por cento na sua rotina.",
  "Quando a gente vê números assim, dá esperança. Imagina você sentindo isso na prática no dia a dia.",
  "Não é garantia, mas é animador. Imagina se você melhora isso de forma consistente nas próximas semanas.",
  "É promissor, né? Imagina acordar e perceber que aquilo já não te domina do mesmo jeito.",
  "Esses percentuais são bem interessantes. Imagina o que muda na sua vida com essa melhora.",
  "É o tipo de estudo que faz a gente prestar atenção. Imagina você reduzindo isso de verdade.",
  "Não é “milagre”, mas é animador. Imagina se a gente encontra um plano que te dê esse ganho.",
  "Esse resultado é acima da média do que muita gente imagina. Imagina você tendo essa evolução.",
  "É uma boa notícia. Imagina melhorar isso sem ficar tentando coisa no escuro.",
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// escolhe a evidência pelo foco (sem inventar condição)
function getEvidenceByFocus(focus) {
  if (!focus) return null;
  if (focus === "dor") return EVIDENCE_DB.dor_cronica;
  if (focus === "insonia") return EVIDENCE_DB.insonia;
  if (focus === "ansiedade") return EVIDENCE_DB.ansiedade;
  if (focus === "enxaqueca") return EVIDENCE_DB.enxaqueca;
  if (focus === "artrose") return EVIDENCE_DB.artrose;
  if (focus === "neuropatica") return EVIDENCE_DB.neuropatica;
  if (focus === "fibromialgia") return EVIDENCE_DB.fibromialgia;
  return null;
}

// se o lead falou fibromialgia explicitamente, permite usar essa evidência
function leadMentionedFibro(text, state) {
  const t = norm(text);
  if (/\b(fibromialgia)\b/.test(t)) return true;
  if (state?.queixa_principal && norm(state.queixa_principal).includes("fibromialgia")) return true;
  return false;
}

// evita repetir evidência em loop (cooldown)
function canUseEvidence(state, key) {
  const lastKey = state.last_evidence_key || "";
  const lastAt = Number(state.last_evidence_at || 0);
  if (lastKey === key && Date.now() - lastAt < 5 * 60 * 1000) return false; // 5 min
  return true;
}

function evidenceReply(focus, text, state) {
  // regra anti-condição fantasma:
  // se foco é "dor", NÃO citar fibromialgia, a menos que o lead tenha mencionado.
  let ev = getEvidenceByFocus(focus);

  if (ev && ev.topic === "fibromialgia" && !leadMentionedFibro(text, state)) {
    // fallback para dor crônica geral
    ev = EVIDENCE_DB.dor_cronica;
  }

  if (!ev) return null;

  const key = ev.topic;
  if (!canUseEvidence(state, key)) return null;

  const msg =
    `Existe pesquisa interessante sobre isso. ${pick(ev.lines)}\n` +
    `${ev.guard}\n` +
    `${pick(EVIDENCE_CLOSERS)}\n` +
    `Só pra eu te orientar certinho: hoje o seu foco é mais ${focus === "insonia" ? "sono" : focus === "ansiedade" ? "ansiedade" : "dor"}?`;

  return { reply: msg, key };
}

// ====== CLASSIFICADOR PSICOLÓGICO ======
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

// ====== MOTOR DE OBJEÇÕES (premium) ======
function objectionReply(leadType, focus) {
  const topic =
    focus === "insonia" ? "sono" :
    focus === "ansiedade" ? "ansiedade" :
    focus === "dor" ? "dor" :
    "seu caso";

  switch (leadType) {
    case "SKEPTIC":
      return `Entendo sua dúvida 🙂 Eu também sou bem pé no chão: não é “milagre” e não serve igual pra todo mundo. O que muda o jogo é avaliação + estratégia segura pro ${topic}. Me diz: o que você já tentou até agora?`;

    case "FEARFUL":
      return `Faz sentido ter receio 🙂 Por isso a gente trabalha com segurança e individualização. Seu receio é mais com efeito colateral, “dependência”, ou com a parte legal/família?`;

    case "ONLINE_DOUBT":
      return `Super compreensível. A consulta online funciona bem quando é bem conduzida: histórico completo, padrão do sintoma e plano claro. O que mais te trava no online: confiança, privacidade ou “não ser examinado”?`;

    case "PRICE_SENSITIVE":
      return `Entendo 🙂 Ajuda pensar que é uma avaliação de 45min bem direcionada pra evitar tentativas no escuro. Você prefere primeiro entender se é “seu caso” ou já quer que eu te passe os valores?`;

    case "CURIOUS":
      return `Boa pergunta 🙂 Pode ajudar em parte dos casos, mas varia bastante conforme o perfil e o objetivo. Só pra eu te responder do jeito certo: seu foco principal hoje é ${topic} mesmo?`;

    default:
      return `Entendi 🙂 Pra eu te orientar melhor: hoje seu foco é mais sono, dor ou ansiedade?`;
  }
}

// ====== FUNIL DETERMINÍSTICO (clínica premium) ======
function urgencyReply() {
  return "Entendi. Pela sua mensagem, isso pode precisar de avaliação URGENTE. Procure um pronto atendimento agora (ou SAMU 192). Assim que estiver seguro(a), me chama aqui.";
}

function whoReply() {
  return "Oi 🙂 Eu sou a Lia, da equipe do Dr. Alef Kotula. Ele é médico formado na Rússia e tem pós-graduação internacional em Cannabis Medicinal, atendimento 100% online. Quer que eu te explique em 30 segundos como funciona a consulta?";
}

function priceReply() {
  return (
    "Perfeito — te passo os valores e você vê se faz sentido 😊\n" +
    "• Consulta online (45 min): R$347\n" +
    "• Consulta + retorno (~30 dias): R$447 (recomendada)\n" +
    "• Retorno avulso: R$200\n" +
    "Quer que eu te sugira 3 horários pra escolher ou prefere dizer um dia/turno (manhã/tarde/noite)?"
  );
}

function safetyDoseReply() {
  return "Entendi sua vontade de começar. Por segurança, eu não consigo orientar dose/como tomar por aqui 🙏 Isso depende do seu caso, medicações e objetivo. Se você quiser, eu te explico como funciona a avaliação (45 min) e te passo horários pra escolher. Você prefere manhã, tarde ou noite?";
}

function suggestSlots(preferDay) {
  if (preferDay === "sábado") return ["sábado 11h", "sábado 13h", "sábado 16h"];
  if (preferDay === "segunda") return ["segunda 13h", "segunda 18h", "terça 19h"];
  if (preferDay === "terça") return ["terça 13h", "terça 19h", "quinta 13h"];
  return ["terça 19h", "quinta 13h", "sábado 11h"];
}

function bookingOffer(state, slot) {
  const options = suggestSlots(slot?.day || state?.booking?.prefer_day);
  return `Perfeito 😊 Tenho essas opções: ${options.join(" / ")}. Qual você prefere?`;
}

function bookingConfirm(slotStr) {
  return `Fechado ✅ Vou reservar ${slotStr}. Pra confirmar, me diga por favor: seu nome completo e seu e-mail (pra eu te enviar o link e as orientações).`;
}

function bookingNeedAlternatives() {
  return "Sem problema 🙂 Você prefere manhã, tarde ou noite? Se me disser isso, eu te mando 3 opções certeiras.";
}

// ====== LIA (LLM) — conversa aberta + aquecimento ======
function buildSystemPromptV11() {
  return `
Você é "Lia", secretária/closer premium do Dr. Alef Kotula (consulta 100% online).
Objetivo: parecer humana, gerar confiança e conduzir para agendamento quando houver sinal.

REGRAS ABSOLUTAS:
- Nunca prescrever dose, nunca orientar compra, nunca recomendar marca.
- Nunca prometer cura/garantir resultado.
- Nunca inventar uma condição (ex.: fibromialgia) se o lead NÃO mencionou e não está na memória.
- Se o lead pedir agendamento/horários: NÃO faça perguntas clínicas, feche com opções.
- Se o lead resistir/ficar irritado: recue (valide + peça desculpa curto + ofereça ajudar sem pressão).
- 1 pergunta por mensagem. Mensagens curtas. Sem “Oi” repetido.
- Tom “clínica premium”: acolhedor, objetivo, sem enrolar.

CIÊNCIA:
- Use evidência em 2-3 linhas, sem prometer.
- Sempre ressalvar que varia e que avaliação define a estratégia.
- Use números SOMENTE se estiverem no contexto fornecido (aqui, você recebeu as linhas prontas no prompt).

FORMATO OBRIGATÓRIO (JSON puro):
{ "reply": "...", "updates": { ... } }
`;
}

function compactMemory(state) {
  const s = state || {};
  return {
    focus: s.focus || null,
    lead_type: s.lead_type || null,
    booking: s.booking || { status: "idle" },
    last_user_message: s.last_user_message || "",
    last_bot_reply: s.last_bot_reply || "",
    nome: s.nome || null,
    queixa_principal: s.queixa_principal || null,
    tempo: s.tempo || null,
    intensidade: s.intensidade || null,
    objecoes: s.objecoes || null,
  };
}

function buildUserPromptV11({ incomingText, state, flags, evidencePack }) {
  const mem = compactMemory(state);
  return `
MEMÓRIA CURTA:
${JSON.stringify(mem)}

MENSAGEM:
${incomingText}

SINAIS:
${JSON.stringify(flags)}

EVIDÊNCIA DISPONÍVEL (se precisar responder "funciona?"):
${evidencePack ? JSON.stringify(evidencePack) : "N/A"}

TAREFA:
- Responder curto, humano, premium.
- 1 pergunta no final.
- Não inventar condição.
- Atualize updates com: nome(se aparecer), queixa_principal, tempo, intensidade(0-10 se dor), foco, objecoes.
`;
}

async function runLiaV11({ incomingText, state, flags, evidencePack }) {
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.5,
    messages: [
      { role: "system", content: buildSystemPromptV11() },
      { role: "user", content: buildUserPromptV11({ incomingText, state, flags, evidencePack }) },
    ],
  });

  const content = resp.choices?.[0]?.message?.content?.trim() || "";
  let parsed = null;
  try { parsed = JSON.parse(content); } catch {}

  if (!parsed || typeof parsed !== "object" || !parsed.reply) {
    return { reply: "Entendi 🙂 Pra eu te orientar melhor: hoje seu foco é mais sono, dor ou ansiedade?", updates: {} };
  }
  if (!parsed.updates) parsed.updates = {};
  parsed.reply = clip(parsed.reply, 700);
  return parsed;
}

// ====== HUMAN DELAY ======
function computeHumanDelay(flags, state, leadType) {
  let base = randInt(MIN_DELAY, MAX_DELAY);
  if (flags.wantsBook || flags.asksHours) base = randInt(3, 6);
  if (flags.wantsPrice) base = randInt(4, 7);

  if (flags.asksIfWorks) base = randInt(6, 11);
  if (flags.refuses) base = randInt(5, 10);

  if (leadType === "SKEPTIC" || leadType === "FEARFUL") base = randInt(7, 12);

  const lastAt = Number(state.last_sent_at || 0);
  if (Date.now() - lastAt < 2000) base += 2;

  return Math.max(2, base);
}

// ====== SEND WHATSAPP (REST API) ======
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
      const lead = req.body.From || "";
      const bot = req.body.To || "";
      const phone = lead.replace("whatsapp:", "").trim();

      const incomingText = (req.body.Body || "").trim();
      const numMedia = parseInt(req.body.NumMedia || "0", 10);

      let finalText = incomingText;

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
      state.lead_type = state.lead_type || null;

      const flags = detectIntent(finalText);
      const slot = extractPreferredSlot(finalText);

      // atualiza foco
      if (flags.focus) state.focus = flags.focus;

      // classificador psicológico
      const leadType = classifyLead(flags, finalText, state);
      state.lead_type = leadType;

      let reply = "";

      // 0) URGÊNCIA
      if (flags.urgency) {
        reply = urgencyReply();
        state.booking.status = "idle";
      }
      // 1) QUEM É
      else if (flags.asksWho) {
        reply = whoReply();
      }
      // 2) RESISTÊNCIA
      else if (flags.refuses) {
        reply = "Tranquilo 🙂 Desculpa se soou pressionado. Quer que eu te explique rapidinho como funciona a avaliação ou prefere só tirar uma dúvida agora?";
        state.booking.status = "idle";
      }
      // 3) PREÇO
      else if (flags.wantsPrice) {
        reply = priceReply();
      }
      // 4) DOSE / “COMEÇAR”
      else if (flags.asksStartNow) {
        reply = safetyDoseReply();
      }
      // 5) AGENDAMENTO / HORÁRIOS (Closer hard + anti-loop)
      else if (flags.wantsBook || flags.asksHours || state.booking.status === "offered") {
        if (flags.declinesSlot) {
          reply = bookingNeedAlternatives();
          state.booking.status = "needs_alternatives";
        } else if (slot.day || slot.hour) {
          const slotStr = `${slot.day || "dia"} ${slot.hour || ""}`.trim();
          const askReserve = `Perfeito 😊 Posso reservar ${slotStr} pra você?`;
          state.booking.status = "offered";
          state.booking.proposed = slotStr;
          reply = similar(askReserve, state.last_bot_reply) ? bookingOffer(state, slot) : askReserve;
        } else if (state.booking.status === "offered" && flags.confirms) {
          reply = bookingConfirm(state.booking.proposed || "o horário");
          state.booking.status = "confirmed";
        } else {
          const offer = bookingOffer(state, slot);
          state.booking.status = "offered";
          state.booking.prefer_day = slot.day || state.booking.prefer_day || null;
          reply = similar(offer, state.last_bot_reply)
            ? "Fechado 😊 Você prefere manhã, tarde ou noite? Aí eu te mando 3 opções certeiras."
            : offer;
        }
      }
      // 6) “FUNCIONA MESMO?” → Evidence Engine (antes de qualquer outra coisa)
      else if (flags.asksIfWorks) {
        const focus = flags.focus || state.focus || null;
        const ev = evidenceReply(focus, finalText, state);

        if (ev && ev.reply) {
          reply = ev.reply;
          state.last_evidence_key = ev.key;
          state.last_evidence_at = Date.now();
        } else {
          // fallback: se não achou foco, pergunta foco
          reply = "Boa pergunta 🙂 Pode ajudar em parte dos casos, mas varia bastante conforme o objetivo e seu histórico. Só pra eu te responder certo: seu foco hoje é mais sono, dor ou ansiedade?";
        }
      }
      // 7) OBJEÇÕES / CURIOSIDADE (motor determinístico)
      else if (
        leadType === "SKEPTIC" ||
        leadType === "FEARFUL" ||
        leadType === "ONLINE_DOUBT" ||
        leadType === "PRICE_SENSITIVE" ||
        leadType === "CURIOUS"
      ) {
        reply = objectionReply(leadType, state.focus);
      }
      // 8) CONVERSA ABERTA (LLM)
      else {
        // passa “pacote” de evidência apenas para o foco atual (não vira prompt gigante)
        const focus = state.focus || null;
        const evidencePack = focus ? getEvidenceByFocus(focus) : null;

        const ai = await runLiaV11({ incomingText: finalText, state, flags, evidencePack });
        reply = ai.reply;
        state = mergeState(state, ai.updates);
      }

      // hard anti-loop final
      if (similar(reply, state.last_bot_reply)) {
        reply = "Entendi 🙂 Só pra eu te guiar sem enrolar: seu foco hoje é mais sono, dor ou ansiedade?";
      }

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
