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

const CHAT_MODEL = MODEL_CHAT || "gpt-4.1"; // <-- TROQUE AQUI SE QUISER (gpt-4o, gpt-4o-mini etc)
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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

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
  if (x.length > 45 && y.length > 45 && x.slice(0, 45) === y.slice(0, 45)) return true;
  return false;
}

function hasAny(text, patterns) {
  const t = norm(text);
  return patterns.some((p) => t.includes(p));
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

  // Node 20+ geralmente tem File; se não tiver, usa Blob
  let file;
  if (typeof File !== "undefined") {
    file = new File([buffer], "audio", { type: guessedType });
  } else if (typeof Blob !== "undefined") {
    const blob = new Blob([buffer], { type: guessedType });
    blob.name = "audio";
    file = blob;
  } else {
    // fallback: não transcreve
    return "";
  }

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
  });

  return (transcription.text || "").trim();
}

// ====== INTENTS (mais forte + anti-loop) ======
function detectIntent(text) {
  const t = norm(text);

  const wantsPrice =
    /\b(preco|preço|valor|quanto custa|investimento|custa)\b/.test(t);

  const wantsBook =
    /\b(quero marcar|quero agendar|marcar consulta|agendar consulta|quero a consulta|quero consulta|vamos agendar|pode marcar|quero fechar|quero pagar)\b/.test(t);

  const asksHours =
    /\b(horarios|horario|que horas|vagas|agenda|disponibilidade|tem horario|tem horarios)\b/.test(t);

  const confirms =
    /\b(sim|ok|pode|confirmo|fechado|beleza|vamos|pode ser|serve)\b/.test(t);

  const refuses =
    /\b(nao quero|não quero|pare|para|chega|rude|grosso|nao gostei|não gostei|voce esta sendo rude|você está sendo rude)\b/.test(t);

  const declinesSlot =
    /\b(nao posso|nao da|não dá|nao consigo|esse horario nao|esse horario nao posso|outro horario|outro horário)\b/.test(t);

  const asksStartNow =
    /\b(quero comecar a tomar|quero começar a tomar|posso tomar|como tomar|dose|dosagem|quantas gotas|comecar agora)\b/.test(t);

  const urgency =
    /\b(dor no peito|falta de ar|desmaio|desmaiei|avc|convuls|paralisia|confusao|confusão|risco de me machucar)\b/.test(t);

  const asksWho =
    /\b(quem e|quem eh|quem e o dr|quem eh o dr|quem e esse doutor|quem é|quem é o dr|quem é esse doutor)\b/.test(t);

  const asksIfWorks =
    /\b(funciona|serve|e bom|é bom|ajuda|melhora)\b/.test(t);

  const focus =
    (/\b(insonia|insomnia|dormir|sono)\b/.test(t) && "insonia") ||
    (/\b(ansiedade|panico|pânico)\b/.test(t) && "ansiedade") ||
    (/\b(dor|fibromialgia|lombar|artrose|artrite|neuropat)\b/.test(t) && "dor") ||
    null;

  return { wantsPrice, wantsBook, asksHours, confirms, refuses, declinesSlot, asksStartNow, urgency, asksWho, asksIfWorks, focus };
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

// ====== EVIDENCE (TEMPLATE — você vai substituir pelo seu PDF depois) ======
const EVIDENCE = {
  insonia:
    "Para insônia, há evidências de melhora do sono em parte dos pacientes — mas varia muito conforme a causa, rotina e medicações. O ponto-chave é individualizar com segurança.",
  dor:
    "Para dor crônica (incluindo fibromialgia em alguns perfis), há estudos e muitos relatos de melhora de dor/sono quando o plano é bem individualizado e acompanhado. Não é milagre — a resposta varia.",
  ansiedade:
    "Para ansiedade, algumas pessoas relatam melhora, mas depende do tipo de ansiedade, gatilhos e medicações em uso. Por isso a avaliação é essencial para segurança e direção.",
};

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
    "Quer que eu te sugira 2 horários ainda essa semana ou prefere sábado?"
  );
}

function safetyDoseReply() {
  return "Entendi sua vontade de começar. Por segurança, eu não consigo orientar dose/como tomar por aqui 🙏 Isso depende do seu caso, medicações e objetivo. Se você quiser, eu te explico como funciona a avaliação (45 min) e te passo horários pra escolher. Você prefere manhã, tarde ou noite?";
}

function suggestSlots(preferDay) {
  if (preferDay === "sábado") return ["sábado 11h", "sábado 13h", "sábado 16h"];
  if (preferDay === "segunda") return ["segunda 13h", "segunda 18h", "terça 19h"];
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

// ====== LIA (LLM) — Só para conversa aberta + aquecimento ======
function buildSystemPromptV8() {
  return `
Você é "Lia", secretária/closer premium do Dr. Alef Kotula (consulta 100% online).
Objetivo: soar humana, gerar confiança e levar ao agendamento quando houver sinal.

REGRAS ABSOLUTAS:
- Nunca prescrever dose, nunca orientar compra, nunca recomendar marca.
- Nunca prometer cura/garantir resultado.
- Pode dizer: "muitos pacientes relatam melhora" + "cada caso é individual" + "a avaliação define a melhor estratégia".
- Não atacar médicos do Brasil.
- Se o lead pedir agendamento/horários, NÃO faça perguntas clínicas: feche.
- Se o lead resistir/ficar irritado, recue: valide + peça desculpa curto + ofereça ajudar sem pressão.
- 1 pergunta por mensagem.
- Não repetir "Oi!" toda hora.

CIÊNCIA:
- Use evidência de forma simples (2–3 linhas) e sempre com ressalva de variabilidade.
- Se mencionar números, prefira % e linguagem acessível (sem exagero).

FORMATO OBRIGATÓRIO (JSON puro):
{ "reply": "...", "updates": { ... } }
`;
}

function buildUserPromptV8({ incomingText, state, flags }) {
  const focus = flags.focus || state.focus || null;
  const evidenceText = focus ? EVIDENCE[focus] : null;

  return `
MEMÓRIA:
${JSON.stringify(state || {})}

MENSAGEM:
${incomingText}

SINAIS:
${JSON.stringify(flags)}

FOCO ATUAL:
${focus}

EVIDÊNCIA (use se ajudar, sem prometer):
${evidenceText || "N/A"}

TAREFA:
- Responder curto, humano e persuasivo (clínica premium).
- 1 pergunta no final.
- Se o lead só quer saber "se funciona", responda responsável + convide para dizer objetivo principal.
- Atualize updates com: nome(se aparecer), queixa_principal, tempo, intensidade, objeções, foco.
`;
}

async function runLiaV8({ incomingText, state, flags }) {
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.55,
    messages: [
      { role: "system", content: buildSystemPromptV8() },
      { role: "user", content: buildUserPromptV8({ incomingText, state, flags }) },
    ],
  });

  const content = resp.choices?.[0]?.message?.content?.trim() || "";
  let parsed = null;
  try { parsed = JSON.parse(content); } catch {}

  if (!parsed || typeof parsed !== "object" || !parsed.reply) {
    return { reply: "Entendi 🙂 Pra eu te orientar melhor: hoje seu foco é mais dor, sono ou ansiedade?", updates: {} };
  }

  if (!parsed.updates) parsed.updates = {};
  return parsed;
}

// ====== HUMAN DELAY + SENDING ======
function computeHumanDelay(flags, state) {
  // mais “humano”:
  // - quando é fechamento (wantsBook/asksHours) responde mais rápido
  // - quando é educação/objeção responde mais “pensando”
  let base = randInt(MIN_DELAY, MAX_DELAY);

  if (flags.wantsBook || flags.asksHours) base = randInt(3, 6);
  if (flags.wantsPrice) base = randInt(4, 7);
  if (flags.asksIfWorks) base = randInt(6, 10);
  if (flags.refuses) base = randInt(5, 9);

  // se a última resposta foi muito recente, adiciona um pouco
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
  // Responde rápido pro Twilio (não bloqueia)
  const twiml = new twilio.twiml.MessagingResponse();
  res.type("text/xml").send(twiml.toString());

  // Processa e envia via REST API com delay
  (async () => {
    try {
      const lead = req.body.From || ""; // ex: "whatsapp:+55..."
      const bot = req.body.To || "";    // seu número/sandbox do Twilio
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

      const flags = detectIntent(finalText);
      const slot = extractPreferredSlot(finalText);

      if (flags.focus) state.focus = flags.focus;

      let reply;

      // 1) URGÊNCIA
      if (flags.urgency) {
        reply = urgencyReply();
        state.booking.status = "idle";
      }
      // 2) QUEM É
      else if (flags.asksWho) {
        reply = whoReply();
      }
      // 3) RESISTÊNCIA
      else if (flags.refuses) {
        reply = "Tranquilo 🙂 Desculpa se soou pressionado. Quer que eu te explique rapidinho como funciona a avaliação ou prefere só tirar uma dúvida agora?";
        state.booking.status = "idle";
      }
      // 4) PREÇO
      else if (flags.wantsPrice) {
        reply = priceReply();
      }
      // 5) DOSE / COMEÇAR
      else if (flags.asksStartNow) {
        reply = safetyDoseReply();
      }
      // 6) AGENDAMENTO / HORÁRIOS (CLOSER HARD)
      else if (flags.wantsBook || flags.asksHours || state.booking.status === "offered") {
        // se recusou horário, alternativas
        if (flags.declinesSlot) {
          reply = bookingNeedAlternatives();
          state.booking.status = "needs_alternatives";
        }
        // se mandou slot (sábado 13h)
        else if (slot.day || slot.hour) {
          const slotStr = `${slot.day || "dia"} ${slot.hour || ""}`.trim();
          const askReserve = `Perfeito 😊 Posso reservar ${slotStr} pra você?`;
          state.booking.status = "offered";
          state.booking.proposed = slotStr;

          // anti-loop: se repetir, manda oferta com 3 opções
          reply = similar(askReserve, state.last_bot_reply) ? bookingOffer(state, slot) : askReserve;
        }
        // se confirmou depois de proposta
        else if (state.booking.status === "offered" && flags.confirms) {
          reply = bookingConfirm(state.booking.proposed || "o horário");
          state.booking.status = "confirmed";
        }
        // caso geral: 3 opções
        else {
          const offer = bookingOffer(state, slot);
          state.booking.status = "offered";
          state.booking.prefer_day = slot.day || state.booking.prefer_day || null;

          reply = similar(offer, state.last_bot_reply)
            ? "Fechado 😊 Você prefere manhã, tarde ou noite? Aí eu te mando 3 opções certeiras."
            : offer;
        }
      }
      // 7) CONVERSA ABERTA (LLM)
      else {
        const ai = await runLiaV8({ incomingText: finalText, state, flags });
        reply = ai.reply;
        state = mergeState(state, ai.updates);
      }

      // salva anti-loop e timestamps
      const delaySec = computeHumanDelay(flags, state);

      state.last_bot_reply = reply;
      state.last_user_message = finalText;
      state.last_sent_at = Date.now();

      await saveUserState(phone, state);

      // envia com delay “humano”
      await sendWhatsApp(lead, bot, reply, delaySec);

    } catch (err) {
      console.error("❌ Erro no processamento async:", err);
      // tenta mandar fallback sem quebrar
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
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
