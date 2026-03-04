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
  // Render internal postgres às vezes funciona sem SSL; manter assim costuma dar certo
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

// ====== SIMPLE INTENT DETECTION ======
function norm(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function detectIntent(text) {
  const t = norm(text);

  const wantsPrice =
    /\b(preco|preço|valor|quanto custa|investimento|custa)\b/.test(t);

  const wantsBook =
    /\b(quero marcar|quero agendar|marcar consulta|agendar consulta|quero a consulta|quero consulta|vamos agendar|agenda|horario|horário|disponibilidade|pode marcar)\b/.test(t);

  const refuses =
    /\b(nao quero consultar|nao quero consulta|nao quero|pare|para|chega|voce esta sendo rude|rude|nao gostei|não gostei)\b/.test(t);

  const asksStartNow =
    /\b(quero comecar a tomar|quero começar a tomar|posso tomar|como tomar|dose|dosagem|quantas gotas)\b/.test(t);

  return { wantsPrice, wantsBook, refuses, asksStartNow };
}

// Captura simples de dia/hora quando o lead já pediu (ex.: "sábado 13h")
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

  // pega algo tipo "13h", "13:00", "19h", "7 da noite"
  let hour = null;
  const m1 = t.match(/\b(\d{1,2})\s*h\b/);
  const m2 = t.match(/\b(\d{1,2})\s*:\s*(\d{2})\b/);
  if (m2) hour = `${m2[1].padStart(2, "0")}:${m2[2]}`;
  else if (m1) hour = `${m1[1].padStart(2, "0")}:00`;

  return { day, hour };
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
  // Node 22 normalmente tem File global
  const guessedType = mimeType && mimeType.startsWith("audio/") ? mimeType : "audio/ogg";
  const file = new File([buffer], "audio", { type: guessedType });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
  });

  return (transcription.text || "").trim();
}

// ====== LIA V6 SYSTEM PROMPT ======
function buildSystemPromptV6() {
  return `
Você é "Lia", secretária/closer premium da equipe do Dr. Alef Kotula (consulta 100% online).
Seu trabalho é: acolher -> qualificar rápido -> gerar valor -> (quando fizer sentido) oferecer preços -> FECHAR agendamento.

PRINCÍPIOS DE OURO (obrigatório):
1) Não repita "Oi!" a cada mensagem. Só cumprimente no início.
2) Se o lead demonstrar intenção de agendar (ex.: "quero marcar", "tem horário?", "prefiro sábado 13h", "sugere um"):
   -> PARE de fazer perguntas clínicas
   -> VÁ direto para FECHAMENTO com horários e confirmação.
3) Se o lead resistir ("não quero consulta", "não gostei", "você está sendo rude"):
   -> NÃO insista em horário
   -> Peça desculpa curto, valide, e ofereça "posso te explicar como funciona" OU "posso tirar uma dúvida rápida".
4) Faça no máximo 1 pergunta por mensagem.
5) Qualificação rápida: no máximo 3 perguntas no total antes de oferecer caminho (educar / consulta / preço).
6) Dor é prioridade (maioria dos leads). Use escala 0-10 quando apropriado.

CONFORMIDADE / SEGURANÇA:
- Não prescrever dose, não recomendar marca, não orientar compra.
- Não prometer cura, não garantir resultado.
- Pode dizer: "muitos pacientes relatam melhora" + "cada caso é individual" + "a avaliação define a melhor estratégia".
- Não atacar médicos do Brasil. Use autoridade do Dr. Alef com elegância: formação na Rússia + pós internacional.
- Urgência real: se dor no peito, falta de ar, desmaio, sinais neurológicos súbitos, risco de autoagressão -> orientar emergência e ENCERRAR.

FUNIL DE CONVERSÃO (LIA V6):
A) Acolhimento humano:
   Ex: "Oi 😊 que bom que você me chamou. Me conta com calma… o que está te incomodando hoje?"
B) Qualificação premium (3 perguntas máx):
   - tempo do problema
   - intensidade 0-10 (se dor)
   - o que já tentou / impacto
C) Valor (sem exagero):
   - "Na consulta (45min) o Dr. Alef revisa histórico, entende padrão da dor e monta plano individual."
   - Use ciência apenas se aumentar confiança: números simples (%), sem prometer.
D) Preço (quando pedirem OU após aquecer):
   - Consulta 45min: R$347
   - Consulta + retorno (~30 dias): R$447 (recomendada)
   - Retorno avulso: R$200
E) Fechamento:
   - Sempre oferecer 2-3 opções de horário e pedir escolha.
   - Confirmar e orientar próximo passo (reserva + pagamento/link).

MODO "EDUCAR E CONVERTER DEPOIS" (lead frio):
- Se a dor for baixa (0-3), pouca urgência, ou pessoa só curiosa:
  -> entregue 1 mini-explicação (2-3 linhas) + 1 pergunta leve
  -> não empurre preço/agenda
  -> objetivo é manter conversa e aquecer.

MODO "QUERO COMEÇAR A TOMAR":
- Se a pessoa pedir para começar a tomar / dose:
  -> Não orientar dose nem compra.
  -> Explicar que precisa de avaliação para segurança e individualização.
  -> Convidar para consulta (sem pressão).

REGRAS DE TOM:
- Curta, humana, com escuta ativa.
- Não faça o paciente se sentir pressionado.
- Se o paciente já quer comprar, seja objetiva e resolutiva.

SAÍDA OBRIGATÓRIA:
Responda SEMPRE com JSON puro (nada fora do JSON).
Formato:
{
  "reply": "texto para enviar no WhatsApp",
  "stage": "acolhimento|qualificacao|educar|preco|agendamento|pos_agendamento|resistencia|urgencia",
  "updates": { ... }
}
`;
}

// Prompt do usuário com memória + intenção
function buildUserPromptV6({ incomingText, state, flags, slot }) {
  const memory = JSON.stringify(state || {});
  return `
MEMÓRIA (estado atual):
${memory}

MENSAGEM DO LEAD:
${incomingText}

SINAIS DETECTADOS:
${JSON.stringify(flags)}

PREFERÊNCIA DE HORÁRIO EXTRAÍDA (se existir):
${JSON.stringify(slot)}

TAREFA:
- Responder como LIA V6, seguindo o funil.
- Se flags.wantsBook = true, faça FECHAMENTO agora (sem novas perguntas clínicas).
- Se flags.refuses = true, entre em modo RESISTÊNCIA (validar, pedir desculpa curto, oferecer explicação, NÃO insistir em horário).
- Se flags.asksStartNow = true, entrar em modo SEGURANÇA (sem dose/compra) e convidar para avaliação.
- Atualize "updates" com dados novos (nome, dor_intensidade, tempo_dor, tratamentos, objeções, intenção, preferencia_horario).
`;
}

// ====== OPENAI RUN (V6) ======
async function runLiaV6({ incomingText, state, flags, slot }) {
  const system = buildSystemPromptV6();
  const user = buildUserPromptV6({ incomingText, state, flags, slot });

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
  } catch (e) {
    parsed = null;
  }

  // Fallback robusto (nunca deixar travar a conversa)
  if (!parsed || typeof parsed !== "object") {
    const fallbackReply = flags.wantsBook
      ? "Perfeito 😊 Me diga: você prefere sábado 11h, sábado 13h ou segunda 19h?"
      : "Entendi 🙏 Me conta com calma… o que está te incomodando hoje?";
    return {
      reply: fallbackReply,
      stage: flags.wantsBook ? "agendamento" : "acolhimento",
      updates: {},
    };
  }

  if (!parsed.reply) parsed.reply = "Me conta com calma… o que está te incomodando hoje?";
  if (!parsed.stage) parsed.stage = "qualificacao";
  if (!parsed.updates) parsed.updates = {};
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

    const state = await getUserState(phone);

    // Texto final (inclui transcrição, se houver)
    let finalText = incomingText;

    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0 || "";

      if (mediaUrl && mediaType.startsWith("audio")) {
        const buf = await downloadTwilioMedia(mediaUrl);
        const transcript = await transcribeAudio(buf, mediaType);
        console.log("🗣️ Transcrição:", transcript);
        finalText = transcript ? transcript : "[ÁUDIO] (não consegui transcrever)";
      } else {
        finalText = incomingText || "[MÍDIA RECEBIDA] Em uma frase: o que você precisa?";
      }
    }

    const flags = detectIntent(finalText);
    const slot = extractPreferredSlot(finalText);

    // roda IA V6
    const ai = await runLiaV6({ incomingText: finalText, state, flags, slot });

    // salvar memória (inclui stage)
    const newState = mergeState(state, ai.updates);
    newState.stage = ai.stage;

    // guardar “intenção” quando aparecer
    if (flags.wantsBook) newState.intent = "agendar";
    if (flags.wantsPrice) newState.intent = newState.intent || "preco";
    if (flags.refuses) newState.intent = "resistente";

    // guardar última mensagem para contexto
    newState.last_user_message = finalText;
    await saveUserState(phone, newState);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(ai.reply);
    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("❌ Erro no webhook:", err);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Tive uma instabilidade rápida aqui 🙏 Me manda de novo: o que está te incomodando hoje?");
    res.type("text/xml").send(twiml.toString());
  }
});

// ====== HEALTH CHECK ======
app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
