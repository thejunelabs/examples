class PCM16Worklet extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = [];
        this.targetSamples = 960; // 40ms at 24kHz
    }

    process(inputs) {
        const input = inputs[0][0];
        if (!input) return true;

        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            this.buffer.push(s * 32767);
        }

        while (this.buffer.length >= this.targetSamples) {
            const slice = this.buffer.splice(0, this.targetSamples);
            const pcm = new Int16Array(slice);
            this.port.postMessage(pcm.buffer, [pcm.buffer]);
        }

        return true;
    }
}

registerProcessor("pcm16-worklet", PCM16Worklet);
