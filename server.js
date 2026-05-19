const WebSocket = require('ws');
const admin = require('firebase-admin');

// Alustetaan Firebase Admin (Base64-ympäristömuuttujasta)
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8')
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const ASSISTANT_NAME = "MID Mentor";

// ✅ 1. DYNAAMINEN PROMPT-FUNKTIO (Tukee kielen vaihtoa lennosta)
const getSystemPrompt = (langCode) => {
  let primaryLanguage = "suomi (Finnish)";
  if (langCode === "en") primaryLanguage = "englanti (English)";
  if (langCode === "sv") primaryLanguage = "ruotsi (Swedish)";

  return `
Your name is ${ASSISTANT_NAME}. You must always identify yourself as ${ASSISTANT_NAME}.
You are a professional, empathetic, and supportive wellbeing and sparring coach (Mentor).
This is a live voice call with the user. Follow these strict rules:
1. Always remember your name is ${ASSISTANT_NAME} and act according to this persona.
2. Keep your responses very short and conversational (max 2-3 sentences at a time) to maintain a natural, real-time phone call flow.
3. Listen actively, detect acoustic nuances in the user's voice, and ask clarifying, supportive questions.
4. DYNAMIC LANGUAGE CODE: The user's preferred profile language is ${primaryLanguage}. Start the conversation in this language.
5. LIVE LANGUAGE SWITCHING: If the user speaks to you in ANY other language during the call, switch your language INSTANTLY to match the user's language. Always respond in the exact same language the user just used.
Never use bullet points or lists, as they sound unnatural when spoken.
`;
};

// Luodaan WebSocket-palvelin
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

wss.on('connection', async (ws, req) => {
  let userId = null;
  let geminiWs = null;
  let startTime = Date.now();
  let quotaCheckInterval = null;

  // 1. AUTH & QUOTA CHECK ALUSSA
  try {
    const urlParams = new URL(req.url, 'http://localhost').searchParams;
    const idToken = urlParams.get('token');
    
    if (!idToken) {
      ws.close(4001, "Valtuutus puuttuu");
      return;
    }

    const decodedToken = await admin.auth().verifyIdToken(idToken);
    userId = decodedToken.uid;

    const userRef = db.collection('userProfiles').doc(userId);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      ws.close(4004, "Käyttäjää ei löydy");
      return;
    }

    const userData = userDoc.data();
    
    // ✅ Luetaan käyttäjän kieli tietokannasta (oletuksena "fi")
    const userLanguage = userData.language || "fi";
    
    let remainingMinutes = userData.voice_quota_remaining !== undefined ? userData.voice_quota_remaining : 30;

    if (remainingMinutes <= 0) {
      ws.close(4003, "Kuukausittainen puheluaika käytetty loppuun");
      return;
    }

    // --- REAALIAIKAINEN KULUNVALVONTA ---
    quotaCheckInterval = setInterval(async () => {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      if (elapsedSeconds / 60 >= remainingMinutes) {
        console.log(`Käyttäjän ${userId} kiintiö loppui kesken puhelun.`);
        ws.send(JSON.stringify({ type: "error", message: "Aika loppui!" }));
        ws.close(4000, "Kiintiö täynnä");
      }
    }, 10000);

    // 2. AVATAAN SUORAN YHTEYS GEMINI LIVEEN
    geminiWs = new WebSocket(GEMINI_WS_URL);

    geminiWs.on('open', () => {
      // ✅ Kytketään dynaaminen prompti ja oikea aito Live-ääni (aoede) tähän viestiin
      const setupMessage = {
        setup: {
          model: "models/gemini-3.1-flash-live-preview",
          generationConfig: {
            responseModalities: ["audio"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "aoede" } }
            }
          },
          systemInstruction: {
            parts: [{ text: getSystemPrompt(userLanguage) }] // ✅ Prompti otetaan nyt funktiosta!
          }
        }
      };
      geminiWs.send(JSON.stringify(setupMessage));
    });

    // 3. KUUNNELLAAN GEMININ VASTAUKSIA JA VÄLITETÄÄN FLUTTERILLE
    geminiWs.on('message', (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    geminiWs.on('close', () => ws.close());
    geminiWs.on('error', (err) => console.error("Gemini WS Virhe:", err));

  } catch (error) {
    console.error("Auth/Alustusvirhe:", error);
    ws.close(4005, "Palvelinvirhe alustuksessa");
    return;
  }

  // 4. KUUNNELLAAN FLUTTERIN LÄHETTÄMÄÄ ÄÄNTÄ
  ws.on('message', (message) => {
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      try {
        const parsed = JSON.parse(message);
        if (parsed.realtimeInput) {
          geminiWs.send(JSON.stringify(parsed));
        }
      } catch (e) {
        // Binääridatan käsittely tarvittaessa
      }
    }
  });

  // 5. PUHELUN LOPETUS JA MINUUTTIEN PAREMPI PÄIVITYS FIREBASEEN
  ws.on('close', async () => {
    clearInterval(quotaCheckInterval);
    if (geminiWs) geminiWs.close();

    const durationSeconds = (Date.now() - startTime) / 1000;
    const usedMinutes = Math.ceil(durationSeconds / 60);

    if (userId && usedMinutes > 0) {
      try {
        const userRef = db.collection('userProfiles').doc(userId);
        await db.runTransaction(async (transaction) => {
          const sfDoc = await transaction.get(userRef);
          const currentRemaining = sfDoc.data().voice_quota_remaining || 30;
          const newRemaining = Math.max(0, currentRemaining - usedMinutes);
          transaction.update(userRef, { voice_quota_remaining: newRemaining });
        });
        console.log(`Puhelu päättyi. Käyttäjältä ${userId} vähennetty ${usedMinutes} minuuttia.`);
      } catch (err) {
        console.error("Virhe kiintiön päivityksessä:", err);
      }
    }
  });
});