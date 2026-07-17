const http = require('http');
const WebSocket = require('ws');
const admin = require('firebase-admin');
const { verifyEmployeeAccess } = require("./verifyEmployeeAccess");

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
  console.log("Puhelin yrittää yhdistää. Aloitetaan Token-tarkistus...");
  let geminiWs = null; // Avataan Gemini-yhteys vasta kun token on validoitu!
  
  const url = new URL(req.url, `http://${req.headers.host}`);
  const userId = url.searchParams.get('userId');
  const idToken = url.searchParams.get('token'); // 🔑 Poimitaan frontista tullut Firebase Token
  ws.clientType = url.searchParams.get('client') || 'native';

  // 🛡️ TIETOTURVAMUURI 1: Tarkistetaan, että molemmat tiedot löytyvät pyynnöstä
  if (!userId || !idToken) {
    console.log("❌ Yhteys hylätty: userId tai token puuttuu pyynnöstä.");
    ws.close(4001, "Unauthorized: Missing credentials");
    return;
  }

  try {
    // 🛡️ TIETOTURVAMUURI 2: Validoidaan token suoraan Firebasen kautta
    console.log("Verifioidaan Firebase idToken...");
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    
    // 🛡️ TIETOTURVAMUURI 3: Varmistetaan, että token kuuluu juuri sille käyttäjälle, joka väittää soittavansa
    if (decodedToken.uid !== userId) {
      console.log(`❌ Yhteys hylätty: Tokenin UID (${decodedToken.uid}) ei täsmää annettuun userId-arvoon (${userId})!`);
      ws.close(4003, "Unauthorized: Identity mismatch");
      return;
    }

    console.log(`✅ Token hyväksytty! Käyttäjä ${userId} on tunnistettu onnistuneesti.`);
    
    // Tallennetaan vahvistetut tiedot turvallisesti ws-olioon muistiin
    ws.userId = userId;
    ws.companyId = "YVBGbAsPAUnP3w1OZsMA"; // Oletusarvo, päivitetään alla

  } catch (authError) {
    console.error("❌ Firebase Token-varmistus epäonnistui (Token vanhentunut tai väärä):", authError.message);
    ws.close(4002, "Unauthorized: Invalid or expired token");
    return;
  }

   // --- TÄSTÄ ETEENPÄIN KÄYTTÄJÄ ON REHELLINEN JA TURVALLINEN ---

  // 🔐 AI consent gate
  // User must accept AI data processing before live mentor audio is handled.
  try {
    const consentSnap = await db.collection('userProfiles').doc(ws.userId).get();
    const consentData = consentSnap.exists ? consentSnap.data() : null;

    if (consentData?.aiChatConsentAccepted !== true) {
      console.log(`❌ Mentor-yhteys hylätty: AI consent puuttuu käyttäjältä ${ws.userId}`);
      ws.close(4004, "AI consent required");
      return;
    }
  } catch (consentError) {
    console.error("❌ AI consent tarkistus epäonnistui:", consentError.message);
    ws.close(4005, "AI consent check failed");
    return;
  }
// 🔐 Access code + subscription gate
try {
  await verifyEmployeeAccess(ws.userId);
} catch (err) {
  console.error("❌ Mentor-yhteys hylätty:", err.message);
  ws.close(4006, err.message);
  return;
}
  // Avataan yhteys Geminiin vasta nyt, kun tiedämme kuka linjoilla on


  const startTime = Date.now();
  let quotaCheckInterval = null;
  let geminiIsSpeaking = false; 
  let isGoogleReady = false; 
  let remainingMinutes = 30;
let latestConversationSummary = "";
  let idleTimer = null;
  let audioBuffer = [];
  let previousMemoryContext = "Käyttäjän kanssa on aloitettu hyvinvointivalmennus.";
  const BUFFER_THRESHOLD = 2;

  // Haetaan loput tiedot Firestoresta (Tämä lohko pysyy samana, mutta käyttää varmistettua ws.userId:tä)
 try {
    const userDoc = await db.collection('userProfiles').doc(ws.userId).get();
    if (userDoc.exists) {
      remainingMinutes = userDoc.data().voice_quota_remaining ?? 30;
      ws.companyId = userDoc.data().companyId || "YVBGbAsPAUnP3w1OZsMA";
      
      const memoryContext = userDoc.data().mentor_context;
const memoryKeywords = userDoc.data().mentor_keywords;

    let latestMoodContext = "";

try {
  const snapshotDoc = await db
    .collection("userAISnapshots")
    .doc(ws.userId)
    .get();

  if (snapshotDoc.exists) {
    const snapshotData = snapshotDoc.data();

    const updatedAt = snapshotData.updated_at
      ? new Date(snapshotData.updated_at)
      : null;

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Käytetään vain jos snapshot on tuore
    if (updatedAt && updatedAt >= sevenDaysAgo) {
      latestMoodContext = `
Recent wellbeing snapshot:
- Mood average: ${snapshotData.mood_avg ?? "N/A"}
- Mood trend: ${snapshotData.mood_trend ?? "N/A"}
- Motivation average: ${snapshotData.motivation_avg ?? "N/A"}
- Motivation trend: ${snapshotData.motivation_trend ?? "N/A"}
- Resilience average: ${snapshotData.resilience_avg ?? "N/A"}
- Resilience trend: ${snapshotData.resilience_trend ?? "N/A"}
- Teamwork average: ${snapshotData.teamwork_avg ?? "N/A"}
- Teamwork trend: ${snapshotData.teamwork_trend ?? "N/A"}
- Context tags: ${(snapshotData.context_tags || []).join(", ")}
- Confidence level: ${snapshotData.confidence_level ?? "N/A"}
`;
    }
  }
} catch (err) {
  console.error("Snapshot context fetch error:", err);
}

if (memoryContext) {
  previousMemoryContext = memoryContext;
}
      
if (latestMoodContext) {
  previousMemoryContext += latestMoodContext;
}
      
if (memoryKeywords && Array.isArray(memoryKeywords)) {
  previousMemoryContext += ` Aiemmat avainsanat: ${memoryKeywords.join(', ')}.`;
}
    }
    console.log("Remaining minutes:", remainingMinutes, "Company ID:", ws.companyId);

    if (remainingMinutes <= 0) {
      ws.close(4003, "No minutes remaining");
      return;
    }
  } catch (err) {
    console.error("Quota read error:", err);
  }

   geminiWs = new WebSocket(GEMINI_WS_URL);

  // Nyt kaikki tämä koodi on "connection"-funktion sisällä:
  quotaCheckInterval = setInterval(() => {
    // KÄYTÄ ws.userId TÄSSÄ:
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    if (ws.userId && (elapsedSeconds / 60 >= remainingMinutes)) {
      ws.close(4000, "Quota exceeded");
    }
  }, 10000);
  
geminiWs.on('open', () => {
    console.log("Yhteys Google Gemini 3.1 Liveen avattu. Odotetaan 300ms setupia...");
    
    // Lisätään pieni viive, jotta Google-yhteys ehtii "asettua"
    setTimeout(() => {
        const edellinenPuheluTiivistelma = previousMemoryContext;

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

Possible lightweight background context from earlier conversations.
Use it only as soft context, never assume the situation is still current unless the user confirms it:
${edellinenPuheluTiivistelma}
If recent wellbeing context exists, briefly acknowledge it naturally early in the conversation.
If you reference earlier conversations, do it briefly and naturally at the beginning of the session, then allow the user to guide the direction of the conversation freely.
`;
    
        const setupMessage = {
          setup: {
            model: "models/gemini-3.1-flash-live-preview",
            generationConfig: {
              responseModalities: ["AUDIO"],
              
  inputAudioTranscription: {},

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
        console.log("Setup lähetetty viiveellä.");
    }, 500);
  });

  // ==========================================
  // GEMINI -> FLUTTER (Ja tekstin poiminta talteen)
  // ==========================================
  geminiWs.on('message', (data) => {
    try {
      const text = data.toString();
      const parsed = JSON.parse(text);
      console.log(JSON.stringify(parsed, null, 2));

      if (parsed.serverContent) {
        if (
  parsed.serverContent.inputTranscription &&
  parsed.serverContent.inputTranscription.text
) {
  latestConversationSummary +=
    parsed.serverContent.inputTranscription.text + " ";
          
          clearTimeout(idleTimer);

idleTimer = setTimeout(() => {
  console.log("⏰ Idle timeout - puhelu suljetaan");
  ws.close(4000, "Idle timeout");
}, 120000);
}
        if (parsed.serverContent.modelTurn) {
  geminiIsSpeaking = true;
}
        
        const isTurnComplete = parsed.serverContent.turnComplete === true;
        const isGenerationComplete = parsed.serverContent.generationComplete === true;
        
        
       if (isTurnComplete || isGenerationComplete) {
  geminiIsSpeaking = false;
}
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

     if (geminiIsSpeaking && ws.clientType === "native") {
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
  // GEMINI STRUCTURAL LISTENERS (Turvalliset paikat)
  // ==========================================
  geminiWs.on('close', (code, reason) => {
    console.log("Gemini sulki yhteyden taustalla.", code, reason.toString());
  });

  geminiWs.on('error', (err) => {
    console.error("Gemini-rajapintavirhe havaittu:", err);
  });

  // ==========================================
  // PUHELUN SULKEUTUMINEN (Päivitykset + Vercel-pukku)
  // ==========================================
  ws.on('close', async () => {
    console.log(`🔴 Puhelu päättyi. Aloitetaan sulkuprosessit käyttäjälle: ${ws.userId || 'Tuntematon'}`);
    clearInterval(quotaCheckInterval);
    clearTimeout(idleTimer);

    const durationSeconds = (Date.now() - startTime) / 1000;
    const usedMinutes = Math.ceil(durationSeconds / 60);
    console.log("Used minutes:", usedMinutes);

    // 1. Päivitetään minuuttikiintiöt Firestoreen
    if (ws.userId && usedMinutes > 0) {
      try {
        console.log("WRITING TO FIRESTORE NOW");
        const userRef = db.collection('userProfiles').doc(ws.userId);

        await db.runTransaction(async (transaction) => {
          const sfDoc = await transaction.get(userRef);
          if (!sfDoc.exists) return; // Turvatarkistus
          
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
    
    // 2. Suljetaan Geminin WebSocket heti
    if (geminiWs) {
      geminiWs.close();
    }

    // 3. Lähetetään tiedot Vercelille (Käytetään ws.userId ja ws.companyId)
    if (ws.userId) {
      try {
        console.log("🔍 Valmistellaan Vercel-kutsua...");
        
        const fullTranscript =
  latestConversationSummary.trim().length > 0
    ? latestConversationSummary.trim()
    : `Käyttäjä kävi ${Math.round(durationSeconds)} sekunnin mittaisen mentor-äänipuhelun sovelluksessa.`;

        const vercelUrl = 'https://www.midconsulting.io/api/processMentorAnalysis';
        console.log("🚀 Puskettaan analyysipyyntö osoitteeseen:", vercelUrl);
        
        // Huom: Varmista että ws.companyId on asetettu yhteyden alussa
        fetch(vercelUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: ws.userId,
            companyId: ws.companyId || "YVBGbAsPAUnP3w1OZsMA",
            durationSeconds: Math.round(durationSeconds),
            transcript: fullTranscript
          })
        })
        .then(async (res) => {
          console.log(`📡 Vercel vastasi HTTP-statuksella: ${res.status}`);
          if (res.ok) {
            const data = await res.json();
            console.log("✅ Vercel-analyysin lopputulos:", data);
          }
        })
        .catch(err => console.error("❌ Itse fetch-verkkopyyntö Verceliin epäonnistui:", err));

      } catch (analError) {
        console.error("❌ Virhe Vercel-kutsun suorituksessa:", analError);
      }
    } else {
      console.log("⚠️ Vercel-kutsua ei tehty, koska ws.userId puuttuu.");
    }
  });

}); // <-- wss.on('connection') sulkeutuu siististi täällä kaikkien alitapahtumien jälkeen!

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Palvelin pyörii onnistuneesti portissa ${PORT}`);
});
