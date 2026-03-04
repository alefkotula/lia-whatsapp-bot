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

// ====== NORMALIZERS ======
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
  // similaridade bem simples por containment
  return x.includes(y) || y.includes(x) || (x.length > 40 && y.length > 40 && x.slice(0, 40) === y.slice(0, 40));
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
  const file = new File([buffer], "audio", { type: guessedType });
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
  });
  return (transcription.text || "").trim();
}

// ====== INTENTS ======
function detectIntent(text) {
  const t = norm(text);

  const wantsPrice = /\b(preco|preço|valor|quanto custa|investimento|custa)\b/.test(t);

  const wantsBook =
    /\b(quero marcar|quero agendar|marcar consulta|agendar consulta|quero a consulta|quero consulta|vamos agendar|pode marcar)\b/.test(t);

  const asksHours =
    /\b(horarios|horario|horas|que horas|vagas|agenda|disponibilidade|tem horario|tem horarios)\b/.test(t);

  const refuses =
    /\b(nao quero|pare|para|chega|voce esta sendo rude|rude|nao gostei|não gostei)\b/.test(t);

  const declinesSlot =
    /\b(nao posso|nao da|nao consigo|esse horario nao|esse horario nao posso|nao)\b/.test(t);

  const asksStartNow =
    /\b(quero comecar a tomar|posso tomar|como tomar|dose|dosagem|quantas gotas|comecar agora)\b/.test(t);

  const urgency =
    /\b(dor no peito|falta de ar|desmaio|desmaiei|avc|convuls|paralisia|confusao|confusão)\b/.test(t);

  const asksWho =
    /\b(quem e|quem eh|quem e o dr|quem eh o dr|quem e esse doutor)\b/.test(t);

  // foco/tema (evita “fibromialgia fantasma”)
  const focus =
    (/\b(insonia|insomnia|dormir|sono)\b/.test(t) && "insonia") ||
    (/\b(ansiedade|panico|pânico)\b/.test(t) && "ansiedade") ||
    (/\b(dor|fibromialgia|lombar|artrose|artrite|neuropat)\b/.test(t) && "dor") ||
    null;

  return { wantsPrice, wantsBook, asksHours, refuses, declinesSlot, asksStartNow, urgency, asksWho, focus };
}

// Captura simples de dia/hora quando o lead fala (ex.: "sábado 13h")
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

// ====== EVIDENCE LIBRARY (placeholder — você vai trocar pelo PDF depois) ======
const EVIDENCE = {
  insomnia: "Para sono/insônia, há estudos mostrando melhora de qualidade do sono em parte dos pacientes, mas o resultado varia bastante. O mais importante é avaliar causa da insônia, histórico e medicações para montar uma estratégia segura.",
  pain: "Para dor crônica, há evidências de melhora de dor e sono em alguns perfis, especialmente quando o plano é individualizado. Não é milagre — funciona melhor quando a gente acerta indicação, dose e acompanhamento.",
  anxiety: "Para ansiedade, alguns pacientes relatam melhora, mas depende do quadro (ansiedade, pânico, depressão), de medicações em uso e do acompanhamento. Por isso a avaliação é essencial para segurança.",
};

// ====== DETERMINISTIC HANDLERS (Closer Premium) ======
function urgencyReply() {
  return "Entendi. Pela sua mensagem, isso pode precisar de avaliação URGENTE. Procure um pronto atendimento agora (ou SAMU 192). Assim que estiver seguro(a), me chama aqui.";
}

function whoReply() {
  return "Sou a Lia, secretária da equipe do Dr. Alef Kotula 🙂 Médico (formado na Rússia) com pós-graduação em Cannabis Medicinal, atendimento 100% online. Quer que eu te explique em 30s como funciona a consulta?";
}

function priceReply(state) {
  // 1 pergunta no final
  return (
    "Perfeito — te passo os valores e você vê se faz sentido 😊\n" +
    "• Consulta online (45 min): R$347\n" +
    "• Consulta + retorno (~30 dias): R$447 (recomendada)\n" +
    "• Retorno avulso: R$200\n" +
    "Quer que eu te sugira 2 horários ainda essa semana ou prefere sábado?"
  );
}

function safetyDoseReply() {
  return "Entendi sua vontade de começar. Por segurança, eu não consigo orientar dose/como tomar por aqui 🙏 Isso depende do seu caso, medicações e objetivos. Se você quiser, eu te explico como funciona a avaliação (45 min) e te passo horários pra escolher. Prefere manhã, tarde ou noite?";
}

// gera 3 opções sempre (evita “travamento”)
function suggestSlots(preferDay) {
  // você pode plugar sua agenda real depois; por enquanto é “template”
  if (preferDay === "sábado") return ["sábado 11h", "sábado 13h", "sábado 16h"];
  if (preferDay === "segunda") return ["segunda 13h", "segunda 18h", "terça 19h"];
  return ["terça 19h", "quinta 13h", "sábado 11h"];
}

function bookingOffer(state, slot) {
  const options = suggestSlots(slot?.day || state?.booking?.prefer_day);
  return `Perfeito 😊 Tenho essas opções: ${options.join(" / ")}. Qual você prefere?`;
}

function bookingConfirm(slotStr) {
  return `Fechado ✅ Vou reservar ${slotStr}. Pra confirmar, me diga por favor: seu nome completo e e-mail (pra eu te enviar o link e as orientações).`;
}

function bookingNeedAlternatives() {
  return "Sem problema 🙂 Você prefere manhã, tarde ou noite? Se me disser isso, eu te mando 3 opções certeiras.";
}

// ====== LIA V7 SYSTEM PROMPT (IA só para conversa, sem “inventar”) ======
function buildSystemPromptV7() {
  return `
Você é "Lia", secretária/closer premium do Dr. Alef Kotula (consulta 100% online).
Objetivo: acolher -> esclarecer -> gerar confiança -> converter em agendamento quando houver sinal.

REGRAS ABSOLUTAS:
- Nunca prescrever dose, nunca orientar compra, nunca recomendar marca.
- Nunca prometer cura/garantia.
- Nunca citar uma condição específica (ex.: fibromialgia) se o lead NÃO mencionou isso na conversa/memória.
- Se o lead pedir horário/agendamento, NÃO faça perguntas clínicas: apenas feche.
- 1 pergunta por mensagem. Mensagens curtas, humanas.

Quando perguntarem "serve pra X? é bom pra X?":
- Responda de forma responsável (sem prometer), com 2-3 linhas e 1 pergunta: "qual seu objetivo principal hoje?"

FORMATO OBRIGATÓRIO (JSON puro):
{ "reply": "...", "updates": { ... } }
`;
}

function buildUserPromptV7({ incomingText, state, flags }) {
  return `
MEMÓRIA:
${JSON.stringify(state || {})}

MENSAGEM:
${incomingText}

SINAIS:
${JSON.stringify(flags)}

EVIDÊNCIA (use só se ajudar, sem prometer):
- sono/insônia: ${EVIDENCE.insomnia}
- dor: ${EVIDENCE.pain}
- ansiedade: ${EVIDENCE.anxiety}

TAREFA:
- Responder curto e humano.
- 1 pergunta no final.
- Atualizar updates com: focus, queixa_principal, objecoes, etc.
`;
}

async function runLiaV7({ incomingText, state, flags }) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.5,
    messages: [
      { role: "system", content: buildSystemPromptV7() },
      { role: "user", content: buildUserPromptV7({ incomingText, state, flags }) },
    ],
  });

  const content = resp.choices?.[0]?.message?.content?.trim() || "";
  let parsed = null;
  try { parsed = JSON.parse(content); } catch {}

  if (!parsed || typeof parsed !== "object" || !parsed.reply) {
    return { reply: "Entendi 🙂 Pra eu te orientar melhor: hoje seu foco é sono, dor ou ansiedade?", updates: {} };
  }

  if (!parsed.updates) parsed.updates = {};
  return parsed;
}

// ====== WEBHOOK ======
app.post("/whatsapp", async (req, res) => {
  try {
    const from = req.body.From || "";
    const phone = from.replace("whatsapp:", "").trim();

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

    const flags = detectIntent(finalText);
    const slot = extractPreferredSlot(finalText);

    // atualiza foco se detectar (evita “fibromialgia fantasma”)
    if (flags.focus) state.focus = flags.focus;

    // 1) URGÊNCIA
    if (flags.urgency) {
      const reply = urgencyReply();
      state.last_bot_reply = reply;
      await saveUserState(phone, state);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      return res.type("text/xml").send(twiml.toString());
    }

    // 2) QUEM É
    if (flags.asksWho) {
      const reply = whoReply();
      state.last_bot_reply = reply;
      await saveUserState(phone, state);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      return res.type("text/xml").send(twiml.toString());
    }

    // 3) RESISTÊNCIA
    if (flags.refuses) {
      const reply = "Tranquilo 🙂 Sem pressão. Quer que eu te explique rapidinho como funciona a avaliação ou prefere só tirar uma dúvida agora?";
      state.booking.status = "idle";
      state.last_bot_reply = reply;
      await saveUserState(phone, state);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      return res.type("text/xml").send(twiml.toString());
    }

    // 4) PEDIU PREÇO
    if (flags.wantsPrice) {
      const reply = priceReply(state);
      state.last_bot_reply = reply;
      await saveUserState(phone, state);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      return res.type("text/xml").send(twiml.toString());
    }

    // 5) QUER COMEÇAR / DOSE
    if (flags.asksStartNow) {
      const reply = safetyDoseReply();
      state.last_bot_reply = reply;
      await saveUserState(phone, state);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      return res.type("text/xml").send(twiml.toString());
    }

    // 6) HORÁRIOS / AGENDAMENTO (CLOSER HARD)
    if (flags.wantsBook || flags.asksHours || state.booking.status === "offered") {
      // Se usuário recusou horário, oferecer alternativas (NÃO explicar consulta)
      if (flags.declinesSlot) {
        const reply = bookingNeedAlternatives();
        state.booking.status = "needs_alternatives";
        state.last_bot_reply = reply;
        await saveUserState(phone, state);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(reply);
        return res.type("text/xml").send(twiml.toString());
      }

      // Se ele mandou um slot específico (segunda 13h, sábado 13h)
      if (slot.day || slot.hour) {
        const slotStr = `${slot.day || "dia"} ${slot.hour || ""}`.trim();
        const reply = `Perfeito 😊 Posso reservar ${slotStr} pra você?`;
        state.booking.status = "offered";
        state.booking.proposed = slotStr;
        // anti-loop
        if (similar(reply, state.last_bot_reply)) {
          const alt = bookingOffer(state, slot);
          state.last_bot_reply = alt;
          await saveUserState(phone, state);
          const twiml = new twilio.twiml.MessagingResponse();
          twiml.message(alt);
          return res.type("text/xml").send(twiml.toString());
        }
        state.last_bot_reply = reply;
        await saveUserState(phone, state);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(reply);
        return res.type("text/xml").send(twiml.toString());
      }

      // Se respondeu "sim" depois de proposta
      const t = norm(finalText);
      if (state.booking.status === "offered" && /\b(sim|ok|pode|confirmo)\b/.test(t)) {
        const reply = bookingConfirm(state.booking.proposed || "o horário");
        state.booking.status = "confirmed";
        state.last_bot_reply = reply;
        await saveUserState(phone, state);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(reply);
        return res.type("text/xml").send(twiml.toString());
      }

      // Caso geral: oferecer 3 opções e pedir escolha
      const reply = bookingOffer(state, slot);
      state.booking.status = "offered";
      state.booking.prefer_day = slot.day || state.booking.prefer_day || null;

      // anti-loop
      const finalReply = similar(reply, state.last_bot_reply)
        ? "Fechado 😊 Me diga: você prefere manhã, tarde ou noite? Aí eu te mando 3 opções certeiras."
        : reply;

      state.last_bot_reply = finalReply;
      await saveUserState(phone, state);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(finalReply);
      return res.type("text/xml").send(twiml.toString());
    }

    // 7) CONVERSA NORMAL (IA)
    const ai = await runLiaV7({ incomingText: finalText, state, flags });
    const newState = mergeState(state, ai.updates);
    // sempre salva last_bot_reply pra anti-loop
    newState.last_bot_reply = ai.reply;

    await saveUserState(phone, newState);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(ai.reply);
    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("❌ Erro no webhook:", err);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Tive uma instabilidade rápida aqui 🙏 Me manda de novo: seu foco hoje é sono, dor ou ansiedade?");
    res.type("text/xml").send(twiml.toString());
  }
});

// ====== HEALTH CHECK ======
app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
