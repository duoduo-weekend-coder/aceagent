/**
 * AceAgent Backend Server
 *
 * Dependencies:
 *   npm install express ws twilio @google/genai dotenv nodemailer
 */

const path    = require('path');
const express = require('express');
const WebSocket = require('ws');
const Twilio = require('twilio');
const { GoogleGenAI, Modality, Type } = require('@google/genai');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const http = require('http');

dotenv.config();

// Keep the process alive if a per-call error slips through
process.on('uncaughtException',    err    => console.error('[Server] Uncaught exception:',    err.message));
process.on('unhandledRejection',   reason => console.error('[Server] Unhandled rejection:',   reason));

// ---------------------------------------------------------------------------
// Auto-detect public base URL (ngrok tunnel or BASE_URL env var).
// Used as the TwiML callback URL so Twilio can reach this server.
// ---------------------------------------------------------------------------
async function detectBaseUrl(reqHost) {
    if (process.env.BASE_URL) return process.env.BASE_URL;
    try {
        const res  = await fetch('http://127.0.0.1:4040/api/tunnels');
        const json = await res.json();
        const tls  = json.tunnels?.find(t => t.proto === 'https');
        if (tls?.public_url) {
            console.log(`[Config] Auto-detected ngrok URL: ${tls.public_url}`);
            return tls.public_url;
        }
    } catch {}
    // Fall back to the Host header (works when deployed behind a real domain)
    const proto = (reqHost.includes('localhost') || reqHost.includes('127.0.0.1')) ? 'http' : 'https';
    return `${proto}://${reqHost}`;
}

const app = express();
const port = process.env.PORT || 8080;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enable CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// --- STATE MANAGEMENT ---
// Maps CallSid -> { frontendWs: WebSocket | null, context: any }
const callSessions = new Map();

// --- CONFIGURATION CHECKS ---
let twilioClient;
try {
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        twilioClient = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    } else {
        console.warn("Twilio credentials missing in .env");
    }
} catch (e) {
    console.error("Twilio Init Error:", e);
}

const GOOGLE_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;
if (!GOOGLE_API_KEY) {
    console.error("❌ GEMINI_API_KEY missing in .env file");
}

const MAX_CALL_DURATION_MS = 10 * 60 * 1000; // 10 minutes cost guard

// --- EMAIL ---
async function sendCallSummaryEmail(email, transcript, booked, bookingDetails) {
    if (!email || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) return;
    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        const subject = booked
            ? 'AceAgent – Tennis Court Booking Confirmed!'
            : 'AceAgent – Call Summary (No Booking Made)';

        const lines = [];
        if (booked && bookingDetails) {
            lines.push('✅ Booking confirmed!\n');
            lines.push(`Day:   ${bookingDetails.confirmedDay}`);
            lines.push(`Time:  ${bookingDetails.confirmedTime}`);
            if (bookingDetails.courtNumber) lines.push(`Court: ${bookingDetails.courtNumber}`);
            lines.push('');
        } else {
            lines.push('ℹ️ The call ended without a confirmed booking.\n');
        }

        lines.push('── Call Log ──────────────────────────────');
        for (const entry of transcript) {
            lines.push(`[${entry.role}] ${entry.message}`);
        }

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject,
            text: lines.join('\n')
        });
        console.log(`[Email] Call summary sent to ${email}`);
    } catch (err) {
        console.error('[Email] Failed to send:', err.message);
    }
}

// Push an event to the session transcript and forward it to the frontend log.
function logEvent(callSid, role, message) {
    const s = callSessions.get(callSid);
    if (!s) return;
    s.transcript.push({ role, message });
    if (s.frontendWs?.readyState === WebSocket.OPEN) {
        s.frontendWs.send(JSON.stringify({ type: 'transcript', role, message }));
    }
}

const {
    mulawToPcm, pcmToMulaw, resample24kTo8k,
    pcmRms, generateDtmfMulaw, createHoldDetector,
} = require('./utils');

// --- TOOL DEFINITIONS ---
const bookCourtFunction = {
    name: 'confirmBooking',
    description: 'Call this function ONLY when the receptionist has confirmed a specific date and time for the booking.',
    parameters: {
      type: 'OBJECT',
      properties: {
        confirmedDay: { type: 'STRING' },
        confirmedTime: { type: 'STRING' },
        courtNumber: { type: 'STRING' },
      },
      required: ['confirmedDay', 'confirmedTime'],
    },
};

const reportHoldStateFunction = {
    name: 'reportHoldState',
    description: 'Call this immediately when you hear hold music, on-hold music, elevator music, a pre-recorded advertisement, or any non-human audio. This pauses audio forwarding to reduce costs while you wait silently for a human to answer.',
    parameters: {
        type: 'OBJECT',
        properties: {
            reason: {
                type: 'STRING',
                description: 'What you heard that triggered this. Be specific, e.g. "hold music", "pre-recorded advertisement about tennis lessons", "silence", "automated IVR message".'
            }
        },
        required: ['reason'],
    },
};

const pressDtmfKeyFunction = {
    name: 'pressDtmfKey',
    description: 'Press a key on the phone keypad to navigate an automated phone menu (IVR system). Call this when you hear a recorded message like "press 1 for reservations". Listen to ALL options before pressing.',
    parameters: {
        type: 'OBJECT',
        properties: {
            digit: {
                type: 'STRING',
                description: 'The key to press: 0-9, *, or #'
            },
            reason: {
                type: 'STRING',
                description: 'Brief description of why this key is being pressed, e.g. "court reservations option"'
            }
        },
        required: ['digit'],
    },
};

// --- ROUTES ---

// 1. Initiate Outbound Call
app.post('/outbound-call', async (req, res) => {
    const { phoneNumber, systemInstruction, email } = req.body;

    if (!phoneNumber) return res.status(400).json({ error: "Missing phoneNumber" });
    if (!twilioClient) return res.status(500).json({ error: "Twilio not configured" });

    try {
        const baseUrl = await detectBaseUrl(req.headers.host || 'localhost:8080');

        const call = await twilioClient.calls.create({
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER,
            url: `${baseUrl}/twiml`,
        });

        // Store by callSid — Twilio won't fetch /twiml until the phone rings,
        // so this is always set before the TwiML handler looks it up
        callSessions.set(call.sid, { frontendWs: null, systemInstruction, email, transcript: [], booked: false, bookingDetails: null });

        console.log(`Call initiated: ${call.sid}`);
        res.json({ callSid: call.sid });

    } catch (error) {
        console.error("Twilio Call Error:", error.message, '| code:', error.code);
        res.status(500).json({ error: error.message, code: error.code });
    }
});

// 2. TwiML Handler
app.post('/twiml', (req, res) => {
    // Twilio posts CallSid in the request body for every TwiML request
    const callSid = req.body.CallSid;
    const session = callSessions.get(callSid);
    const systemInstruction = session?.systemInstruction || '';
    const host = req.headers.host;

    console.log(`[TwiML] callSid=${callSid} host=${host} instruction=${systemInstruction ? 'present' : 'MISSING'}`);

    const twiml = `
    <Response>
        <Connect>
            <Stream url="wss://${host}/media-stream">
                <Parameter name="systemInstruction" value="${Buffer.from(systemInstruction).toString('base64')}" />
            </Stream>
        </Connect>
    </Response>
    `;

    res.type('text/xml');
    res.send(twiml);
});

// 3. End Call
app.post('/end-call', async (req, res) => {
    const { callSid } = req.body;
    if (!callSid || !twilioClient) return res.status(400).send();
    try {
        await twilioClient.calls(callSid).update({ status: 'completed' });
        res.json({ success: true });
    } catch (e) {
        console.error("End call error:", e);
        res.status(500).json({ error: e.message });
    }
});

// --- WEBSOCKET HANDLERS ---

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // A. FRONTEND CLIENT LOG CONNECTION
    if (pathname === '/client-log') {
        const callSid = url.searchParams.get('callSid');
        console.log(`[Frontend] Connected for CallSID: ${callSid}`);

        if (callSid) {
            const session = callSessions.get(callSid) || {};
            session.frontendWs = ws;
            callSessions.set(callSid, session);
        }

        ws.on('close', () => {
            console.log(`[Frontend] Disconnected for CallSID: ${callSid}`);
            if (callSid && callSessions.has(callSid)) {
                const s = callSessions.get(callSid);
                s.frontendWs = null;
            }
        });
    }
    // B. TWILIO MEDIA STREAM
    else if (pathname === '/media-stream') {
        handleMediaStream(ws);
    }
    else {
        ws.close();
    }
});

async function handleMediaStream(ws) {
    console.log("[Twilio] Media Stream Connected");

    const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
    let session = null;
    let streamSid = null;
    let callSid = null;
    let systemInstruction = "You are a helpful assistant.";
    let maxDurationTimer = null;

    // Persistent transcript buffers
    const transcriptBuffers = { input: '', output: '' };

    const holdDetector = createHoldDetector();

    // Log throttling counter
    let inboundChunkCount = 0;

    ws.on('message', async (message) => {
        let msg;
        try { msg = JSON.parse(message); } catch (e) { return; }

        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            const customParams = msg.start.customParameters;

            if (customParams && customParams.systemInstruction) {
                systemInstruction = Buffer.from(customParams.systemInstruction, 'base64').toString('utf-8');
            }

            console.log(`[Twilio] Stream Start: CallSid=${callSid}, StreamSid=${streamSid}`);
            console.log(`[Gemini] Connecting... Model: gemini-2.5-flash-native-audio-preview-09-2025`);

            // Connect to Gemini Live
            // Audio format (PCM16 @ 8kHz) is declared via mimeType in sendRealtimeInput;
            // no separate audioConfig message is needed with SDK ≥ 1.30.
            try {
                session = await ai.live.connect({
                    model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                    config: {
                        responseModalities: [Modality.AUDIO],
                        systemInstruction: systemInstruction,
                        tools: [{ functionDeclarations: [bookCourtFunction, pressDtmfKeyFunction, reportHoldStateFunction] }],
                        inputAudioTranscription: { enabled: true },
                        outputAudioTranscription: { enabled: true },
                        speechConfig: {
                            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } }
                        }
                    },
                    callbacks: {
                        onopen: () => {
                            console.log("[Gemini] Session Open - Ready for Audio");
                            // Cost guard — session is assigned by the time the timer fires
                            maxDurationTimer = setTimeout(() => {
                                console.warn("[Cost Guard] Max call duration reached, closing session.");
                                if (session) session.close();
                                ws.close();
                            }, MAX_CALL_DURATION_MS);
                        },
                        onmessage: (serverMsg) => {
                            handleGeminiMessage(serverMsg, callSid, ws, streamSid, session, transcriptBuffers, holdDetector);
                        },
                        onclose: () => {
                            console.log("[Gemini] Session Closed");
                            if (maxDurationTimer) clearTimeout(maxDurationTimer);
                        },
                        onerror: (err) => console.error("[Gemini] Error:", err)
                    }
                });
            } catch (err) {
                console.error("[Gemini] Connection Failed:", err);
                ws.close();
            }
        }
        else if (msg.event === 'media') {
            if (!session) {
                if (inboundChunkCount === 0) console.log("[Twilio] Session not ready, dropping audio...");
                return;
            }

            inboundChunkCount++;

            const mulawBuffer = Buffer.from(msg.media.payload, 'base64');
            const pcmBuffer = mulawToPcm(mulawBuffer);

            if (holdDetector.isOnHold) {
                // --- HOLD MODE: cheap energy monitor, do NOT send to Gemini ---
                const rms = pcmRms(pcmBuffer);
                const shouldWakeup = holdDetector.process(rms);

                if (shouldWakeup) {
                    console.log(`[Hold] Audio change detected (rms=${rms.toFixed(3)}), waking Gemini`);

                    logEvent(callSid, 'System', '[Hold ended — resuming audio]');

                    // Re-orient Gemini — tell it the audio change could be an ad
                    try {
                        session.sendClientContent({
                            turns: [{ role: 'user', parts: [{ text: 'The hold audio has changed. Listen for 2–3 seconds and decide: (a) if a live receptionist is speaking directly to you, greet them and proceed with booking; (b) if you hear a pre-recorded advertisement, announcement, or the hold music has simply changed, call reportHoldState immediately to keep waiting.' }] }],
                            turnComplete: true
                        });
                    } catch (_) { /* session may be reconnecting */ }
                }
                return; // never forward hold audio to Gemini
            }

            // --- NORMAL MODE: forward to Gemini ---
            if (inboundChunkCount % 50 === 0) {
                console.log(`[Twilio -> Gemini] Forwarding chunk #${inboundChunkCount}`);
            }
            try {
                session.sendRealtimeInput({
                    media: { data: pcmBuffer.toString('base64'), mimeType: 'audio/pcm;rate=8000' }
                });
            } catch (err) {
                console.error("[Gemini] Audio send error:", err);
            }
        }
        else if (msg.event === 'stop') {
            console.log("[Twilio] Media Stream Stopped");
            if (session) session.close();
        }
    });

    ws.on('close', () => {
        console.log("[Twilio] WebSocket Closed");
        if (maxDurationTimer) clearTimeout(maxDurationTimer);
        if (session) session.close();
        if (callSid) {
            const callSession = callSessions.get(callSid);
            if (callSession) {
                logEvent(callSid, 'System', '[Call ended]');
                // Send full call log email regardless of booking outcome
                sendCallSummaryEmail(
                    callSession.email,
                    callSession.transcript,
                    callSession.booked,
                    callSession.bookingDetails
                );
                if (callSession.frontendWs?.readyState === WebSocket.OPEN) {
                    callSession.frontendWs.send(JSON.stringify({ type: 'hangup' }));
                }
            }
            callSessions.delete(callSid);
        }
    });
}

function handleGeminiMessage(msg, callSid, twilioWs, streamSid, session, buffers, holdDetector) {
    // 1. Handle Audio (Send to Twilio)
    // Gemini outputs 24kHz PCM16; Twilio requires 8kHz µ-law (PCMU)
    const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (audioData) {
        const pcm24k = Buffer.from(audioData, 'base64');
        const pcm8k = resample24kTo8k(pcm24k);
        const mulaw = pcmToMulaw(pcm8k);
        twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: mulaw.toString('base64') }
        }));
    }

    // 2. Handle Transcription Buffering
    if (msg.serverContent?.outputTranscription?.text) {
        const text = msg.serverContent.outputTranscription.text;
        buffers.output += text;
        console.log(`[Gemini] Thinking/Speaking: "${text}"`);
    }
    if (msg.serverContent?.inputTranscription?.text) {
        const text = msg.serverContent.inputTranscription.text;
        buffers.input += text;
        console.log(`[Gemini] Heard User: "${text}"`);
    }

    // 3. Flush spoken turns on Turn Complete
    if (msg.serverContent?.turnComplete) {
        const inputText  = buffers.input.trim();
        const outputText = buffers.output.trim();
        if (inputText)  logEvent(callSid, 'Receptionist', inputText);
        if (outputText) logEvent(callSid, 'Agent', outputText);
        buffers.input  = '';
        buffers.output = '';
    }

    // 4. Handle Function Calls
    if (msg.toolCall) {
        for (const fc of msg.toolCall.functionCalls) {
            if (fc.name === 'reportHoldState') {
                const reason = fc.args?.reason || 'non-human audio';
                console.log(`[Hold] Pausing — ${reason}`);
                holdDetector.enter();
                logEvent(callSid, 'System', `[On hold: ${reason}]`);
                session.sendToolResponse({
                    functionResponses: { id: fc.id, name: fc.name,
                        response: { result: 'Acknowledged. Audio forwarding paused. Remain silent.' } }
                });
            }

            if (fc.name === 'pressDtmfKey') {
                const { digit, reason } = fc.args;
                console.log(`[DTMF] Pressing '${digit}' — ${reason || 'IVR navigation'}`);
                const dtmfAudio = generateDtmfMulaw(digit);
                if (dtmfAudio) {
                    twilioWs.send(JSON.stringify({ event: 'media', streamSid,
                        media: { payload: dtmfAudio.toString('base64') } }));
                }
                logEvent(callSid, 'Agent', `[Pressed key: ${digit}${reason ? ' — ' + reason : ''}]`);
                session.sendToolResponse({
                    functionResponses: { id: fc.id, name: fc.name,
                        response: { result: `Key ${digit} pressed successfully.` } }
                });
            }

            if (fc.name === 'confirmBooking') {
                console.log("[Gemini] confirmBooking:", fc.args);
                const callSession = callSessions.get(callSid);
                if (callSession) {
                    callSession.booked = true;
                    callSession.bookingDetails = fc.args;
                    logEvent(callSid, 'System', `[Booking confirmed — ${fc.args.confirmedDay} ${fc.args.confirmedTime}${fc.args.courtNumber ? ' court ' + fc.args.courtNumber : ''}]`);
                    if (callSession.frontendWs?.readyState === WebSocket.OPEN) {
                        callSession.frontendWs.send(JSON.stringify({ type: 'booked', details: fc.args }));
                    }
                }
                session.sendToolResponse({
                    functionResponses: { id: fc.id, name: fc.name,
                        response: { result: "Booking Confirmed. Hang up now." } }
                });
            }
        }
    }
}

// Serve built frontend — production only (dev uses `npm run dev` on port 5173)
const distDir = path.join(__dirname, 'dist');
if (require('fs').existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

server.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
