const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ====== ENV ======
const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  DATABASE_URL,
} = process.env;

if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error("❌ Falta OPENAI_API_KEY / TWILIO_* nas env vars.");
}
if (!DATABASE_URL) {
  console.error("❌ Falta DATABASE_URL nas env vars.");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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
    "INSERT INTO wa_users (phone, state, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (phone) DO UPDATE SET state=$2::jsonb, updated_at=NOW()",
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

// ====== TWILIO MEDIA DOWNLOAD (Basic Auth) ======
async function downloadTwilioMedia(url) {
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Falha ao baixar mídia: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ====== OPENAI TRANSCRIBE (áudio) ======
async function transcribeAudio(buffer) {
  const file = new File([buffer], "audio.ogg", { type: "audio/ogg" });
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
  });
  return (transcription.text || "").trim();
}

// ====== GUARDRAILS (anti-robô, 1 pergunta, timing) ======
function stripOverGreeting(text) {
  return text
    .replace(/(^|\n)\s*Oi!\s*/g, "$1")
    .replace(/(^|\n)\s*Olá!\s*/g, "$1")
    .trim();
}

function ensureOneQuestion(text) {
  const idx = text.indexOf("?");
  if (idx === -1) return text.trim();
  return text.slice(0, idx + 1).trim();
}

function capLength(text, maxChars = 420) {
  const t = (text || "").trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars).trim();
}

function normalizeReply(text, isFirstMessage = false) {
  let out = (text || "").trim();
  if (!isFirstMessage) out = stripOverGreeting(out);
  out = ensureOneQuestion(out);
  out = capLength(out, 420);
  if (!out) out = "Entendi 🙏 Me conta com calma… o que está te incomodando mais ultimamente?";
  return out;
}

// ====== DETECTORES (resistência, urgência, intenções) ======
function hasAny(text, patterns) {
  const t = (text || "").toLowerCase();
  return patterns.some((p) => t.includes(p));
}

function detectResistance(text) {
  const patterns = [
    "não quero", "nao quero", "não vou", "nao vou",
    "não gostei", "nao gostei", "rude", "grosso",
    "pare", "para", "chega", "me deixe", "me deixa",
    "eu nem falei", "não falei", "nao falei",
    "não decidi", "nao decidi", "não entendi", "nao entendi",
  ];
  return hasAny(text, patterns);
}

function detectPriceAsk(text) {
  const patterns = ["valor", "preço", "preco", "quanto custa", "quanto é", "quanto eh", "investimento"];
  return hasAny(text, patterns);
}

function detectUrgency(text) {
  const patterns = [
    "dor no peito", "falta de ar", "desmaio", "desmaiei",
    "paralisia", "formigamento súbito", "formigamento subito",
    "fraqueza súbita", "fraqueza subita", "confusão", "confusao",
    "avc", "convuls", "sangramento intenso",
  ];
  return hasAny(text, patterns);
}

function detectIntroAsk(text) {
  const patterns = ["quem é", "quem eh", "quem é esse", "quem eh esse", "quem é o dr", "quem eh o dr", "quem é o doutor", "quem eh o doutor"];
  return hasAny(text, patterns);
}

// ====== LEAD SCORING / STATE MACHINE ======
function ensureDefaults(state) {
  const s = { ...(state || {}) };
  if (typeof s.trust_score !== "number") s.trust_score = 0;
  if (!s.stage) s.stage = "empatia";
  if (!s.mode) s.mode = "normal"; // normal | educar
  if (typeof s.last_question !== "string") s.last_question = "";
  if (typeof s.no_pitch_until !== "number") s.no_pitch_until = 0; // cooldown timestamp
  return s;
}

function computeTrustDelta(updates = {}) {
  let delta = 0;
  if (updates.nome) delta += 1;
  if (updates.queixa_principal) delta += 1;
  if (updates.dor_intensidade !== undefined && updates.dor_intensidade !== null) delta += 2;
  if (updates.tempo_dor) delta += 1;
  if (updates.impacto) delta += 1;
  if (updates.tratamentos_previos) delta += 1;
  if (updates.objecoes || updates.medo_principal) delta += 1;
  return delta;
}

function isHotEnough(state) {
  // quente = já temos intensidade + impacto/tempo + confiança mínima
  const hasIntensity = typeof state.dor_intensidade === "number";
  const hasTimeOrImpact = !!(state.tempo_dor || state.impacto);
  return hasIntensity && hasTimeOrImpact && state.trust_score >= 4;
}

function isColdLead(state) {
  // frio = pouca info e/ou intensidade baixa
  const intensity = typeof state.dor_intensidade === "number" ? state.dor_intensidade : null;
  if (intensity !== null && intensity <= 3) return true;
  const infoCount =
    (state.nome ? 1 : 0) +
    (state.queixa_principal ? 1 : 0) +
    (state.tempo_dor ? 1 : 0) +
    (state.impacto ? 1 : 0) +
    (typeof state.dor_intensidade === "number" ? 1 : 0);
  return infoCount <= 1;
}

function applyStageGuards(requestedStage, state, intent) {
  // Não permitir agendamento cedo demais (a menos que esteja quente OU lead pediu explícito)
  if (requestedStage === "agendamento") {
    const askedToSchedule = intent === "asked_schedule";
    if (!askedToSchedule && !isHotEnough(state)) return "aquecimento";
  }
  // Em modo educar, evitar preço/agendamento, a menos que lead peça
  if (state.mode === "educar") {
    if ((requestedStage === "preco" || requestedStage === "agendamento") && intent !== "asked_price") {
      return "educacao";
    }
  }
  return requestedStage;
}

// ====== PROMPT V5.1 (com modos + travas) ======
function buildSystemPrompt() {
  return `
Você é "Lia", secretária/closer da equipe do Dr. Alef Kotula (médico formado na Rússia + pós-graduação internacional em Cannabis Medicinal, atendimento 100% online).
Sua missão: acolher, qualificar em poucas mensagens e conduzir (com elegância) ao AGENDAMENTO da consulta.

REGRAS ABSOLUTAS:
- NÃO prescrever dose, NÃO recomendar marca, NÃO orientar compra.
- NÃO prometer cura nem garantir resultado.
- Pode dizer "muitos pacientes relatam melhora" e "há evidências" com linguagem responsável.
- URGÊNCIA (dor no peito, falta de ar, desmaio, sintomas neurológicos súbitos): orientar emergência e ENCERRAR.
- Não atacar médicos do Brasil.

ESTILO:
- 100% humana: frases curtas, calor, escuta ativa, sem repetição, sem “Oi!” a cada mensagem.
- 1 PERGUNTA POR VEZ. SEMPRE.
- Priorize dor (maioria dos leads). Para dor: peça intensidade 0–10 cedo, com tato.
- Não empurrar consulta cedo: primeiro confiança.
- Se o lead resistir ("não falei que quero consultar", "não quero consulta", "você está rude"): recuar, validar e continuar ajudando sem insistir.

DOIS MODOS:
1) MODO NORMAL (converter): qualifica → aquece → convite → (se pedirem) preço → agendamento.
2) MODO EDUCAR (lead frio): responder breve, educar em 1 insight, fazer 1 pergunta leve, e encerrar com porta aberta.
   - NÃO oferecer agendamento no modo EDUCAR, a menos que o lead peça.

PREÇO:
- Se pedirem preço de cara: fazer 2–3 perguntas rápidas antes de falar valores.
- 3 opções:
  • Consulta (45 min): R$347
  • Consulta + retorno (~30 dias): R$447 (recomendada)
  • Retorno avulso: R$200
- Escassez leve e real: "a agenda costuma fechar rápido".

CIÊNCIA:
- Quando citar estudo, traduzir em linguagem simples e percentual.
- Sempre ressalvar que varia por pessoa e avaliação é essencial.

MEMÓRIA:
- Registrar em "updates": nome, queixa_principal, tempo_dor, dor_intensidade(0-10), local_dor, impacto, tratamentos_previos, medo_principal, objecoes, disponibilidade_horario.

FORMATO DE SAÍDA:
Responda SEMPRE em JSON puro:
{
  "reply": "texto WhatsApp",
  "stage": "empatia|qualificacao|aquecimento|educacao|preco|agendamento|pos_agendamento|urgencia|resistencia",
  "updates": { ... }
}

EXEMPLOS:
- Resistência:
reply: "Tranquilo, sem problema 🙂 Só pra eu entender melhor: o que hoje mais te incomoda — a dor ou o sono?"
stage: "resistencia"

- Lead frio (dor 2/10):
reply: "Entendi 🙂 Dor leve às vezes piora com postura e estresse. Ela aparece mais ao ficar sentado ou em pé?"
stage: "educacao"

- Lead quente:
reply: "Pelo que você me contou, faz sentido uma avaliação médica bem direcionada. Quer que eu te passe dois horários pra escolher?"
stage: "agendamento"
`;
}

function buildUserPrompt(incomingText, state, meta) {
  const memory = JSON.stringify(state || {});
  const m = meta || {};
  return `
MEMÓRIA ATUAL:
${memory}

META:
- primeira mensagem? ${m.isFirstMessage ? "SIM" : "NÃO"}
- modo atual: ${m.mode}
- trust_score atual: ${m.trust_score}
- intenção detectada: ${m.intent}

MENSAGEM DO LEAD:
${incomingText}

TAREFA:
- Responder curto e humano.
- Fazer exatamente 1 pergunta.
- Respeitar o modo (NORMAL vs EDUCAR).
- Se houver resistência: validar e recuar.
- Atualizar "updates" com dados novos.
`;
}

// ====== OPENAI CHAT (JSON output) ======
async function runLia(incomingText, state, meta) {
  const system = buildSystemPrompt();
  const user = buildUserPrompt(incomingText, state, meta);

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.55,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const content = resp.choices?.[0]?.message?.content?.trim() || "";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = {
      reply: "Entendi 🙏 Me conta com calma… o que está te incomodando mais ultimamente?",
      stage: "qualificacao",
      updates: {},
    };
  }

  if (!parsed.reply) parsed.reply = "Entendi 🙏 Me conta com calma… o que está te incomodando mais ultimamente?";
  if (!parsed.stage) parsed.stage = "qualificacao";
  if (!parsed.updates) parsed.updates = {};

  // Guardrails finais
  parsed.reply = normalizeReply(parsed.reply, !!(meta && meta.isFirstMessage));
  return parsed;
}

// ====== HANDLERS FIXOS (resistência/urgência) ======
function fixedUrgencyReply() {
  return {
    reply: "Entendi. Pela sua mensagem, pode ser algo que precisa de avaliação URGENTE. Procure um pronto atendimento agora (ou SAMU 192) e, se puder, peça ajuda de alguém para te acompanhar. Assim que estiver seguro(a), me chama aqui.",
    stage: "urgencia",
    updates: {},
  };
}

function fixedResistanceReply(state) {
  // Se ficou irritado, NÃO insistir; manter humano e 1 pergunta leve
  // (porta aberta + qualificação suave)
  const name = state?.nome ? `, ${state.nome}` : "";
  return {
    reply: `Tranquilo${name} 🙂 Sem pressão nenhuma. Só pra eu te orientar melhor: hoje o que mais te incomoda — a dor, o sono ou a ansiedade?`,
    stage: "resistencia",
    updates: {},
  };
}

// ====== INTENT DETECTOR ======
function detectIntent(text, state) {
  const t = (text || "").toLowerCase();

  if (detectPriceAsk(t)) return "asked_price";
  if (t.includes("quero marcar") || t.includes("quero agendar") || t.includes("vamos marcar") || t.includes("agenda")) return "asked_schedule";
  if (detectIntroAsk(t)) return "asked_who";
  return "normal";
}

// ====== WEBHOOK ======
app.post("/whatsapp", async (req, res) => {
  try {
    const from = req.body.From || "";
    const phone = from.replace("whatsapp:", "").trim() || "unknown";

    const incomingText = (req.body.Body || "").trim();
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    console.log("📩 Mensagem recebida:", { phone, incomingText, numMedia });

    // memória
    let state = ensureDefaults(await getUserState(phone));
    const isFirstMessage = !state || Object.keys(state).length === 0;

    // áudio/mídia
    let finalText = incomingText;
    let cameFromAudio = false;

    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0 || "";

      if (mediaUrl && mediaType.startsWith("audio")) {
        cameFromAudio = true;
        const buf = await downloadTwilioMedia(mediaUrl);
        const transcript = await transcribeAudio(buf);
        console.log("🗣️ Transcrição:", transcript);
        finalText = transcript ? transcript : "(áudio curto — não consegui transcrever)";
      } else {
        finalText = incomingText || "Recebi uma mídia. Em uma frase: o que você precisa?";
      }
    }

    // urgência antes de tudo
    if (detectUrgency(finalText)) {
      const urgent = fixedUrgencyReply();
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(urgent.reply);
      res.type("text/xml").send(twiml.toString());
      return;
    }

    // resistência antes da IA (cooldown)
    if (detectResistance(finalText)) {
      // trava “não vender” por 15 minutos
      state.no_pitch_until = Date.now() + 15 * 60 * 1000;
      state.stage = "resistencia";
      await saveUserState(phone, state);

      const fixed = fixedResistanceReply(state);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(fixed.reply);
      res.type("text/xml").send(twiml.toString());
      return;
    }

    // intent + modo
    const intent = detectIntent(finalText, state);

    // Se está em cooldown, não pode vender/empurrar agendamento/preço
    const inCooldown = Date.now() < (state.no_pitch_until || 0);

    // Decide se lead é frio → modo educar (sem insistir)
    // (se pedir preço/agendar, mantém normal)
    if (!inCooldown && intent !== "asked_price" && intent !== "asked_schedule") {
      if (isColdLead(state)) state.mode = "educar";
      else state.mode = "normal";
    }

    // roda IA
    const ai = await runLia(finalText, state, {
      isFirstMessage,
      cameFromAudio,
      mode: state.mode,
      trust_score: state.trust_score,
      intent,
    });

    // aplica updates + trust score
    const merged = mergeState(state, ai.updates);

    // incrementa trust_score conforme informações captadas
    const delta = computeTrustDelta(ai.updates);
    merged.trust_score = Math.min(10, (merged.trust_score || 0) + delta);

    // trava de fase
    const guardedStage = applyStageGuards(ai.stage, merged, intent);
    merged.stage = guardedStage;

    // Se está em cooldown, força educacao/qualificacao e bloqueia preco/agendamento
    if (inCooldown) {
      merged.mode = "educar";
      if (merged.stage === "preco" || merged.stage === "agendamento") merged.stage = "educacao";
    }

    // Ajuste extra: se está no modo educar, a resposta já vem curta,
    // mas garantimos que não empurre consulta
    let reply = ai.reply;
    if (merged.mode === "educar" && intent !== "asked_price" && intent !== "asked_schedule") {
      // se por acaso ela mencionar agendar, suaviza
      reply = reply
        .replace(/agendar|agenda|horário|horario/gi, "entender")
        .replace(/consulta/gi, "avaliação");
      reply = normalizeReply(reply, isFirstMessage);
    }

    // salva estado final
    await saveUserState(phone, merged);

    // responde via Twilio
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);

    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("❌ Erro no webhook:", err);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Tive uma instabilidade rápida aqui 🙏 Me manda de novo: o que está te incomodando mais hoje?");
    res.type("text/xml").send(twiml.toString());
  }
});

// ====== HEALTH CHECK ======
app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
