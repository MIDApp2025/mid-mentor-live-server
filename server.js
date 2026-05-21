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
  let geminiIsSpeaking = false; 
  let isGoogleReady = false; 
  let remainingMinutes = 30;
  let companyId = "YVBGbAsPAUnP3w1OZsMA"; // Oletusarvo, joka päivitetään alta

  // 📝 UUSI: Kerätään puhelun tekstitranskriptio tähän taulukkoon taustalla halpaa analyysiä varten
  let chatHistory = [];

  // 🎯 TAUSTAPALVELIMEN PUSKUROINTI
  let audioBuffer = [];
  const BUFFER_THRESHOLD = 2;

  if (userId) {
    try {
      const userDoc = await db.collection('userProfiles').doc(userId).get();
      if (userDoc.exists) {
        remainingMinutes = userDoc.data().voice_quota_remaining ?? 30;
        // Poimitaan yrityksen ID talteen, jotta se voidaan lähettää anonyymisti eteenpäin
        companyId = userDoc.data().companyId || "YVBGbAsPAUnP3w1OZsMA";
      }
      console.log("Remaining minutes:", remainingMinutes, "Company ID:", companyId);

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
    if (userId && (elapsedSeconds / 60 >= remainingMinutes)) {
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
    
    const edellinenPuheluTiivistelma = "Käyttäjän kanssa on aloitettu hyvinvointivalmennus."; 

    const systemPrompt = `
Your name is MID Mentor.
You are a highly perceptive, calm, and conversational real-time assistant.
Your role is to help the user think clearly, organize thoughts, prepare for situations, explore ideas, solve problems, and gain perspective in natural conversation.

Speak like an intelligent, grounded human being.
Be natural, conversational, sharp, and supportive without sounding scripted.

Do not act like a therapist.
Do not default to emotional support or generic wellbeing advice unless the user clearly needs it.

Avoid clichés like "take a deep breath", "go for a walk", or "listen to music".
Focus instead on: clarity, perspective, communication, preparation, decision-making, confidence, practical thinking.

Keep responses strictly short and concise, ideally 1-3 sentences max. 
This is a fast-paced live voice conversation. 
Never give long monologues, never use bullet points, and avoid sounding like a motivational speaker.

Adapt to the user's situation naturally.
Ask meaningful follow-up questions when helpful.
Challenge ideas gently when needed. Do not blindly agree with everything.

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

  // ==========================================
  // GEMINI -> FLUTTER (Ja tekstin poiminta talteen)
  // ==========================================
  geminiWs.on('message', (data) => {
    try {
      const text = data.toString();
      const parsed = JSON.parse(text);

      if (parsed.serverContent) {
        if (parsed.serverContent.modelTurn) {
          geminiIsSpeaking = true;

          // 📝 UUSI: Poimitaan Geminin oma puhe tekstinä talteen analyysiä varten
          const parts = parsed.serverContent.modelTurn.parts || [];
          parts.forEach(p => {
            if (p.text && p.text.trim().length > 0) {
              chatHistory.push({ role: 'mentor', text: p.text.trim() });
            }
          });
        }
        
        const isTurnComplete = parsed.serverContent.turnComplete === true;
        const isGenerationComplete = parsed.serverContent.generationComplete === true;
        const isInterrupted = parsed.serverContent.interrupted === true;
        
        if (isTurnComplete || isGenerationComplete || isInterrupted) {
          geminiIsSpeaking = false;
          console.log(`🤖 Gemini lopetti puheen (Turn: ${isTurnComplete}, Gen: ${isGenerationComplete}, Int: ${isInterrupted})`);
        }
      }

      // 📝 UUSI: Poimitaan käyttäjän puhe (Litterointi/Transcription) talteen, jonka Gemini tunnisti livenä
      if (parsed.serverContent && parsed.serverContent.userTurn) {
        const parts = parsed.serverContent.userTurn.parts || [];
        parts.forEach(p => {
          if (p.text && p.text.trim().length > 0) {
            chatHistory.push({ role: 'user', text: p.text.trim() });
          }
        });
      }

      if (!text.includes("inlineData")) {
        console.log("FROM GEMINI (System/Text):", text.slice(0, 300));
      }

      if (parsed.setupComplete) {
        isGoogleReady = true;
        console.log("🎤 Audio streaming enabled & setupComplete!");

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

  // ==========================================
  // FLUTTER -> GEMINI
  // ==========================================
  ws.on('message', (message) => {
    if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN || !isGoogleReady) {
      return;
    }

    try {
      const parsed = JSON.parse(message.toString());

      if (geminiIsSpeaking) {
        if (parsed.realtimeInput && parsed.realtimeInput.audio) {
          audioBuffer = []; 
          return; 
        }
      }

      if (parsed.realtimeInput && parsed.realtimeInput.audio && parsed.realtimeInput.audio.data) {
        const rawBuffer = Buffer.from(parsed.realtimeInput.audio.data, 'base64');
        audioBuffer.push(rawBuffer);

        if (audioBuffer.length >= BUFFER_THRESHOLD) {
          const combinedBuffer = Buffer.concat(audioBuffer);
          
          const optimizedMessage = {
            realtimeInput: {
              audio: {
                mimeType: "audio/pcm;rate=16000",
                data: combinedBuffer.toString('base64')
              }
            }
          };

          geminiWs.send(JSON.stringify(optimizedMessage));
          audioBuffer = []; 
        }
      } else {
        geminiWs.send(JSON.stringify(parsed));
      }

    } catch (error) {
      console.error("Virhe JSON välityksessä:", error);
    }
  });

  // ==========================================
  // PUHELUN SULKEUTUMINEN (Päivitykset + Vercel-pukku)
  // ==========================================
  ws.on('close', async () => {
    console.log("Puhelu päättyi.");
    clearInterval(quotaCheckInterval);

    const durationSeconds = (Date.now() - startTime) / 1000;
    const usedMinutes = Math.ceil(durationSeconds / 60);
    console.log("Used minutes:", usedMinutes);

    // 1. Päivitetään minuuttikiintiöt Firestoreen (Alkuperäinen koodisi)
    if (userId && usedMinutes > 0) {
      try {
        console.log("WRITING TO FIRESTORE NOW");
        const userRef = db.collection('userProfiles').doc(userId);

        await db.runTransaction(async (transaction) => {
          const sfDoc = await transaction.get(userRef);
          const currentRemaining = sfDoc.data().voice_quota_remaining ?? 30;
          const newRemaining = Math.max(0, currentRemaining - usedMinutes);

          transaction.update(userRef, {
            voice_quota_remaining: newRemaining,
          });
          console.log(`FIRESTORE WRITE SUCCESS. New balance: ${newRemaining}`);
        });
      } catch (err) {
        console.error("Quota update error:", err);
      }
    }
    
    // 2. Suljetaan Geminin WebSocket heti, jotta kallis Live Audio -laskutus katkeaa lennosta
    if (geminiWs) {
      geminiWs.close();
    }

    // 📝 3. UUSI: Lähetetään kertyneet tekstit Vercelin 'processMentorAnalysis' -funktiolle
    if (userId && chatHistory.length > 0) {
      try {
        console.log("Lähetetään transkriptio Verceliin halpaa analyysiä varten...");
        
        // Rakennetaan selkeä tekstipötkö: "Käyttäjä: Hei", "Mentor: Huomenta" jne.
        const fullTranscript = chatHistory
          .map(h => `${h.role === 'user' ? 'Käyttäjä' : 'Mentor'}: ${h.text}`)
          .join('\n');

        // HUOM: Vaihda tähän alle sinun TARKKA Vercel-projektisi osoite!
        const vercelUrl = 'https://sinun-vercel-osoitteesi.vercel.app/api/processMentorAnalysis';

        // Pukataan data taustalla Vercelille (ilman awaitia, ettei puhelun sulku viivästy!)
        fetch(vercelUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: userId,
            companyId: companyId,
            durationSeconds: Math.round(durationSeconds),
            transcript: fullTranscript
          })
        })
        .then(res => res.json())
        .then(data => console.log("✅ Vercel suoritti mentor-analyysin:", data.message || data))
        .catch(err => console.error("❌ Vercel-kutsu epäonnistui:", err));

      } catch (analError) {
        console.error("Virhe Vercel-kutsun valmistelussa:", analError);
      }
    }
  });

  geminiWs.on('close', (code, reason) => {
    console.log("Gemini sulki yhteyden.", code, reason.toString());
  });

  geminiWs.on('error', (err) => {
    console.error("Gemini virhe:", err);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Palvelin pyörii onnistuneesti portissa ${PORT}`);
});
