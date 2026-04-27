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
if (!GOOGLE_API_KEY) console.error("❌ GEMINI_API_KEY missing in .env file");

// Only native-audio model currently available for the Live bidiGenerateContent API.
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL
    || 'gemini-2.5-flash-native-audio-preview-09-2025';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-mini-realtime-preview';

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

// Shared tool execution logic — identical for Gemini and OpenAI.
// sendToolResponse(result) is provider-specific and passed in as a callback.
function executeToolCall(name, args, callSid, twilioWs, streamSid, holdDetector, sendToolResponse) {
    if (name === 'reportHoldState') {
        const reason = args?.reason || 'non-human audio';
        console.log(`[Hold] Pausing — ${reason}`);
        holdDetector.enter();
        logEvent(callSid, 'System', `[On hold: ${reason}]`);
        sendToolResponse('Acknowledged. Audio forwarding paused. Remain silent.');
    }
    if (name === 'pressDtmfKey') {
        const { digit, reason } = args;
        console.log(`[DTMF] Pressing '${digit}' — ${reason || 'IVR navigation'}`);
        const dtmfAudio = generateDtmfMulaw(digit);
        if (dtmfAudio) twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: dtmfAudio.toString('base64') } }));
        logEvent(callSid, 'Agent', `[Pressed key: ${digit}${reason ? ' — ' + reason : ''}]`);
        sendToolResponse(`Key ${digit} pressed successfully.`);
    }
    if (name === 'confirmBooking') {
        console.log('[AI] confirmBooking:', args);
        const callSession = callSessions.get(callSid);
        if (callSession) {
            callSession.booked = true;
            callSession.bookingDetails = args;
            logEvent(callSid, 'System', `[Booking confirmed — ${args.confirmedDay} ${args.confirmedTime}${args.courtNumber ? ' court ' + args.courtNumber : ''}]`);
            if (callSession.frontendWs?.readyState === WebSocket.OPEN) {
                callSession.frontendWs.send(JSON.stringify({ type: 'booked', details: args }));
            }
        }
        sendToolResponse('Booking Confirmed. Hang up now.');
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

// --- OPENAI REALTIME ---

// OpenAI uses standard JSON Schema (lowercase types), unlike Gemini's uppercase OBJECT/STRING.
const openAITools = [
    {
        type: 'function', name: 'confirmBooking',
        description: 'Call this function ONLY when the receptionist has confirmed a specific date and time for the booking.',
        parameters: { type: 'object', properties: { confirmedDay: { type: 'string' }, confirmedTime: { type: 'string' }, courtNumber: { type: 'string' } }, required: ['confirmedDay', 'confirmedTime'] },
    },
    {
        type: 'function', name: 'reportHoldState',
        description: 'Call this immediately when you hear hold music, on-hold music, elevator music, a pre-recorded advertisement, or any non-human audio.',
        parameters: { type: 'object', properties: { reason: { type: 'string', description: 'What you heard that triggered this. Be specific.' } }, required: ['reason'] },
    },
    {
        type: 'function', name: 'pressDtmfKey',
        description: 'Press a key on the phone keypad to navigate an automated phone menu (IVR system).',
        parameters: { type: 'object', properties: { digit: { type: 'string', description: 'The key to press: 0-9, *, or #' }, reason: { type: 'string' } }, required: ['digit'] },
    },
];

// Opens an OpenAI Realtime WebSocket and returns a thin interface matching our Gemini pattern.
// OpenAI natively accepts and emits g711_ulaw — no audio conversion needed.
// opts.inputAudioFormat / outputAudioFormat: 'g711_ulaw' (real calls) or 'pcm16' (simulation)
function createOpenAISession(systemInstruction, { onopen, onmessage, onclose, onerror }, opts = {}) {
    if (!OPENAI_API_KEY) {
        console.error('[OpenAI] OPENAI_API_KEY not set in .env');
        return null;
    }
    const inputFmt  = opts.inputAudioFormat  || 'g711_ulaw';
    const outputFmt = opts.outputAudioFormat || 'g711_ulaw';
    const oaiWs = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`,
        { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
    );
    oaiWs.on('open', () => {
        oaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
                modalities: ['audio', 'text'],
                instructions: systemInstruction,
                voice: 'alloy',
                input_audio_format: inputFmt,
                output_audio_format: outputFmt,
                input_audio_transcription: { model: 'whisper-1' },
                turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
                tools: openAITools,
                tool_choice: 'auto',
            }
        }));
        onopen();
    });
    oaiWs.on('message', (data) => { try { onmessage(JSON.parse(data)); } catch {} });
    oaiWs.on('close',   (code, reason) => onclose(code, reason?.toString() || ''));
    oaiWs.on('error',   onerror);

    return {
        sendAudio: (mulawBuf) => {
            if (oaiWs.readyState === WebSocket.OPEN)
                oaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mulawBuf.toString('base64') }));
        },
        sendText: (text) => {
            if (oaiWs.readyState !== WebSocket.OPEN) return;
            oaiWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
            oaiWs.send(JSON.stringify({ type: 'response.create' }));
        },
        sendToolResponse: (callId, result) => {
            if (oaiWs.readyState !== WebSocket.OPEN) return;
            oaiWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ result }) } }));
            oaiWs.send(JSON.stringify({ type: 'response.create' }));
        },
        close: () => { if (oaiWs.readyState === WebSocket.OPEN) oaiWs.close(); },
    };
}

function handleOpenAIMessage(event, callSid, twilioWs, streamSid, holdDetector, transcriptBuffers, oai) {
    switch (event.type) {
        case 'response.audio.delta':
            // Already g711_ulaw — forward directly to Twilio, no conversion
            twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
            break;
        case 'response.audio_transcript.delta':
            transcriptBuffers.output += event.delta || '';
            break;
        case 'response.audio_transcript.done':
            if (transcriptBuffers.output.trim()) logEvent(callSid, 'Agent', transcriptBuffers.output.trim());
            transcriptBuffers.output = '';
            break;
        case 'conversation.item.input_audio_transcription.completed':
            if (event.transcript?.trim()) logEvent(callSid, 'Receptionist', event.transcript.trim());
            break;
        case 'response.function_call_arguments.done': {
            let args = {};
            try { args = JSON.parse(event.arguments || '{}'); } catch {}
            executeToolCall(event.name, args, callSid, twilioWs, streamSid, holdDetector,
                (result) => oai.sendToolResponse(event.call_id, result));
            break;
        }
        case 'error':
            console.error('[OpenAI] Event error:', event.error);
            logEvent(callSid, 'System', `[OpenAI error: ${event.error?.message || 'unknown'}]`);
            break;
    }
}

// --- ROUTES ---

// 1. Initiate Outbound Call
app.post('/outbound-call', async (req, res) => {
    const { phoneNumber, systemInstruction, email, aiProvider } = req.body;

    if (!phoneNumber) return res.status(400).json({ error: "Missing phoneNumber" });
    if (!twilioClient) return res.status(500).json({ error: "Twilio not configured" });
    if (aiProvider === 'openai' && !OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not set on server — add it to .env and restart" });

    try {
        const baseUrl = await detectBaseUrl(req.headers.host || 'localhost:8080');

        const call = await twilioClient.calls.create({
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER,
            url: `${baseUrl}/twiml`,
        });

        // Store by callSid — Twilio won't fetch /twiml until the phone rings,
        // so this is always set before the TwiML handler looks it up
        callSessions.set(call.sid, { frontendWs: null, systemInstruction, email, aiProvider: aiProvider || 'gemini', transcript: [], booked: false, bookingDetails: null });

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
    // C. OPENAI BROWSER SIMULATION PROXY
    else if (pathname === '/openai-sim') {
        handleOpenAISimProxy(ws);
    }
    else {
        ws.close();
    }
});

// Proxies browser simulation audio to OpenAI Realtime (PCM16 ↔ PCM16).
// Browser sends { type:'init', systemInstruction } then { type:'audio', data:base64pcm16 }.
// We send back { type:'audio'|'transcript'|'booked', ... } in a unified format
// that AgentInterface can handle without knowing about OpenAI internals.
function handleOpenAISimProxy(clientWs) {
    let oai = null;
    const buffers = { input: '', output: '' };

    const send = (msg) => { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(msg)); };

    clientWs.on('message', (data) => {
        let msg; try { msg = JSON.parse(data); } catch { return; }

        if (msg.type === 'init') {
            oai = createOpenAISession(msg.systemInstruction, {
                onopen: () => send({ type: 'connected' }),
                onmessage: (event) => {
                    switch (event.type) {
                        case 'response.audio.delta':
                            send({ type: 'audio', data: event.delta });
                            break;
                        case 'response.audio_transcript.delta':
                            buffers.output += event.delta || '';
                            break;
                        case 'response.audio_transcript.done':
                            if (buffers.output.trim()) send({ type: 'transcript', role: 'agent', text: buffers.output.trim() });
                            buffers.output = '';
                            break;
                        case 'conversation.item.input_audio_transcription.completed':
                            if (event.transcript?.trim()) send({ type: 'transcript', role: 'user', text: event.transcript.trim() });
                            break;
                        case 'response.function_call_arguments.done': {
                            let args = {}; try { args = JSON.parse(event.arguments || '{}'); } catch {}
                            if (event.name === 'confirmBooking') {
                                send({ type: 'transcript', role: 'system', text: `[Booking confirmed — ${args.confirmedDay} ${args.confirmedTime}]` });
                                send({ type: 'booked', details: args });
                                oai.sendToolResponse(event.call_id, 'Booking Confirmed. Say goodbye.');
                            } else if (event.name === 'reportHoldState') {
                                send({ type: 'transcript', role: 'system', text: `[On hold: ${args.reason || 'non-human audio'}]` });
                                oai.sendToolResponse(event.call_id, 'Acknowledged. Remain silent.');
                            } else if (event.name === 'pressDtmfKey') {
                                send({ type: 'transcript', role: 'agent', text: `[Pressed key: ${args.digit}${args.reason ? ' — ' + args.reason : ''}]` });
                                oai.sendToolResponse(event.call_id, `Key ${args.digit} pressed.`);
                            }
                            break;
                        }
                        case 'error':
                            console.error('[OpenAI Sim] Error:', event.error);
                            break;
                    }
                },
                onclose: () => { if (clientWs.readyState === WebSocket.OPEN) clientWs.close(); },
                onerror: (err) => console.error('[OpenAI Sim]', err),
            }, { inputAudioFormat: 'pcm16', outputAudioFormat: 'pcm16' });

            if (!oai) { clientWs.close(); }

        } else if (msg.type === 'audio' && oai) {
            oai.sendAudio(Buffer.from(msg.data, 'base64'));
        }
    });

    clientWs.on('close', () => { if (oai) oai.close(); });
}

async function handleMediaStream(ws) {
    console.log("[Twilio] Media Stream Connected");

    const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
    let streamSid = null;
    let callSid   = null;
    let systemInstruction = "You are a helpful assistant.";
    let maxDurationTimer  = null;
    let inboundChunkCount = 0;

    const holdDetector    = createHoldDetector();
    const transcriptBuffers = { input: '', output: '' };

    // Provider-agnostic interface — filled in once the AI session connects
    let aiReady     = false;
    let aiSendAudio = () => {};  // (mulawBuffer) → void
    let aiSendText  = () => {};  // (text) → void  (hold wakeup injection)
    let aiClose     = () => {};

    // Gemini-specific: kept separate so handleGeminiMessage can reference it
    let geminiSession = null;

    ws.on('message', async (message) => {
        let msg;
        try { msg = JSON.parse(message); } catch { return; }

        // ── START ─────────────────────────────────────────────────────────
        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            callSid   = msg.start.callSid;
            const customParams = msg.start.customParameters;
            if (customParams?.systemInstruction)
                systemInstruction = Buffer.from(customParams.systemInstruction, 'base64').toString('utf-8');

            const callSession = callSessions.get(callSid);
            const aiProvider  = callSession?.aiProvider || 'gemini';
            console.log(`[Twilio] Stream Start: CallSid=${callSid} provider=${aiProvider}`);

            if (aiProvider === 'openai') {
                console.log(`[OpenAI] Connecting... model=${OPENAI_MODEL}`);
                const oai = createOpenAISession(systemInstruction, {
                    onopen: () => {
                        console.log(`[OpenAI] ✓ Connected — model: ${OPENAI_MODEL}`);
                        logEvent(callSid, 'System', `[OpenAI connected — ${OPENAI_MODEL}]`);
                        aiReady = true;
                        maxDurationTimer = setTimeout(() => {
                            console.warn('[Cost Guard] Max duration reached'); oai.close(); ws.close();
                        }, MAX_CALL_DURATION_MS);
                    },
                    onmessage: (event) => handleOpenAIMessage(event, callSid, ws, streamSid, holdDetector, transcriptBuffers, oai),
                    onclose: (code, reason) => {
                        if (code !== 1000) {
                            console.error(`[OpenAI] Closed unexpectedly code=${code} reason=${reason}`);
                            logEvent(callSid, 'System', `[OpenAI disconnected: code=${code}]`);
                        } else { console.log('[OpenAI] Session closed normally'); }
                        aiReady = false;
                        if (maxDurationTimer) clearTimeout(maxDurationTimer);
                    },
                    onerror: (err) => {
                        console.error('[OpenAI] Error:', err);
                        logEvent(callSid, 'System', `[OpenAI error: ${String(err).slice(0, 80)}]`);
                    },
                });
                if (!oai) { ws.close(); return; }
                aiSendAudio = (buf) => oai.sendAudio(buf);
                aiSendText  = (txt) => oai.sendText(txt);
                aiClose     = ()    => oai.close();

            } else {
                console.log(`[Gemini] Connecting with model: ${LIVE_MODEL}`);
                try {
                    geminiSession = await ai.live.connect({
                        model: LIVE_MODEL,
                        config: {
                            responseModalities: [Modality.AUDIO],
                            systemInstruction,
                            tools: [{ functionDeclarations: [bookCourtFunction, pressDtmfKeyFunction, reportHoldStateFunction] }],
                            inputAudioTranscription: { enabled: true },
                            outputAudioTranscription: { enabled: true },
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } }
                        },
                        callbacks: {
                            onopen: () => {
                                console.log(`[Gemini] ✓ Connected — model: ${LIVE_MODEL}`);
                                logEvent(callSid, 'System', `[Gemini connected — ${LIVE_MODEL}]`);
                                aiReady = true;
                                maxDurationTimer = setTimeout(() => {
                                    console.warn('[Cost Guard] Max duration reached');
                                    if (geminiSession) geminiSession.close(); ws.close();
                                }, MAX_CALL_DURATION_MS);
                            },
                            onmessage: (serverMsg) => handleGeminiMessage(serverMsg, callSid, ws, streamSid, geminiSession, transcriptBuffers, holdDetector),
                            onclose: (event) => {
                                const code = event?.code ?? '?', reason = event?.reason ?? '';
                                if (code === 1000) { console.log('[Gemini] Session closed normally'); }
                                else {
                                    console.error(`[Gemini] Closed unexpectedly code=${code} reason=${reason}`);
                                    logEvent(callSid, 'System', `[Gemini disconnected: code=${code}${reason ? ' ' + reason.slice(0, 80) : ''}]`);
                                }
                                geminiSession = null; aiReady = false;
                                if (maxDurationTimer) clearTimeout(maxDurationTimer);
                            },
                            onerror: (err) => {
                                console.error('[Gemini] Error:', err);
                                logEvent(callSid, 'System', `[Gemini error: ${String(err).slice(0, 80)}]`);
                            }
                        }
                    });
                    aiSendAudio = (buf) => {
                        if (!geminiSession) return;
                        geminiSession.sendRealtimeInput({ media: { data: mulawToPcm(buf).toString('base64'), mimeType: 'audio/pcm;rate=8000' } });
                    };
                    aiSendText = (txt) => {
                        if (!geminiSession) return;
                        geminiSession.sendClientContent({ turns: [{ role: 'user', parts: [{ text: txt }] }], turnComplete: true });
                    };
                    aiClose = () => { if (geminiSession) geminiSession.close(); };
                } catch (err) {
                    console.error('[Gemini] Connection Failed:', err); ws.close();
                }
            }
        }

        // ── MEDIA ─────────────────────────────────────────────────────────
        else if (msg.event === 'media') {
            inboundChunkCount++;
            const mulawBuffer = Buffer.from(msg.media.payload, 'base64');

            if (holdDetector.isOnHold) {
                const rms = pcmRms(mulawToPcm(mulawBuffer));
                if (holdDetector.process(rms)) {
                    console.log(`[Hold] Audio change detected (rms=${rms.toFixed(3)}), waking AI`);
                    logEvent(callSid, 'System', '[Hold ended — resuming audio]');
                    try {
                        aiSendText('The hold audio has changed. Listen for 2–3 seconds and decide: (a) if a live receptionist is speaking directly to you, greet them and proceed with booking; (b) if you hear a pre-recorded advertisement or the hold music has simply changed, call reportHoldState immediately to keep waiting.');
                    } catch (_) {}
                }
                return;
            }

            if (!aiReady) {
                if (inboundChunkCount % 50 === 0) console.log(`[Twilio] Waiting for AI... (${inboundChunkCount} chunks dropped)`);
                return;
            }
            if (inboundChunkCount % 50 === 0) console.log(`[Twilio -> AI] Forwarding chunk #${inboundChunkCount}`);
            try { aiSendAudio(mulawBuffer); } catch (err) { console.error('[AI] Audio send error:', err); }
        }

        // ── STOP ──────────────────────────────────────────────────────────
        else if (msg.event === 'stop') {
            console.log("[Twilio] Media Stream Stopped");
            aiClose();
        }
    });

    ws.on('close', () => {
        console.log("[Twilio] WebSocket Closed");
        if (maxDurationTimer) clearTimeout(maxDurationTimer);
        aiClose();
        if (callSid) {
            const callSession = callSessions.get(callSid);
            if (callSession) {
                logEvent(callSid, 'System', '[Call ended]');
                sendCallSummaryEmail(callSession.email, callSession.transcript, callSession.booked, callSession.bookingDetails);
                if (callSession.frontendWs?.readyState === WebSocket.OPEN)
                    callSession.frontendWs.send(JSON.stringify({ type: 'hangup' }));
            }
            callSessions.delete(callSid);
        }
    });
}

function handleGeminiMessage(msg, callSid, twilioWs, streamSid, session, buffers, holdDetector) {
    // 1. Audio: Gemini outputs 24kHz PCM16 → resample to 8kHz → µ-law → Twilio
    const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (audioData) {
        const mulaw = pcmToMulaw(resample24kTo8k(Buffer.from(audioData, 'base64')));
        twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: mulaw.toString('base64') } }));
    }

    // 2. Transcription buffering
    if (msg.serverContent?.outputTranscription?.text) buffers.output += msg.serverContent.outputTranscription.text;
    if (msg.serverContent?.inputTranscription?.text)  buffers.input  += msg.serverContent.inputTranscription.text;

    // 3. Flush on turn complete
    if (msg.serverContent?.turnComplete) {
        const i = buffers.input.trim(), o = buffers.output.trim();
        if (i) logEvent(callSid, 'Receptionist', i);
        if (o) logEvent(callSid, 'Agent', o);
        buffers.input = buffers.output = '';
    }

    // 4. Tool calls — shared logic, provider-specific response
    if (msg.toolCall) {
        for (const fc of msg.toolCall.functionCalls) {
            executeToolCall(fc.name, fc.args, callSid, twilioWs, streamSid, holdDetector,
                (result) => { if (session) session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result } } }); }
            );
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
