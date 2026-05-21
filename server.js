const http = require('http');
const WebSocket = require('ws');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('MID Mentor Live Server is Running\n');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', async (ws, req) => {
  console.log("Puhelin yhdisti palvelimelle! Avataan yhteys Geminiin...");
  let geminiWs = new WebSocket(GEMINI_WS_URL);
  const url = new URL(req.url, `http://${req.headers.host}`);
const userId = url.searchParams.get('userId');

const startTime = Date.now();

let quotaCheckInterval = null;
  
  let isGoogleReady = false; 
  let remainingMinutes = 30;

if (userId) {
  try {
    const userDoc = await db.collection('userProfiles').doc(userId).get();

    if (userDoc.exists) {
      remainingMinutes =
        userDoc.data().voice_quota_remaining ?? 30;
    }

    console.log("Remaining minutes:", remainingMinutes);

    if (remainingMinutes <= 0) {
      ws.close(4003, "No minutes remaining");
      return;
    }
  } catch (err) {
    console.error("Quota read error:", err);
  }
}
quotaCheckInterval = setInterval(() => {
  const elapsedSeconds = (Date.now() - startTime) / 1000;

  if (elapsedSeconds / 60 >= remainingMinutes) {
    console.log(`User ${userId} quota exceeded`);

    ws.send(
      JSON.stringify({
        type: "error",
        message: "Voice minutes exhausted"
      })
    );

    ws.close(4000, "Quota exceeded");
  }
}, 10000);
geminiWs.on('open', () => {
    console.log("Yhteys Google Gemini 3.1 Liveen avattu. Lähetetään setup...");
    
    // 🧠 PALAUTE EDELLESEN PUHELUN ASIASTA (Paikka Firebasen datalle)
    const edellinenPuheluTiivistelma = "Käyttäjän kanssa on aloitettu hyvinvointivalmennus."; 

    const systemPrompt = `
Your name is MID Mentor.

You are a highly perceptive, calm, and conversational real-time assistant.

Your role is to help the user think clearly, organize thoughts, prepare for situations, explore ideas, solve problems, and gain perspective in natural conversation.

Speak like an intelligent, grounded human being.
Be natural, conversational, sharp, and supportive without sounding scripted.

Do not act like a therapist.
Do not default to emotional support or generic wellbeing advice unless the user clearly needs it.

Avoid clichés like:
- "take a deep breath"
- "go for a walk"
- "listen to music"

Focus instead on:
- clarity
- perspective
- communication
- preparation
- decision-making
- confidence
- practical thinking

Keep responses strictly short and concise, ideally 1-3 sentences max. 
This is a fast-paced live voice conversation. 
Never give long monologues, never use bullet points, and avoid sounding like a motivational speaker.

Adapt to the user's situation naturally:
- sometimes practical
- sometimes reflective
- sometimes strategic
- sometimes simply conversational

Ask meaningful follow-up questions when helpful.
Challenge ideas gently when needed.
Do not blindly agree with everything.

Never mention AI, NLP, coaching frameworks, or psychological methodologies.

Detect the user's language immediately and continue fully in that language.

Previous session context:
${edellinenPuheluTiivistelma}
`;
    
    const setupMessage = {
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "aoede" } }
          }
        },
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        }
      }
    };
    
    geminiWs.send(JSON.stringify(setupMessage));
  });

  // Gemini -> Flutter
  // Gemini -> Flutter
  // Gemini -> Flutter
  // Gemini -> Flutter
  geminiWs.on('message', (data) => {
    try {
      const text = data.toString();
      
      // Tulostetaan teksti VAIN jos se EI sisällä raakaa audiodataa (säästää lokeja)
      if (!text.includes("inlineData")) {
        console.log("FROM GEMINI (System/Text):", text.slice(0, 300));
      }

      const parsed = JSON.parse(text);
      if (parsed.setupComplete) {
        isGoogleReady = true;
        console.log("🎤 Audio streaming enabled & setupComplete!");


        // 🔥 PAKOTETAAN GEMINI ALOITTAMAAN PUHELU ITSE (Keskeytykset estetty alussa)
        const kaynnistysViesti = {
          clientContent: {
            turns: [{
              role: "user",
              parts: [{ text: "Hello! Please greet the user and start the session now in their language. Do not let the user interrupt this very first greeting." }]
            }],
            turnComplete: true
          }
        };
        geminiWs.send(JSON.stringify(kaynnistysViesti));
        console.log("🤖 Käynnistyskäsky lähetetty Geminiin. Gemini aloittaa puhelun!");
      }
    } catch (_) {}
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
  // Flutter -> Gemini
  ws.on('message', (message) => {
    if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN || !isGoogleReady) {
      return;
    }

    try {
      const parsed = JSON.parse(message.toString());
      geminiWs.send(JSON.stringify(parsed));
    } catch (error) {
      console.error("Virhe JSON välityksessä:", error);
    }
  });

  ws.on('close', async () => {
  console.log("Puhelu päättyi.");

  clearInterval(quotaCheckInterval);

  if (geminiWs) {
    geminiWs.close();
  }

  const durationSeconds = (Date.now() - startTime) / 1000;

  const usedMinutes = Math.ceil(durationSeconds / 60);

  console.log("Used minutes:", usedMinutes);

  if (userId && usedMinutes > 0) {
    try {
      const userRef = db.collection('userProfiles').doc(userId);

      await db.runTransaction(async (transaction) => {
        const sfDoc = await transaction.get(userRef);

        const currentRemaining =
          sfDoc.data().voice_quota_remaining ?? 30;

        const newRemaining = Math.max(
          0,
          currentRemaining - usedMinutes
        );

        transaction.update(userRef, {
          voice_quota_remaining: newRemaining,
        });

        console.log(
          `Updated remaining minutes: ${newRemaining}`
        );
      });
    } catch (err) {
      console.error("Quota update error:", err);
    }
  }
});

  geminiWs.on('close', (code, reason) => {
    console.log("Gemini sulki yhteyden.");
    console.log("CODE:", code);
    console.log("REASON:", reason.toString());
  });

  geminiWs.on('error', (err) => {
    console.error("Gemini virhe:", err);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Palvelin pyörii onnistuneesti portissa ${PORT}`);
});
