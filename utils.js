'use strict';

// --- AUDIO CONVERSION ---

function mulawToPcm(mulawBuffer) {
    const pcmBuffer = Buffer.alloc(mulawBuffer.length * 2);
    for (let i = 0; i < mulawBuffer.length; i++) {
        // G.711: undo the bitwise complement that was applied during encoding,
        // then extract sign/exponent/mantissa from the resulting byte.
        const byte = (~mulawBuffer[i]) & 0xFF;
        let t = ((byte & 0x0F) << 3) + 0x84;
        t <<= (byte & 0x70) >> 4;
        const pcm = (byte & 0x80) ? (0x84 - t) : (t - 0x84);
        pcmBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, pcm)), i * 2);
    }
    return pcmBuffer;
}

function linearToMulaw(pcm) {
    const MU = 255;
    const sign = pcm < 0 ? 0x80 : 0;
    const abs = Math.min(Math.abs(pcm), 32767);
    const compressed = Math.round((Math.log(1 + MU * abs / 32767) / Math.log(1 + MU)) * 127);
    return (~(sign | compressed)) & 0xFF;
}

function pcmToMulaw(pcmBuffer) {
    const samples = pcmBuffer.length / 2;
    const out = Buffer.alloc(samples);
    for (let i = 0; i < samples; i++) {
        out[i] = linearToMulaw(pcmBuffer.readInt16LE(i * 2));
    }
    return out;
}

// 24kHz PCM16 → 8kHz PCM16 via 3:1 averaging decimation
function resample24kTo8k(pcmBuffer) {
    const inSamples = Math.floor(pcmBuffer.length / 2);
    const outSamples = Math.floor(inSamples / 3);
    const out = Buffer.alloc(outSamples * 2);
    for (let i = 0; i < outSamples; i++) {
        const s0 = pcmBuffer.readInt16LE(i * 6);
        const s1 = pcmBuffer.readInt16LE(i * 6 + 2);
        const s2 = pcmBuffer.readInt16LE(i * 6 + 4);
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((s0 + s1 + s2) / 3))), i * 2);
    }
    return out;
}

// Normalized RMS energy of a PCM16 buffer (0–1)
function pcmRms(pcmBuffer) {
    const samples = pcmBuffer.length / 2;
    let sum = 0;
    for (let i = 0; i < samples; i++) {
        const s = pcmBuffer.readInt16LE(i * 2) / 32768.0;
        sum += s * s;
    }
    return Math.sqrt(sum / samples);
}

// --- DTMF GENERATION ---

const DTMF_FREQS = {
    '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
    '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
    '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
    '0': [941, 1336], '*': [941, 1209], '#': [941, 1477],
};

// Returns µ-law buffer: 300ms tone + 200ms silence
function generateDtmfMulaw(digit) {
    const freqs = DTMF_FREQS[digit];
    if (!freqs) return null;
    const sampleRate = 8000;
    const toneSamples    = Math.floor(sampleRate * 0.3);
    const silenceSamples = Math.floor(sampleRate * 0.2);
    const pcm = Buffer.alloc((toneSamples + silenceSamples) * 2);
    for (let i = 0; i < toneSamples; i++) {
        const t = i / sampleRate;
        const s = 0.4 * Math.sin(2 * Math.PI * freqs[0] * t)
                + 0.4 * Math.sin(2 * Math.PI * freqs[1] * t);
        pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
    }
    return pcmToMulaw(pcm);
}

// --- HOLD DETECTOR ---
//
// Tracks whether the call is on hold and detects when hold ends.
// Configurable so tests can use tiny chunk counts.

function createHoldDetector({
    baselineChunks   = 50,   // chunks to build energy baseline (~1 s at 20ms/chunk)
    wakeupChunks     = 20,   // sustained deviation chunks needed to wake up (~400 ms)
    wakeupDeviation  = 0.4,  // fraction of baseline that counts as deviation
    silenceThreshold = 0.015 // absolute RMS below which we treat audio as silence
} = {}) {
    let isOnHold          = false;
    let holdBaseline      = null;
    let chunksAnalyzed    = 0;
    let wakeupCount       = 0;

    return {
        get isOnHold() { return isOnHold; },

        // Called when Gemini detects hold music
        enter() {
            isOnHold       = true;
            holdBaseline   = null;
            chunksAnalyzed = 0;
            wakeupCount    = 0;
        },

        // Feed one audio chunk's RMS. Returns true exactly once when wakeup fires.
        process(rms) {
            if (!isOnHold) return false;

            if (chunksAnalyzed < baselineChunks) {
                holdBaseline   = holdBaseline === null ? rms : holdBaseline * 0.95 + rms * 0.05;
                chunksAnalyzed++;
                return false;
            }

            const deviation = holdBaseline > 0.001
                ? Math.abs(rms - holdBaseline) / holdBaseline
                : 0;
            const isSilent = rms < silenceThreshold;

            if (deviation > wakeupDeviation || isSilent) {
                if (++wakeupCount >= wakeupChunks) {
                    isOnHold       = false;
                    holdBaseline   = null;
                    chunksAnalyzed = 0;
                    wakeupCount    = 0;
                    return true;
                }
            } else {
                wakeupCount = Math.max(0, wakeupCount - 1);
            }
            return false;
        },
    };
}

module.exports = {
    mulawToPcm,
    linearToMulaw,
    pcmToMulaw,
    resample24kTo8k,
    pcmRms,
    DTMF_FREQS,
    generateDtmfMulaw,
    createHoldDetector,
};
