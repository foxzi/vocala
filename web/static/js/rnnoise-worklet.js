// RNNoise AudioWorklet processor for Vocala.
// Expects rnnoise-sync.js to be prepended to this file at load time
// (so createRNNWasmModuleSync is available as a global) — the worklet
// is registered from a Blob URL built in app.js, since AudioWorkletGlobalScope
// does not provide importScripts in Firefox.

const RNNOISE_FRAME = 480;          // 10 ms @ 48 kHz
const SHIFT_16_BIT = 32768;

class RnnoiseProcessor {
    constructor(wasmModule) {
        this._wasm = wasmModule;
        this._ptr = this._wasm._malloc(RNNOISE_FRAME * 4);
        if (!this._ptr) throw new Error('rnnoise: malloc failed');
        this._idx = this._ptr >> 2;
        this._ctx = this._wasm._rnnoise_create();
    }
    // Denoise 480 samples in place.
    process(frame) {
        const heap = this._wasm.HEAPF32;
        const idx = this._idx;
        for (let i = 0; i < RNNOISE_FRAME; i++) heap[idx + i] = frame[i] * SHIFT_16_BIT;
        this._wasm._rnnoise_process_frame(this._ctx, this._ptr, this._ptr);
        for (let i = 0; i < RNNOISE_FRAME; i++) frame[i] = heap[idx + i] / SHIFT_16_BIT;
    }
}

class NoiseSuppressorWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        if (typeof createRNNWasmModuleSync !== 'function') {
            throw new Error('rnnoise wasm module not available in worklet scope');
        }
        if (sampleRate !== 48000) {
            // RNNoise is only valid at 48 kHz; bail out so caller falls back.
            throw new Error('rnnoise requires 48 kHz AudioContext, got ' + sampleRate);
        }
        this._proc = new RnnoiseProcessor(createRNNWasmModuleSync());
        // Input accumulator: fills until 480 samples, then we denoise.
        this._inBuf = new Float32Array(RNNOISE_FRAME);
        this._inLen = 0;
        // Output queue: holds denoised samples awaiting consumption.
        // Worst case: 1 full frame already queued + up to RNNOISE_FRAME-1 from current call.
        this._outBuf = new Float32Array(RNNOISE_FRAME * 2);
        this._outHead = 0;
        this._outTail = 0;
    }

    process(inputs, outputs) {
        const inData = inputs[0] && inputs[0][0];
        const outData = outputs[0] && outputs[0][0];
        if (!outData) return true;

        if (inData && inData.length) {
            for (let i = 0; i < inData.length; i++) {
                this._inBuf[this._inLen++] = inData[i];
                if (this._inLen === RNNOISE_FRAME) {
                    this._proc.process(this._inBuf);
                    // Compact output queue if needed.
                    if (this._outTail + RNNOISE_FRAME > this._outBuf.length) {
                        const remain = this._outTail - this._outHead;
                        this._outBuf.copyWithin(0, this._outHead, this._outTail);
                        this._outHead = 0;
                        this._outTail = remain;
                    }
                    this._outBuf.set(this._inBuf, this._outTail);
                    this._outTail += RNNOISE_FRAME;
                    this._inLen = 0;
                }
            }
        }

        const avail = this._outTail - this._outHead;
        const want = outData.length;
        if (avail >= want) {
            outData.set(this._outBuf.subarray(this._outHead, this._outHead + want));
            this._outHead += want;
        }
        // else: warm-up — leave outData zero-filled (a few quanta of silence).

        return true;
    }
}

registerProcessor('NoiseSuppressorWorklet', NoiseSuppressorWorklet);
