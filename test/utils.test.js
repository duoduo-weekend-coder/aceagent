'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    mulawToPcm, pcmToMulaw, linearToMulaw,
    resample24kTo8k, pcmRms,
    DTMF_FREQS, generateDtmfMulaw,
    createHoldDetector,
} = require('../utils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** PCM16 buffer containing a sine wave */
function makeSine(freqHz, amplitudeNorm, durationMs, sampleRate = 8000) {
    const samples = Math.floor(sampleRate * durationMs / 1000);
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        const s = amplitudeNorm * Math.sin(2 * Math.PI * freqHz * i / sampleRate);
        buf.writeInt16LE(Math.round(s * 32767), i * 2);
    }
    return buf;
}

/** PCM16 buffer of pure silence */
function makeSilence(durationMs, sampleRate = 8000) {
    return Buffer.alloc(Math.floor(sampleRate * durationMs / 1000) * 2);
}

/** Feed N identical RMS values into a detector */
function feedRms(detector, rms, count) {
    // Build a PCM16 buffer whose RMS equals the target value.
    // A DC signal at amplitude A has RMS = A, so just fill with A * 32767.
    const pcm16 = Math.round(rms * 32767);
    const buf = Buffer.alloc(160 * 2); // one Twilio chunk (160 samples)
    for (let i = 0; i < 160; i++) buf.writeInt16LE(pcm16, i * 2);
    for (let i = 0; i < count; i++) detector.process(pcmRms(buf));
}

// ---------------------------------------------------------------------------
// Audio conversion
// ---------------------------------------------------------------------------

describe('mulawToPcm / pcmToMulaw', () => {
    it('roundtrip is lossless at silence (µ-law zero)', () => {
        // µ-law 0xFF is the negative-side zero
        const mulaw = Buffer.from([0xFF]);
        const pcm = mulawToPcm(mulaw);
        // µ-law silence decodes to a small negative value (not exactly 0, by spec)
        assert.ok(Math.abs(pcm.readInt16LE(0)) < 100);
    });

    it('pcmToMulaw output length equals input sample count', () => {
        const pcm = makeSine(440, 0.5, 100); // 800 samples
        const mulaw = pcmToMulaw(pcm);
        assert.equal(mulaw.length, pcm.length / 2);
    });

    it('roundtrip preserves sign of a positive sample', () => {
        // Encode a moderate positive value, decode it, check sign is preserved
        const pcm = Buffer.alloc(2);
        pcm.writeInt16LE(8000, 0);
        const mulaw = pcmToMulaw(pcm);
        const decoded = mulawToPcm(mulaw);
        assert.ok(decoded.readInt16LE(0) > 0, 'sign should be positive after roundtrip');
    });

    it('roundtrip preserves sign of a negative sample', () => {
        const pcm = Buffer.alloc(2);
        pcm.writeInt16LE(-8000, 0);
        const mulaw = pcmToMulaw(pcm);
        const decoded = mulawToPcm(mulaw);
        assert.ok(decoded.readInt16LE(0) < 0, 'sign should be negative after roundtrip');
    });
});

describe('resample24kTo8k', () => {
    it('output length is exactly 1/3 of input samples', () => {
        const input = Buffer.alloc(300 * 2); // 300 samples @ 24kHz
        const output = resample24kTo8k(input);
        assert.equal(output.length / 2, 100); // 100 samples @ 8kHz
    });

    it('silence in → silence out', () => {
        const input = Buffer.alloc(300 * 2);
        const output = resample24kTo8k(input);
        for (let i = 0; i < output.length / 2; i++) {
            assert.equal(output.readInt16LE(i * 2), 0);
        }
    });

    it('averages three input samples into one output sample', () => {
        const input = Buffer.alloc(6 * 2); // 6 samples → 2 output samples
        input.writeInt16LE(300, 0);
        input.writeInt16LE(600, 2);
        input.writeInt16LE(900, 4); // avg = 600
        input.writeInt16LE(100, 6);
        input.writeInt16LE(200, 8);
        input.writeInt16LE(300, 10); // avg = 200
        const output = resample24kTo8k(input);
        assert.equal(output.readInt16LE(0), 600);
        assert.equal(output.readInt16LE(2), 200);
    });
});

describe('pcmRms', () => {
    it('silence returns 0', () => {
        assert.equal(pcmRms(makeSilence(100)), 0);
    });

    it('full-scale sine wave has RMS ≈ 0.707', () => {
        // Sine wave with amplitude 1.0 has RMS = 1/√2 ≈ 0.707
        const buf = makeSine(440, 1.0, 100); // 800 samples — enough for accuracy
        const rms = pcmRms(buf);
        assert.ok(Math.abs(rms - 0.707) < 0.01, `expected ~0.707, got ${rms.toFixed(4)}`);
    });

    it('half-amplitude sine wave has RMS ≈ 0.354', () => {
        const buf = makeSine(440, 0.5, 100);
        const rms = pcmRms(buf);
        assert.ok(Math.abs(rms - 0.354) < 0.01, `expected ~0.354, got ${rms.toFixed(4)}`);
    });
});

// ---------------------------------------------------------------------------
// DTMF generation
// ---------------------------------------------------------------------------

describe('generateDtmfMulaw', () => {
    it('returns null for an invalid digit', () => {
        assert.equal(generateDtmfMulaw('Q'), null);
        assert.equal(generateDtmfMulaw(''),  null);
    });

    it('returns a Buffer for every valid digit', () => {
        const digits = Object.keys(DTMF_FREQS);
        for (const d of digits) {
            const buf = generateDtmfMulaw(d);
            assert.ok(buf instanceof Buffer, `digit '${d}' should return a Buffer`);
            assert.ok(buf.length > 0);
        }
    });

    it('output length is 500ms of audio at 8kHz µ-law (300ms tone + 200ms silence)', () => {
        const buf = generateDtmfMulaw('1');
        const expectedSamples = Math.floor(8000 * 0.5); // 4000
        assert.equal(buf.length, expectedSamples);
    });

    it('tone region is non-silent, silence region is near-zero', () => {
        const buf = generateDtmfMulaw('5');
        // Decode and check energy in first 300ms vs last 200ms
        const { mulawToPcm: decode, pcmRms: rms } = require('../utils');
        const tonePart    = decode(buf.subarray(0, 2400));    // 300ms × 8 samples/ms
        const silencePart = decode(buf.subarray(2400));        // 200ms
        assert.ok(rms(tonePart)    > 0.1,  'tone region should have significant energy');
        assert.ok(rms(silencePart) < 0.01, 'silence region should be near zero');
    });
});

// ---------------------------------------------------------------------------
// Hold detector
// ---------------------------------------------------------------------------

describe('createHoldDetector', () => {
    it('starts not on hold', () => {
        const d = createHoldDetector();
        assert.equal(d.isOnHold, false);
    });

    it('enter() sets isOnHold = true', () => {
        const d = createHoldDetector();
        d.enter();
        assert.equal(d.isOnHold, true);
    });

    it('process() returns false during baseline window', () => {
        const d = createHoldDetector({ baselineChunks: 5, wakeupChunks: 3 });
        d.enter();
        // Feed 5 identical chunks — still in baseline phase, should never wakeup
        for (let i = 0; i < 5; i++) {
            assert.equal(d.process(0.2), false);
        }
        assert.equal(d.isOnHold, true);
    });

    it('sustained deviation triggers wakeup and resets state', () => {
        const d = createHoldDetector({ baselineChunks: 5, wakeupChunks: 3, wakeupDeviation: 0.4 });
        d.enter();
        // Build baseline at RMS = 0.2
        for (let i = 0; i < 5; i++) d.process(0.2);
        // Feed 3 chunks deviating >40 % from 0.2 (e.g. 0.5: deviation = 150 %)
        assert.equal(d.process(0.5), false); // 1st deviation chunk
        assert.equal(d.process(0.5), false); // 2nd
        assert.equal(d.process(0.5), true);  // 3rd → wakeup fires
        // State must reset after wakeup
        assert.equal(d.isOnHold, false);
    });

    it('brief deviation (< wakeupChunks) does NOT trigger wakeup', () => {
        const d = createHoldDetector({ baselineChunks: 5, wakeupChunks: 5, wakeupDeviation: 0.4 });
        d.enter();
        for (let i = 0; i < 5; i++) d.process(0.2);  // baseline
        // 3 deviation chunks, then back to baseline — should not wake up
        d.process(0.5);
        d.process(0.5);
        d.process(0.5);
        for (let i = 0; i < 5; i++) d.process(0.2); // decay counter back to 0
        assert.equal(d.isOnHold, true, 'should still be on hold after brief deviation');
    });

    it('near-silence triggers wakeup (music stopped)', () => {
        const d = createHoldDetector({
            baselineChunks: 5, wakeupChunks: 3,
            silenceThreshold: 0.015, wakeupDeviation: 0.9,
        });
        d.enter();
        for (let i = 0; i < 5; i++) d.process(0.2); // baseline
        // Feed near-silence (music ended)
        assert.equal(d.process(0.005), false);
        assert.equal(d.process(0.005), false);
        assert.equal(d.process(0.005), true); // wakeup
    });

    it('calling enter() again resets baseline so it rebuilds', () => {
        const d = createHoldDetector({ baselineChunks: 3, wakeupChunks: 2, wakeupDeviation: 0.4 });
        d.enter();
        for (let i = 0; i < 3; i++) d.process(0.2); // baseline at 0.2
        // Re-enter (e.g. Gemini called reportHoldState again for an ad)
        d.enter();
        // Now back in baseline window — deviation should not fire
        d.process(0.5); // would have been a deviation before re-enter
        d.process(0.5);
        assert.equal(d.isOnHold, true, 'should still be on hold after re-enter during baseline');
    });

    it('wakeup fires only once even with continued deviation', () => {
        const d = createHoldDetector({ baselineChunks: 2, wakeupChunks: 2, wakeupDeviation: 0.4 });
        d.enter();
        d.process(0.2); d.process(0.2); // baseline
        d.process(0.5); d.process(0.5); // wakeup fires here
        // Subsequent calls after wakeup must not fire again (state is reset)
        for (let i = 0; i < 10; i++) {
            assert.equal(d.process(0.5), false);
        }
    });
});
