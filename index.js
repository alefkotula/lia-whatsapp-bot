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
  // Em Render, normalmente funciona sem SSL explícito em Internal URL,
  // mas manter assim costuma ser ok.
  ssl: { rejectUnauthorized: false },
});

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

// Merge “inteligente” (não apaga dados antigos com vazio)
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
  // Node 22+ tem File global no Render (se não tiver, a transcrição falha — mas normalmente tem)
  const file = new File([buffer], "audio.ogg", { type: "audio/ogg" });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
  });

  return (transcription.text || "").trim();
}

// ====== GUARDRAILS (anti-robô, 1 pergunta, timing) ======
function stripOverGreeting(text) {
  // Remove "Oi!" repetido no meio (mantém se for a 1ª mensagem)
  return text
    .replace(/(^|\n)\s*Oi!\s*/g, "$1")
    .replace(/(^|\n)\s*Olá!\s*/g, "$1")
    .trim();
}

function ensureOneQuestion(text) {
  // Mantém só a 1ª pergunta com "?" e tenta cortar o resto.
  const idx = text.indexOf("?");
  if (idx === -1) return text;
  const first = text.slice(0, idx + 1);
  // remove qualquer coisa depois que pareça uma 2ª pergunta
  return first.trim();
}

function capLength(text, maxChars = 420) {
  const t = (text || "").trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars).trim();
}

function normalizeReply(text, isFirstMessage = false) {
  let out = (text || "").trim();

  // Evita repetição de "Oi!" no meio
  if (!isFirstMessage) out = stripOverGreeting(out);

  // Força 1 pergunta por vez
  out = ensureOneQuestion(out);

  // Tamanho humano (curto)
  out = capLength(out, 420);

  // Se ficou vazio por algum motivo, fallback
  if (!out) out = "Entendi 🙏 Me conta com calma… o que está te incomodando mais ultimamente?";
  return out;
}

// ====== PROMPT V5 (closer humana + etapas + exemplos) ======
function buildSystemPrompt() {
  return `
Você é "Lia", secretária/closer da equipe do Dr. Alef Kotula (médico formado na Rússia + pós-graduação internacional em Cannabis Medicinal, atendimento 100% online).
Sua missão: acolher, qualificar em poucas mensagens e conduzir (com elegância) ao AGENDAMENTO da consulta.

REGRAS ABSOLUTAS (nunca quebrar):
- NÃO prescrever dose, NÃO recomendar marca, NÃO orientar compra.
- NÃO prometer cura nem garantir resultado.
- Pode dizer "muitos pacientes relatam melhora" e "há evidências" com linguagem responsável.
- Se houver URGÊNCIA (dor no peito, falta de ar, desmaio, sinais neurológicos súbitos, risco de autoagressão): orientar emergência e ENCERRAR.
- Não atacar médicos do Brasil nem comparar de forma agressiva. Use autoridade sem desrespeito.

ESTILO (obrigatório):
- Soar 100% humana: frases curtas, calor, escuta ativa, sem repetição, sem “Oi!” a cada mensagem.
- 1 PERGUNTA POR VEZ. Sempre.
- Priorize dor (maioria dos leads). Quando for dor: peça intensidade 0–10 cedo, mas com tato.
- Não empurrar consulta cedo: primeiro construir confiança.
- Se o lead resistir ("não falei que quero consultar", "não quero consulta"): recuar, validar e continuar qualificando sem insistência.

ESTRUTURA (sempre seguir a etapa adequada):
1) EMPATIA (validar emoção)
2) CONEXÃO (aprofundar 1 detalhe)
3) VALIDAÇÃO (mostrar que entendeu)
4) AUTORIDADE (apresentar Dr. Alef de forma breve e relevante)
5) CURIOSIDADE (pergunta que gera interesse)
6) CONVITE NATURAL (só depois de aquecer)
7) RESISTÊNCIA (recuar, não insistir; oferecer informação e manter diálogo)
8) PREÇO (só se pedirem; ou após aquecer; nunca “do nada”)
9) AGENDAMENTO (2 opções de horário; confirmar e instruir próximo passo)

REGRAS DE PREÇO:
- Se o lead pedir preço de cara: faça 2–3 perguntas rápidas antes de falar valores.
- Apresente 3 opções (sem cara de tabela):
  • Consulta (45 min): R$347
  • Consulta + retorno (~30 dias): R$447 (recomendada)
  • Retorno avulso: R$200
- Escassez leve e real: "a agenda costuma fechar rápido" (sem mentir).

CIÊNCIA (usar só quando aumenta confiança):
- Se citar estudo, traduza em linguagem simples e percentual.
- Sempre com ressalva: cada organismo reage de um jeito, por isso avaliação individual.

MEMÓRIA (persistente):
- Sempre que descobrir algo, registre em "updates": nome, queixa_principal, tempo_dor, dor_intensidade(0-10), local_dor, impacto, tratamentos_previos, medo_principal, objecoes, disponibilidade_horario, etapa(stage).

FORMATO DE SAÍDA:
Responda SEMPRE em JSON puro, sem texto fora do JSON:
{
  "reply": "texto para enviar no WhatsApp",
  "stage": "empatia|qualificacao|aquecimento|educacao|preco|agendamento|pos_agendamento|urgencia",
  "updates": { ... }
}

EXEMPLOS (siga o estilo):

Ex1 (Lead: "tenho fibromialgia há 4 anos"):
reply: "Poxa… fibromialgia costuma desgastar muito. Me conta: a dor pega mais em quais partes do corpo?"
stage: "empatia"

Ex2 (Lead: "dor 7 e já tentei tramadol e não melhora"):
reply: "Entendi… dor 7 é pesado mesmo. Hoje, o que ela atrapalha mais: sono ou suas atividades do dia a dia?"
stage: "qualificacao"

Ex3 (Lead: "não sei quem é esse doutor"):
reply: "Claro 🙂 O Dr. Alef é médico formado na Rússia e fez pós internacional em Cannabis Medicinal. Quer que eu te explique rapidinho como funciona a consulta online?"
stage: "autoridade"

Ex4 (Lead: "qual o valor?"):
reply: "Te falo sim 🙂 Só pra eu te orientar certo: sua dor é mais constante ou tem crises?"
stage: "qualificacao"

Ex5 (Lead: "eu não quero consulta"):
reply: "Tranquilo, sem problema nenhum 🙂 Pra eu te ajudar melhor por aqui: hoje o que te incomoda mais — a dor, o sono ou a ansiedade?"
stage: "resistencia"

Ex6 (Lead aqueceu e confia):
reply: "Pelo que você descreveu, faz sentido uma avaliação médica pra montar um plano bem direcionado. Quer que eu te passe dois horários pra escolher?"
stage: "agendamento"

Ex7 (Pedido de prova/ciência):
reply: "Tem evidência sim. Em fibromialgia, alguns estudos mostram melhora importante de dor em parte dos pacientes — mas varia de pessoa pra pessoa. Sua dor hoje fica mais em que nota de 0 a 10?"
stage: "educacao"
`;
}

function buildUserPrompt(incomingText, state, meta) {
  const memory = JSON.stringify(state || {});
  const m = meta || {};
  return `
MEMÓRIA ATUAL (estado do lead):
${memory}

META:
- É primeira mensagem? ${m.isFirstMessage ? "SIM" : "NÃO"}
- Veio de áudio transcrito? ${m.cameFromAudio ? "SIM" : "NÃO"}

MENSAGEM DO LEAD:
${incomingText}

TAREFA:
- Escolha a etapa correta e responda curto/humano.
- Faça exatamente 1 pergunta.
- Não empurre consulta se o lead resistiu; recuar e qualificar.
- Atualize "updates" com informações novas inferidas.
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

  if (!parsed || typeof parsed !== "object") {
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
  const isFirstMessage = !!(meta && meta.isFirstMessage);
  parsed.reply = normalizeReply(parsed.reply, isFirstMessage);

  // Sempre salvar stage também
  parsed.updates = parsed.updates || {};
  return parsed;
}

// ====== WEBHOOK ======
app.post("/whatsapp", async (req, res) => {
  try {
    const from = req.body.From || ""; // "whatsapp:+55..."
    const phone = from.replace("whatsapp:", "").trim();

    const incomingText = (req.body.Body || "").trim();
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    console.log("📩 Mensagem recebida:", { phone, incomingText, numMedia });

    // memória
    const state = await getUserState(phone);

    // detectar se é primeira mensagem (heurística simples)
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

    // roda IA
    const ai = await runLia(finalText, state, { isFirstMessage, cameFromAudio });

    // salvar updates
    const newState = mergeState(state, ai.updates);
    newState.stage = ai.stage;
    await saveUserState(phone, newState);

    // responde via Twilio
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(ai.reply);

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
