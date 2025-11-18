class PCM16Worklet extends AudioWorkletProcessor {
    constructor(options) {
        super(options);
        this.buffer = [];

        const { inputSampleRate, targetSampleRate } = options.processorOptions;

        this.inputSampleRate = inputSampleRate;
        this.targetSampleRate = targetSampleRate;
        this.targetSamples = 960;

        this.resampleRatio = this.inputSampleRate / this.targetSampleRate;

        this.resampleIndex = 0;
    }

    resample(input) {
        const output = [];
        const sourceLength = input.length;

        while (this.resampleIndex < sourceLength) {
            const index0 = Math.floor(this.resampleIndex);
            const index1 = index0 + 1;

            const weight1 = this.resampleIndex - index0;
            const weight0 = 1.0 - weight1;

            const sample0 = input[index0];
            const sample1 = (index1 < sourceLength) ? input[index1] : input[index0];

            const resampledValue = (sample0 * weight0) + (sample1 * weight1);

            output.push(resampledValue);

            this.resampleIndex += this.resampleRatio;
        }
        this.resampleIndex %= 1.0;

        return output;
    }
    // ----------------------------------------

    process(inputs) {
        const input = inputs[0][0];
        if (!input) return true;

        const resampledAudio = this.resample(input);

        for (let i = 0; i < resampledAudio.length; i++) {
            const s = Math.max(-1, Math.min(1, resampledAudio[i]));
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