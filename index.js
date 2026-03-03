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
  // cria registro vazio
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
  // OpenAI speech-to-text: via "audio.transcriptions.create"
  // enviamos como arquivo in-memory (buffer)
  const file = new File([buffer], "audio.ogg", { type: "audio/ogg" });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
  });

  return (transcription.text || "").trim();
}

// ====== PROMPT V4 (JSON output) ======
function buildSystemPrompt() {
  return `
Você é "Lia", secretária/closer da equipe do Dr. Alef Kotula (médico, pós em Cannabis Medicinal, atendimento 100% online).
Seu objetivo é CONVERTER em AGENDAMENTO de consulta.

Regras absolutas:
- NÃO prescrever dose, NÃO indicar marca/produto, NÃO orientar compra.
- NÃO prometer cura. Pode citar que pacientes têm bons resultados e que há evidências, com linguagem responsável.
- Se houver sinais de urgência (dor no peito, falta de ar, desmaio, sintomas neurológicos súbitos, risco de autoagressão): orientar emergência e ENCERRAR.

Estilo:
- Humana, quente, curta, com escuta ativa. Nada robótico.
- Priorize dor (maioria dos leads).
- Faça 2 a 5 perguntas curtas para qualificar.
- Use autoridade do Dr. Alef: formado na Rússia (Europa) + pós internacional (sem atacar médicos do Brasil).
- Ciência só quando aumentar confiança: use números simples (%), sem exagero.

Estratégia de preço:
- Se a pessoa pedir preço de cara: faça 2-3 perguntas rápidas antes.
- Ofereça 3 opções: Consulta 45min R$347 | Consulta + retorno (~30 dias) R$447 (recomendada) | Retorno avulso R$200.
- Use leve escassez real ("agenda costuma fechar rápido") sem mentir.

Memória:
- Sempre que descobrir: nome, queixa principal, tempo, intensidade (0-10), impacto, tratamentos prévios, objeções, preferências de horário — salve em "updates".

IMPORTANTE: Você deve responder SEMPRE em JSON puro, sem texto fora do JSON.
Formato:
{
  "reply": "texto para enviar no WhatsApp",
  "stage": "qualificacao|aquecimento|preco|agendamento|pos_agendamento|urgencia",
  "updates": { "nome": "...", "dor_intensidade": 7, "tempo_dor": "...", ... }
}
`;
}

function buildUserPrompt(incomingText, state) {
  const memory = JSON.stringify(state || {});
  return `
MEMÓRIA (estado atual do lead):
${memory}

MENSAGEM DO LEAD:
${incomingText}

Tarefa:
- Produza a melhor resposta para converter.
- Faça perguntas curtas quando necessário.
- Atualize "updates" com qualquer informação nova inferida do texto.
- Se a pessoa já estiver quente, avance para agendamento.
`;
}

// ====== OPENAI CHAT ======
async function runLia(incomingText, state) {
  const system = buildSystemPrompt();
  const user = buildUserPrompt(incomingText, state);

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.6,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const content = resp.choices?.[0]?.message?.content?.trim() || "";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // fallback seguro
    parsed = {
      reply: "Entendi 🙏 Me conta com calma… o que está te incomodando mais ultimamente?",
      stage: "qualificacao",
      updates: {},
    };
  }

  if (!parsed.reply) parsed.reply = "Me conta com calma… o que está te incomodando mais ultimamente?";
  if (!parsed.stage) parsed.stage = "qualificacao";
  if (!parsed.updates) parsed.updates = {};
  return parsed;
}

// ====== WEBHOOK ======
app.post("/whatsapp", async (req, res) => {
  try {
    const from = req.body.From || ""; // ex: "whatsapp:+55..."
    const phone = from.replace("whatsapp:", "").trim();

    const incomingText = (req.body.Body || "").trim();
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    console.log("📩 Mensagem recebida:", { phone, incomingText, numMedia });

    // busca memória
    const state = await getUserState(phone);

    // Se veio áudio/arquivo
    let finalText = incomingText;
    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0 || "";

      if (mediaUrl && mediaType.startsWith("audio")) {
        const buf = await downloadTwilioMedia(mediaUrl);
        const transcript = await transcribeAudio(buf);
        console.log("🗣️ Transcrição:", transcript);
        finalText = transcript ? `[ÁUDIO TRANSCRITO] ${transcript}` : "[ÁUDIO] (não consegui transcrever)";
      } else {
        finalText = incomingText || "[MÍDIA RECEBIDA] Pode me explicar em uma frase o que você precisa?";
      }
    }

    // roda IA
    const ai = await runLia(finalText, state);

    // salva updates
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
